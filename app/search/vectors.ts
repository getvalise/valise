import {
  type EmbeddingBudgetEnv,
  recordEmbeddingFailure,
  reserveEmbedding,
  utf8Bytes,
} from "~/search/embedding-budget";
import { docKey, type ProjectionRow, projectMemory } from "~/search/project";
import type { SearchFilters } from "~/search/query";

export const VECTOR_MODEL = "@cf/baai/bge-m3";
export const VECTOR_DEPTH = 50;
// Live bge-m3 cold requests exceeded the original one-second experiment budget.
// Keep a finite end-to-end bound including metadata-filter fan-out/hydration.
export const VECTOR_TIMEOUT_MS = 2500;
const DIMENSIONS = 1024;
// Bound indexed-id filter fan-out and preserve the search deadline. Oversized
// tag scopes explicitly fall back to lexical search, never a truncated ANN set.
export const VECTOR_TAG_SCOPE_LIMIT = 256;
const SCOPE_PAGE = 32;

export async function vectorProjectKey(project: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(project),
  );
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Fixed-width, deployment+tenant partition; neither component may be omitted. */
export async function tenantVectorNamespace(
  deployment: string,
  userId: string,
): Promise<string> {
  if (!deployment || !userId)
    throw new VectorSearchFailure("vector tenant not configured");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(["tenant-v1", deployment, userId])),
  );
  // 45 ASCII bytes, leaving room for the disjoint h: historical partition.
  return `t:${btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")}`;
}

/** Optional capabilities until the vector delivery/index rollout is verified. */
export type VectorBindings = EmbeddingBudgetEnv & {
  VECTOR_INDEX?: Pick<Vectorize, "query">;
  /** Deployment-owned identity, combined with the authenticated tenant. */
  VALISE_VECTOR_NAMESPACE?: string;
};

export class VectorSearchFailure extends Error {}

export const DAILY_BUDGET_FALLBACK = "daily embedding budget reached";

/** Meter a search-time query embedding; refuse it once today's budget is spent. */
export async function reserveQueryEmbedding(
  env: { DB: D1Database } & EmbeddingBudgetEnv,
  userId: string,
  query: string,
): Promise<void> {
  if (!(await reserveEmbedding(env, userId, "query", utf8Bytes(query))))
    throw new VectorSearchFailure(DAILY_BUDGET_FALLBACK);
}

export type MemoryVectorHead = {
  projection: ProjectionRow;
  /** Revisions snapshot pre-edit content; the live head starts at generation 1. */
  generation: number;
};

/** The vector id and freshness stamp, including the workspace and model version. */
export async function memoryVectorStamp(
  namespace: string,
  head: MemoryVectorHead,
): Promise<string> {
  const p = head.projection;
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      "valise-memory-vector-1",
      VECTOR_MODEL,
      namespace,
      p.docKey,
      head.generation,
      p.project,
      p.title,
      p.body,
      p.tags,
      p.updatedAt,
    ]),
  );
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Candidate ids are hints, not content or authority. Hydrate current live heads
 * from D1 and reject stale stamps before any text goes to the reranker.
 * No store scan or embedding cache is part of search. Its one write meters
 * the query embedding against the owner's daily budget; a spent budget is a
 * `VectorSearchFailure`, so search falls back to lexical order and says why.
 */
export async function memoryVectorCandidates(
  env: VectorBindings & { DB: D1Database; AI?: Pick<Ai, "run"> },
  filters: SearchFilters,
): Promise<ProjectionRow[]> {
  if (filters.concepts?.length && !filters.concepts.includes("memory"))
    return [];
  const namespace = env.VALISE_VECTOR_NAMESPACE;
  const index = env.VECTOR_INDEX;
  const ai = env.AI;
  if (!namespace || !index || !ai) {
    throw new VectorSearchFailure("vectors not configured");
  }

  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new VectorSearchFailure(
        `vector timeout ${VECTOR_TIMEOUT_MS} ms`,
      );
      stop.abort(error);
      reject(error);
    }, VECTOR_TIMEOUT_MS);
  });
  const candidates = async () => {
    const tenantNamespace = await tenantVectorNamespace(
      namespace,
      filters.userId,
    );
    stop.signal.throwIfAborted();
    await reserveQueryEmbedding(env, filters.userId, filters.query);
    stop.signal.throwIfAborted();
    const out: unknown = await ai
      .run(VECTOR_MODEL, { text: [filters.query] }, { signal: stop.signal })
      .catch(async (error: unknown) => {
        await recordEmbeddingFailure(env.DB, filters.userId, "query");
        throw error;
      });
    stop.signal.throwIfAborted();
    const vector = queryVector(out);
    const projectFilter: VectorizeVectorMetadataFilter = filters.project
      ? { project: await vectorProjectKey(filters.project) }
      : {};
    const scopes: VectorizeVectorMetadataFilter[] = [];
    if (filters.tags?.length) {
      const { results } = await env.DB.prepare(`SELECT doc_key FROM search_docs
        WHERE user_id = ? AND concept = 'memory' ${filters.project ? "AND project = ?" : ""}
        ${filters.tags.map(() => "AND instr(' ' || tags || ' ', ' ' || ? || ' ') > 0").join(" ")}
        ORDER BY doc_key LIMIT ?`)
        .bind(
          filters.userId,
          ...(filters.project ? [filters.project] : []),
          ...filters.tags,
          VECTOR_TAG_SCOPE_LIMIT + 1,
        )
        .all<{ doc_key: string }>();
      if (results.length > VECTOR_TAG_SCOPE_LIMIT)
        throw new VectorSearchFailure(
          `vector tag scope exceeds ${VECTOR_TAG_SCOPE_LIMIT} heads`,
        );
      if (!results.length) return [];
      for (let start = 0; start < results.length; start += SCOPE_PAGE)
        scopes.push({
          ...projectFilter,
          docKey: {
            $in: results
              .slice(start, start + SCOPE_PAGE)
              .map((row) => row.doc_key),
          },
        });
    } else if (filters.project) scopes.push(projectFilter);
    // A delayed scoped D1 read must not start remote ANN work after fallback.
    stop.signal.throwIfAborted();
    const pages = await Promise.all(
      (scopes.length ? scopes : [undefined]).map((filter) =>
        index.query(vector, {
          namespace: tenantNamespace,
          topK: VECTOR_DEPTH,
          returnMetadata: "all",
          returnValues: false,
          ...(filter ? { filter } : {}),
        }),
      ),
    );
    const matches = pages
      .flatMap((page) => page.matches)
      .sort((a, b) => b.score - a.score)
      .slice(0, VECTOR_DEPTH);
    // Vectorize's binding has no cancellation option. Ignore late results and
    // do not start hydration after the deadline.
    stop.signal.throwIfAborted();
    const refs = matches.flatMap((match) => {
      const key = match.metadata?.docKey;
      const stamp = match.metadata?.stamp;
      return match.namespace === tenantNamespace &&
        typeof key === "string" &&
        key.startsWith("memory:") &&
        typeof stamp === "string" &&
        /^[a-f0-9]{64}$/.test(stamp) &&
        match.id === stamp
        ? [{ key, stamp }]
        : [];
    });
    if (!refs.length) return [];
    // Namespace filtering precedes ANN topK. Still treat the index as untrusted:
    // only current, published heads owned by the authenticated tenant hydrate.
    const { results } = await env.DB.prepare(
      `SELECT m.memory_id, m.user_id, m.memory_type, m.title, m.body, m.tags_json,
              m.project, m.updated_at,
              1 + COALESCE((SELECT MAX(revision) FROM memory_revisions r
                            WHERE r.memory_id = m.memory_id), 0) AS generation
         FROM memories m
         JOIN search_docs si ON si.concept_id = m.memory_id AND si.concept = 'memory'
                            AND si.user_id = m.user_id
        WHERE m.deleted_at IS NULL AND m.user_id = ?
          AND si.doc_key IN (SELECT value FROM json_each(?))`,
    )
      .bind(filters.userId, JSON.stringify(refs.map((ref) => ref.key)))
      .all<MemoryHeadRow>();
    const heads = new Map<string, ProjectionRow>();
    await Promise.all(
      results.map(async (row) => {
        const projection = projectMemory({
          memoryId: row.memory_id,
          userId: row.user_id,
          memoryType: row.memory_type,
          title: row.title,
          body: row.body,
          tagsJson: row.tags_json,
          project: row.project,
          deletedAt: null,
          updatedAt: row.updated_at,
        });
        if (!projection || !allows(filters, projection)) return;
        const stamp = await memoryVectorStamp(namespace, {
          projection,
          generation: row.generation,
        });
        if (
          refs.some(
            (ref) => ref.key === projection.docKey && ref.stamp === stamp,
          )
        ) {
          heads.set(projection.docKey, projection);
        }
      }),
    );
    stop.signal.throwIfAborted();
    const annOrderedHeads = new Map<string, ProjectionRow>();
    for (const ref of refs) {
      const head = heads.get(ref.key);
      if (head) annOrderedHeads.set(docKey("memory", head.conceptId), head);
    }
    return [...annOrderedHeads.values()];
  };
  try {
    return await Promise.race([candidates(), timeout]);
  } finally {
    clearTimeout(timer);
    stop.abort();
  }
}

export function queryVector(out: unknown): number[] {
  if (
    typeof out === "object" &&
    out !== null &&
    "data" in out &&
    Array.isArray(out.data) &&
    out.data.length === 1
  ) {
    const vector: unknown = out.data[0];
    if (
      Array.isArray(vector) &&
      vector.length === DIMENSIONS &&
      vector.every(
        (n: unknown) => typeof n === "number" && Number.isFinite(n),
      ) &&
      vector.some((n) => n !== 0)
    )
      return vector;
  }
  throw new VectorSearchFailure("invalid query embedding");
}

function allows(filters: SearchFilters, row: ProjectionRow): boolean {
  return (
    (!filters.project || row.project === filters.project) &&
    (filters.tags ?? []).every((tag) => ` ${row.tags} `.includes(` ${tag} `))
  );
}

type MemoryHeadRow = {
  memory_id: string;
  user_id: string;
  memory_type: string;
  title: string | null;
  body: string;
  tags_json: string;
  project: string | null;
  updated_at: number;
  generation: number;
};
