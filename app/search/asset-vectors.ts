import {
  MAX_PASSAGES,
  parsePassageIndex,
  passageTexts,
} from "~/concepts/asset-passages";
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

/** Deployment ledger identity; remote partitions are tenant-scoped below. */
export function assetVectorNamespace(base: string): string {
  return `a:${base}`;
}

export type AssetVectorOutput = {
  userId: string;
  processingId: string;
  assetId: string;
  originalSha256: string;
  text: string;
  /** The output's passage index; null for outputs from before passages. */
  passagesJson?: string | null;
};

/**
 * One vector per passage, so a semantic hit names its page. Outputs from
 * before passages keep their nine 8 KiB chunks of the text's start.
 */
export function assetChunks(output: AssetVectorOutput): string[] {
  // A candidate page checks many passages of one book; cut it once.
  const cached = chunkCache.get(output);
  if (cached) return cached;
  const index = parsePassageIndex(output.passagesJson);
  const chunks = index
    ? passageTexts(output.text, index.passages).map((text) =>
        capBody(text, 8192),
      )
    : assetTextChunks(output.text);
  chunkCache.set(output, chunks);
  return chunks;
}
const chunkCache = new WeakMap<AssetVectorOutput, string[]>();

export function assetTextChunks(text: string): string[] {
  const chunks: string[] = [];
  let rest = text;
  // Eight full chunks plus a possible UTF-8 boundary remainder.
  while (rest && chunks.length < 9) {
    const chunk = capBody(rest, 8192);
    chunks.push(chunk);
    rest = rest.slice(chunk.length);
  }
  return chunks;
}

export async function assetVectorStamp(
  namespace: string,
  output: AssetVectorOutput,
  chunk: number,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      "valise-asset-vector-1",
      VECTOR_MODEL,
      namespace,
      output.userId,
      output.assetId,
      output.processingId,
      output.originalSha256,
      chunk,
      assetChunks(output)[chunk],
    ]),
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Captured inside the successful extraction + FTS batch. No provider call.
 * One statement however many passages, so a book stays inside D1's
 * per-invocation statement budget. */
export async function assetVectorStatements(
  env: { DB: D1Database; VALISE_VECTOR_NAMESPACE?: string },
  output: AssetVectorOutput,
): Promise<D1PreparedStatement[]> {
  if (!env.VALISE_VECTOR_NAMESPACE) return [];
  const namespace = assetVectorNamespace(env.VALISE_VECTOR_NAMESPACE);
  const stamps = await Promise.all(
    assetChunks(output).map(async (_, chunk) => [
      chunk,
      await assetVectorStamp(namespace, output, chunk),
    ]),
  );
  return [
    env.DB.prepare(
      `INSERT OR IGNORE INTO asset_vector_pending (namespace, user_id, processing_id, asset_id, chunk, stamp)
      SELECT ?, o.user_id, o.processing_id, o.asset_id, s.value ->> '$[0]', s.value ->> '$[1]'
        FROM asset_processing_outputs o, json_each(?) s
       WHERE o.processing_id = ? AND o.user_id = ?`,
    ).bind(
      namespace,
      JSON.stringify(stamps),
      output.processingId,
      output.userId,
    ),
  ];
}

const CURRENT_OUTPUTS = `SELECT o.processing_id AS processingId, o.user_id AS userId,
    o.asset_id AS assetId, o.original_sha256 AS originalSha256, o.text, o.passages_json AS passagesJson
    FROM asset_processing_outputs o JOIN asset_processing_heads h USING (processing_id)
    JOIN assets a ON a.asset_id = h.asset_id AND a.user_id = h.user_id
    JOIN objects b ON b.object_id = a.object_id AND b.user_id = a.user_id AND b.sha256 = o.original_sha256
    JOIN users u ON u.user_id = a.user_id AND (u.role = 'owner' OR u.email_verified = 1)
    WHERE o.user_id = h.user_id AND o.asset_id = a.asset_id AND o.object_id = a.object_id
      AND a.state = 'ready' AND a.archived_at IS NULL
      AND (a.expires_at IS NULL OR a.expires_at > unixepoch())`;

/** Recovery enqueue only: current immutable outputs, no R2 read or provider capability. */
export async function backfillAssetVectors(
  env: { DB: D1Database; VALISE_VECTOR_NAMESPACE?: string },
  after = "",
) {
  if (!env.VALISE_VECTOR_NAMESPACE)
    throw new VectorSearchFailure("asset vector namespace not configured");
  const { results } = await env.DB.prepare(
    `${CURRENT_OUTPUTS} AND a.asset_id > ? ORDER BY a.asset_id LIMIT 50`,
  )
    .bind(after)
    .all<AssetVectorOutput>();
  let queuedChunks = 0;
  for (const output of results) {
    const statements = await assetVectorStatements(env, output);
    if (statements.length) {
      const inserted = await env.DB.batch(statements);
      queuedChunks += inserted.reduce(
        (sum, result) => sum + result.meta.changes,
        0,
      );
    }
  }
  return {
    cursor: results.at(-1)?.assetId ?? after,
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
  processingId: string;
  assetId: string;
  chunk: number;
  stamp: string;
  attempts: number;
  epoch: number;
};

/** Publication changes dirty every recorded namespace in the authoritative batch. */
export function assetVectorInvalidateStatement(
  db: D1Database,
  userId: string,
  assetId: string,
) {
  return db
    .prepare(`UPDATE asset_vector_pending SET epoch = epoch + 1,
    next_attempt_at = 0, mutation_id = NULL, error_code = NULL, attempts = 0
    WHERE asset_id = ? AND user_id = ?`)
    .bind(assetId, userId);
}

/** Four bounded chunks/minute, token-fenced retries, retained delete targets. */
export async function maintainAssetVectors(env: VectorDeliveryEnv) {
  if (!env.VALISE_VECTOR_NAMESPACE || !env.AI || !env.VECTOR_INDEX)
    return { configured: false, delivered: 0, failed: 0 };
  const namespace = assetVectorNamespace(env.VALISE_VECTOR_NAMESPACE);
  const drainToken = crypto.randomUUID();
  const reservation =
    await env.DB.prepare(`INSERT INTO asset_drain_state(namespace, lease_token, lease_until)
    VALUES (?, ?, unixepoch() + 90) ON CONFLICT(namespace) DO UPDATE SET lease_token = excluded.lease_token,
    lease_until = excluded.lease_until WHERE asset_drain_state.lease_until <= unixepoch() RETURNING after_user_id`)
      .bind(namespace, drainToken)
      .first<{ after_user_id: string }>();
  if (!reservation)
    return { configured: true, delivered: 0, failed: 0, drainLeased: true };
  try {
    const { results: missing } = await env.DB.prepare(`${CURRENT_OUTPUTS}
      AND NOT EXISTS (SELECT 1 FROM asset_vector_pending v WHERE v.processing_id = o.processing_id
      AND v.user_id = o.user_id AND v.namespace = ?) LIMIT 2`)
      .bind(namespace)
      .all<AssetVectorOutput>();
    for (const output of missing) {
      const statements = await assetVectorStatements(env, output);
      if (statements.length) await env.DB.batch(statements);
    }
    const tenantPage = async (after: string, limit: number, upper?: string) => {
      const bound = upper === undefined ? "" : "AND user_id <= ?";
      const { results } =
        await env.DB.prepare(`WITH RECURSIVE tenants(user_id, n) AS (
      SELECT (SELECT MIN(user_id) FROM asset_vector_pending WHERE namespace = ? AND user_id > ? ${bound}), 1
      UNION ALL SELECT (SELECT MIN(user_id) FROM asset_vector_pending WHERE namespace = ? AND user_id > tenants.user_id ${bound}), n + 1
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
    processing_id AS processingId, asset_id AS assetId, chunk, stamp, attempts, epoch
    FROM asset_vector_pending WHERE namespace = ? AND user_id = ? AND next_attempt_at <= unixepoch()
      AND lease_until <= unixepoch() ORDER BY next_attempt_at, processing_id, chunk LIMIT 4`)
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
        await env.DB.prepare(`UPDATE asset_vector_pending SET lease_token = ?, lease_until = unixepoch() + 90
      WHERE namespace = ? AND user_id = ? AND processing_id = ? AND chunk = ? AND lease_until <= unixepoch()
         AND next_attempt_at <= unixepoch() RETURNING epoch`)
          .bind(token, namespace, job.userId, job.processingId, job.chunk)
          .first<{ epoch: number }>();
      if (!claim) continue;
      job.epoch = claim.epoch;
      try {
        const output = await liveOutput(env.DB, job.userId, job.processingId);
        const index = env.VECTOR_INDEX;
        let mutation: VectorizeAsyncMutation | VectorizeVectorMutation;
        if (!output) {
          mutation = await bounded<
            VectorizeAsyncMutation | VectorizeVectorMutation
          >(index.deleteByIds([job.stamp]), 5000);
        } else {
          const text = assetChunks(output)[job.chunk];
          if (
            !text ||
            (await assetVectorStamp(namespace, output, job.chunk)) !== job.stamp
          )
            throw new Error("invalid snapshot");
          if (
            !(await reserveEmbedding(env, job.userId, "asset", utf8Bytes(text)))
          ) {
            // Spent for today: no provider call, no failure, back at 00:00 UTC.
            await env.DB.prepare(`UPDATE asset_vector_pending SET lease_token = NULL, lease_until = 0,
              error_code = ?, next_attempt_at = CASE WHEN epoch = ? THEN ${NEXT_UTC_DAY_SQL} ELSE 0 END
              WHERE namespace = ? AND user_id = ? AND processing_id = ? AND chunk = ? AND lease_token = ?`)
              .bind(
                DAILY_BUDGET_ERROR,
                job.epoch,
                namespace,
                job.userId,
                job.processingId,
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
            await recordEmbeddingFailure(env.DB, job.userId, "asset");
            throw error;
          });
          mutation = await bounded<
            VectorizeAsyncMutation | VectorizeVectorMutation
          >(
            index.upsert([
              {
                id: job.stamp,
                namespace: `a:${await tenantVectorNamespace(env.VALISE_VECTOR_NAMESPACE, job.userId)}`,
                values: queryVector(embedding),
                metadata: {
                  docKey: `asset:${job.assetId}`,
                  processingId: job.processingId,
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
        // A publication change during inference is repaired next tick, not tomorrow.
        const stillLive = await liveOutput(
          env.DB,
          job.userId,
          job.processingId,
        );
        const settled =
          await env.DB.prepare(`UPDATE asset_vector_pending SET lease_token = NULL, lease_until = 0,
        attempts = 0, error_code = NULL,
        mutation_id = CASE WHEN epoch = ? THEN ? ELSE NULL END,
        next_attempt_at = CASE WHEN epoch = ? THEN unixepoch() + ? ELSE 0 END
        WHERE namespace = ? AND user_id = ? AND processing_id = ? AND chunk = ? AND lease_token = ?`)
            .bind(
              job.epoch,
              mutation.mutationId,
              job.epoch,
              Boolean(output) === Boolean(stillLive) ? 86400 : 0,
              namespace,
              job.userId,
              job.processingId,
              job.chunk,
              token,
            )
            .run();
        if (!settled.meta.changes)
          await repairUncertainAssetMutation(env.DB, job);
        delivered++;
      } catch {
        const retried =
          await env.DB.prepare(`UPDATE asset_vector_pending SET attempts = attempts + 1,
         lease_token = NULL, lease_until = MAX(lease_until, unixepoch() + 90), error_code = 'vector_delivery_failed',
         next_attempt_at = CASE WHEN epoch = ? THEN unixepoch() + ? ELSE 0 END
         WHERE namespace = ? AND user_id = ? AND processing_id = ? AND chunk = ? AND lease_token = ?`)
            .bind(
              job.epoch,
              Math.min(86400, 60 * 2 ** Math.min(job.attempts, 11)),
              namespace,
              job.userId,
              job.processingId,
              job.chunk,
              token,
            )
            .run();
        if (!retried.meta.changes)
          await repairUncertainAssetMutation(env.DB, job);
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

function repairUncertainAssetMutation(db: D1Database, job: VectorJob) {
  // A timed-out or lease-losing caller cannot clear another worker's lease,
  // but it must reopen repair work after a possibly late external mutation.
  return db
    .prepare(`UPDATE asset_vector_pending SET epoch = epoch + 1, next_attempt_at = 0, mutation_id = NULL
    WHERE namespace = ? AND user_id = ? AND processing_id = ? AND chunk = ?`)
    .bind(job.namespace, job.userId, job.processingId, job.chunk)
    .run();
}

function liveOutput(db: D1Database, userId: string, processingId: string) {
  return db
    .prepare(`SELECT o.processing_id AS processingId, o.user_id AS userId, o.asset_id AS assetId,
    o.original_sha256 AS originalSha256, o.text, o.passages_json AS passagesJson FROM asset_processing_outputs o
    JOIN asset_processing_heads h USING (processing_id) JOIN assets a ON a.asset_id = h.asset_id
    JOIN users u ON u.user_id = a.user_id AND (u.role = 'owner' OR u.email_verified = 1)
    WHERE o.processing_id = ? AND o.user_id = ? AND h.user_id = ? AND a.user_id = ?
      AND a.state = 'ready' AND a.archived_at IS NULL
      AND a.object_id = o.object_id AND (a.expires_at IS NULL OR a.expires_at > unixepoch())`)
    .bind(processingId, userId, userId, userId)
    .first<AssetVectorOutput>();
}

/** Candidate hints hydrate owned, published current output before any reranking. */
export async function assetVectorCandidates(
  env: VectorBindings & { DB: D1Database; AI?: Pick<Ai, "run"> },
  filters: SearchFilters,
): Promise<ProjectionRow[]> {
  if (!filters.concepts?.includes("asset") || !filters.userId) return [];
  if (!env.AI || !env.VECTOR_INDEX || !env.VALISE_VECTOR_NAMESPACE)
    throw new VectorSearchFailure("asset vectors not configured");
  const namespace = assetVectorNamespace(env.VALISE_VECTOR_NAMESPACE);
  const partition = `a:${await tenantVectorNamespace(env.VALISE_VECTOR_NAMESPACE, filters.userId)}`;
  const signal = AbortSignal.timeout(VECTOR_TIMEOUT_MS);
  const work = async () => {
    const scopes: VectorizeVectorMetadataFilter[] = [];
    // Asset ownership is always enforced before ANN as well as after. Scoped
    // keys are partitioned exactly like the memory all-tag path (P9 vocabulary).
    const { results: eligible } =
      await env.DB.prepare(`SELECT s.doc_key FROM search_docs s
      JOIN assets a ON a.asset_id = s.concept_id AND s.concept = 'asset'
        AND s.doc_key = 'asset:' || a.asset_id
      JOIN users u ON u.user_id = a.user_id AND (u.role = 'owner' OR u.email_verified = 1)
      JOIN asset_processing_heads h ON h.asset_id = a.asset_id AND h.user_id = a.user_id
      WHERE a.user_id = ? AND s.user_id = a.user_id AND a.state = 'ready' AND a.archived_at IS NULL
        AND (a.expires_at IS NULL OR a.expires_at > unixepoch())
        ${filters.project ? "AND s.project = ?" : ""}
        ${(filters.tags ?? []).map(() => "AND instr(' ' || s.tags || ' ', ' ' || ? || ' ') > 0").join(" ")}
      ORDER BY s.doc_key LIMIT ?`)
        .bind(
          filters.userId,
          ...(filters.project ? [filters.project] : []),
          ...(filters.tags ?? []),
          VECTOR_TAG_SCOPE_LIMIT + 1,
        )
        .all<{ doc_key: string }>();
    if (eligible.length > VECTOR_TAG_SCOPE_LIMIT)
      throw new VectorSearchFailure("asset vector scope exceeds 256 heads");
    if (!eligible.length) return [];
    for (let start = 0; start < eligible.length; start += 32)
      scopes.push({
        docKey: {
          $in: eligible.slice(start, start + 32).map((row) => row.doc_key),
        },
      });
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
    if (!index) throw new VectorSearchFailure("asset vectors not configured");
    const pages = await Promise.all(
      scopes.map((filter) =>
        index.query(vector, {
          namespace: partition,
          topK: VECTOR_DEPTH,
          returnMetadata: "all",
          returnValues: false,
          filter,
        }),
      ),
    );
    signal.throwIfAborted();
    const matches = pages
      .flatMap((page) => page.matches)
      .sort((a, b) => b.score - a.score)
      .slice(0, VECTOR_DEPTH);
    const refs = matches.flatMap((match) => {
      const meta = match.metadata;
      return match.namespace === partition &&
        meta &&
        typeof meta.processingId === "string" &&
        typeof meta.chunk === "number" &&
        Number.isInteger(meta.chunk) &&
        meta.chunk >= 0 &&
        meta.chunk < MAX_PASSAGES &&
        typeof meta.stamp === "string" &&
        /^[a-f0-9]{64}$/.test(meta.stamp) &&
        meta.stamp === match.id &&
        typeof meta.docKey === "string" &&
        eligible.some((row) => row.doc_key === meta.docKey)
        ? [
            {
              processingId: meta.processingId,
              chunk: meta.chunk,
              stamp: meta.stamp,
              key: meta.docKey,
            },
          ]
        : [];
    });
    if (!refs.length) return [];
    const { results: outputs } =
      await env.DB.prepare(`SELECT o.processing_id AS processingId, o.user_id AS userId,
      o.asset_id AS assetId, o.original_sha256 AS originalSha256, o.text,
      o.passages_json AS passagesJson,
      s.project, s.title, s.tags, s.updated_at AS updatedAt
      FROM asset_processing_outputs o JOIN asset_processing_heads h USING (processing_id)
      JOIN assets a ON a.asset_id = h.asset_id JOIN search_docs s ON s.doc_key = 'asset:' || a.asset_id
      JOIN users u ON u.user_id = a.user_id AND (u.role = 'owner' OR u.email_verified = 1)
      WHERE a.user_id = ? AND o.user_id = a.user_id AND h.user_id = a.user_id AND s.user_id = a.user_id
        AND a.state = 'ready' AND a.archived_at IS NULL AND a.object_id = o.object_id
        AND (a.expires_at IS NULL OR a.expires_at > unixepoch())
        AND o.processing_id IN (SELECT value FROM json_each(?))`)
        .bind(
          filters.userId,
          JSON.stringify(refs.map((ref) => ref.processingId)),
        )
        .all<
          AssetVectorOutput & {
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
          row.processingId === ref.processingId &&
          `asset:${row.assetId}` === ref.key,
      );
      // A passage hit keys as its passage, so it merges with the lexical
      // row for the same page; a pre-passage chunk keys as its asset.
      const index = output && parsePassageIndex(output.passagesJson);
      const key = index ? `${ref.key}#${ref.chunk}` : ref.key;
      if (
        !output ||
        hits.has(key) ||
        (filters.project && output.project !== filters.project) ||
        !(filters.tags ?? []).every((tag) =>
          ` ${output.tags} `.includes(` ${tag} `),
        ) ||
        (await assetVectorStamp(namespace, output, ref.chunk)) !== ref.stamp
      )
        continue;
      hits.set(key, {
        userId: output.userId,
        docKey: key,
        concept: "asset",
        conceptId: output.assetId,
        project: output.project,
        title: index ? (index.passages[ref.chunk]?.label ?? "") : output.title,
        body: assetChunks(output)[ref.chunk],
        tags: output.tags,
        updatedAt: output.updatedAt,
      });
    }
    signal.throwIfAborted();
    return [...hits.values()];
  };
  return bounded(work(), VECTOR_TIMEOUT_MS);
}

export async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new VectorSearchFailure("asset vector timeout")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
