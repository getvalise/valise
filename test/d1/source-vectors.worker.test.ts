import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enrichSource } from "~/concepts/source-enrichment";
import {
  deleteSource,
  saveSource,
  setSourceArchived,
} from "~/concepts/sources";
import { SUMMARY_MODEL } from "~/concepts/summary-model";
import { rerankedSearch } from "~/search/rerank";
import {
  backfillSourceVectors,
  maintainSourceVectors,
  sourceVectorCandidates,
} from "~/search/source-vectors";

// Real D1, enrichment, projection and ledger. Workers AI, Vectorize and Jev
// are contract doubles: this proves wiring and isolation, not ranking quality.
const db = env.DB;
const embedding = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
const vectors = new Map<string, VectorizeVector>();
const upsert = vi.fn<Vectorize["upsert"]>();
const deleteByIds = vi.fn<Vectorize["deleteByIds"]>();
const query = vi.fn<Vectorize["query"]>();
const run = vi.fn();
const bindings = {
  DB: db,
  AI: { run } as unknown as Pick<Ai, "run">,
  VALISE_VECTOR_NAMESPACE: "source-test",
  VECTOR_INDEX: { upsert, deleteByIds, query },
  TYPESAFE_API_KEY: "test",
};

function paragraphs(topic: string, count: number) {
  return Array.from(
    { length: count },
    (_, i) =>
      `Paragraph ${i} on ${topic}: hawthorn hedgerows give bumblebees shelter and nectar early in spring, and slow the wind that dries the soil between fruit trees.`,
  ).join("\n\n");
}

async function bookmark(
  userId = "local",
  text = paragraphs("hedgerows", 200),
  extra = {},
) {
  const source = await saveSource(
    { DB: db },
    {
      kind: "bookmark",
      title: "Why hedgerows matter",
      url: `https://example.org/${crypto.randomUUID()}`,
      notes: "",
      tags: ["ecology"],
      project: "garden",
      article: {
        detected: true,
        markdown: text,
        text,
        truncated: false,
        wordCount: 2000,
        pageWordCount: 2000,
        extractor: "defuddle",
        published: null,
        siteName: null,
        canonicalUrl: null,
        leadImage: null,
        description: null,
        language: null,
      },
      ...extra,
    },
    { userId, agent: "vitest", client: "test", session: null },
  );
  await enrichSource(bindings, userId, source.sourceId);
  return source.sourceId;
}

async function ledger() {
  const { results } = await db
    .prepare(
      `SELECT user_id AS userId, source_id AS sourceId, chunk, mutation_id AS mutationId
         FROM source_vector_pending ORDER BY source_id, chunk`,
    )
    .all<{
      userId: string;
      sourceId: string;
      chunk: number;
      mutationId: string | null;
    }>();
  return results;
}

async function passageCount(sourceId: string) {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM search_docs WHERE concept_id = ? AND doc_key LIKE '%#%'",
    )
    .bind(sourceId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function drain() {
  let delivered = 0;
  for (;;) {
    const report = await maintainSourceVectors(bindings);
    delivered += report.delivered;
    if (!report.delivered && !report.failed) return delivered;
  }
}

const filters = {
  query: "places where bees can shelter",
  concepts: ["source" as const],
  userId: "local",
};

beforeEach(() => {
  vectors.clear();
  run.mockReset().mockImplementation(async (model: string) =>
    model === SUMMARY_MODEL.id
      ? {
          response: JSON.stringify({
            summary: "Hedgerows shelter pollinators.",
            concepts: ["hedgerow ecology"],
            tags: [],
          }),
          usage: { prompt_tokens: 3000, completion_tokens: 100 },
        }
      : { data: [embedding] },
  );
  upsert.mockReset().mockImplementation(async (rows) => {
    for (const row of rows) vectors.set(row.id, row);
    return { mutationId: crypto.randomUUID() };
  });
  deleteByIds.mockReset().mockImplementation(async (ids) => {
    for (const id of ids) vectors.delete(id);
    return { mutationId: crypto.randomUUID() };
  });
  query.mockReset().mockImplementation(async (_vector, options) => {
    const keys = (options?.filter?.docKey as { $in?: string[] } | undefined)
      ?.$in;
    const matches = [...vectors.values()]
      .filter(
        (row) =>
          row.namespace === options?.namespace &&
          (!keys || keys.includes(String(row.metadata?.docKey))),
      )
      .map((row) => ({
        id: row.id,
        namespace: row.namespace,
        metadata: row.metadata,
        score: 0.9,
      }));
    return { matches, count: matches.length };
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const table of [
    "search_docs",
    "source_vector_pending",
    "source_enrichments",
    "source_articles",
    "source_revision_assets",
    "source_revisions",
    "sources",
    "asset_drain_state",
    "embedding_usage_daily",
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
  await db
    .prepare("DELETE FROM users WHERE user_id IN ('usr_alice', 'usr_bob')")
    .run();
});

describe("bookmark passage vectors", () => {
  it("meters each passage, parks a spent owner's until the next UTC day, and falls back at search", async () => {
    const sourceId = await bookmark();
    const passages = await passageCount(sourceId);
    await db
      .prepare(`INSERT INTO embedding_usage_daily (user_id, day, kind, calls, input_bytes)
        VALUES ('local', date('now'), 'query', 1, 100)`)
      .run();
    run.mockClear();
    const spent = { ...bindings, VALISE_EMBEDDING_DAILY_BYTES: "100" };
    const parked = await maintainSourceVectors(spent);
    expect(parked).toMatchObject({ delivered: 0, failed: 0 });
    expect("budgetDeferred" in parked && parked.budgetDeferred).toBeGreaterThan(
      0,
    );
    expect(run).not.toHaveBeenCalled();
    expect(
      (
        await db
          .prepare(`SELECT DISTINCT error_code, attempts,
            next_attempt_at = unixepoch(date('now', '+1 day')) AS tomorrow
            FROM source_vector_pending WHERE error_code IS NOT NULL`)
          .all()
      ).results,
    ).toEqual([{ error_code: "daily_budget", attempts: 0, tomorrow: 1 }]);
    await expect(sourceVectorCandidates(spent, filters)).rejects.toThrow(
      "daily embedding budget reached",
    );

    await db.prepare("DELETE FROM embedding_usage_daily").run();
    await db
      .prepare("UPDATE source_vector_pending SET next_attempt_at = 0")
      .run();
    expect(await drain()).toBe(passages);
    expect(
      await db
        .prepare(`SELECT calls, failures FROM embedding_usage_daily
          WHERE user_id = 'local' AND kind = 'source' AND day = date('now')`)
        .first(),
    ).toEqual({ calls: passages, failures: 0 });
  });

  it("queues one vector per passage with the enrichment and delivers them to the source partition", async () => {
    const sourceId = await bookmark();
    const passages = await passageCount(sourceId);
    expect(passages).toBeGreaterThan(1);
    expect(await ledger()).toHaveLength(passages);
    expect(await drain()).toBe(passages);
    expect(vectors.size).toBe(passages);
    for (const vector of vectors.values()) {
      expect(vector.namespace).toMatch(/^s:/);
      expect(vector.metadata).toMatchObject({ docKey: `source:${sourceId}` });
    }
    // Delivered rows rest for a day; nothing is redone on the next tick.
    expect(await maintainSourceVectors(bindings)).toMatchObject({
      delivered: 0,
      failed: 0,
    });

    const candidates = await sourceVectorCandidates(bindings, filters);
    expect(candidates).toHaveLength(passages);
    expect(candidates[0]).toMatchObject({
      concept: "source",
      conceptId: sourceId,
      docKey: expect.stringMatching(new RegExp(`^source:${sourceId}#\\d+$`)),
      body: expect.stringContaining("hedgerows"),
    });
    // A key that merges with the lexical passage row for the same passage.
    const lexical = await db
      .prepare("SELECT doc_key FROM search_docs WHERE doc_key = ?")
      .bind(candidates[0].docKey)
      .first();
    expect(lexical).not.toBeNull();
    expect(
      await sourceVectorCandidates(bindings, { ...filters, project: "other" }),
    ).toEqual([]);
    expect(
      await sourceVectorCandidates(bindings, { ...filters, tags: ["other"] }),
    ).toEqual([]);
    expect(
      await sourceVectorCandidates(bindings, {
        ...filters,
        concepts: ["asset"],
      }),
    ).toEqual([]);
  });

  it("finds a bookmark by meaning in hybrid search when no word matches", async () => {
    const sourceId = await bookmark();
    await drain();
    // The double picks the first candidate; this proves the union, not ranking.
    const answers = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [
        `D${String(i).padStart(2, "0")}`,
        { noul: i === 0 ? 0.99 : 0.1 },
      ]),
    );
    vi.stubGlobal("fetch", async () => Response.json({ answers }));
    const { hits, rerank } = await rerankedSearch(bindings, "hybrid", {
      ...filters,
      query: "zzqx unrelated wording",
    });
    expect(rerank?.fallback).toBeUndefined();
    expect(hits[0]).toMatchObject({ concept: "source", conceptId: sourceId });
    // The author filter's source ids hold on the key-scoped vector path.
    expect(
      await sourceVectorCandidates(bindings, {
        ...filters,
        sourceIds: [sourceId],
      }),
    ).not.toEqual([]);
    expect(
      await sourceVectorCandidates(bindings, {
        ...filters,
        sourceIds: ["src_someone_else"],
      }),
    ).toEqual([]);
  });

  it("deletes vectors on archive, restores them, and deletes them with the source", async () => {
    const sourceId = await bookmark();
    const passages = await passageCount(sourceId);
    await drain();
    expect(vectors.size).toBe(passages);

    await setSourceArchived(db, "local", sourceId, true);
    // Stale hints are refused before the drain catches up.
    expect(await sourceVectorCandidates(bindings, filters)).toEqual([]);
    await drain();
    expect(vectors.size).toBe(0);

    await setSourceArchived(db, "local", sourceId, false);
    await drain();
    expect(vectors.size).toBe(passages);
    expect(await sourceVectorCandidates(bindings, filters)).toHaveLength(
      passages,
    );

    await deleteSource(db, "local", sourceId);
    await drain();
    expect(vectors.size).toBe(0);
    // The ledger keeps the delete targets after the source is gone.
    expect(await ledger()).toHaveLength(passages);
  });

  it("replaces the previous enrichment's vectors when a newer one arrives", async () => {
    const sourceId = await bookmark();
    await drain();
    const before = new Set(vectors.keys());
    await enrichSource(bindings, "local", sourceId);
    await drain();
    expect(vectors.size).toBe(before.size);
    for (const id of vectors.keys()) expect(before.has(id)).toBe(false);
  });

  it("enqueues enrichments written before the ledger, two a tick, and through the recovery backfill", async () => {
    const quiet = { ...bindings, VALISE_VECTOR_NAMESPACE: undefined };
    const first = await saveAndEnrich(quiet, paragraphs("orchards", 120));
    const second = await saveAndEnrich(quiet, paragraphs("meadows", 120));
    expect(await ledger()).toEqual([]);
    await maintainSourceVectors(bindings);
    const queued = new Set((await ledger()).map((row) => row.sourceId));
    expect(queued).toEqual(new Set([first, second]));

    await db.prepare("DELETE FROM source_vector_pending").run();
    const page = await backfillSourceVectors(bindings);
    expect(page).toMatchObject({ outputs: 2, done: true, delivered: false });
    expect(page.queuedChunks).toBe(
      (await passageCount(first)) + (await passageCount(second)),
    );
    expect((await backfillSourceVectors(bindings)).queuedChunks).toBe(0);
  });

  it("keeps two owners' bookmark vectors apart", async () => {
    await db.batch(
      ["usr_alice", "usr_bob"].map((userId) =>
        db
          .prepare(
            `INSERT INTO users (user_id, email, display_name, role, plan, email_verified, created_at)
             VALUES (?, ?, ?, 'member', 'free', 1, 1)`,
          )
          .bind(userId, `${userId}@example.test`, userId),
      ),
    );
    const alice = await bookmark("usr_alice");
    const bob = await bookmark("usr_bob");
    await drain();
    const namespaces = new Set(
      [...vectors.values()].map((vector) => vector.namespace),
    );
    expect(namespaces.size).toBe(2);
    const forAlice = await sourceVectorCandidates(bindings, {
      ...filters,
      userId: "usr_alice",
    });
    expect(forAlice.length).toBeGreaterThan(0);
    expect(forAlice.every((hit) => hit.conceptId === alice)).toBe(true);
    const forBob = await sourceVectorCandidates(bindings, {
      ...filters,
      userId: "usr_bob",
    });
    expect(forBob.every((hit) => hit.conceptId === bob)).toBe(true);
  });

  it("searches a library past 256 bookmarks without a key filter and still applies every filter", async () => {
    const sourceId = await bookmark();
    await drain();
    // 257 more eligible bookmarks, copied in SQL rather than saved one by one.
    const { results: columns } = await db
      .prepare("SELECT name FROM pragma_table_info('sources')")
      .all<{ name: string }>();
    const list = columns.map((column) => column.name);
    const select = list
      .map((name) =>
        name === "source_id" ? "'src_bulk_' || n.value AS source_id" : name,
      )
      .join(", ");
    await db.batch([
      db
        .prepare(
          `INSERT INTO sources (${list.join(", ")})
           SELECT ${select} FROM sources, json_each(?) n WHERE source_id = ?`,
        )
        .bind(
          JSON.stringify(Array.from({ length: 257 }, (_, i) => i)),
          sourceId,
        ),
      db.prepare(
        `INSERT INTO search_docs (doc_key, user_id, concept, concept_id, project, title, body, tags, updated_at)
         SELECT 'source:' || source_id, user_id, 'source', source_id, project, title, '', 'ecology', updated_at
           FROM sources WHERE source_id LIKE 'src_bulk_%'`,
      ),
      db.prepare(
        `INSERT INTO source_enrichments (enrichment_id, user_id, source_id, revision, state, passages_json, created_at)
         SELECT 'sen_bulk_' || source_id, user_id, source_id, 1, 'ready', '{"passages":[]}', 1
           FROM sources WHERE source_id LIKE 'src_bulk_%'`,
      ),
    ]);
    const wide = await sourceVectorCandidates(bindings, filters);
    expect(query.mock.calls.at(-1)?.[1]?.filter).toBeUndefined();
    expect(wide.length).toBeGreaterThan(0);
    expect(wide.every((hit) => hit.conceptId === sourceId)).toBe(true);
    // Filters still hold on the unscoped path, after the query.
    await db
      .prepare("UPDATE search_docs SET project = 'moved' WHERE concept_id = ?")
      .bind(sourceId)
      .run();
    expect(await sourceVectorCandidates(bindings, filters)).toHaveLength(
      wide.length,
    );
    expect(
      await sourceVectorCandidates(bindings, { ...filters, project: "garden" }),
    ).toEqual([]);
    // 257 ids still overflow the key scope, so this exercises the filter
    // applied after the unscoped query: only the excluded bookmark has vectors.
    const bulk = Array.from({ length: 257 }, (_, i) => `src_bulk_${i}`);
    expect(
      await sourceVectorCandidates(bindings, { ...filters, sourceIds: bulk }),
    ).toEqual([]);
    expect(query.mock.calls.at(-1)?.[1]?.filter).toBeUndefined();
  });
});

async function saveAndEnrich(
  enrichEnv: Omit<typeof bindings, "VALISE_VECTOR_NAMESPACE"> & {
    VALISE_VECTOR_NAMESPACE?: string;
  },
  text: string,
) {
  const source = await saveSource(
    { DB: db },
    {
      kind: "bookmark",
      title: "Saved",
      url: `https://example.org/${crypto.randomUUID()}`,
      notes: "",
      tags: [],
      article: {
        detected: true,
        markdown: text,
        text,
        truncated: false,
        wordCount: 1000,
        pageWordCount: 1000,
        extractor: "defuddle",
        published: null,
        siteName: null,
        canonicalUrl: null,
        leadImage: null,
        description: null,
        language: null,
      },
    },
    { userId: "local", agent: "vitest", client: "test", session: null },
  );
  await enrichSource(enrichEnv, "local", source.sourceId);
  return source.sourceId;
}
