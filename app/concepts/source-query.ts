import { readListCursor, tagSignature, writeListCursor } from "./list-cursor";
import { everyTagSql } from "./list-filters";
import { sourceRef } from "./sources";

export type SourceQuery = {
  project?: string;
  kind?: string;
  /** Every tag must be on the source, compared without regard to case. */
  tags?: string[];
  /** Archived sources instead of live ones. Default false. */
  archived?: boolean;
  /** Inclusive Unix seconds on created_at, when the source was first saved. */
  saved_since?: number;
  /** Exclusive Unix seconds on created_at. */
  saved_before?: number;
  /** Null or empty starts a listing, as omission does. */
  cursor?: string | null;
  limit?: number;
};

/**
 * Every source a person owns, a page at a time, newest saved first. Rows are
 * the head revision's metadata only: no notes, no article text, no linked
 * assets. Archived sources are a separate listing, as in the Library. Paging
 * is the `queryTodos` keyset (`list-cursor.ts`); a source saved again keeps
 * its `created_at`, so a revision between pages moves nothing.
 */
export async function querySources(
  db: D1Database,
  userId: string,
  input: SourceQuery = {},
  now = Math.floor(Date.now() / 1000),
) {
  const limit = Math.min(100, Math.max(1, input.limit ?? 50));
  const tags = tagSignature(input.tags);
  const archived = input.archived ?? false;
  const filter = JSON.stringify([
    "sources",
    userId,
    input.project ?? null,
    input.kind ?? null,
    tags,
    archived,
    input.saved_since ?? null,
    input.saved_before ?? null,
  ]);
  const cursor = readListCursor(
    input.cursor,
    filter,
    "project, kind, tags, archived, saved_since and saved_before",
  );
  const high =
    cursor?.high ??
    (await db
      .prepare(
        "SELECT COALESCE(MAX(rowid), 0) AS high FROM sources WHERE user_id = ?",
      )
      .bind(userId)
      .first<number>("high")) ??
    0;
  const { results } = await db
    .prepare(
      `SELECT source_id, title, url, kind, project, tags_json, authors_json,
              created_at, updated_at, archived_at
         FROM sources
        WHERE user_id = ?1 AND rowid <= ?2
          AND (archived_at IS NOT NULL) = ?3
          AND (?4 IS NULL OR project = ?4)
          AND (?5 IS NULL OR kind = ?5)
          AND (?6 IS NULL OR created_at >= ?6)
          AND (?7 IS NULL OR created_at < ?7)
          AND (?8 IS NULL OR created_at < ?8 OR (created_at = ?8 AND source_id > ?9))
          AND ${everyTagSql("tags_json", "?10")}
        ORDER BY created_at DESC, source_id ASC LIMIT ?11`,
    )
    .bind(
      userId,
      high,
      archived ? 1 : 0,
      input.project ?? null,
      input.kind ?? null,
      input.saved_since ?? null,
      input.saved_before ?? null,
      cursor?.created ?? null,
      cursor?.id ?? null,
      JSON.stringify(tags),
      limit + 1,
    )
    .all<{
      source_id: string;
      title: string;
      url: string | null;
      kind: string;
      project: string | null;
      tags_json: string;
      authors_json: string;
      created_at: number;
      updated_at: number;
      archived_at: number | null;
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
            id: last.source_id,
          })
        : null,
    has_more: hasMore,
    sources: rows.map((row) => ({
      id: sourceRef(row.source_id),
      title: row.title,
      url: row.url,
      kind: row.kind,
      project: row.project,
      tags: JSON.parse(row.tags_json) as string[],
      authors: JSON.parse(row.authors_json) as string[],
      created_at: row.created_at,
      updated_at: row.updated_at,
      archived_at: row.archived_at,
    })),
  };
}
