import {
  DAILY_BUDGET_ERROR,
  type EmbeddingBudgetEnv,
  NEXT_UTC_DAY_SQL,
  recordEmbeddingFailure,
  reserveEmbedding,
  utf8Bytes,
} from "~/search/embedding-budget";
import { memoryAffectedSql, memorySourceSql } from "~/search/memory-source";
import { type ProjectionRow, projectMemory } from "~/search/project";
import {
  memoryVectorStamp,
  queryVector,
  tenantVectorNamespace,
  VECTOR_MODEL,
  vectorProjectKey,
} from "~/search/vectors";

export type VectorDeliveryEnv = EmbeddingBudgetEnv & {
  DB: D1Database;
  AI?: Pick<Ai, "run">;
  // Wrangler 4.151 generates the legacy VectorizeIndex type even for V2.
  // Validate the V2 acknowledgement at the runtime boundary below.
  VECTOR_INDEX?:
    | Pick<Vectorize, "upsert" | "deleteByIds">
    | Pick<VectorizeIndex, "upsert" | "deleteByIds">;
  VALISE_VECTOR_NAMESPACE?: string;
};

export const VECTOR_DRAIN_LIMIT = 20;
export const VECTOR_DRAIN_CONCURRENCY = 4;
export const VECTOR_LEASE_SECONDS = 120;
export const VECTOR_TENANT_VISIT_LIMIT = VECTOR_DRAIN_LIMIT;
export const VECTOR_OWNER_BACKFILL_LIMIT = 50;
const PROVIDER_TIMEOUT_MS = 5000;

/** A completed deployment-wide scan must not suppress tenant relocation. */
export function vectorBackfillKey(namespace: string) {
  return `tenant-v1:${namespace}`;
}

/** Capture the projected generation inside the authoritative+FTS transaction. */
export function vectorSnapshotStatement(db: D1Database, id: string) {
  return db
    .prepare(`INSERT OR IGNORE INTO vector_snapshots
    (memory_id, generation, projection_json)
    SELECT m.memory_id,
      1 + COALESCE((SELECT MAX(revision) FROM memory_revisions WHERE memory_id = m.memory_id), 0),
      json_object('docKey', s.doc_key, 'userId', s.user_id, 'concept', s.concept, 'conceptId', s.concept_id,
        'project', s.project, 'title', s.title, 'body', s.body, 'tags', s.tags, 'updatedAt', s.updated_at)
    FROM memories m JOIN (${memorySourceSql(`(${memoryAffectedSql}) AND m.deleted_at IS NULL`)}) s
      ON s.concept_id = m.memory_id`)
    .bind(id, id);
}

/** Deployment settings the memory write path reads; never a caller's owner. */
export type VectorAdmissionEnv = {
  VALISE_VECTOR_NAMESPACE?: string;
  VALISE_VECTOR_BACKLOG_CAP?: string;
};

/**
 * Distinct memories per owner with unfinished, non-delete embedding work.
 * Production on 2026-11-01 held 164 memories in two tenants, at most 12
 * created in an hour and an empty backlog; 200 is ten minutes of the whole
 * 20-job drain and admits the largest tenant's entire corpus. ADR-0017.
 */
export const VECTOR_BACKLOG_CAP = 200;

export function vectorBacklogCap(env: VectorAdmissionEnv): number {
  const cap = Number(env.VALISE_VECTOR_BACKLOG_CAP);
  return Number.isSafeInteger(cap) && cap > 0 ? cap : VECTOR_BACKLOG_CAP;
}

/** Bounded by the cap, through `vector_pending_outstanding`, however much history a tenant keeps. */
const outstandingCountSql = (user: string) => `(SELECT COUNT(*) FROM (
    SELECT DISTINCT o.memory_id FROM vector_pending o
    WHERE o.namespace = ? AND o.user_id = ${user}
      AND o.completed_epoch < o.epoch AND o.target != 'delete' LIMIT ?))`;

/**
 * Admit deletes, memories already waiting (repeat edits coalesce into their
 * queued rows), and any memory while its owner is under the cap. Two
 * namespace and one cap binding, in that order.
 */
const admittedSql = `(m.deleted_at IS NOT NULL
    OR EXISTS (SELECT 1 FROM vector_pending o WHERE o.namespace = ? AND o.memory_id = m.memory_id
      AND o.completed_epoch < o.epoch AND o.target != 'delete')
    OR ${outstandingCountSql("m.user_id")} < ?)`;

function admittedBindings(namespace: string, cap: number) {
  return [namespace, namespace, cap, cap];
}

const pendingSql = (
  gate: string,
) => `INSERT INTO vector_pending (namespace, user_id, memory_id, generation, target, queued_at)
    SELECT n.namespace, m.user_id, v.memory_id, v.generation,
      CASE WHEN m.deleted_at IS NOT NULL THEN 'delete'
      WHEN EXISTS (SELECT 1 FROM search_docs WHERE doc_key = 'memory:' || m.memory_id)
        AND v.generation = 1 + COALESCE((SELECT MAX(revision) FROM memory_revisions
        WHERE memory_id = m.memory_id), 0) THEN 'head' ELSE 'history' END, unixepoch()
    FROM vector_snapshots v JOIN memories m USING (memory_id)
    CROSS JOIN (SELECT namespace FROM vector_pending WHERE memory_id IN
      (SELECT m.memory_id FROM memories m WHERE (${memoryAffectedSql}))
      UNION SELECT ? WHERE ? IS NOT NULL) n
    WHERE v.memory_id IN (SELECT m.memory_id FROM memories m WHERE (${memoryAffectedSql}))${gate}
    ON CONFLICT(namespace, memory_id, generation) DO UPDATE SET
      user_id = excluded.user_id, target = excluded.target, epoch = vector_pending.epoch + 1,
      attempts = 0, next_attempt_at = 0, error_code = NULL, queued_at = unixepoch()
    WHERE vector_pending.target != excluded.target`;

/**
 * Ungated: backfill, relocation and promotion are repair, and stay possible
 * at the cap. Also invalidates existing namespaces when vectors are disabled.
 */
export function vectorPendingStatement(
  env: { DB: D1Database; VALISE_VECTOR_NAMESPACE?: string },
  id: string,
) {
  const namespace = env.VALISE_VECTOR_NAMESPACE || null;
  return env.DB.prepare(pendingSql("")).bind(
    id,
    id,
    namespace,
    namespace,
    id,
    id,
  );
}

/**
 * A user write's enqueue, admitted against the owner's backlog cap inside the
 * writer's batch. D1 runs batches one at a time, so concurrent writers each
 * count the backlog the previous batch left. A memory refused here is recorded
 * once in `vector_deferred` (first statement) and its authoritative write and
 * FTS projection still commit; the cron promotes it later. The last statement
 * clears the deferral once the memory is admitted. Old namespaces being
 * invalidated are never gated.
 */
export function vectorAdmissionStatements(
  db: D1Database,
  id: string,
  env: VectorAdmissionEnv,
): D1PreparedStatement[] {
  const namespace = env.VALISE_VECTOR_NAMESPACE;
  if (!namespace) return [vectorPendingStatement({ DB: db }, id)];
  const cap = vectorBacklogCap(env);
  return [
    db
      .prepare(`INSERT INTO vector_deferred (namespace, user_id, memory_id, deferred_at)
      SELECT ?, m.user_id, m.memory_id, unixepoch() FROM memories m
      WHERE (${memoryAffectedSql}) AND NOT ${admittedSql}
        AND EXISTS (SELECT 1 FROM vector_snapshots v WHERE v.memory_id = m.memory_id)
      ON CONFLICT(namespace, memory_id) DO NOTHING`)
      .bind(namespace, id, id, ...admittedBindings(namespace, cap)),
    db
      .prepare(pendingSql(` AND (n.namespace IS NOT ? OR ${admittedSql})`))
      .bind(
        id,
        id,
        namespace,
        namespace,
        id,
        id,
        namespace,
        ...admittedBindings(namespace, cap),
      ),
    vectorDeferralClearStatement(db, namespace, cap, id),
  ];
}

function vectorDeferralClearStatement(
  db: D1Database,
  namespace: string,
  cap: number,
  id: string,
) {
  return db
    .prepare(`DELETE FROM vector_deferred WHERE namespace = ? AND (memory_id IN
      (SELECT m.memory_id FROM memories m WHERE (${memoryAffectedSql}) AND ${admittedSql})
      OR (memory_id = ? AND NOT EXISTS (SELECT 1 FROM memories WHERE memory_id = ?)))`)
    .bind(namespace, id, id, ...admittedBindings(namespace, cap), id, id);
}

export type VectorDeferral = {
  state: "deferred";
  outstanding: number;
  cap: number;
};

/** What a writer tells its caller after the batch: null once admitted. */
export async function vectorDeferral(
  env: { DB: D1Database } & VectorAdmissionEnv,
  userId: string,
  id: string,
): Promise<VectorDeferral | null> {
  const namespace = env.VALISE_VECTOR_NAMESPACE;
  if (!namespace) return null;
  const cap = vectorBacklogCap(env);
  const row =
    await env.DB.prepare(`SELECT ${outstandingCountSql("?")} AS outstanding
    FROM vector_deferred WHERE namespace = ? AND memory_id = ? AND user_id = ?`)
      .bind(namespace, userId, cap, namespace, id, userId)
      .first<{ outstanding: number }>();
  return row ? { state: "deferred", outstanding: row.outstanding, cap } : null;
}

/** Deferred memories promoted per pass, round-robin over owners under the cap. */
export const VECTOR_PROMOTE_LIMIT = VECTOR_DRAIN_LIMIT;

/**
 * Moves deferred memories into the delivery ledger through the same gate a
 * write uses, so promotion cannot push an owner past the cap either.
 */
export async function promoteDeferredVectors(
  env: { DB: D1Database } & VectorAdmissionEnv,
) {
  const namespace = env.VALISE_VECTOR_NAMESPACE;
  if (!namespace) return { promoted: 0, tenantsVisited: 0 };
  const cap = vectorBacklogCap(env);
  const cursorKey = `defer:${namespace}`;
  const cursor = await env.DB.prepare(
    "SELECT after_user_id FROM vector_drain_state WHERE namespace = ?",
  )
    .bind(cursorKey)
    .first<{ after_user_id: string }>();
  const after = cursor?.after_user_id ?? "";
  const tenantPage = async (from: string, limit: number, upTo?: string) => {
    const upper = upTo === undefined ? "" : "AND user_id <= ?";
    const { results } =
      await env.DB.prepare(`WITH RECURSIVE tenants(user_id, n) AS (
      SELECT (SELECT MIN(user_id) FROM vector_deferred WHERE namespace = ? AND user_id > ? ${upper}), 1
      UNION ALL SELECT (SELECT MIN(user_id) FROM vector_deferred
        WHERE namespace = ? AND user_id > tenants.user_id ${upper}), n + 1
      FROM tenants WHERE user_id IS NOT NULL AND n < ?
    ) SELECT user_id FROM tenants WHERE user_id IS NOT NULL`)
        .bind(
          namespace,
          from,
          ...(upTo === undefined ? [] : [upTo]),
          namespace,
          ...(upTo === undefined ? [] : [upTo]),
          limit,
        )
        .all<{ user_id: string }>();
    return results.map((row) => row.user_id);
  };
  const tenants = await tenantPage(after, VECTOR_TENANT_VISIT_LIMIT);
  if (after && tenants.length < VECTOR_TENANT_VISIT_LIMIT)
    tenants.push(
      ...(await tenantPage(
        "",
        VECTOR_TENANT_VISIT_LIMIT - tenants.length,
        after,
      )),
    );
  if (!tenants.length) return { promoted: 0, tenantsVisited: 0 };
  const pages = await Promise.all(
    tenants.map(async (userId) => {
      const { results } =
        await env.DB.prepare(`SELECT memory_id FROM vector_deferred
        WHERE namespace = ? AND user_id = ? ORDER BY deferred_at, memory_id
        LIMIT MAX(0, MIN(?, ? - ${outstandingCountSql("?")}))`)
          .bind(
            namespace,
            userId,
            VECTOR_PROMOTE_LIMIT,
            cap,
            namespace,
            userId,
            cap,
          )
          .all<{ memory_id: string }>();
      return results.map((row) => row.memory_id);
    }),
  );
  const ids: string[] = [];
  for (let round = 0; round < VECTOR_PROMOTE_LIMIT; round++)
    for (const page of pages)
      if (page[round] && ids.length < VECTOR_PROMOTE_LIMIT)
        ids.push(page[round]);
  await env.DB.prepare(`INSERT INTO vector_drain_state (namespace, after_user_id)
    VALUES (?, ?) ON CONFLICT(namespace) DO UPDATE SET after_user_id = excluded.after_user_id`)
    .bind(cursorKey, tenants.at(-1) ?? "")
    .run();
  let promoted = 0;
  for (const id of ids) {
    const [, enqueued, cleared] = await env.DB.batch(
      vectorAdmissionStatements(env.DB, id, env),
    );
    if (enqueued.meta.changes || cleared.meta.changes) promoted++;
  }
  return { promoted, tenantsVisited: tenants.length };
}

type Job = {
  namespace: string;
  memory_id: string;
  generation: number;
  target: "head" | "history" | "delete";
  epoch: number;
  attempts: number;
};

/** Fill scheduling hints only: never re-embed, reset epochs or trust snapshot owners. */
async function backfillVectorOwners(db: D1Database, namespace: string) {
  const { results } = await db
    .prepare(`SELECT p.memory_id, p.generation, m.user_id
    FROM vector_pending p JOIN memories m USING (memory_id)
    WHERE p.namespace = ? AND p.user_id IS NULL LIMIT ?`)
    .bind(namespace, VECTOR_OWNER_BACKFILL_LIMIT)
    .all<{ memory_id: string; generation: number; user_id: string }>();
  if (results.length)
    await db.batch(
      results.map((row) =>
        db
          .prepare(
            `UPDATE vector_pending SET user_id = ?
      WHERE namespace = ? AND memory_id = ? AND generation = ? AND user_id IS NULL`,
          )
          .bind(row.user_id, namespace, row.memory_id, row.generation),
      ),
    );
  return results.length;
}

/** One indexed seek per tenant, not DISTINCT over every bulk-import generation. */
async function vectorTenantPage(
  db: D1Database,
  namespace: string,
  after: string,
  limit: number,
  wrap = false,
) {
  const upper = wrap ? "AND user_id <= ?" : "";
  const { results } = await db
    .prepare(`WITH RECURSIVE tenants(user_id, n) AS (
    SELECT (SELECT MIN(user_id) FROM vector_pending
      WHERE namespace = ? AND user_id > ? ${upper}), 1
    UNION ALL
    SELECT (SELECT MIN(user_id) FROM vector_pending
      WHERE namespace = ? AND user_id > tenants.user_id ${upper}), n + 1
    FROM tenants WHERE user_id IS NOT NULL AND n < ?
  ) SELECT user_id FROM tenants WHERE user_id IS NOT NULL`)
    .bind(
      namespace,
      wrap ? "" : after,
      ...(wrap ? [after] : []),
      namespace,
      ...(wrap ? [after] : []),
      limit,
    )
    .all<{ user_id: string }>();
  return results.map((row) => row.user_id);
}

async function fairVectorPage(
  db: D1Database,
  namespace: string,
  after: string,
  now: number,
) {
  const tenants = await vectorTenantPage(
    db,
    namespace,
    after,
    VECTOR_TENANT_VISIT_LIMIT,
  );
  if (after && tenants.length < VECTOR_TENANT_VISIT_LIMIT)
    tenants.push(
      ...(await vectorTenantPage(
        db,
        namespace,
        after,
        VECTOR_TENANT_VISIT_LIMIT - tenants.length,
        true,
      )),
    );
  // At most 20 x 20 references, with only 20 of them allowed to claim/provider work.
  const pages = await Promise.all(
    tenants.map(async (userId) => {
      const { results } = await db
        .prepare(`SELECT namespace, memory_id, generation
      FROM vector_pending WHERE namespace = ? AND user_id = ?
        AND next_attempt_at <= ? AND lease_until <= ?
      ORDER BY next_attempt_at, memory_id, generation LIMIT ?`)
        .bind(namespace, userId, now, now, VECTOR_DRAIN_LIMIT)
        .all<Pick<Job, "namespace" | "memory_id" | "generation">>();
      return results;
    }),
  );
  const results: Pick<Job, "namespace" | "memory_id" | "generation">[] = [];
  for (
    let round = 0;
    round < VECTOR_DRAIN_LIMIT && results.length < VECTOR_DRAIN_LIMIT;
    round++
  ) {
    for (const page of pages) {
      if (page[round]) results.push(page[round]);
      if (results.length === VECTOR_DRAIN_LIMIT) break;
    }
  }
  return {
    results,
    tenantsVisited: tenants.length,
    after: tenants.at(-1) ?? after,
  };
}

export async function vectorStatus(db: D1Database, namespace: string) {
  return db
    .prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(completed_epoch < epoch), 0) AS pending,
    COALESCE(SUM(completed_epoch < epoch AND attempts > 0), 0) AS failed,
    COALESCE(SUM(user_id IS NULL), 0) AS ownerHintsPending,
    COALESCE(SUM(next_attempt_at <= unixepoch() AND lease_until <= unixepoch()), 0) AS due,
    COALESCE(MAX(CASE WHEN completed_epoch < epoch AND queued_at > 0
      THEN MAX(0, unixepoch() - queued_at) ELSE 0 END), 0) AS oldestPendingSeconds,
    COALESCE(MAX(completed_at), 0) AS lastAcceptedAt,
    (SELECT COUNT(*) FROM vector_deferred WHERE namespace = ?) AS deferred,
    COALESCE(SUM(completed_epoch < epoch AND error_code = '${DAILY_BUDGET_ERROR}'), 0) AS budgetDeferred
    FROM vector_pending WHERE namespace = ?`)
    .bind(namespace, namespace)
    .first<{
      total: number;
      pending: number;
      failed: number;
      ownerHintsPending: number;
      due: number;
      oldestPendingSeconds: number;
      lastAcceptedAt: number;
      deferred: number;
      budgetDeferred: number;
    }>();
}

/** No inference without all capabilities. Cron retries a bounded page, never search. */
export async function drainVectors(
  env: VectorDeliveryEnv,
  reportStatus = true,
) {
  const namespace = env.VALISE_VECTOR_NAMESPACE;
  const index = env.VECTOR_INDEX;
  const ai = env.AI;
  if (!namespace || !index || !ai)
    return { configured: false, delivered: 0, failed: 0 };
  const now = Math.floor(Date.now() / 1000);
  const drainToken = crypto.randomUUID();
  const reservation = await env.DB.prepare(`INSERT INTO vector_drain_state
    (namespace, lease_token, lease_until) VALUES (?, ?, ?)
    ON CONFLICT(namespace) DO UPDATE SET lease_token = excluded.lease_token,
      lease_until = excluded.lease_until WHERE vector_drain_state.lease_until <= ?
    RETURNING after_user_id`)
    .bind(namespace, drainToken, now + VECTOR_LEASE_SECONDS, now)
    .first<{ after_user_id: string }>();
  if (!reservation)
    return {
      configured: true,
      delivered: 0,
      attemptedFailed: 0,
      drainLeased: true,
      ...(reportStatus ? await vectorStatus(env.DB, namespace) : {}),
    };
  try {
    const ownerHintsBackfilled = await backfillVectorOwners(env.DB, namespace);
    const { results, tenantsVisited, after } = await fairVectorPage(
      env.DB,
      namespace,
      reservation.after_user_id,
      now,
    );
    // Reserve the next turn before network work: failed/crashed tenants cannot pin it.
    const advanced =
      await env.DB.prepare(`UPDATE vector_drain_state SET after_user_id = ?
    WHERE namespace = ? AND lease_token = ? AND lease_until > ?`)
        .bind(after, namespace, drainToken, Math.floor(Date.now() / 1000))
        .run();
    if (!advanced.meta.changes)
      return {
        configured: true,
        delivered: 0,
        attemptedFailed: 0,
        drainLeased: true,
      };
    let delivered = 0;
    let failed = 0;
    let budgetDeferred = 0;
    const deliver = async (ref: (typeof results)[number]) => {
      const token = crypto.randomUUID();
      const claimAt = Math.floor(Date.now() / 1000);
      const claimed =
        await env.DB.prepare(`UPDATE vector_pending SET lease_token = ?, lease_until = ?,
        queued_at = CASE WHEN completed_epoch = epoch THEN unixepoch() ELSE queued_at END,
        completed_epoch = 0
      WHERE namespace = ? AND memory_id = ? AND generation = ?
        AND next_attempt_at <= ? AND lease_until <= ?
      RETURNING target, epoch, attempts`)
          .bind(
            token,
            claimAt + VECTOR_LEASE_SECONDS,
            namespace,
            ref.memory_id,
            ref.generation,
            claimAt,
            claimAt,
          )
          .first<Pick<Job, "target" | "epoch" | "attempts">>();
      if (!claimed) return;
      const job: Job = { ...ref, ...claimed };
      let stage: "snapshot" | "embedding" | "mutation" | "acknowledgement" =
        "snapshot";
      try {
        const snapshot =
          await env.DB.prepare(`SELECT v.projection_json, m.user_id FROM vector_snapshots v
        JOIN memories m USING (memory_id) WHERE v.memory_id = ? AND v.generation = ?`)
            .bind(ref.memory_id, ref.generation)
            .first<{ projection_json: string; user_id: string }>();
        if (!snapshot) throw new Error("vector snapshot missing");
        const projection = parseProjection(
          snapshot.projection_json,
          snapshot.user_id,
        );
        // Pre-tenancy immutable snapshots may omit userId. The authoritative
        // memory owns routing, never a guessed legacy owner or snapshot metadata.
        const tenantNamespace = await tenantVectorNamespace(
          namespace,
          snapshot.user_id,
        );
        // Preserve deployment-based ids: upsert moves the SAME id out of the old
        // shared head/history namespace. Deletes then work in either layout.
        const stamp = await memoryVectorStamp(namespace, {
          projection,
          generation: job.generation,
        });
        let mutation: VectorizeAsyncMutation | VectorizeVectorMutation;
        if (job.target === "delete") {
          stage = "mutation";
          mutation = await withProviderDeadline<
            VectorizeAsyncMutation | VectorizeVectorMutation
          >(index.deleteByIds([stamp]));
        } else {
          const text = `${projection.title}\n\n${projection.body}`;
          if (
            !(await reserveEmbedding(
              env,
              snapshot.user_id,
              "memory",
              utf8Bytes(text),
            ))
          ) {
            // Spent for today: no provider call, no failure, back at 00:00 UTC.
            await env.DB.prepare(`UPDATE vector_pending SET
              next_attempt_at = CASE WHEN epoch = ? THEN ${NEXT_UTC_DAY_SQL} ELSE 0 END,
              lease_token = NULL, lease_until = 0, error_code = ?
              WHERE namespace = ? AND memory_id = ? AND generation = ? AND lease_token = ?`)
              .bind(
                job.epoch,
                DAILY_BUDGET_ERROR,
                namespace,
                job.memory_id,
                job.generation,
                token,
              )
              .run();
            budgetDeferred++;
            return;
          }
          stage = "embedding";
          const out: unknown = await withProviderDeadline(
            ai.run(
              VECTOR_MODEL,
              { text: [text] },
              { signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) },
            ),
          ).catch(async (error: unknown) => {
            await recordEmbeddingFailure(env.DB, snapshot.user_id, "memory");
            throw error;
          });
          const values = queryVector(out);
          stage = "mutation";
          mutation = await withProviderDeadline<
            VectorizeAsyncMutation | VectorizeVectorMutation
          >(
            index.upsert([
              {
                id: stamp,
                namespace:
                  job.target === "head"
                    ? tenantNamespace
                    : `h:${tenantNamespace}`,
                values,
                metadata: {
                  docKey: projection.docKey,
                  stamp,
                  ...(projection.project
                    ? { project: await vectorProjectKey(projection.project) }
                    : {}),
                },
              },
            ]),
          );
        }
        stage = "acknowledgement";
        if (
          !("mutationId" in mutation) ||
          typeof mutation.mutationId !== "string" ||
          !mutation.mutationId
        )
          throw new Error("missing V2 mutation acknowledgement");
        // Acknowledgement is acceptance, NOT ANN visibility. Keep a dirty epoch if
        // an edit/archive raced the network call; its next delivery repairs routing.
        const completed = await env.DB.prepare(`UPDATE vector_pending SET
        completed_epoch = CASE WHEN epoch = ? THEN ? ELSE 0 END,
        next_attempt_at = CASE WHEN epoch = ? THEN ? ELSE 0 END,
        lease_token = NULL, lease_until = 0, mutation_id = ?, error_code = NULL, attempts = 0,
        completed_at = unixepoch()
        WHERE namespace = ? AND memory_id = ? AND generation = ? AND lease_token = ?`)
          .bind(
            job.epoch,
            job.epoch,
            job.epoch,
            Math.floor(Date.now() / 1000) + 86400,
            mutation.mutationId,
            namespace,
            job.memory_id,
            job.generation,
            token,
          )
          .run();
        if (!completed.meta.changes)
          await requeueUncertainMutation(env.DB, job);
        delivered++;
      } catch {
        failed++;
        const retryAt =
          Math.floor(Date.now() / 1000) +
          Math.min(86400, 60 * 2 ** Math.min(job.attempts, 11));
        const retried =
          await env.DB.prepare(`UPDATE vector_pending SET attempts = attempts + 1,
        next_attempt_at = CASE WHEN epoch = ? THEN ? ELSE 0 END,
        lease_token = NULL, lease_until = 0, error_code = ?
        WHERE namespace = ? AND memory_id = ? AND generation = ? AND lease_token = ?`)
            .bind(
              job.epoch,
              retryAt,
              `${stage}_failure`,
              namespace,
              job.memory_id,
              job.generation,
              token,
            )
            .run();
        if (!retried.meta.changes) await requeueUncertainMutation(env.DB, job);
      }
    };
    for (
      let start = 0;
      start < results.length;
      start += VECTOR_DRAIN_CONCURRENCY
    ) {
      // A stolen/expired reservation must not launch another provider wave.
      const held = await env.DB.prepare(`SELECT 1 FROM vector_drain_state
      WHERE namespace = ? AND lease_token = ? AND lease_until > ?`)
        .bind(namespace, drainToken, Math.floor(Date.now() / 1000))
        .first();
      if (!held) break;
      // A claim or failed retry/ack write may reject outside the provider catch.
      // Keep the reservation until EVERY admitted sibling has settled, then
      // surface persistence failures rather than launching another wave.
      const settled = await Promise.allSettled(
        results.slice(start, start + VECTOR_DRAIN_CONCURRENCY).map(deliver),
      );
      const failures = settled.filter((result) => result.status === "rejected");
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          "vector delivery persistence failure",
        );
    }
    return {
      configured: true,
      tenantsVisited,
      ownerHintsBackfilled,
      delivered,
      attemptedFailed: failed,
      budgetDeferred,
      ...(reportStatus ? await vectorStatus(env.DB, namespace) : {}),
    };
  } finally {
    await env.DB.prepare(`UPDATE vector_drain_state SET lease_token = NULL, lease_until = 0
      WHERE namespace = ? AND lease_token = ?`)
      .bind(namespace, drainToken)
      .run();
  }
}

function requeueUncertainMutation(db: D1Database, job: Job) {
  return db
    .prepare(`UPDATE vector_pending
    SET completed_epoch = 0, epoch = epoch + 1, next_attempt_at = 0, queued_at = unixepoch()
    WHERE namespace = ? AND memory_id = ? AND generation = ?`)
    .bind(job.namespace, job.memory_id, job.generation)
    .run();
}

/** Each minute: one resumable source page, then one bounded delivery page. */
export async function maintainVectors(
  env: VectorDeliveryEnv & VectorAdmissionEnv,
  reportStatus = true,
) {
  const namespace = env.VALISE_VECTOR_NAMESPACE;
  if (!namespace || !env.VECTOR_INDEX || !env.AI)
    return drainVectors(env, reportStatus);
  const checkpoint = await env.DB.prepare(
    "SELECT cursor, done FROM vector_backfills WHERE namespace = ?",
  )
    .bind(vectorBackfillKey(namespace))
    .first<{ cursor: string; done: number }>();
  let backfill;
  if (!checkpoint?.done) {
    backfill = await backfillVectors(env, checkpoint?.cursor ?? "", true);
    // Concurrent cron retries may repeat a page, but cannot regress its cursor.
    await env.DB.prepare(`INSERT INTO vector_backfills (namespace, cursor, done)
      VALUES (?, ?, ?) ON CONFLICT(namespace) DO UPDATE SET cursor = excluded.cursor,
      done = excluded.done WHERE vector_backfills.cursor = ? AND vector_backfills.done = 0`)
      .bind(
        vectorBackfillKey(namespace),
        backfill.cursor,
        backfill.done ? 1 : 0,
        checkpoint?.cursor ?? "",
      )
      .run();
  }
  const promotion = await promoteDeferredVectors(env);
  return {
    ...(await drainVectors(env, reportStatus)),
    statusSampled: reportStatus,
    backfill,
    promotion,
  };
}

async function withProviderDeadline<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("vector provider timeout")),
          PROVIDER_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function parseProjection(json: string, userId: string): ProjectionRow {
  const p: unknown = JSON.parse(json);
  if (
    typeof p === "object" &&
    p !== null &&
    "docKey" in p &&
    typeof p.docKey === "string" &&
    "concept" in p &&
    p.concept === "memory" &&
    "conceptId" in p &&
    typeof p.conceptId === "string" &&
    "project" in p &&
    (p.project === null || typeof p.project === "string") &&
    "title" in p &&
    typeof p.title === "string" &&
    "body" in p &&
    typeof p.body === "string" &&
    "tags" in p &&
    typeof p.tags === "string" &&
    "updatedAt" in p &&
    typeof p.updatedAt === "number"
  ) {
    return {
      docKey: p.docKey,
      // Legacy snapshots need no rewrite; their owner comes from memories.
      userId,
      concept: p.concept,
      conceptId: p.conceptId,
      project: p.project,
      title: p.title,
      body: p.body,
      tags: p.tags,
      updatedAt: p.updatedAt,
    };
  }
  throw new Error("invalid vector snapshot");
}

/** One resumable page of at most 50 revisions/heads. No provider call. */
export async function backfillVectors(
  env: { DB: D1Database; VALISE_VECTOR_NAMESPACE?: string },
  after = "",
  relocate = false,
) {
  const namespace = env.VALISE_VECTOR_NAMESPACE;
  if (!namespace) throw new Error("vector namespace not configured");
  const cursor: unknown = after ? JSON.parse(after) : ["", 0];
  if (
    !Array.isArray(cursor) ||
    cursor.length !== 2 ||
    typeof cursor[0] !== "string" ||
    !Number.isSafeInteger(cursor[1]) ||
    cursor[1] < 0
  )
    throw new Error("invalid vector backfill cursor");
  const { results } = await env.DB.prepare(`WITH sources AS (
      SELECT memory_id, revision AS generation FROM memory_revisions
      UNION ALL SELECT memory_id, 1 + COALESCE((SELECT MAX(revision) FROM memory_revisions r
        WHERE r.memory_id = m.memory_id), 0) FROM memories m
    ) SELECT memory_id, generation FROM sources
    WHERE memory_id > ? OR (memory_id = ? AND generation > ?)
    ORDER BY memory_id, generation LIMIT 50`)
    .bind(cursor[0], cursor[0], cursor[1])
    .all<{ memory_id: string; generation: number }>();
  for (const { memory_id: id, generation } of results) {
    const r =
      await env.DB.prepare(`SELECT r.revision, r.memory_type, r.title, r.body, r.tags_json, r.project, r.created_at,
        m.user_id
      FROM memory_revisions r JOIN memories m ON m.memory_id = r.memory_id
      WHERE r.memory_id = ? AND r.revision = ?`)
        .bind(id, generation)
        .first<{
          revision: number;
          user_id: string;
          memory_type: string;
          title: string | null;
          body: string;
          tags_json: string;
          project: string | null;
          created_at: number;
        }>();
    if (r) {
      const reconstructedRevision = projectMemory({
        memoryId: id,
        userId: r.user_id,
        memoryType: r.memory_type,
        title: r.title,
        body: r.body,
        tagsJson: r.tags_json,
        project: r.project,
        deletedAt: null,
        updatedAt: r.created_at,
      });
      if (reconstructedRevision)
        await env.DB.prepare(`INSERT OR IGNORE INTO vector_snapshots
        (memory_id, generation, projection_json) VALUES (?, ?, ?)`)
          .bind(id, r.revision, JSON.stringify(reconstructedRevision))
          .run();
    }
    await env.DB.batch([
      vectorSnapshotStatement(env.DB, id),
      vectorPendingStatement(env, id),
      ...(relocate
        ? [
            env.DB.prepare(`UPDATE vector_pending SET epoch = epoch + 1,
            completed_epoch = 0, next_attempt_at = 0, attempts = 0,
            error_code = NULL, queued_at = unixepoch()
            WHERE namespace = ? AND memory_id = ? AND generation = ?`).bind(
              namespace,
              id,
              generation,
            ),
          ]
        : []),
    ]);
  }
  const last = results.at(-1);
  return {
    cursor: last ? JSON.stringify([last.memory_id, last.generation]) : after,
    done: results.length < 50,
    scanned: results.length,
    ...(await vectorStatus(env.DB, namespace)),
  };
}
