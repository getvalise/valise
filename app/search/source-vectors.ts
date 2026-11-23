import { parsePassageIndex, passageTexts } from "~/concepts/asset-passages";
import { bounded } from "~/search/asset-vectors";
import {
  DAILY_BUDGET_ERROR,
  NEXT_UTC_DAY_SQL,
  recordEmbeddingFailure,
  reserveEmbedding,
  utf8Bytes,
} from "~/search/embedding-budget";
import { capBody, type ProjectionRow } from "~/search/project";
import type { SearchFilters } from "~/search/query";
import type { VectorDeliveryEnv } from "~/search/vector-outbox";
import {
  queryVector,
  reserveQueryEmbedding,
  tenantVectorNamespace,
  VECTOR_DEPTH,
  VECTOR_MODEL,
  VECTOR_TAG_SCOPE_LIMIT,
  VECTOR_TIMEOUT_MS,
  type VectorBindings,
  VectorSearchFailure,
} from "~/search/vectors";

/**
 * Bookmark passages get what file passages get (`asset-vectors.ts`): one
 * bge-m3 vector per passage of the current enrichment, delivered from a D1
 * ledger in fair tenant turns, four a minute, and hydrated from D1 before
 * reranking. Vectors live in their own `s:<tenant>` partition, so bookmarks
 * cannot take file or memory candidate slots. ADR-0015.
 */

/** Deployment ledger identity; remote partitions are tenant-scoped below. */
export function sourceVectorNamespace(base: string): string {
  return `s:${base}`;
}

export type SourceVectorOutput = {
  userId: string;
  enrichmentId: string;
  sourceId: string;
  /** The article text the enrichment's passages index. */
  text: string;
  passagesJson: string;
};

/** Per job, a source's passages, each capped at 8 KiB like a file's. */
export function sourceChunks(output: SourceVectorOutput): string[] {
  const cached = chunkCache.get(output);
  if (cached) return cached;
  const index = parsePassageIndex(output.passagesJson);
  const chunks = index
    ? passageTexts(output.text, index.passages).map((text) =>
        capBody(text, 8192),
      )
    : [];
  chunkCache.set(output, chunks);
  return chunks;
}
const chunkCache = new WeakMap<SourceVectorOutput, string[]>();

export async function sourceVectorStamp(
  namespace: string,
  output: SourceVectorOutput,
  chunk: number,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      "valise-source-vector-1",
      VECTOR_MODEL,
      namespace,
      output.userId,
      output.sourceId,
      output.enrichmentId,
      chunk,
      sourceChunks(output)[chunk],
    ]),
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * A source's current enrichment: its newest ready attempt, the one
 * `sourceSearchStatements` publishes passages from, while the source is live.
 * A unary `+` on a `user_id` keeps SQLite on the per-source or per-enrichment
 * key; the user indexes match nearly every row of a single-owner instance.
 */
const CURRENT = `SELECT e.enrichment_id AS enrichmentId, e.user_id AS userId,
    e.source_id AS sourceId, sa.text, e.passages_json AS passagesJson
    FROM source_enrichments e
    JOIN sources s ON s.source_id = e.source_id AND s.user_id = e.user_id
    JOIN source_articles sa ON sa.source_id = s.source_id AND sa.user_id = s.user_id
      AND sa.revision = e.article_revision AND sa.detected = 1
    JOIN users u ON u.user_id = s.user_id AND (u.role = 'owner' OR u.email_verified = 1)
    WHERE e.state = 'ready' AND e.passages_json IS NOT NULL AND s.archived_at IS NULL
      AND e.enrichment_id = (SELECT f.enrichment_id FROM source_enrichments f
        WHERE f.source_id = e.source_id AND +f.user_id = e.user_id AND f.state = 'ready'
        ORDER BY f.created_at DESC, f.rowid DESC LIMIT 1)`;

/**
 * Enqueue every passage of one enrichment. No provider call, one statement,
 * so it fits in the batch that publishes the enrichment.
 */
export async function sourceVectorStatements(
  env: { DB: D1Database; VALISE_VECTOR_NAMESPACE?: string },
  output: SourceVectorOutput,
): Promise<D1PreparedStatement[]> {
  if (!env.VALISE_VECTOR_NAMESPACE) return [];
  const namespace = sourceVectorNamespace(env.VALISE_VECTOR_NAMESPACE);
  const stamps = await Promise.all(
    sourceChunks(output).map(async (_, chunk) => [
      chunk,
      await sourceVectorStamp(namespace, output, chunk),
    ]),
  );
  if (!stamps.length) return [];
  return [
    env.DB.prepare(
      `INSERT OR IGNORE INTO source_vector_pending (namespace, user_id, enrichment_id, source_id, chunk, stamp)
       SELECT ?, ?, ?, ?, s.value ->> '$[0]', s.value ->> '$[1]' FROM json_each(?) s`,
    ).bind(
      namespace,
      output.userId,
      output.enrichmentId,
      output.sourceId,
      JSON.stringify(stamps),
    ),
  ];
}

/**
 * Archive, restore, delete and a new enrichment dirty every recorded vector
 * of the source, in the batch that makes the change: the drain then deletes
 * what is no longer current and upserts what is.
 */
export function sourceVectorInvalidateStatement(
  db: D1Database,
  userId: string,
  sourceId: string,
) {
  return db
    .prepare(`UPDATE source_vector_pending SET epoch = epoch + 1,
    next_attempt_at = 0, mutation_id = NULL, error_code = NULL, attempts = 0
    WHERE source_id = ? AND user_id = ?`)
    .bind(sourceId, userId);
}

/** Recovery enqueue only: current enrichments, no provider capability. */
export async function backfillSourceVectors(
  env: { DB: D1Database; VALISE_VECTOR_NAMESPACE?: string },
  after = "",
) {
  if (!env.VALISE_VECTOR_NAMESPACE)
    throw new VectorSearchFailure("source vector namespace not configured");
  const { results } = await env.DB.prepare(
    `${CURRENT} AND s.source_id > ? ORDER BY s.source_id LIMIT 50`,
  )
    .bind(after)
    .all<SourceVectorOutput>();
  let queuedChunks = 0;
  for (const output of results) {
    const statements = await sourceVectorStatements(env, output);
    if (statements.length) {
      const inserted = await env.DB.batch(statements);
      queuedChunks += inserted.reduce(
        (sum, result) => sum + result.meta.changes,
        0,
      );
    }
  }
  return {
    cursor: results.at(-1)?.sourceId ?? after,
    done: results.length < 50,
    outputs: results.length,
    queuedChunks,
    delivered: false,
    visibilityVerified: false,
  };
}

type VectorJob = {
  userId: string;
  namespace: string;
  enrichmentId: string;
  sourceId: string;
  chunk: number;
  stamp: string;
  attempts: number;
  epoch: number;
};

/** Four bounded passages a minute in fair tenant turns, token-fenced retries. */
export async function maintainSourceVectors(env: VectorDeliveryEnv) {
  if (!env.VALISE_VECTOR_NAMESPACE || !env.AI || !env.VECTOR_INDEX)
    return { configured: false, delivered: 0, failed: 0 };
  const namespace = sourceVectorNamespace(env.VALISE_VECTOR_NAMESPACE);
  const drainToken = crypto.randomUUID();
  // The drain lease shares `asset_drain_state`, keyed by this namespace.
  const reservation =
    await env.DB.prepare(`INSERT INTO asset_drain_state(namespace, lease_token, lease_until)
    VALUES (?, ?, unixepoch() + 90) ON CONFLICT(namespace) DO UPDATE SET lease_token = excluded.lease_token,
    lease_until = excluded.lease_until WHERE asset_drain_state.lease_until <= unixepoch() RETURNING after_user_id`)
      .bind(namespace, drainToken)
      .first<{ after_user_id: string }>();
  if (!reservation)
    return { configured: true, delivered: 0, failed: 0, drainLeased: true };
  try {
    // Two current enrichments a minute that no path enqueued: imports,
    // restores, and the backlog from before this ledger existed.
    const { results: missing } = await env.DB.prepare(`${CURRENT}
      AND NOT EXISTS (SELECT 1 FROM source_vector_pending v WHERE v.enrichment_id = e.enrichment_id
      AND +v.user_id = e.user_id AND v.namespace = ?) LIMIT 2`)
      .bind(namespace)
      .all<SourceVectorOutput>();
    for (const output of missing) {
      const statements = await sourceVectorStatements(env, output);
      if (statements.length) await env.DB.batch(statements);
    }
    const tenantPage = async (after: string, limit: number, upper?: string) => {
      const bound = upper === undefined ? "" : "AND user_id <= ?";
      const { results } =
        await env.DB.prepare(`WITH RECURSIVE tenants(user_id, n) AS (
      SELECT (SELECT MIN(user_id) FROM source_vector_pending WHERE namespace = ? AND user_id > ? ${bound}), 1
      UNION ALL SELECT (SELECT MIN(user_id) FROM source_vector_pending WHERE namespace = ? AND user_id > tenants.user_id ${bound}), n + 1
      FROM tenants WHERE user_id IS NOT NULL AND n < ?
    ) SELECT user_id AS userId FROM tenants WHERE user_id IS NOT NULL`)
          .bind(
            namespace,
            after,
            ...(upper === undefined ? [] : [upper]),
            namespace,
            ...(upper === undefined ? [] : [upper]),
            limit,
          )
          .all<{ userId: string }>();
      return results;
    };
    const tenants = await tenantPage(reservation.after_user_id, 4);
    if (reservation.after_user_id && tenants.length < 4)
      tenants.push(
        ...(await tenantPage(
          "",
          4 - tenants.length,
          reservation.after_user_id,
        )),
      );
    const pages = await Promise.all(
      tenants.map(async ({ userId }) => {
        const { results } =
          await env.DB.prepare(`SELECT namespace, user_id AS userId,
    enrichment_id AS enrichmentId, source_id AS sourceId, chunk, stamp, attempts, epoch
    FROM source_vector_pending WHERE namespace = ? AND user_id = ? AND next_attempt_at <= unixepoch()
      AND lease_until <= unixepoch() ORDER BY next_attempt_at, enrichment_id, chunk LIMIT 4`)
            .bind(namespace, userId)
            .all<VectorJob>();
        return results;
      }),
    );
    const jobs: VectorJob[] = [];
    for (let round = 0; round < 4 && jobs.length < 4; round++) {
      for (const page of pages) {
        if (page[round]) jobs.push(page[round]);
        if (jobs.length === 4) break;
      }
    }
    await env.DB.prepare(
      "UPDATE asset_drain_state SET after_user_id = ? WHERE namespace = ? AND lease_token = ?",
    )
      .bind(
        tenants.at(-1)?.userId ?? reservation.after_user_id,
        namespace,
        drainToken,
      )
      .run();
    let delivered = 0;
    let failed = 0;
    let budgetDeferred = 0;
    for (const job of jobs) {
      const held = await env.DB.prepare(
        "SELECT 1 FROM asset_drain_state WHERE namespace = ? AND lease_token = ? AND lease_until > unixepoch()",
      )
        .bind(namespace, drainToken)
        .first();
      if (!held) break;
      const token = crypto.randomUUID();
      const claim =
        await env.DB.prepare(`UPDATE source_vector_pending SET lease_token = ?, lease_until = unixepoch() + 90
      WHERE namespace = ? AND user_id = ? AND enrichment_id = ? AND chunk = ? AND lease_until <= unixepoch()
         AND next_attempt_at <= unixepoch() RETURNING epoch`)
          .bind(token, namespace, job.userId, job.enrichmentId, job.chunk)
          .first<{ epoch: number }>();
      if (!claim) continue;
      job.epoch = claim.epoch;
      try {
        const output = await liveOutput(env.DB, job.userId, job.enrichmentId);
        const index = env.VECTOR_INDEX;
        let mutation: VectorizeAsyncMutation | VectorizeVectorMutation;
        if (!output) {
          mutation = await bounded<
            VectorizeAsyncMutation | VectorizeVectorMutation
          >(index.deleteByIds([job.stamp]), 5000);
        } else {
          const text = sourceChunks(output)[job.chunk];
          if (
            !text ||
            (await sourceVectorStamp(namespace, output, job.chunk)) !==
              job.stamp
          )
            throw new Error("invalid snapshot");
          if (
            !(await reserveEmbedding(
              env,
              job.userId,
              "source",
              utf8Bytes(text),
            ))
          ) {
            // Spent for today: no provider call, no failure, back at 00:00 UTC.
            await env.DB.prepare(`UPDATE source_vector_pending SET lease_token = NULL, lease_until = 0,
              error_code = ?, next_attempt_at = CASE WHEN epoch = ? THEN ${NEXT_UTC_DAY_SQL} ELSE 0 END
              WHERE namespace = ? AND user_id = ? AND enrichment_id = ? AND chunk = ? AND lease_token = ?`)
              .bind(
                DAILY_BUDGET_ERROR,
                job.epoch,
                namespace,
                job.userId,
                job.enrichmentId,
                job.chunk,
                token,
              )
              .run();
            budgetDeferred++;
            continue;
          }
          const embedding: unknown = await bounded(
            env.AI.run(
              VECTOR_MODEL,
              { text: [text] },
              { signal: AbortSignal.timeout(5000) },
            ),
            5000,
          ).catch(async (error: unknown) => {
            await recordEmbeddingFailure(env.DB, job.userId, "source");
            throw error;
          });
          mutation = await bounded<
            VectorizeAsyncMutation | VectorizeVectorMutation
          >(
            index.upsert([
              {
                id: job.stamp,
                namespace: `s:${await tenantVectorNamespace(env.VALISE_VECTOR_NAMESPACE, job.userId)}`,
                values: queryVector(embedding),
                metadata: {
                  docKey: `source:${job.sourceId}`,
                  enrichmentId: job.enrichmentId,
                  chunk: job.chunk,
                  stamp: job.stamp,
                },
              },
            ]),
            5000,
          );
        }
        if (
          !("mutationId" in mutation) ||
          typeof mutation.mutationId !== "string" ||
          !mutation.mutationId
        )
          throw new Error("missing acknowledgement");
        // A change during inference is repaired next tick, not tomorrow.
        const stillLive = await liveOutput(
          env.DB,
          job.userId,
          job.enrichmentId,
        );
        const settled =
          await env.DB.prepare(`UPDATE source_vector_pending SET lease_token = NULL, lease_until = 0,
        attempts = 0, error_code = NULL,
        mutation_id = CASE WHEN epoch = ? THEN ? ELSE NULL END,
        next_attempt_at = CASE WHEN epoch = ? THEN unixepoch() + ? ELSE 0 END
        WHERE namespace = ? AND user_id = ? AND enrichment_id = ? AND chunk = ? AND lease_token = ?`)
            .bind(
              job.epoch,
              mutation.mutationId,
              job.epoch,
              Boolean(output) === Boolean(stillLive) ? 86400 : 0,
              namespace,
              job.userId,
              job.enrichmentId,
              job.chunk,
              token,
            )
            .run();
        if (!settled.meta.changes) await repairUncertainMutation(env.DB, job);
        delivered++;
      } catch {
        const retried =
          await env.DB.prepare(`UPDATE source_vector_pending SET attempts = attempts + 1,
         lease_token = NULL, lease_until = MAX(lease_until, unixepoch() + 90), error_code = 'vector_delivery_failed',
         next_attempt_at = CASE WHEN epoch = ? THEN unixepoch() + ? ELSE 0 END
         WHERE namespace = ? AND user_id = ? AND enrichment_id = ? AND chunk = ? AND lease_token = ?`)
            .bind(
              job.epoch,
              Math.min(86400, 60 * 2 ** Math.min(job.attempts, 11)),
              namespace,
              job.userId,
              job.enrichmentId,
              job.chunk,
              token,
            )
            .run();
        if (!retried.meta.changes) await repairUncertainMutation(env.DB, job);
        failed++;
      }
    }
    return { configured: true, delivered, failed, budgetDeferred };
  } finally {
    await env.DB.prepare(
      "UPDATE asset_drain_state SET lease_token = NULL, lease_until = 0 WHERE namespace = ? AND lease_token = ?",
    )
      .bind(namespace, drainToken)
      .run();
  }
}

function repairUncertainMutation(db: D1Database, job: VectorJob) {
  // A late acknowledgement must not clear newer work; reopen the row instead.
  return db
    .prepare(`UPDATE source_vector_pending SET epoch = epoch + 1, next_attempt_at = 0, mutation_id = NULL
    WHERE namespace = ? AND user_id = ? AND enrichment_id = ? AND chunk = ?`)
    .bind(job.namespace, job.userId, job.enrichmentId, job.chunk)
    .run();
}

function liveOutput(db: D1Database, userId: string, enrichmentId: string) {
  return db
    .prepare(`${CURRENT} AND e.enrichment_id = ? AND e.user_id = ?`)
    .bind(enrichmentId, userId)
    .first<SourceVectorOutput>();
}

/**
 * Semantic candidates for bookmark passages, hydrated from the current
 * enrichment and every filter before reranking. Up to 256 eligible
 * bookmarks are prefiltered by key, as files are. A wider library queries
 * the owner's own partition without a key filter and drops what fails the
 * filters afterwards, rather than falling back to words alone: a person with
 * 900 bookmarks is the case this exists for.
 */
export async function sourceVectorCandidates(
  env: VectorBindings & { DB: D1Database; AI?: Pick<Ai, "run"> },
  filters: SearchFilters,
): Promise<ProjectionRow[]> {
  if (!filters.concepts?.includes("source") || !filters.userId) return [];
  if (!env.AI || !env.VECTOR_INDEX || !env.VALISE_VECTOR_NAMESPACE)
    throw new VectorSearchFailure("source vectors not configured");
  const namespace = sourceVectorNamespace(env.VALISE_VECTOR_NAMESPACE);
  const partition = `s:${await tenantVectorNamespace(env.VALISE_VECTOR_NAMESPACE, filters.userId)}`;
  const userId = filters.userId;
  const signal = AbortSignal.timeout(VECTOR_TIMEOUT_MS);
  const work = async () => {
    const { results: eligible } =
      await env.DB.prepare(`SELECT s.doc_key FROM search_docs s
      JOIN sources so ON so.source_id = s.concept_id AND s.concept = 'source'
        AND s.doc_key = 'source:' || so.source_id
      JOIN users u ON u.user_id = so.user_id AND (u.role = 'owner' OR u.email_verified = 1)
      WHERE so.user_id = ? AND s.user_id = so.user_id AND so.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM source_enrichments e WHERE e.source_id = so.source_id
          AND +e.user_id = so.user_id AND e.state = 'ready' AND e.passages_json IS NOT NULL)
        ${filters.project ? "AND s.project = ?" : ""}
        ${(filters.tags ?? []).map(() => "AND instr(' ' || s.tags || ' ', ' ' || ? || ' ') > 0").join(" ")}
        ${filters.sourceIds ? "AND so.source_id IN (SELECT value FROM json_each(?))" : ""}
      ORDER BY s.doc_key LIMIT ?`)
        .bind(
          userId,
          ...(filters.project ? [filters.project] : []),
          ...(filters.tags ?? []),
          ...(filters.sourceIds ? [JSON.stringify(filters.sourceIds)] : []),
          VECTOR_TAG_SCOPE_LIMIT + 1,
        )
        .all<{ doc_key: string }>();
    if (!eligible.length) return [];
    const scoped = eligible.length <= VECTOR_TAG_SCOPE_LIMIT;
    const scopes: (VectorizeVectorMetadataFilter | undefined)[] = [];
    if (scoped)
      for (let start = 0; start < eligible.length; start += 32)
        scopes.push({
          docKey: {
            $in: eligible.slice(start, start + 32).map((row) => row.doc_key),
          },
        });
    else scopes.push(undefined);
    signal.throwIfAborted();
    await reserveQueryEmbedding(env, filters.userId, filters.query);
    signal.throwIfAborted();
    const embedding: unknown = await env.AI?.run(
      VECTOR_MODEL,
      { text: [filters.query] },
      { signal },
    ).catch(async (error: unknown) => {
      await recordEmbeddingFailure(env.DB, filters.userId, "query");
      throw error;
    });
    signal.throwIfAborted();
    const vector = queryVector(embedding);
    const index = env.VECTOR_INDEX;
    if (!index) throw new VectorSearchFailure("source vectors not configured");
    const pages = await Promise.all(
      scopes.map((filter) =>
        index.query(vector, {
          namespace: partition,
          topK: VECTOR_DEPTH,
          returnMetadata: "all",
          returnValues: false,
          ...(filter ? { filter } : {}),
        }),
      ),
    );
    signal.throwIfAborted();
    const allowed = new Set(eligible.map((row) => row.doc_key));
    const refs = pages
      .flatMap((page) => page.matches)
      .sort((a, b) => b.score - a.score)
      .slice(0, VECTOR_DEPTH)
      .flatMap((match) => {
        const meta = match.metadata;
        return match.namespace === partition &&
          meta &&
          typeof meta.enrichmentId === "string" &&
          typeof meta.chunk === "number" &&
          Number.isInteger(meta.chunk) &&
          meta.chunk >= 0 &&
          typeof meta.stamp === "string" &&
          /^[a-f0-9]{64}$/.test(meta.stamp) &&
          meta.stamp === match.id &&
          typeof meta.docKey === "string" &&
          (!scoped || allowed.has(meta.docKey))
          ? [
              {
                enrichmentId: meta.enrichmentId,
                chunk: meta.chunk,
                stamp: meta.stamp,
                key: meta.docKey,
              },
            ]
          : [];
      });
    if (!refs.length) return [];
    // Hydration re-checks ownership, archive, the current enrichment and
    // every filter, so the unscoped query cannot leak or resurrect anything.
    const { results: outputs } = await env.DB.prepare(`SELECT o.*,
      d.project, d.title, d.tags, d.updated_at AS updatedAt
      FROM (${CURRENT}) o
      JOIN search_docs d ON d.doc_key = 'source:' || o.sourceId AND d.user_id = o.userId
      WHERE o.userId = ? AND o.enrichmentId IN (SELECT value FROM json_each(?))`)
      .bind(userId, JSON.stringify(refs.map((ref) => ref.enrichmentId)))
      .all<
        SourceVectorOutput & {
          project: string | null;
          title: string;
          tags: string;
          updatedAt: number;
        }
      >();
    const hits = new Map<string, ProjectionRow>();
    for (const ref of refs) {
      const output = outputs.find(
        (row) =>
          row.enrichmentId === ref.enrichmentId &&
          `source:${row.sourceId}` === ref.key,
      );
      // Keyed as its passage, so it merges with the lexical passage row.
      const key = `${ref.key}#${ref.chunk}`;
      const index = output && parsePassageIndex(output.passagesJson);
      const body = output ? sourceChunks(output)[ref.chunk] : undefined;
      if (
        !output ||
        !index ||
        body === undefined ||
        hits.has(key) ||
        (filters.project && output.project !== filters.project) ||
        (filters.sourceIds && !filters.sourceIds.includes(output.sourceId)) ||
        !(filters.tags ?? []).every((tag) =>
          ` ${output.tags} `.includes(` ${tag} `),
        ) ||
        (await sourceVectorStamp(namespace, output, ref.chunk)) !== ref.stamp
      )
        continue;
      hits.set(key, {
        userId: output.userId,
        docKey: key,
        concept: "source",
        conceptId: output.sourceId,
        project: output.project,
        title: index.passages[ref.chunk]?.label ?? "",
        body,
        tags: "",
        updatedAt: output.updatedAt,
      });
    }
    signal.throwIfAborted();
    return [...hits.values()];
  };
  return bounded(work(), VECTOR_TIMEOUT_MS);
}
