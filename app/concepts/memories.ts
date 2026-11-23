import { memoryProjectionStatements } from "~/search/memory";
import { docKey } from "~/search/project";
import { type HitProvenance, readProvenance } from "~/search/provenance";
import { search } from "~/search/query";
import { vectorSnapshotStatement } from "~/search/vector-outbox";
import { everyTagSql, type ListFilters, tagsParam } from "./list-filters";
import {
  type MemoryRelation,
  memoryLinkBatch,
  memoryLinkStatements,
} from "./memory-links";
import type { ListWindow } from "./pagination";

export type Provenance = {
  userId: string;
  agent: string;
  client: string;
  session: string | null;
  /**
   * What the session calls itself, such as `mcp-guides-improvements-1a`, from
   * the plugin's `X-Valise-Session-Name` header. A label beside `agent`, never
   * in place of it: `agent` stays the identity that holds leases. ADR-0004.
   */
  sessionName?: string | null;
};

export type SavedMemory = {
  id: string;
  type: string;
  title: string;
  body: string;
  tags: string[];
  project: string | null;
  createdAt: number;
};

export type ConsoleMemory = {
  id: string;
  type: string;
  title: string;
  body: string;
  tags: string[];
  project: string | null;
  sourceAgent: string;
  sourceClient: string;
  sourceSession: string | null;
  sourceSessionName: string | null;
  createdAt: number;
  updatedAt: number;
};

/** A new memory, from save_memory or the tenant store. */
export type MemoryDraft = {
  type: string;
  title: string;
  body: string;
  tags: string[];
  project?: string;
  relates?: MemoryRelation[];
  /** Raw subject ids (`sub_…`). Each must be a live subject of this user. */
  subjects?: string[];
};

/** A subject named on save was missing, foreign or deleted; nothing was written. */
export class MemorySubjectError extends Error {}

export type MemoryEdit = {
  type: string;
  title: string;
  body: string;
  project: string | null;
  tags: readonly string[];
};

export async function saveMemory(
  env: { DB: D1Database; VALISE_VECTOR_NAMESPACE?: string },
  input: MemoryDraft,
  provenance: Provenance,
): Promise<SavedMemory> {
  const id = `mem_${crypto.randomUUID()}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const tagsJson = JSON.stringify(input.tags);
  const project = input.project ?? null;
  const title = input.title ?? "";
  const links = await memoryLinkStatements(
    env.DB,
    id,
    input.relates ?? [],
    provenance,
  );

  await memoryLinkBatch(env.DB, [
    env.DB.prepare(
      `INSERT INTO memories (
          memory_id, user_id, memory_type, title, body, tags_json, project,
          source_agent, source_client, source_session, source_session_name,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      provenance.userId,
      input.type,
      title || null,
      input.body,
      tagsJson,
      project,
      provenance.agent,
      provenance.client,
      provenance.session,
      provenance.sessionName ?? null,
      createdAt,
      createdAt,
    ),
    ...links,
    ...subjectMemberStatements(
      env.DB,
      id,
      input.subjects ?? [],
      provenance,
      createdAt,
    ),
    ...memoryProjectionStatements(env.DB, id, env),
  ]).catch((error: unknown) => {
    if (
      error instanceof Error &&
      error.message.includes(
        "NOT NULL constraint failed: memory_subject_members.subject_id",
      )
    )
      throw new MemorySubjectError(
        "A subject in subjects is not a live subject of yours. Find it with list_subjects and try again.",
        { cause: error },
      );
    throw error;
  });

  return {
    id: docKey("memory", id),
    type: input.type,
    title,
    body: input.body,
    tags: input.tags,
    project,
    createdAt,
  };
}

/**
 * Confirmed memberships an agent asked for while saving, recorded as the
 * model's assertion like `edit_subject`'s `add_members` (ADR-0003, 2026-11-04).
 * A missing, foreign or deleted subject selects NULL into a NOT NULL column,
 * which fails the whole batch, so the memory is never saved without them.
 */
function subjectMemberStatements(
  db: D1Database,
  memoryId: string,
  subjectIds: readonly string[],
  provenance: Provenance,
  now: number,
) {
  return [...new Set(subjectIds)].map((subjectId) =>
    db
      .prepare(
        `INSERT INTO memory_subject_members
          (subject_id, memory_id, asserted_by, confirmed_at, confirmed_by, created_at)
        VALUES ((SELECT subject_id FROM memory_subjects
          WHERE subject_id = ? AND user_id = ? AND deleted_at IS NULL), ?, 'model', ?, ?, ?)`,
      )
      .bind(
        subjectId,
        provenance.userId,
        memoryId,
        now,
        provenance.userId,
        now,
      ),
  );
}

/** Dated and attributed, so the caller can tell a stale claim from a live one. */
export type SimilarMemory = {
  id: string;
  title: string;
} & Partial<HitProvenance>;

/** Three ids and titles keep the save result one glance long. */
const SIMILAR_LIMIT = 3;

/**
 * Memories that may already hold the claim about to be saved, for the line
 * `save_memory` returns. The title is the query, because it is the claim in
 * one sentence; a whole body as a query matches every memory on its filler
 * words. Same project first, where a restated lesson usually lives, then
 * everywhere. Called before the insert, so the new memory is never its own
 * hit. No score threshold: BM25 scores do not compare across queries, so the
 * model judges the three rather than the server guessing a cutoff.
 */
export async function similarMemories(
  env: { DB: D1Database },
  userId: string,
  title: string,
  project: string | null,
): Promise<SimilarMemory[]> {
  const scoped = project
    ? await search(env, {
        query: title,
        userId,
        concepts: ["memory"],
        project,
        limit: SIMILAR_LIMIT,
      })
    : [];
  const everywhere =
    scoped.length < SIMILAR_LIMIT
      ? await search(env, {
          query: title,
          userId,
          concepts: ["memory"],
          limit: SIMILAR_LIMIT,
        })
      : [];
  const seen = new Set<string>();
  const hits = [...scoped, ...everywhere]
    .filter((hit) => !seen.has(hit.docKey) && seen.add(hit.docKey))
    .slice(0, SIMILAR_LIMIT);
  const provenance = await readProvenance(env.DB, userId, hits);
  return hits.map((hit) => ({
    id: hit.docKey,
    title: hit.title,
    ...provenance.get(hit.docKey),
  }));
}

export async function countMemories(
  db: D1Database,
  userId: string,
  filters: ListFilters = {},
) {
  const row = await memoryListStatement(
    db,
    filters,
    "SELECT COUNT(*) AS total",
    "",
  )
    .bind(userId, ...memoryListParams(userId, filters))
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function listMemories(
  db: D1Database,
  userId: string,
  filters: ListFilters = {},
  window?: ListWindow,
): Promise<ConsoleMemory[]> {
  const { results } = await memoryListStatement(
    db,
    filters,
    `SELECT memory_id, memory_type, title, body, tags_json, project,
              source_agent, source_client, source_session, source_session_name,
              created_at, updated_at`,
    `ORDER BY ${usageOrder(filters.sort)} updated_at DESC, memory_id
       LIMIT ? OFFSET ?`,
  )
    .bind(
      userId,
      ...memoryListParams(userId, filters),
      window?.limit ?? -1,
      window?.offset ?? 0,
    )
    .all<MemoryRow>();
  return results.map(consoleMemory);
}

/** The owner binds first, then once more inside the usage join when sorted by it. */
function memoryListParams(userId: string, filters: ListFilters) {
  return [
    ...(usageOrder(filters.sort) ? [userId] : []),
    filters.query ?? "",
    filters.query ?? "",
    filters.query ?? "",
    filters.project ?? null,
    filters.project ?? null,
    filters.type ?? null,
    filters.type ?? null,
    tagsParam(filters),
  ];
}

function memoryListStatement(
  db: D1Database,
  filters: ListFilters,
  select: string,
  tail: string,
) {
  return db.prepare(`${select} FROM (SELECT * FROM memories WHERE user_id = ?) AS memories
         ${usageOrder(filters.sort) ? `LEFT JOIN (${MEMORY_USAGE_SQL}) usage ON usage.id = 'memory:' || memory_id` : ""}
        WHERE deleted_at IS NULL
          -- instr, not LIKE: D1 rejects a LIKE pattern over 50 bytes, and
          -- a pasted title is longer than that. It also keeps % and _ literal.
          AND (
            ? = '' OR instr(lower(title), lower(?)) > 0
              OR instr(lower(body), lower(?)) > 0
          )
          AND (? IS NULL OR project = ?)
          AND (? IS NULL OR lower(memory_type) = lower(?))
          AND ${everyTagSql("tags_json")} ${tail}`);
}

/**
 * The memories list's named orders past the default, newest update first.
 * Each reads the call log's usage, then falls back to the default order, so
 * a tie and the never-touched tail stay stable across reloads (P4).
 */
export const MEMORY_SORTS = {
  "last-fetched":
    "COALESCE(usage.lastFetched, 0) DESC, COALESCE(usage.fetches, 0) DESC,",
  fetched:
    "COALESCE(usage.fetches, 0) DESC, COALESCE(usage.lastFetched, 0) DESC,",
  "in-results":
    "COALESCE(usage.appearances, 0) DESC, COALESCE(usage.lastFetched, 0) DESC,",
} as const;

export type MemorySort = keyof typeof MEMORY_SORTS;

export function memorySort(sort: string | undefined): MemorySort | undefined {
  return sort !== undefined && Object.hasOwn(MEMORY_SORTS, sort)
    ? (sort as MemorySort)
    : undefined;
}

/** An unknown `?sort=` is the default order, never interpolated SQL. */
function usageOrder(sort: string | undefined): string {
  const named = memorySort(sort);
  return named ? MEMORY_SORTS[named] : "";
}

export type MemoryUsage = {
  appearances: number;
  /** `fetch` calls that returned it, inside the call log's thirty days. */
  fetches: number;
  /** Unix milliseconds of the newest of those, as the call log keeps time. */
  lastFetched: number | null;
};

/**
 * How often agents open each memory, read from the call log rather than
 * counted on the memory row, so a read never writes to `memories` or to the
 * search projection (ADR-0001, ADR-0006). A fetch is the access: the agent
 * asked for that memory by id and got it. A refused fetch is not one.
 * Search appearances count the first ten delivered results of each successful
 * search, independently of fetches. Both signals age out with the call log.
 */
const MEMORY_USAGE_SQL = `WITH calls AS (
         SELECT * FROM mcp_calls WHERE user_id = ?
       ), fetched AS (
         SELECT COALESCE(target_id, CASE WHEN json_valid(args_json)
                  THEN json_extract(args_json, '$.id') END) AS id, at
           FROM calls WHERE tool = 'fetch' AND outcome = 'ok'
       ), uses AS (
         SELECT id, 1 AS fetches,
                 0 AS appearances, at AS fetched_at
           FROM fetched WHERE id LIKE 'memory:%'
         UNION ALL
         SELECT j.value AS id, 0, 1, NULL
           FROM calls c, json_each(c.search_result_ids_json) j
          WHERE c.tool = 'search' AND c.outcome = 'ok' AND j.value LIKE 'memory:%'
       )
       SELECT id, SUM(fetches) AS fetches, SUM(appearances) AS appearances,
              MAX(fetched_at) AS lastFetched FROM uses GROUP BY id`;

export async function readMemoryUsage(
  db: D1Database,
  userId: string,
): Promise<Map<string, MemoryUsage>> {
  const { results } = await db.prepare(MEMORY_USAGE_SQL).bind(userId).all<{
    id: string;
    fetches: number;
    appearances: number;
    lastFetched: number | null;
  }>();
  return new Map(
    results.map((row) => [
      row.id,
      {
        fetches: row.fetches,
        appearances: row.appearances,
        lastFetched: row.lastFetched,
      },
    ]),
  );
}

/** The vocabulary as written, drift included, for the console's type filter. */
export async function listMemoryTypes(
  db: D1Database,
  userId: string,
): Promise<{ type: string; count: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT memory_type AS type, COUNT(*) AS count
         FROM memories
        WHERE user_id = ? AND deleted_at IS NULL
        GROUP BY memory_type
        ORDER BY count DESC, memory_type`,
    )
    .bind(userId)
    .all<{ type: string; count: number }>();
  return results;
}

export async function getMemory(
  db: D1Database,
  userId: string,
  id: string,
): Promise<ConsoleMemory | null> {
  const row = await db
    .prepare(
      `SELECT memory_id, memory_type, title, body, tags_json, project,
              source_agent, source_client, source_session, source_session_name,
              created_at, updated_at
         FROM memories
        WHERE memory_id = ? AND user_id = ? AND deleted_at IS NULL`,
    )
    .bind(id, userId)
    .first<MemoryRow>();
  return row === null ? null : consoleMemory(row);
}

/**
 * Records the pre-edit content as an immutable revision, then changes the live
 * row and its search projection together. Snapshots and revision numbers are
 * selected inside the transaction so concurrent editors cannot snapshot stale
 * content or reuse a revision number. Only supplied fields are written.
 */
export async function editMemory(
  env: { DB: D1Database; VALISE_VECTOR_NAMESPACE?: string },
  id: string,
  edit: Partial<MemoryEdit>,
  provenance: Provenance,
  relates: readonly MemoryRelation[] = [],
): Promise<ConsoleMemory | null> {
  const current = await getMemory(env.DB, provenance.userId, id);
  if (current === null) return null;

  const links = await memoryLinkStatements(env.DB, id, relates, provenance);
  const now = Math.floor(Date.now() / 1000);
  const assignments: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [field, column] of [
    ["type", "memory_type"],
    ["title", "title"],
    ["body", "body"],
    ["project", "project"],
  ] as const) {
    if (edit[field] !== undefined) {
      assignments.push(`${column} = ?`);
      values.push(edit[field] ?? null);
    }
  }
  if (edit.tags !== undefined) {
    assignments.push("tags_json = ?");
    values.push(JSON.stringify(edit.tags));
  }
  const statements: D1PreparedStatement[] = [];
  if (assignments.length > 0) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO memory_revisions (
          revision_id, memory_id, revision, memory_type, title, body,
          tags_json, created_at, created_by, project, source_client, source_session
        ) SELECT ?, memory_id,
          (SELECT COALESCE(MAX(revision), 0) + 1 FROM memory_revisions WHERE memory_id = ?),
          memory_type, title, body, tags_json, ?, ?, project, ?, ?
          FROM memories WHERE memory_id = ? AND user_id = ? AND deleted_at IS NULL`,
      ).bind(
        `mrv_${crypto.randomUUID()}`,
        id,
        now,
        provenance.agent,
        provenance.client,
        provenance.session,
        id,
        provenance.userId,
      ),
      env.DB.prepare(`UPDATE memories SET ${assignments.join(", ")}, updated_at = ?
      WHERE memory_id = ? AND user_id = ? AND deleted_at IS NULL`).bind(
        ...values,
        now,
        id,
        provenance.userId,
      ),
    );
  }
  if (statements.length || links.length)
    await memoryLinkBatch(env.DB, [
      vectorSnapshotStatement(env.DB, id),
      ...statements,
      ...links,
      ...memoryProjectionStatements(env.DB, id, env),
    ]);
  return getMemory(env.DB, provenance.userId, id);
}

/** One field at a time, which is all the console's inline editor ever sends. */
export async function patchMemory(
  env: { DB: D1Database; VALISE_VECTOR_NAMESPACE?: string },
  id: string,
  patch: Partial<MemoryEdit>,
  provenance: Provenance,
): Promise<ConsoleMemory | null> {
  return editMemory(env, id, patch, provenance);
}

export type MemoryRevision = {
  revision: number;
  type: string;
  title: string;
  body: string;
  tags: string[];
  createdAt: number;
  createdBy: string;
  project: string | null;
  sourceClient: string | null;
  sourceSession: string | null;
};

/**
 * What the memory said before each edit, newest first. The rows are the ones
 * `editMemory` has been writing since V1-6; this is the read that makes them
 * worth having, because an agent-written claim that someone has since
 * reworded is only trustworthy if the wording it replaced is still there.
 */
export async function listMemoryRevisions(
  db: D1Database,
  userId: string,
  id: string,
): Promise<MemoryRevision[]> {
  const { results } = await db
    .prepare(
      `SELECT revision, memory_type, title, body, tags_json, created_at, created_by,
              project, source_client, source_session
         FROM memory_revisions
        WHERE memory_id = ?
          AND memory_id IN (SELECT memory_id FROM memories WHERE user_id = ?)
        ORDER BY revision DESC`,
    )
    .bind(id, userId)
    .all<{
      revision: number;
      memory_type: string;
      title: string | null;
      body: string;
      tags_json: string;
      created_at: number;
      created_by: string;
      project: string | null;
      source_client: string | null;
      source_session: string | null;
    }>();
  return results.map((row) => ({
    revision: row.revision,
    type: row.memory_type,
    title: row.title ?? "",
    body: row.body,
    tags: parseTags(row.tags_json),
    createdAt: row.created_at,
    createdBy: row.created_by,
    project: row.project,
    sourceClient: row.source_client,
    sourceSession: row.source_session,
  }));
}

export async function archiveMemory(
  env: { DB: D1Database; VALISE_VECTOR_NAMESPACE?: string },
  userId: string,
  id: string,
): Promise<boolean> {
  const exists = await env.DB.prepare(
    "SELECT 1 FROM memories WHERE memory_id = ? AND user_id = ?",
  )
    .bind(id, userId)
    .first<{ 1: number }>();
  if (exists === null) return false;

  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    vectorSnapshotStatement(env.DB, id),
    env.DB.prepare(
      `UPDATE memories
            SET deleted_at = COALESCE(deleted_at, ?),
                updated_at = CASE WHEN deleted_at IS NULL THEN ? ELSE updated_at END
          WHERE memory_id = ? AND user_id = ?`,
    ).bind(now, now, id, userId),
    ...memoryProjectionStatements(env.DB, id, env),
  ]);
  return true;
}

type MemoryRow = {
  memory_id: string;
  memory_type: string;
  title: string | null;
  body: string;
  tags_json: string;
  project: string | null;
  source_agent: string;
  source_client: string;
  source_session: string | null;
  source_session_name: string | null;
  created_at: number;
  updated_at: number;
};

function consoleMemory(row: MemoryRow): ConsoleMemory {
  return {
    id: docKey("memory", row.memory_id),
    type: row.memory_type,
    title: row.title ?? "",
    body: row.body,
    tags: parseTags(row.tags_json),
    project: row.project,
    sourceAgent: row.source_agent,
    sourceClient: row.source_client,
    sourceSession: row.source_session,
    sourceSessionName: row.source_session_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseTags(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}
