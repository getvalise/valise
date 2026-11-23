import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trimActivity } from "~/concepts/activity";
import { archiveMemory, saveMemory } from "~/concepts/memories";
import {
  DAILY_BUDGET_ERROR,
  embeddingDailyBudget,
  recordEmbeddingFailure,
  reserveEmbedding,
  utf8Bytes,
} from "~/search/embedding-budget";
import { drainVectors, vectorStatus } from "~/search/vector-outbox";
import {
  DAILY_BUDGET_FALLBACK,
  memoryVectorCandidates,
  VectorSearchFailure,
} from "~/search/vectors";

// Real workerd/D1. Only the model and index are doubles.
const db = env.DB;
const namespace = "budget-workspace";
const embedding = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
const upsert = vi.fn<Vectorize["upsert"]>();
const deleteByIds = vi.fn<Vectorize["deleteByIds"]>();
const query = vi.fn<Vectorize["query"]>();
const metered = { DB: db };
const budgeted = (bytes: number) => ({
  DB: db,
  VALISE_EMBEDDING_DAILY_BYTES: String(bytes),
});
const as = (userId: string) => ({
  userId,
  agent: "test",
  client: "test",
  session: null,
});
let run: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  let mutation = 0;
  run = vi.spyOn(env.AI, "run").mockResolvedValue({ data: [embedding] });
  upsert
    .mockReset()
    .mockImplementation(async () => ({ mutationId: String(++mutation) }));
  deleteByIds
    .mockReset()
    .mockImplementation(async () => ({ mutationId: String(++mutation) }));
  query.mockReset().mockResolvedValue({ matches: [], count: 0 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.batch(
    [
      "embedding_usage_daily",
      "vector_deferred",
      "vector_pending",
      "vector_snapshots",
      "vector_drain_state",
      "search_docs",
      "memory_revisions",
      "memories",
    ].map((table) => db.prepare(`DELETE FROM ${table}`)),
  );
});

async function usage(userId: string) {
  const { results } = await db
    .prepare(`SELECT day = date('now') AS today, kind, calls, failures, input_bytes
      FROM embedding_usage_daily WHERE user_id = ? ORDER BY kind`)
    .bind(userId)
    .all();
  return results;
}
async function spend(userId: string, bytes: number, day = "date('now')") {
  await db
    .prepare(`INSERT INTO embedding_usage_daily (user_id, day, kind, calls, input_bytes)
      VALUES (?, ${day}, 'memory', 1, ?)`)
    .bind(userId, bytes)
    .run();
}

describe("daily embedding metering", () => {
  it("reads a configured budget and otherwise meters without one", () => {
    expect(embeddingDailyBudget({ VALISE_EMBEDDING_DAILY_BYTES: "4096" })).toBe(
      4096,
    );
    for (const value of [undefined, "", "0", "-1", "1.5", "lots"])
      expect(
        embeddingDailyBudget({ VALISE_EMBEDDING_DAILY_BYTES: value }),
      ).toBeNull();
    expect(utf8Bytes("é🌳")).toBe(6);
  });

  it("counts every call's input bytes and failures by kind, refusing nothing when unset", async () => {
    for (let n = 0; n < 3; n++)
      expect(
        await reserveEmbedding(metered, "alice", "memory", 1_000_000),
      ).toBe(true);
    expect(await reserveEmbedding(metered, "alice", "query", 12)).toBe(true);
    await recordEmbeddingFailure(db, "alice", "memory");
    expect(await usage("alice")).toEqual([
      {
        today: 1,
        kind: "memory",
        calls: 3,
        failures: 1,
        input_bytes: 3_000_000,
      },
      { today: 1, kind: "query", calls: 1, failures: 0, input_bytes: 12 },
    ]);
  });

  it("refuses once the owner's UTC day is spent, records nothing refused, and leaves others alone", async () => {
    const env = budgeted(100);
    expect(await reserveEmbedding(env, "alice", "memory", 60)).toBe(true);
    // Admitted while under: one call may overshoot by its own input.
    expect(await reserveEmbedding(env, "alice", "asset", 60)).toBe(true);
    expect(await reserveEmbedding(env, "alice", "query", 1)).toBe(false);
    expect(await usage("alice")).toEqual([
      { today: 1, kind: "asset", calls: 1, failures: 0, input_bytes: 60 },
      { today: 1, kind: "memory", calls: 1, failures: 0, input_bytes: 60 },
    ]);
    expect(await reserveEmbedding(env, "bob", "memory", 60)).toBe(true);
  });

  it("resets at the UTC day boundary", async () => {
    await spend("alice", 10_000, "date('now', '-1 day')");
    expect(await reserveEmbedding(budgeted(100), "alice", "memory", 10)).toBe(
      true,
    );
    await spend("bob", 100);
    expect(await reserveEmbedding(budgeted(100), "bob", "memory", 10)).toBe(
      false,
    );
  });

  it("admits exactly up to the budget under concurrent reservations", async () => {
    const admitted = await Promise.all(
      Array.from({ length: 20 }, () =>
        reserveEmbedding(budgeted(50), "alice", "query", 10),
      ),
    );
    expect(admitted.filter(Boolean)).toHaveLength(5);
    expect(await usage("alice")).toEqual([
      { today: 1, kind: "query", calls: 5, failures: 0, input_bytes: 50 },
    ]);
  });

  it("trims usage older than ninety days nightly", async () => {
    await spend("alice", 1, "date('now', '-91 days')");
    await spend("bob", 1, "date('now', '-89 days')");
    expect((await trimActivity(env)).embeddingUsage).toBe(1);
    expect(
      (await db.prepare("SELECT user_id FROM embedding_usage_daily").all())
        .results,
    ).toEqual([{ user_id: "bob" }]);
  });
});

describe("daily budget in the memory drain", () => {
  const delivery = (budget?: number) => ({
    DB: db,
    AI: env.AI,
    VECTOR_INDEX: { upsert, deleteByIds },
    VALISE_VECTOR_NAMESPACE: namespace,
    ...(budget ? { VALISE_EMBEDDING_DAILY_BYTES: String(budget) } : {}),
  });

  it("moves a spent owner's jobs to the next UTC day while others and deletes proceed", async () => {
    const save = (userId: string, title: string) =>
      saveMemory(
        delivery(),
        { type: "fact", title, body: `${title} body`, tags: [] },
        as(userId),
      );
    const alice = await save("alice", "Alice note");
    await save("bob", "Bob note");
    await spend("alice", 5_000);

    const report = await drainVectors(delivery(5_000), false);
    expect(report).toMatchObject({
      delivered: 1,
      attemptedFailed: 0,
      budgetDeferred: 1,
    });
    expect(run).toHaveBeenCalledTimes(1);
    const parked = await db
      .prepare(`SELECT error_code, attempts, completed_epoch < epoch AS pending,
        next_attempt_at = unixepoch(date('now', '+1 day')) AS tomorrow
        FROM vector_pending WHERE user_id = 'alice'`)
      .first();
    expect(parked).toEqual({
      error_code: DAILY_BUDGET_ERROR,
      attempts: 0,
      pending: 1,
      tomorrow: 1,
    });
    expect(await vectorStatus(db, namespace)).toMatchObject({
      budgetDeferred: 1,
      failed: 0,
    });
    // Not due again today: a spent owner takes no drain slot from others.
    expect(await drainVectors(delivery(5_000), false)).toMatchObject({
      delivered: 0,
      budgetDeferred: 0,
    });

    // A delete needs no inference allowance.
    await archiveMemory(delivery(), "alice", alice.id.slice("memory:".length));
    expect(await drainVectors(delivery(5_000), false)).toMatchObject({
      delivered: 1,
      budgetDeferred: 0,
    });
    expect(deleteByIds).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("meters each delivery's input and its provider failures", async () => {
    await saveMemory(
      delivery(),
      { type: "fact", title: "Metered", body: "é body", tags: [] },
      as("alice"),
    );
    run.mockRejectedValueOnce(new Error("provider down"));
    expect(await drainVectors(delivery(), false)).toMatchObject({
      attemptedFailed: 1,
    });
    await db.prepare("UPDATE vector_pending SET next_attempt_at = 0").run();
    expect(await drainVectors(delivery(), false)).toMatchObject({
      delivered: 1,
    });
    const bytes = utf8Bytes("Metered\n\né body");
    expect(await usage("alice")).toEqual([
      {
        today: 1,
        kind: "memory",
        calls: 2,
        failures: 1,
        input_bytes: 2 * bytes,
      },
    ]);
  });
});

describe("daily budget at search time", () => {
  const searching = (budget?: number) => ({
    DB: db,
    AI: env.AI,
    VECTOR_INDEX: { query },
    VALISE_VECTOR_NAMESPACE: namespace,
    ...(budget ? { VALISE_EMBEDDING_DAILY_BYTES: String(budget) } : {}),
  });

  it("meters query embeddings and falls back to lexical once spent", async () => {
    await memoryVectorCandidates(searching(), {
      query: "orchard water",
      userId: "alice",
    });
    expect(await usage("alice")).toEqual([
      {
        today: 1,
        kind: "query",
        calls: 1,
        failures: 0,
        input_bytes: utf8Bytes("orchard water"),
      },
    ]);
    await spend("alice", 100);
    run.mockClear();
    const refused = memoryVectorCandidates(searching(100), {
      query: "orchard water",
      userId: "alice",
    });
    await expect(refused).rejects.toBeInstanceOf(VectorSearchFailure);
    await expect(refused).rejects.toThrow(DAILY_BUDGET_FALLBACK);
    expect(run).not.toHaveBeenCalled();
  });
});
