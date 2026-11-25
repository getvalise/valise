import { readListCursor, tagSignature, writeListCursor } from "./list-cursor";
import { everyTagSql } from "./list-filters";
import { summarize } from "./update-summary";

export type MemoryQuery = {
  project?: string;
  /** Matched without regard to case, as the console's type filter does. */
  memory_type?: string;
  /** Every tag must be on the memory, compared without regard to case. */
  tags?: string[];
  /** Inclusive Unix seconds on updated_at. */
  updated_since?: number;
  /** Exclusive Unix seconds on updated_at. */
  updated_before?: number;
  /** Null or empty starts a listing, as omission does. */
  cursor?: string | null;
  limit?: number;
};

/** Enough of the body for its opening sentences; the body never leaves D1 whole. */
const LEAD_CHARS = 600;

/**
 * Every live memory a person owns, a page at a time, newest saved first.
 * Rows are compact: the title, the body's opening sentences as `summary`,
 * and the facets, never the body. A soft-deleted memory is left out; one a
 * confirmed `supersedes` link retired stays, as it does in the console list,
 * since enumeration answers what is stored rather than what to read first.
 * Paging is the `queryTodos` keyset (`list-cursor.ts`); the `updated_*`
 * bounds are a live filter on that order, not the order itself, because
 * ordering by `updated_at` would let an edit between pages skip or repeat a
 * row.
 */
export async function queryMemories(
  db: D1Database,
  userId: string,
  input: MemoryQuery = {},
  now = Math.floor(Date.now() / 1000),
) {
  const limit = Math.min(100, Math.max(1, input.limit ?? 50));
  const tags = tagSignature(input.tags);
  const memoryType = input.memory_type?.trim().toLowerCase() || null;
  const filter = JSON.stringify([
    "memories",
    userId,
    input.project ?? null,
    memoryType,
    tags,
    input.updated_since ?? null,
    input.updated_before ?? null,
  ]);
  const cursor = readListCursor(
    input.cursor,
    filter,
    "project, memory_type, tags, updated_since and updated_before",
  );
  const high =
    cursor?.high ??
    (await db
      .prepare(
        "SELECT COALESCE(MAX(rowid), 0) AS high FROM memories WHERE user_id = ?",
      )
      .bind(userId)
      .first<number>("high")) ??
    0;
  const { results } = await db
    .prepare(
      `SELECT memory_id, title, substr(body, 1, ${LEAD_CHARS}) AS lead,
              memory_type, project, tags_json, created_at, updated_at
         FROM memories
        WHERE user_id = ?1 AND rowid <= ?2 AND deleted_at IS NULL
          AND (?3 IS NULL OR project = ?3)
          AND (?4 IS NULL OR lower(memory_type) = ?4)
          AND (?5 IS NULL OR updated_at >= ?5)
          AND (?6 IS NULL OR updated_at < ?6)
          AND (?7 IS NULL OR created_at < ?7 OR (created_at = ?7 AND memory_id > ?8))
          AND ${everyTagSql("tags_json", "?9")}
        ORDER BY created_at DESC, memory_id ASC LIMIT ?10`,
    )
    .bind(
      userId,
      high,
      input.project ?? null,
      memoryType,
      input.updated_since ?? null,
      input.updated_before ?? null,
      cursor?.created ?? null,
      cursor?.id ?? null,
      JSON.stringify(tags),
      limit + 1,
    )
    .all<{
      memory_id: string;
      title: string | null;
      lead: string;
      memory_type: string;
      project: string | null;
      tags_json: string;
      created_at: number;
      updated_at: number;
    }>();
  const rows = results.slice(0, limit);
  const last = rows.at(-1);
  const hasMore = results.length > limit;
  return {
    generated_at: now,
    limit,
    next_cursor:
      hasMore && last
        ? writeListCursor({
            filter,
            high,
            created: last.created_at,
            id: last.memory_id,
          })
        : null,
    has_more: hasMore,
    memories: rows.map((row) => {
      const summary = summarize(row.lead) || null;
      const title = row.title?.trim() || summary || "(untitled)";
      return {
        id: `memory:${row.memory_id}`,
        title,
        summary: summary === title ? null : summary,
        memory_type: row.memory_type,
        project: row.project,
        tags: JSON.parse(row.tags_json) as string[],
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    }),
  };
}
