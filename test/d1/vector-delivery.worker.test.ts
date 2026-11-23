import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveMemory, editMemory, saveMemory } from "~/concepts/memories";
import {
  assertPersonMemoryLink,
  changeMemoryLink,
} from "~/concepts/memory-links";
import { search } from "~/search/query";
import { reindex } from "~/search/reindex";
import {
  backfillVectors,
  drainVectors,
  maintainVectors,
  VECTOR_DRAIN_CONCURRENCY,
  VECTOR_DRAIN_LIMIT,
  VECTOR_LEASE_SECONDS,
  VECTOR_OWNER_BACKFILL_LIMIT,
  VECTOR_TENANT_VISIT_LIMIT,
  vectorBackfillKey,
  vectorStatus,
} from "~/search/vector-outbox";
import {
  memoryVectorCandidates,
  tenantVectorNamespace,
} from "~/search/vectors";

// Real workerd/D1 and application writes. Only the unavailable model/index are doubles.
const db = env.DB;
const namespace = "delivery-workspace";
const provenance = {
  userId: "local",
  agent: "test",
  client: "test",
  session: null,
};
const embedding = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
const vectors = new Map<string, VectorizeVector>();
const upsert = vi.fn<Vectorize["upsert"]>();
const deleteByIds = vi.fn<Vectorize["deleteByIds"]>();
const query = vi.fn<Vectorize["query"]>();
const bindings = {
  DB: db,
  AI: env.AI,
  VECTOR_INDEX: { upsert, deleteByIds, query },
  VALISE_VECTOR_NAMESPACE: namespace,
};
let mutation = 0;
let tenantNamespace: string;
beforeEach(async () => {
  tenantNamespace = await tenantVectorNamespace(namespace, "local");
  vectors.clear();
  mutation = 0;
  vi.spyOn(env.AI, "run").mockResolvedValue({ data: [embedding] });
  upsert.mockReset().mockImplementation(async (rows) => {
    for (const row of rows) vectors.set(row.id, row);
    return { mutationId: String(++mutation) };
  });
  deleteByIds.mockReset().mockImplementation(async (ids) => {
    for (const id of ids) vectors.delete(id);
    return { mutationId: String(++mutation) };
  });
  query.mockReset().mockImplementation(async (_values, options) => {
    const matches = [...vectors.values()]
      .filter((v) => v.namespace === options?.namespace)
      .map((v) => ({
        id: v.id,
        namespace: v.namespace,
        metadata: v.metadata,
        score: 0.9,
      }));
    return { matches, count: matches.length };
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.batch([
    db.prepare("DELETE FROM vector_drain_state"),
    db.prepare("DELETE FROM vector_backfills"),
    db.prepare("DELETE FROM search_docs"),
    db.prepare("DELETE FROM memory_links"),
    db.prepare("DELETE FROM memory_revisions"),
    db.prepare("DELETE FROM memories"),
  ]);
});
async function add(body = "durable recovery evidence") {
  return saveMemory(
    bindings,
    { type: "fact", title: "Delivery", body, project: "valise", tags: ["ops"] },
    provenance,
  );
}
async function addForUser(userId: string, body = userId) {
  return saveMemory(
    bindings,
    { type: "fact", title: userId, body, tags: [] },
    { ...provenance, userId },
  );
}
async function edit(id: string, body: string) {
  return editMemory(
    bindings,
    id.slice(7),
    { type: "fact", title: "Delivery", body, project: "moved", tags: ["new"] },
    provenance,
  );
}
async function jobs() {
  return (
    await db
      .prepare(
        "SELECT generation, target, epoch, completed_epoch, attempts, next_attempt_at, lease_token, error_code FROM vector_pending ORDER BY generation",
      )
      .all()
  ).results;
}

describe("fair tenant vector scheduling", () => {
  it("uses owner hints for scheduling, never as delivery or hydration authority", async () => {
    const memory = await add();
    await db
      .prepare("UPDATE vector_pending SET user_id = 'foreign-hint'")
      .run();
    expect(await drainVectors(bindings)).toMatchObject({
      delivered: 1,
      tenantsVisited: 1,
    });
    expect([...vectors.values()].map((v) => v.namespace)).toEqual([
      tenantNamespace,
    ]);
    expect(
      (
        await memoryVectorCandidates(bindings, {
          userId: "local",
          query: "meaning",
        })
      ).map((p) => p.docKey),
    ).toEqual([memory.id]);
    expect(
      await memoryVectorCandidates(bindings, {
        userId: "foreign-hint",
        query: "meaning",
      }),
    ).toEqual([]);
  });

  it("gives quiet tenants a turn before consuming an older bulk import", async () => {
    const bulk = [];
    for (let i = 0; i < 45; i++)
      bulk.push(await addForUser("a-bulk", String(i)));
    const quiet = [await addForUser("m-quiet"), await addForUser("z-quiet")];
    // All bulk jobs outrank the quiet jobs in the old global due ordering.
    await db
      .prepare(
        "UPDATE vector_pending SET next_attempt_at = 1 WHERE user_id != 'a-bulk'",
      )
      .run();
    const oldPage = await db
      .prepare(
        "SELECT memory_id FROM vector_pending ORDER BY next_attempt_at, memory_id, generation LIMIT 20",
      )
      .all<{ memory_id: string }>();
    expect(
      oldPage.results.some((row) =>
        quiet.some((memory) => memory.id === `memory:${row.memory_id}`),
      ),
    ).toBe(false);
    const prepared = vi.spyOn(db, "prepare");
    expect(await drainVectors(bindings)).toMatchObject({
      delivered: VECTOR_DRAIN_LIMIT,
      tenantsVisited: 3,
    });
    const sent = upsert.mock.calls.flatMap(([rows]) =>
      rows.map((row) => row.metadata?.docKey),
    );
    for (const memory of quiet)
      expect(sent.slice(0, VECTOR_DRAIN_CONCURRENCY)).toContain(memory.id);
    expect(bulk.some((memory) => memory.id === sent[0])).toBe(true);
    expect(sent).toHaveLength(VECTOR_DRAIN_LIMIT);
    expect(env.AI.run).toHaveBeenCalledTimes(VECTOR_DRAIN_LIMIT);
    expect(
      sent.filter((id) => quiet.some((row) => row.id === id)),
    ).toHaveLength(2);
    const discoverySql = prepared.mock.calls.find(([sql]) =>
      sql.includes("WITH RECURSIVE tenants"),
    )?.[0];
    if (!discoverySql) throw new Error("tenant discovery query missing");
    const discoveryPlan = await db
      .prepare(`EXPLAIN QUERY PLAN ${discoverySql}`)
      .bind(namespace, "", namespace, VECTOR_TENANT_VISIT_LIMIT)
      .all<{ detail: string }>();
    expect(
      discoveryPlan.results.filter((row) =>
        row.detail.includes(
          "SEARCH vector_pending USING COVERING INDEX vector_pending_tenant_due",
        ),
      ).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      discoveryPlan.results.some((row) =>
        row.detail.includes("SCAN vector_pending"),
      ),
    ).toBe(false);
  });

  it("persists rotation beyond a full tenant page despite continuing bulk arrivals", async () => {
    for (let i = 0; i < 45; i++) await addForUser("a-bulk", String(i));
    const quiet: Awaited<ReturnType<typeof addForUser>>[] = [];
    for (let i = 0; i < VECTOR_TENANT_VISIT_LIMIT + 5; i++)
      quiet.push(await addForUser(`quiet-${String(i).padStart(2, "0")}`));
    const first = await drainVectors(bindings);
    expect(first).toMatchObject({
      delivered: 20,
      tenantsVisited: VECTOR_TENANT_VISIT_LIMIT,
    });
    const cursor = await db
      .prepare(
        "SELECT after_user_id FROM vector_drain_state WHERE namespace = ?",
      )
      .bind(namespace)
      .first();
    expect(cursor).toMatchObject({ after_user_id: "quiet-18" });
    expect(
      [...vectors.values()].some(
        (v) => v.metadata?.docKey === quiet.at(-1)?.id,
      ),
    ).toBe(false);
    for (let i = 0; i < 5; i++) await addForUser("a-bulk", `new-${i}`);
    expect(await drainVectors(bindings)).toMatchObject({
      delivered: 20,
      tenantsVisited: VECTOR_TENANT_VISIT_LIMIT,
    });
    for (const memory of quiet)
      expect(
        [...vectors.values()].some((v) => v.metadata?.docKey === memory.id),
      ).toBe(true);
    expect(env.AI.run).toHaveBeenCalledTimes(40);
  });

  it("redistributes unused turns without disturbing leased or backed-off jobs", async () => {
    for (let i = 0; i < 25; i++) await addForUser("a-bulk", String(i));
    const leased = await addForUser("m-leased");
    const backedOff = await addForUser("n-backoff");
    const quiet = await addForUser("z-quiet");
    await db.batch([
      db
        .prepare(
          "UPDATE vector_pending SET lease_token = 'existing', lease_until = unixepoch() + 120 WHERE memory_id = ?",
        )
        .bind(leased.id.slice(7)),
      db
        .prepare(
          "UPDATE vector_pending SET attempts = 2, next_attempt_at = unixepoch() + 3600, error_code = 'embedding_failure' WHERE memory_id = ?",
        )
        .bind(backedOff.id.slice(7)),
    ]);
    expect(await drainVectors(bindings)).toMatchObject({
      delivered: 20,
      tenantsVisited: 4,
    });
    const sent = upsert.mock.calls.flatMap(([rows]) =>
      rows.map((row) => row.metadata?.docKey),
    );
    expect(sent).toContain(quiet.id);
    expect(sent).not.toContain(leased.id);
    expect(sent).not.toContain(backedOff.id);
    expect(
      await db
        .prepare(
          "SELECT lease_token, completed_epoch FROM vector_pending WHERE memory_id = ?",
        )
        .bind(leased.id.slice(7))
        .first(),
    ).toMatchObject({ lease_token: "existing", completed_epoch: 0 });
    expect(
      await db
        .prepare(
          "SELECT attempts, error_code FROM vector_pending WHERE memory_id = ?",
        )
        .bind(backedOff.id.slice(7))
        .first(),
    ).toMatchObject({ attempts: 2, error_code: "embedding_failure" });
  });

  it("retries a quiet tenant and deletes its head while bulk work remains", async () => {
    for (let i = 0; i < 45; i++) await addForUser("a-bulk", String(i));
    const quiet = await addForUser("z-quiet");
    const normal = upsert.getMockImplementation();
    upsert.mockImplementation(async (rows) => {
      if (rows.some((row) => row.metadata?.docKey === quiet.id))
        throw new Error("quiet retry");
      if (!normal) throw new Error("fixture missing");
      return normal(rows);
    });
    expect(await drainVectors(bindings)).toMatchObject({
      delivered: 19,
      attemptedFailed: 1,
    });
    expect(
      await db
        .prepare(
          "SELECT attempts, completed_epoch FROM vector_pending WHERE memory_id = ?",
        )
        .bind(quiet.id.slice(7))
        .first(),
    ).toMatchObject({ attempts: 1, completed_epoch: 0 });
    await db
      .prepare(
        "UPDATE vector_pending SET next_attempt_at = 0 WHERE memory_id = ?",
      )
      .bind(quiet.id.slice(7))
      .run();
    if (!normal) throw new Error("fixture missing");
    upsert.mockImplementation(normal);
    expect(await drainVectors(bindings)).toMatchObject({ delivered: 20 });
    expect(
      [...vectors.values()].some((v) => v.metadata?.docKey === quiet.id),
    ).toBe(true);
    await archiveMemory(bindings, "z-quiet", quiet.id.slice(7));
    const embeddings = vi.mocked(env.AI.run).mock.calls.length;
    expect(await drainVectors(bindings)).toMatchObject({
      delivered: 8,
      pending: 0,
    });
    expect(env.AI.run).toHaveBeenCalledTimes(embeddings + 7);
    expect(
      [...vectors.values()].some((v) => v.metadata?.docKey === quiet.id),
    ).toBe(false);
  });

  it("does not multiply inference through an overlapping drain invocation", async () => {
    for (let i = 0; i < 25; i++) await addForUser("a-bulk", String(i));
    let release = () => {};
    let enter = () => {};
    const started = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    upsert.mockImplementationOnce(async () => {
      enter();
      await gate;
      return { mutationId: "accepted" };
    });
    const first = drainVectors(bindings);
    await started;
    try {
      expect(await drainVectors(bindings)).toMatchObject({
        delivered: 0,
        attemptedFailed: 0,
        drainLeased: true,
      });
      expect(vi.mocked(env.AI.run).mock.calls.length).toBeLessThanOrEqual(
        VECTOR_DRAIN_CONCURRENCY,
      );
    } finally {
      release();
      await first;
    }
    expect(env.AI.run).toHaveBeenCalledTimes(VECTOR_DRAIN_LIMIT);
    expect(
      await db
        .prepare(
          "SELECT lease_token, lease_until FROM vector_drain_state WHERE namespace = ?",
        )
        .bind(namespace)
        .first(),
    ).toMatchObject({ lease_token: null, lease_until: 0 });
  });

  it.each(["claim", "retry", "acknowledgement"] as const)(
    "holds the pass reservation until sibling embeddings settle after a %s write failure",
    async (stage) => {
      const failing = await add("failing-wave-job");
      for (let i = 0; i < 7; i++) await add(`sibling-job-${i}`);
      await db
        .prepare(
          "UPDATE vector_pending SET next_attempt_at = 1 WHERE memory_id != ?",
        )
        .bind(failing.id.slice(7))
        .run();
      const condition =
        stage === "claim"
          ? "NEW.lease_token IS NOT NULL AND OLD.lease_token IS NULL"
          : stage === "retry"
            ? "NEW.attempts > OLD.attempts"
            : "NEW.mutation_id IS NOT NULL OR NEW.attempts > OLD.attempts";
      // Real SQLite failures, not a rejected provider double. In the ack case,
      // persistence of both acceptance and its retry fails.
      await db
        .prepare(`CREATE TRIGGER reject_wave_persistence BEFORE UPDATE ON vector_pending
        WHEN NEW.memory_id = '${failing.id.slice(7)}' AND (${condition})
        BEGIN SELECT RAISE(ABORT, 'test ${stage} write failure'); END`)
        .run();
      let release = () => {};
      let enter = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        enter = resolve;
      });
      let active = 0;
      let peak = 0;
      vi.mocked(env.AI.run).mockImplementation(async (_model, input) => {
        if (JSON.stringify(input).includes("failing-wave-job")) {
          if (stage === "retry") throw new Error("test embedding failure");
          return { data: [embedding] };
        }
        active++;
        peak = Math.max(peak, active);
        if (active === VECTOR_DRAIN_CONCURRENCY - 1) enter();
        try {
          await gate;
          return { data: [embedding] };
        } finally {
          active--;
        }
      });
      let settled = false;
      const first = drainVectors(bindings).then(
        (value) => {
          settled = true;
          return { value, error: null };
        },
        (error: unknown) => {
          settled = true;
          return { value: null, error };
        },
      );
      try {
        await started;
        // Flush the failed SQLite write before checking the reservation.
        await db.prepare("SELECT 1").first();
        expect(
          await db
            .prepare(
              "SELECT lease_token FROM vector_drain_state WHERE namespace = ?",
            )
            .bind(namespace)
            .first(),
        ).toMatchObject({ lease_token: expect.any(String) });
        expect(settled).toBe(false);
        expect(await drainVectors(bindings)).toMatchObject({
          drainLeased: true,
          delivered: 0,
        });
        expect(active).toBe(VECTOR_DRAIN_CONCURRENCY - 1);
        expect(peak).toBeLessThanOrEqual(VECTOR_DRAIN_CONCURRENCY);
        expect(env.AI.run).toHaveBeenCalledTimes(stage === "claim" ? 3 : 4);
      } finally {
        release();
        await first;
        await db.exec("DROP TRIGGER reject_wave_persistence");
      }
      const outcome = await first;
      expect(outcome.error).toBeInstanceOf(AggregateError);
      if (!(outcome.error instanceof AggregateError))
        throw new Error("persistence failure hidden");
      expect(
        outcome.error.errors.some(
          (error: unknown) =>
            error instanceof Error &&
            error.message.includes(`test ${stage} write failure`),
        ),
      ).toBe(true);
      expect(active).toBe(0);
      expect(
        await db
          .prepare(
            "SELECT lease_token, lease_until FROM vector_drain_state WHERE namespace = ?",
          )
          .bind(namespace)
          .first(),
      ).toMatchObject({ lease_token: null, lease_until: 0 });
      // No later wave ran. Unclaimed/uncertain work remains recoverable.
      expect(await vectorStatus(db, namespace)).toMatchObject({ pending: 5 });
      vi.mocked(env.AI.run).mockResolvedValue({ data: [embedding] });
      await db.prepare("UPDATE vector_pending SET lease_until = 0").run();
      expect(await drainVectors(bindings)).toMatchObject({
        delivered: 5,
        pending: 0,
      });
    },
  );

  it("resumes a crashed rotation and stops launching waves after losing its reservation", async () => {
    for (let i = 0; i < 25; i++) await addForUser("a-bulk", String(i));
    const quiet = await addForUser("z-quiet");
    await db
      .prepare(
        "INSERT INTO vector_drain_state(namespace, after_user_id, lease_token, lease_until) VALUES (?, 'a-bulk', 'crashed', unixepoch() + 120)",
      )
      .bind(namespace)
      .run();
    expect(await drainVectors(bindings)).toMatchObject({
      drainLeased: true,
      delivered: 0,
    });
    expect(env.AI.run).not.toHaveBeenCalled();
    await db.prepare("UPDATE vector_drain_state SET lease_until = 0").run();
    const normal = upsert.getMockImplementation();
    upsert.mockImplementationOnce(async (rows) => {
      await db
        .prepare(
          "UPDATE vector_drain_state SET lease_token = 'replacement', lease_until = 0",
        )
        .run();
      if (!normal) throw new Error("fixture missing");
      return normal(rows);
    });
    expect(await drainVectors(bindings)).toMatchObject({
      delivered: VECTOR_DRAIN_CONCURRENCY,
    });
    expect(env.AI.run).toHaveBeenCalledTimes(VECTOR_DRAIN_CONCURRENCY);
    expect(
      [...vectors.values()].some((v) => v.metadata?.docKey === quiet.id),
    ).toBe(true);
    expect(
      await db
        .prepare(
          "SELECT lease_token FROM vector_drain_state WHERE namespace = ?",
        )
        .bind(namespace)
        .first(),
    ).toMatchObject({ lease_token: "replacement" });
    expect(await drainVectors(bindings)).toMatchObject({
      delivered: VECTOR_DRAIN_LIMIT,
    });
  });

  it("bootstraps legacy owner hints in bounded pages without invalidating acceptance", async () => {
    for (let i = 0; i <= VECTOR_OWNER_BACKFILL_LIMIT; i++) await add(String(i));
    await db
      .prepare(`UPDATE vector_pending SET user_id = NULL, completed_epoch = epoch,
      next_attempt_at = unixepoch() + 86400, mutation_id = 'legacy-ack'`)
      .run();
    const before = (await jobs()).map((job) => ({ ...job }));
    expect(await drainVectors(bindings)).toMatchObject({
      ownerHintsBackfilled: VECTOR_OWNER_BACKFILL_LIMIT,
      delivered: 0,
    });
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM vector_pending WHERE user_id IS NULL",
        )
        .first(),
    ).toMatchObject({ n: 1 });
    expect(await drainVectors(bindings)).toMatchObject({
      ownerHintsBackfilled: 1,
      delivered: 0,
    });
    expect(await drainVectors(bindings)).toMatchObject({
      ownerHintsBackfilled: 0,
      delivered: 0,
    });
    expect(await jobs()).toEqual(before);
    expect(env.AI.run).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(deleteByIds).not.toHaveBeenCalled();
    const plan = await db
      .prepare(`EXPLAIN QUERY PLAN SELECT memory_id, generation FROM vector_pending
      WHERE namespace = ? AND user_id = ? AND next_attempt_at <= ? AND lease_until <= ?
      ORDER BY next_attempt_at, memory_id, generation LIMIT 20`)
      .bind(namespace, "local", 0, 0)
      .all<{ detail: string }>();
    expect(
      plan.results.some((row) =>
        row.detail.includes("vector_pending_tenant_due"),
      ),
    ).toBe(true);
    expect(plan.results.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(
      false,
    );
  });
});

describe("durable vector delivery", () => {
  it("does not settle a relocation epoch behind an in-flight pre-rollout delivery", async () => {
    await add();
    const normal = upsert.getMockImplementation();
    let release = () => {};
    let enter = () => {};
    const started = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    upsert.mockImplementationOnce(async (rows) => {
      enter();
      await gate;
      if (!normal) throw new Error("fixture missing");
      // Emulate the old worker's last network write into the shared namespace.
      return normal(rows.map((row) => ({ ...row, namespace })));
    });
    const old = drainVectors(bindings);
    await started;
    try {
      expect(await maintainVectors(bindings)).toMatchObject({
        delivered: 0,
        pending: 1,
        backfill: { done: true },
      });
    } finally {
      release();
      await old;
    }
    expect(await vectorStatus(db, namespace)).toMatchObject({ pending: 1 });
    expect(
      await memoryVectorCandidates(bindings, {
        userId: "local",
        query: "meaning",
      }),
    ).toEqual([]);
    expect(await maintainVectors(bindings)).toMatchObject({
      delivered: 1,
      pending: 0,
      backfill: undefined,
    });
    expect([...vectors.values()].map((row) => row.namespace)).toEqual([
      tenantNamespace,
    ]);
  });

  it("relocates settled legacy heads/history with a new checkpoint, retries and namespace-independent deletion", async () => {
    const owner = await add("old owner head");
    await edit(owner.id, "current owner head");
    const member = await saveMemory(
      bindings,
      { type: "fact", title: "Member", body: "member head", tags: [] },
      { ...provenance, userId: "other" },
    );
    await drainVectors(bindings);
    const ids = [...vectors.keys()].sort();
    // Simulate the pre-rollout index and completed checkpoint, including an
    // immutable pre-tenancy snapshot without userId (do not guess its owner).
    for (const row of vectors.values())
      row.namespace = row.namespace?.startsWith("h:")
        ? `h:${namespace}`
        : namespace;
    await db
      .prepare(
        "UPDATE vector_snapshots SET projection_json = json_remove(projection_json, '$.userId')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO vector_backfills(namespace, cursor, done) VALUES (?, ?, 1)",
      )
      .bind(namespace, JSON.stringify(["zzzz", 100]))
      .run();
    const snapshots = (
      await db
        .prepare(
          "SELECT * FROM vector_snapshots ORDER BY memory_id, generation",
        )
        .all()
    ).results;
    expect(
      await memoryVectorCandidates(bindings, {
        userId: "local",
        query: "meaning",
      }),
    ).toEqual([]);
    upsert.mockRejectedValueOnce(new Error("migration retry"));
    expect(await maintainVectors(bindings)).toMatchObject({
      delivered: 2,
      attemptedFailed: 1,
      pending: 1,
      backfill: { scanned: 3, done: true },
    });
    expect(
      await db
        .prepare("SELECT done FROM vector_backfills WHERE namespace = ?")
        .bind(vectorBackfillKey(namespace))
        .first(),
    ).toMatchObject({ done: 1 });
    expect(
      await db
        .prepare("SELECT cursor FROM vector_backfills WHERE namespace = ?")
        .bind(namespace)
        .first(),
    ).toMatchObject({ cursor: JSON.stringify(["zzzz", 100]) });
    await db
      .prepare(
        "UPDATE vector_pending SET next_attempt_at = 0 WHERE attempts > 0",
      )
      .run();
    expect(await maintainVectors(bindings)).toMatchObject({
      delivered: 1,
      pending: 0,
      backfill: undefined,
    });
    expect([...vectors.keys()].sort()).toEqual(ids);
    expect(
      [...vectors.values()].filter(
        (v) => v.namespace === namespace || v.namespace === `h:${namespace}`,
      ),
    ).toHaveLength(0);
    expect(
      [...vectors.values()].filter(
        (v) => v.namespace === `h:${tenantNamespace}`,
      ),
    ).toHaveLength(1);
    expect(
      (
        await memoryVectorCandidates(bindings, {
          userId: "local",
          query: "meaning",
        })
      ).map((p) => p.docKey),
    ).toEqual([owner.id]);
    expect(
      (
        await memoryVectorCandidates(bindings, {
          userId: "other",
          query: "meaning",
        })
      ).map((p) => p.docKey),
    ).toEqual([member.id]);
    expect(
      (
        await db
          .prepare(
            "SELECT * FROM vector_snapshots ORDER BY memory_id, generation",
          )
          .all()
      ).results,
    ).toEqual(snapshots);
    // A delayed legacy worker may put a member vector back in the old namespace.
    // Tombstones use unchanged ids and delete it there, without embedding.
    for (const row of vectors.values())
      if (row.metadata?.docKey === member.id) row.namespace = namespace;
    await archiveMemory(bindings, "other", member.id.slice(7));
    await drainVectors(bindings);
    expect(
      [...vectors.values()].some((v) => v.metadata?.docKey === member.id),
    ).toBe(false);
  });

  // Real D1 writes, a 51-head backfill and three drain pages exceed the default
  // five-second budget on a contended build runner. This is not a latency test.
  it("resumes initial backfill on minute ticks without repeating a completed scan", {
    timeout: 20_000,
  }, async () => {
    for (let i = 0; i < 51; i++) await add(String(i));
    await db.prepare("DELETE FROM vector_snapshots").run();
    expect(await maintainVectors(bindings)).toMatchObject({
      delivered: 20,
      backfill: { scanned: 50, done: false },
    });
    expect(await maintainVectors(bindings)).toMatchObject({
      delivered: 20,
      backfill: { scanned: 1, done: true },
    });
    expect(await maintainVectors(bindings)).toMatchObject({
      delivered: 11,
      pending: 0,
      backfill: undefined,
    });
    expect(
      (
        await db
          .prepare("SELECT done FROM vector_backfills WHERE namespace = ?")
          .bind(vectorBackfillKey(namespace))
          .first()
      )?.done,
    ).toBe(1);
    await add("new head after completed backfill");
    expect(await maintainVectors(bindings)).toMatchObject({
      delivered: 1,
      pending: 0,
      backfill: undefined,
    });
  });

  it("reports queue age separately from accepted mutation visibility", async () => {
    await add();
    await db
      .prepare("UPDATE vector_pending SET queued_at = unixepoch() - 90")
      .run();
    const before = await vectorStatus(db, namespace);
    expect(before?.oldestPendingSeconds).toBeGreaterThanOrEqual(90);
    expect(before?.lastAcceptedAt).toBe(0);
    await drainVectors(bindings);
    const after = await vectorStatus(db, namespace);
    expect(after).toMatchObject({
      pending: 0,
      due: 0,
      oldestPendingSeconds: 0,
    });
    expect(after?.lastAcceptedAt).toBeGreaterThan(0);
  });

  it("does not scan the settled ledger on unsampled minute ticks", async () => {
    await add();
    await maintainVectors(bindings);
    const prepare = vi.spyOn(db, "prepare");
    const report = await maintainVectors(bindings, false);
    expect(report).toMatchObject({
      configured: true,
      delivered: 0,
      statusSampled: false,
    });
    expect(report).not.toHaveProperty("pending");
    expect(
      prepare.mock.calls.some(([sql]) =>
        sql.includes("SELECT COUNT(*) AS total"),
      ),
    ).toBe(false);
  });

  it("bounds concurrent provider work as well as total attempts", async () => {
    for (let i = 0; i < VECTOR_DRAIN_LIMIT; i++) await add(String(i));
    let active = 0;
    let peak = 0;
    upsert.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { mutationId: "accepted" };
    });
    expect(await drainVectors(bindings)).toMatchObject({
      delivered: VECTOR_DRAIN_LIMIT,
    });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(VECTOR_DRAIN_CONCURRENCY);
  });

  it.each(["upsert", "delete"] as const)(
    "lets later jobs progress when a %s mutation stalls",
    async (operation) => {
      const first = await add("first queued memory");
      const second = await add("second queued memory");
      if (operation === "delete") {
        await archiveMemory(bindings, "local", first.id.slice(7));
        await archiveMemory(bindings, "local", second.id.slice(7));
      }
      let release = () => {};
      let entered = () => {};
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const stalled = async () => {
        entered();
        await gate;
        return { mutationId: "late-acceptance" };
      };
      if (operation === "upsert") upsert.mockImplementationOnce(stalled);
      else deleteByIds.mockImplementationOnce(stalled);
      const draining = drainVectors(bindings);
      await started;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          draining,
          new Promise<"starved">((resolve) => {
            timer = setTimeout(() => resolve("starved"), 7000);
          }),
        ]);
        expect(result).not.toBe("starved");
        expect(result).toMatchObject({
          delivered: 1,
          attemptedFailed: 1,
          pending: 1,
        });
        expect(
          operation === "upsert" ? upsert : deleteByIds,
        ).toHaveBeenCalledTimes(2);
      } finally {
        clearTimeout(timer);
        release();
        await draining;
      }
    },
    20_000,
  );

  it("routes rebuilt live heads to the head namespace after projection loss", async () => {
    const memory = await add("restored live memory");
    await db.batch([
      db.prepare("DELETE FROM search_docs"),
      db.prepare("DELETE FROM vector_snapshots"),
    ]);
    await reindex(bindings, ["skill", "memory"]);
    await backfillVectors(bindings);
    expect((await jobs())[0]).toMatchObject({ target: "head" });
    await drainVectors(bindings);
    expect(
      (
        await memoryVectorCandidates(bindings, {
          userId: "local",
          query: "restored meaning",
        })
      ).map((head) => head.docKey),
    ).toEqual([memory.id]);
  });

  it("recovers after commit with no send and keeps lexical search immediately available", async () => {
    const memory = await add();
    expect(upsert).not.toHaveBeenCalled();
    expect(
      (await search(bindings, { userId: "local", query: "durable" }))[0]
        ?.docKey,
    ).toBe(memory.id);
    expect(await vectorStatus(db, namespace)).toMatchObject({ pending: 1 });
    expect(await drainVectors(bindings)).toMatchObject({
      delivered: 1,
      pending: 0,
    });
    expect(
      (
        await memoryVectorCandidates(bindings, {
          userId: "local",
          query: "paraphrase",
        })
      )[0]?.docKey,
    ).toBe(memory.id);
  });

  it("rolls back snapshots and pending state with the authoritative and FTS batch", async () => {
    await db.exec(
      "CREATE TRIGGER reject_vector_snapshot BEFORE INSERT ON vector_snapshots BEGIN SELECT RAISE(ABORT, 'test outbox failure'); END",
    );
    try {
      await expect(add()).rejects.toThrow("test outbox failure");
      expect(
        (
          await db
            .prepare("SELECT COUNT(*) AS n FROM memories")
            .first<{ n: number }>()
        )?.n,
      ).toBe(0);
      expect(
        await search(bindings, { userId: "local", query: "durable" }),
      ).toEqual([]);
    } finally {
      await db.exec("DROP TRIGGER reject_vector_snapshot");
    }
  });

  it("keeps each rapid revision, routes only the head to search and ignores duplicate delivery", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const memory = await add("first");
    await drainVectors(bindings);
    const first = [...vectors.values()][0];
    await edit(memory.id, "second");
    await edit(memory.id, "third");
    // The formerly published vector cannot admit stale content while catch-up runs.
    expect(
      await memoryVectorCandidates(bindings, {
        userId: "local",
        query: "meaning",
      }),
    ).toEqual([]);
    await drainVectors(bindings);
    expect(vectors.size).toBe(3);
    expect(
      [...vectors.values()].filter((v) => v.namespace === tenantNamespace),
    ).toHaveLength(1);
    expect(
      [...vectors.values()].filter(
        (v) => v.namespace === `h:${tenantNamespace}`,
      ),
    ).toHaveLength(2);
    expect(vectors.get(first.id)?.namespace).toBe(`h:${tenantNamespace}`);
    expect(
      (
        await memoryVectorCandidates(bindings, {
          userId: "local",
          query: "meaning",
        })
      )[0]?.body,
    ).toBe("third");
    await db
      .prepare(
        "UPDATE vector_pending SET completed_epoch = 0, next_attempt_at = 0",
      )
      .run();
    await drainVectors(bindings);
    expect(vectors.size).toBe(3);
    expect(
      (
        await db
          .prepare("SELECT COUNT(*) AS n FROM memory_revisions")
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);
  });

  it("does not acknowledge a newer epoch when an edit races an old delivery", async () => {
    const memory = await add("before");
    const normal = upsert.getMockImplementation();
    upsert.mockImplementationOnce(async (rows) => {
      await edit(memory.id, "after");
      if (!normal) throw new Error("fixture missing");
      return normal(rows);
    });
    await drainVectors(bindings);
    expect(await vectorStatus(db, namespace)).toMatchObject({ pending: 2 });
    expect(
      await memoryVectorCandidates(bindings, {
        userId: "local",
        query: "meaning",
      }),
    ).toEqual([]);
    await drainVectors(bindings);
    expect(
      [...vectors.values()].filter((v) => v.namespace === tenantNamespace),
    ).toHaveLength(1);
    expect(
      (
        await memoryVectorCandidates(bindings, {
          userId: "local",
          query: "meaning",
        })
      )[0]?.body,
    ).toBe("after");
  });

  it("archives during delivery leave durable tombstones and remove all revision vectors", async () => {
    const memory = await add();
    const normal = upsert.getMockImplementation();
    upsert.mockImplementationOnce(async (rows) => {
      await archiveMemory(bindings, "local", memory.id.slice(7));
      if (!normal) throw new Error("fixture missing");
      return normal(rows);
    });
    await drainVectors(bindings);
    expect(
      await memoryVectorCandidates(bindings, {
        userId: "local",
        query: "meaning",
      }),
    ).toEqual([]);
    expect(
      await search(bindings, { userId: "local", query: "durable" }),
    ).toEqual([]);
    expect(await jobs()).toMatchObject([
      { target: "delete", completed_epoch: 0 },
    ]);
    await drainVectors(bindings);
    expect(vectors.size).toBe(0);
    await archiveMemory(bindings, "local", memory.id.slice(7));
    expect(await vectorStatus(db, namespace)).toMatchObject({ pending: 0 });
  });

  it("backs off failures without exposing provider text or failing saves", async () => {
    await add();
    upsert.mockRejectedValueOnce(new Error("secret memory provider details"));
    expect(await drainVectors(bindings)).toMatchObject({
      failed: 1,
      pending: 1,
    });
    const state = await jobs();
    expect(state).toMatchObject([
      { attempts: 1, error_code: "mutation_failure" },
    ]);
    expect(JSON.stringify(state)).not.toContain("secret");
    expect(await drainVectors(bindings)).toMatchObject({ delivered: 0 });
    await db.prepare("UPDATE vector_pending SET next_attempt_at = 0").run();
    expect(await drainVectors(bindings)).toMatchObject({
      delivered: 1,
      pending: 0,
    });
  });

  it("recovers a crashed leased delivery and accepts duplicate upserts", async () => {
    await add();
    await drainVectors(bindings);
    await db
      .prepare(
        "UPDATE vector_pending SET completed_epoch = 0, next_attempt_at = 0, lease_token = 'crashed', lease_until = ?",
      )
      .bind(Math.floor(Date.now() / 1000) + VECTOR_LEASE_SECONDS)
      .run();
    expect(await drainVectors(bindings)).toMatchObject({ delivered: 0 });
    await db.prepare("UPDATE vector_pending SET lease_until = 0").run();
    expect(await drainVectors(bindings)).toMatchObject({
      delivered: 1,
      pending: 0,
    });
    expect(vectors.size).toBe(1);
  });

  it("repairs an out-of-order old delivery after its lease expired and a tombstone completed", async () => {
    const memory = await add();
    const normal = upsert.getMockImplementation();
    let release: () => void = () => {
      throw new Error("delivery not waiting");
    };
    let entered: () => void = () => {
      throw new Error("start not waiting");
    };
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    upsert.mockImplementationOnce(async (rows) => {
      entered();
      await gate;
      if (!normal) throw new Error("fixture missing");
      return normal(rows);
    });
    const oldWorker = drainVectors(bindings);
    await started;
    await archiveMemory(bindings, "local", memory.id.slice(7));
    // Recover both the abandoned pass reservation and its job claim.
    await db.batch([
      db.prepare("UPDATE vector_pending SET lease_until = 0"),
      db.prepare("UPDATE vector_drain_state SET lease_until = 0"),
    ]);
    expect(await drainVectors(bindings)).toMatchObject({ pending: 0 });
    release();
    await oldWorker;
    expect(vectors.size).toBe(1);
    expect(
      await memoryVectorCandidates(bindings, {
        userId: "local",
        query: "meaning",
      }),
    ).toEqual([]);
    expect(await vectorStatus(db, namespace)).toMatchObject({ pending: 1 });
    await drainVectors(bindings);
    expect(vectors.size).toBe(0);
  });

  it("deletes all historical generations on archive, not just the last head", async () => {
    const memory = await add();
    await edit(memory.id, "changed");
    await drainVectors(bindings);
    expect(vectors.size).toBe(2);
    await archiveMemory(bindings, "local", memory.id.slice(7));
    deleteByIds.mockRejectedValueOnce(new Error("retry tombstone"));
    expect(await drainVectors(bindings)).toMatchObject({
      failed: 1,
      pending: 1,
    });
    await db.prepare("UPDATE vector_pending SET next_attempt_at = 0").run();
    await drainVectors(bindings);
    expect(vectors.size).toBe(0);
    expect(await jobs()).toMatchObject([
      { target: "delete" },
      { target: "delete" },
    ]);
  });

  it("periodically repairs settled tombstones after an unobserved stale remote upsert", async () => {
    const memory = await add();
    await drainVectors(bindings);
    const stale = [...vectors.values()][0];
    await archiveMemory(bindings, "local", memory.id.slice(7));
    await drainVectors(bindings);
    expect(await vectorStatus(db, namespace)).toMatchObject({ pending: 0 });
    // Simulate a delayed remote mutation after its worker died before reporting.
    vectors.set(stale.id, stale);
    expect(await drainVectors(bindings)).toMatchObject({ delivered: 0 });
    await db.prepare("UPDATE vector_pending SET next_attempt_at = 0").run();
    await drainVectors(bindings);
    expect(vectors.size).toBe(0);
  });

  it("isolates namespaces and does not infer or mutate without capabilities", async () => {
    const memory = await add();
    expect(await drainVectors({ DB: db })).toMatchObject({ configured: false });
    const other = { ...bindings, VALISE_VECTOR_NAMESPACE: "other-workspace" };
    await backfillVectors(other);
    await drainVectors(other);
    expect(await vectorStatus(db, namespace)).toMatchObject({ pending: 1 });
    expect(
      await memoryVectorCandidates(bindings, {
        userId: "local",
        query: "meaning",
      }),
    ).toEqual([]);
    await drainVectors(bindings);
    expect(vectors.size).toBe(2);
    await archiveMemory({ DB: db }, "local", memory.id.slice(7));
    expect(await vectorStatus(db, "other-workspace")).toMatchObject({
      pending: 1,
    });
    await drainVectors(bindings);
    expect(vectors.size).toBe(1);
    await drainVectors(other);
    expect(vectors.size).toBe(0);
  });

  it("backfills revisions idempotently without rewriting history or replacing recorded project", async () => {
    const memory = await add("one");
    await edit(memory.id, "two");
    await edit(memory.id, "three");
    const revisions = await db
      .prepare("SELECT * FROM memory_revisions ORDER BY revision")
      .all();
    await db.prepare("DELETE FROM vector_snapshots").run();
    expect(await backfillVectors(bindings)).toMatchObject({
      done: true,
      pending: 3,
    });
    await drainVectors(bindings);
    const saved = await db
      .prepare("SELECT * FROM vector_snapshots ORDER BY generation")
      .all();
    expect(JSON.parse(String(saved.results[0]?.projection_json)).project).toBe(
      "valise",
    );
    expect(JSON.parse(String(saved.results[2]?.projection_json)).project).toBe(
      "moved",
    );
    expect(await backfillVectors(bindings)).toMatchObject({ pending: 0 });
    // D1 execution metadata (notably duration) may differ between reads.
    // Immutability concerns the stored rows, not query timings.
    expect(
      (
        await db
          .prepare("SELECT * FROM vector_snapshots ORDER BY generation")
          .all()
      ).results,
    ).toEqual(saved.results);
    expect(
      (
        await db
          .prepare("SELECT * FROM memory_revisions ORDER BY revision")
          .all()
      ).results,
    ).toEqual(revisions.results);
    expect(vectors.size).toBe(3);
    expect(
      (
        await memoryVectorCandidates(bindings, {
          userId: "local",
          query: "meaning",
        })
      )[0]?.body,
    ).toBe("three");
  });

  it("suppresses confirmed supersession, then repairs predecessor routing on removal and successor archive", async () => {
    const old = await add("original");
    const successor = await add("replacement");
    await drainVectors(bindings);
    await assertPersonMemoryLink(
      bindings,
      successor.id.slice(7),
      { id: old.id, kind: "supersedes" },
      provenance,
    );
    expect(
      (
        await memoryVectorCandidates(bindings, {
          userId: "local",
          query: "meaning",
        })
      ).map((p) => p.docKey),
    ).toEqual([successor.id]);
    await drainVectors(bindings);
    expect(
      [...vectors.values()].filter((v) => v.namespace === tenantNamespace),
    ).toHaveLength(1);
    expect(vectors.size).toBe(2);
    const link = await db
      .prepare("SELECT link_id FROM memory_links")
      .first<{ link_id: string }>();
    if (!link) throw new Error("fixture link missing");
    await changeMemoryLink(
      bindings,
      successor.id.slice(7),
      link.link_id,
      "remove",
      "local",
    );
    await drainVectors(bindings);
    expect(vectors.size).toBe(2);
    await changeMemoryLink(
      bindings,
      successor.id.slice(7),
      link.link_id,
      "restore",
      "local",
    );
    await drainVectors(bindings);
    expect(
      [...vectors.values()].filter((v) => v.namespace === tenantNamespace),
    ).toHaveLength(1);
    await archiveMemory({ DB: db }, "local", successor.id.slice(7));
    await drainVectors(bindings);
    expect(
      (
        await memoryVectorCandidates(bindings, {
          userId: "local",
          query: "meaning",
        })
      ).map((p) => p.docKey),
    ).toEqual([old.id]);
  });

  it("bounds each drain page", async () => {
    for (let i = 0; i < VECTOR_DRAIN_LIMIT + 1; i++) await add(String(i));
    expect(await drainVectors(bindings)).toMatchObject({
      delivered: VECTOR_DRAIN_LIMIT,
      pending: 1,
    });
    expect(await drainVectors(bindings)).toMatchObject({
      delivered: 1,
      pending: 0,
    });
  });

  it("bounds backfill by revisions even when one memory has more than a page", async () => {
    const memory = await add("zero");
    for (let i = 1; i <= 51; i++) await edit(memory.id, String(i));
    await db.prepare("DELETE FROM vector_snapshots").run();
    const first = await backfillVectors(bindings);
    expect(first).toMatchObject({ scanned: 50, done: false });
    expect(
      (
        await db
          .prepare("SELECT COUNT(*) AS n FROM vector_snapshots")
          .first<{ n: number }>()
      )?.n,
    ).toBe(51);
    const second = await backfillVectors(bindings, first.cursor);
    expect(second).toMatchObject({ scanned: 2, done: true, pending: 52 });
    const final = await backfillVectors(bindings, second.cursor);
    expect(final).toMatchObject({ scanned: 0, done: true, pending: 52 });
  });
});
