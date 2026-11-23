import { MAX_BODY_BYTES } from "~/search/project";

/** Only live, confirmed replacements from a live successor unpublish a claim. */
export function supersededMemorySql(alias: string): string {
  return `EXISTS (SELECT 1 FROM memory_links l
    JOIN memories successor ON successor.memory_id = l.from_memory_id
    WHERE l.to_memory_id = ${alias}.memory_id AND l.kind = 'supersedes'
      AND l.confirmed_at IS NOT NULL AND l.removed_at IS NULL
      AND successor.deleted_at IS NULL)`;
}

export const memoryAffectedSql = `m.memory_id = ? OR m.memory_id IN (
  SELECT to_memory_id FROM memory_links WHERE from_memory_id = ? AND kind = 'supersedes')`;

/** Same mapping for FTS publication and immutable vector delivery snapshots. */
export function memorySourceSql(where: string): string {
  const byte = (back: number) =>
    `hex(substr(CAST(m.body AS BLOB), ${MAX_BODY_BYTES - back}, 1))`;
  const continuation = (back: number) => `${byte(back)} BETWEEN '80' AND 'BF'`;
  const trim = `CASE WHEN ${byte(0)} >= 'C0' THEN 1
    WHEN ${continuation(0)} AND ${byte(1)} >= 'E0' THEN 2
    WHEN ${continuation(0)} AND ${continuation(1)} AND ${byte(2)} >= 'F0' THEN 3 ELSE 0 END`;
  const body = `CASE WHEN length(CAST(m.body AS BLOB)) <= ${MAX_BODY_BYTES} THEN m.body
    ELSE CAST(substr(CAST(m.body AS BLOB), 1, ${MAX_BODY_BYTES} - (${trim})) AS TEXT) END`;
  return `SELECT 'memory:' || m.memory_id AS doc_key, m.user_id, 'memory' AS concept,
    m.memory_id AS concept_id, m.project, COALESCE(m.title, '') AS title, ${body} AS body,
    CASE WHEN m.search_tags = '' THEN m.memory_type WHEN m.memory_type = '' THEN m.search_tags
      ELSE m.search_tags || ' ' || m.memory_type END AS tags, m.updated_at
    FROM (SELECT memories.*, COALESCE((SELECT group_concat(value, ' ') FROM json_each(tags_json)
      WHERE type = 'text'), '') AS search_tags FROM memories) m WHERE ${where}`;
}
