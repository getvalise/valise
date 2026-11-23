import type { ProjectionRow } from "~/search/project";

const INSERT_SQL = `INSERT INTO search_docs (doc_key, user_id, concept, concept_id, project, title, body, tags, updated_at)`;
const CONFLICT_SQL = `ON CONFLICT(doc_key) DO UPDATE SET
  user_id = excluded.user_id,
  concept = excluded.concept,
  concept_id = excluded.concept_id,
  project = excluded.project,
  title = excluded.title,
  body = excluded.body,
  tags = excluded.tags,
  updated_at = excluded.updated_at`;
const UPSERT_SQL = `${INSERT_SQL} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ${CONFLICT_SQL}`;

/** Read authoritative values inside the batch, after its writes, not before it. */
export type ProjectionSelect = {
  selectSql: string;
  bindings: (string | number | null)[];
};

const DELETE_SQL = `DELETE FROM search_docs WHERE doc_key = ?`;

export function upsertProjection(
  db: D1Database,
  row: ProjectionRow,
): D1PreparedStatement {
  return db
    .prepare(UPSERT_SQL)
    .bind(
      row.docKey,
      row.userId,
      row.concept,
      row.conceptId,
      row.project,
      row.title,
      row.body,
      row.tags,
      row.updatedAt,
    );
}

export function unpublishProjection(
  db: D1Database,
  key: string,
): D1PreparedStatement {
  return db.prepare(DELETE_SQL).bind(key);
}

/**
 * The statement a concept write path pairs with its authoritative write inside
 * one `db.batch`, so the row and its projection commit or fail together.
 * A null projection unpublishes, which is how soft deletes leave the ranking.
 */
export function projectionStatement(
  db: D1Database,
  row: ProjectionRow | ProjectionSelect | null,
  key: string,
): D1PreparedStatement {
  if (row === null) return unpublishProjection(db, key);
  if ("selectSql" in row) {
    return db
      .prepare(`${INSERT_SQL} ${row.selectSql} ${CONFLICT_SQL}`)
      .bind(...row.bindings);
  }
  return upsertProjection(db, row);
}
