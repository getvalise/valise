import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveMemory, editMemory, saveMemory } from "~/concepts/memories";
import {
  backfillVectors,
  drainVectors,
  maintainVectors,
  VECTOR_BACKLOG_CAP,
  vectorBackfillKey,
  vectorBacklogCap,
  vectorDeferral,
  vectorStatus,
} from "~/search/vector-outbox";

// Real workerd/D1 and application writes. Only the model and index are doubles.
const db = env.DB;
const namespace = "admission-workspace";
const embedding = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
const upsert = vi.fn<Vectorize["upsert"]>();
const deleteByIds = vi.fn<Vectorize["deleteByIds"]>();
const bindings = {
  DB: db,
  AI: env.AI,
  VECTOR_INDEX: { upsert, deleteByIds },
  VALISE_VECTOR_NAMESPACE: namespace,
  VALISE_VECTOR_BACKLOG_CAP: "3",
};
const as = (userId: string) => ({
  userId,
  agent: "test",
  client: "test",
  session: null,
});

beforeEach(() => {
  let mutation = 0;
  vi.spyOn(env.AI, "run").mockResolvedValue({ data: [embedding] });
  upsert
    .mockReset()
    .mockImplementation(async () => ({ mutationId: String(++mutation) }));
  deleteByIds
    .mockReset()
    .mockImplementation(async () => ({ mutationId: String(++mutation) }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.batch([
    db.prepare("DELETE FROM vector_deferred"),
    db.prepare("DELETE FROM vector_pending"),
    db.prepare("DELETE FROM vector_snapshots"),
    db.prepare("DELETE FROM vector_drain_state"),
    db.prepare("DELETE FROM vector_backfills"),
    db.prepare("DELETE FROM search_docs"),
    db.prepare("DELETE FROM memory_links"),
    db.prepare("DELETE FROM memory_revisions"),
    db.prepare("DELETE FROM memories"),
  ]);
});

async function save(userId: string, title: string, env = bindings) {
  const saved = await saveMemory(
    env,
    { type: "fact", title, body: `${title} body`, tags: [] },
    as(userId),
  );
  return saved.id.slice("memory:".length);
}
async function outstanding(userId: string) {
  const row = await db
    .prepare(`SELECT COUNT(DISTINCT memory_id) AS n FROM vector_pending
      WHERE namespace = ? AND user_id = ? AND completed_epoch < epoch AND target != 'delete'`)
    .bind(namespace, userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
async function deferred(userId?: string) {
  const { results } = await db
    .prepare(
      `SELECT memory_id FROM vector_deferred WHERE namespace = ?
      ${userId ? "AND user_id = ?" : ""} ORDER BY deferred_at, memory_id`,
    )
    .bind(...(userId ? [namespace, userId] : [namespace]))
    .all<{ memory_id: string }>();
  return results.map((row) => row.memory_id);
}
function promotionOf(report: object) {
  return "promotion" in report ? report.promotion : undefined;
}
async function published(id: string) {
  return db
    .prepare("SELECT 1 FROM search_docs WHERE doc_key = ?")
    .bind(`memory:${id}`)
    .first();
}

describe("embedding backlog admission", () => {
  it("reads a configured cap and falls back to the default", () => {
    expect(vectorBacklogCap({ VALISE_VECTOR_BACKLOG_CAP: "3" })).toBe(3);
    for (const value of [undefined, "", "0", "-4", "2.5", "lots"])
      expect(vectorBacklogCap({ VALISE_VECTOR_BACKLOG_CAP: value })).toBe(
        VECTOR_BACKLOG_CAP,
      );
  });

  it("commits and publishes the write at the cap, deferring only its embedding", async () => {
    const admitted = [];
    for (const n of [1, 2, 3]) admitted.push(await save("alice", `a${n}`));
    expect(await outstanding("alice")).toBe(3);
    for (const id of admitted)
      expect(await vectorDeferral(bindings, "alice", id)).toBeNull();

    const late = await save("alice", "a4");
    expect(await published(late)).not.toBeNull();
    expect(await outstanding("alice")).toBe(3);
    expect(await deferred()).toEqual([late]);
    expect(await vectorDeferral(bindings, "alice", late)).toEqual({
      state: "deferred",
      outstanding: 3,
      cap: 3,
    });
    // The owner, not the caller, scopes the answer.
    expect(await vectorDeferral(bindings, "bob", late)).toBeNull();
    expect(await vectorStatus(db, namespace)).toMatchObject({ deferred: 1 });
  });

  it("coalesces repeated edits into one queued or deferred entry", async () => {
    const [a] = [await save("alice", "a1")];
    await save("alice", "a2");
    await save("alice", "a3");
    const late = await save("alice", "a4");

    // A memory already waiting takes its new generation at the cap.
    await editMemory(bindings, a, { body: "a1 again" }, as("alice"));
    await editMemory(bindings, a, { body: "a1 thrice" }, as("alice"));
    expect(await outstanding("alice")).toBe(3);
    expect(await vectorDeferral(bindings, "alice", a)).toBeNull();

    // A deferred memory stays one row, keeping its place in line.
    const before = await db
      .prepare("SELECT deferred_at FROM vector_deferred WHERE memory_id = ?")
      .bind(late)
      .first();
    await editMemory(bindings, late, { body: "a4 again" }, as("alice"));
    await editMemory(bindings, late, { body: "a4 thrice" }, as("alice"));
    expect(await deferred()).toEqual([late]);
    expect(
      await db
        .prepare("SELECT deferred_at FROM vector_deferred WHERE memory_id = ?")
        .bind(late)
        .first(),
    ).toEqual(before);
    expect(
      (
        await db
          .prepare(
            "SELECT COUNT(*) AS n FROM vector_pending WHERE memory_id = ?",
          )
          .bind(late)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });

  it("admits archives and repair at the cap", async () => {
    const ids = [];
    for (const n of [1, 2, 3, 4]) ids.push(await save("alice", `a${n}`));
    const late = ids[3];

    expect(await archiveMemory(bindings, "alice", late)).toBe(true);
    expect(await deferred()).toEqual([]);
    expect(
      (
        await db
          .prepare(
            "SELECT DISTINCT target FROM vector_pending WHERE memory_id = ?",
          )
          .bind(late)
          .all()
      ).results,
    ).toEqual([{ target: "delete" }]);

    expect(await archiveMemory(bindings, "alice", ids[0])).toBe(true);
    expect(await outstanding("alice")).toBe(2);

    // Backfill is repair: it enqueues everything, cap or not.
    const extra = await save("alice", "a5", {
      ...bindings,
      VALISE_VECTOR_BACKLOG_CAP: "1",
    });
    expect(await deferred()).toEqual([extra]);
    await backfillVectors(bindings);
    expect(
      (
        await db
          .prepare(
            "SELECT COUNT(*) AS n FROM vector_pending WHERE memory_id = ?",
          )
          .bind(extra)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });

  it("keeps each tenant's cap independent", async () => {
    for (const n of [1, 2, 3, 4]) await save("alice", `a${n}`);
    const bob = [await save("bob", "b1"), await save("bob", "b2")];
    expect(await outstanding("bob")).toBe(2);
    expect(await deferred("bob")).toEqual([]);
    for (const id of bob)
      expect(await vectorDeferral(bindings, "bob", id)).toBeNull();
    expect(await deferred("alice")).toHaveLength(1);
  });

  it("never lets concurrent writers past the cap or lose a write", async () => {
    const ids = await Promise.all(
      Array.from({ length: 12 }, (_, n) => save("alice", `race ${n}`)),
    );
    expect(await outstanding("alice")).toBe(3);
    expect((await deferred("alice")).sort()).toHaveLength(9);
    for (const id of ids) expect(await published(id)).not.toBeNull();
    const queuedOrDeferred = await db
      .prepare(`SELECT COUNT(DISTINCT memory_id) AS n FROM (
        SELECT memory_id FROM vector_pending UNION ALL SELECT memory_id FROM vector_deferred)`)
      .first<{ n: number }>();
    expect(queuedOrDeferred?.n).toBe(12);
  });

  it("promotes deferred work as the backlog drains until nothing is left", async () => {
    const ids = [];
    for (let n = 0; n < 8; n++) ids.push(await save("alice", `a${n}`));
    ids.push(await save("bob", "b0"));
    expect(await deferred()).toHaveLength(5);
    // The deployment scan is done, so only promotion can enqueue the rest.
    await db
      .prepare(
        "INSERT INTO vector_backfills (namespace, cursor, done) VALUES (?, '', 1)",
      )
      .bind(vectorBackfillKey(namespace))
      .run();

    // Promotion uses the write's gate: no headroom, no promotion.
    expect(
      promotionOf(await maintainVectors({ ...bindings, AI: undefined }, false)),
    ).toBeUndefined();
    let report = await maintainVectors(bindings, false);
    expect(promotionOf(report)).toEqual({ promoted: 0, tenantsVisited: 1 });
    expect(report.delivered).toBe(4);
    expect(await outstanding("alice")).toBe(0);

    for (let pass = 0; pass < 5 && (await deferred()).length; pass++) {
      report = await maintainVectors(bindings, false);
      expect(await outstanding("alice")).toBeLessThanOrEqual(3);
    }
    expect(await deferred()).toEqual([]);
    await drainVectors(bindings, false);
    const delivered = await db
      .prepare(`SELECT COUNT(DISTINCT memory_id) AS n FROM vector_pending
        WHERE completed_epoch = epoch AND target = 'head'`)
      .first<{ n: number }>();
    expect(delivered?.n).toBe(ids.length);
  });

  it("counts the backlog through the partial index, not the retained history", async () => {
    const { results } = await db
      .prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM (
        SELECT DISTINCT o.memory_id FROM vector_pending o
        WHERE o.namespace = ? AND o.user_id = ?
          AND o.completed_epoch < o.epoch AND o.target != 'delete' LIMIT ?)`)
      .bind(namespace, "alice", 3)
      .all<{ detail: string }>();
    expect(results.map((row) => row.detail).join("\n")).toContain(
      "vector_pending_outstanding",
    );
  });
});
