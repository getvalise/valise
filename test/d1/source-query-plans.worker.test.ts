import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { maintainSourceEnrichment } from "~/concepts/source-enrichment";
import {
  maintainSourceVectors,
  sourceVectorCandidates,
} from "~/search/source-vectors";

// The minute drains run these per-source subqueries over every live source.
// On a single-owner instance a user-only index matches every row, so a plan
// that picks one reads sources × enrichments rows a tick: 2.3B rows a day in
// production from 2026-10-29 to 2026-11-08. Correct answers, wrong bill.
const db = env.DB;

type Seen = { sql: string; args: unknown[] };

function recording(seen: Seen[]): D1Database {
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          const entry: Seen = { sql, args: [] };
          seen.push(entry);
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(inner, name) {
              if (name === "bind")
                return (...args: unknown[]) => {
                  entry.args = args;
                  return inner.bind(...args);
                };
              const value = Reflect.get(inner, name);
              return typeof value === "function" ? value.bind(inner) : value;
            },
          });
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function plan(seen: Seen[], marker: string) {
  const query = seen.find((entry) => entry.sql.includes(marker));
  if (!query) throw new Error(`query with ${marker} was not prepared`);
  const { results } = await db
    .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
    .bind(...query.args)
    .all<{ detail: string }>();
  return results.map((row) => row.detail);
}

const userOnly =
  /USING (COVERING )?INDEX (source_enrichments_user_time|source_vector_due) \((namespace=\? AND )?user_id=\?\)$/;

const ai = { run: async () => ({ data: [] }) } as unknown as Pick<Ai, "run">;
const vectorIndex = {
  query: async () => ({ matches: [], count: 0 }),
  upsert: async () => ({ mutationId: "m" }),
  deleteByIds: async () => ({ mutationId: "m" }),
} as unknown as Vectorize;

describe("source drain query plans", () => {
  it("finds owed sources through the per-source enrichment key", async () => {
    const seen: Seen[] = [];
    await maintainSourceEnrichment({ DB: recording(seen), AI: ai } as never);
    const details = await plan(seen, "ORDER BY s.created_at DESC");
    expect(details.filter((d) => userOnly.test(d))).toEqual([]);
    expect(
      details.filter((d) => d.includes("source_enrichments_source")).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("finds unqueued enrichments through per-source and per-enrichment keys", async () => {
    const seen: Seen[] = [];
    await maintainSourceVectors({
      DB: recording(seen),
      AI: ai,
      VALISE_VECTOR_NAMESPACE: "plan-test",
      VECTOR_INDEX: vectorIndex,
    } as never);
    const details = await plan(seen, "FROM source_vector_pending v");
    expect(details.filter((d) => userOnly.test(d))).toEqual([]);
    expect(
      details.some((d) =>
        d.includes("SEARCH f USING INDEX source_enrichments_source"),
      ),
    ).toBe(true);
    expect(details.some((d) => d.includes("enrichment_id=?"))).toBe(true);
  });

  it("scopes search candidates without a user-only enrichment scan", async () => {
    const seen: Seen[] = [];
    await sourceVectorCandidates(
      {
        DB: recording(seen),
        AI: ai,
        VALISE_VECTOR_NAMESPACE: "plan-test",
        VECTOR_INDEX: vectorIndex,
      } as never,
      { query: "hedgerows", concepts: ["source"], userId: "local" },
    ).catch(() => []);
    const details = await plan(seen, "SELECT s.doc_key FROM search_docs s");
    expect(details.filter((d) => userOnly.test(d))).toEqual([]);
  });
});
