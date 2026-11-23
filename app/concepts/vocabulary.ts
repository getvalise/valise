/** The owner's written vocabulary, including library categories/collections. P9, ADR-0016. */
export type Vocabulary = { projects: string[]; tags: string[] };

export async function readVocabulary(
  db: D1Database,
  userId: string,
): Promise<Vocabulary> {
  const [projects, tags] = await db.batch<{ value: string }>([
    db
      .prepare(`SELECT project AS value FROM (
      SELECT project FROM skills WHERE user_id = ?1 AND deleted_at IS NULL
      UNION ALL SELECT project FROM memories WHERE user_id = ?1 AND deleted_at IS NULL
      UNION ALL SELECT project FROM todos WHERE user_id = ?1
      UNION ALL SELECT project FROM assets WHERE user_id = ?1 AND archived_at IS NULL AND state = 'ready'
        AND (expires_at IS NULL OR expires_at > unixepoch())
      UNION ALL SELECT project FROM sources WHERE user_id = ?1 AND archived_at IS NULL
    ) WHERE project IS NOT NULL AND project <> '' GROUP BY project ORDER BY COUNT(*) DESC, project`)
      .bind(userId),
    db
      .prepare(`SELECT tag.value AS value FROM (
      SELECT tags_json FROM skills WHERE user_id = ?1 AND deleted_at IS NULL
      UNION ALL SELECT tags_json FROM memories WHERE user_id = ?1 AND deleted_at IS NULL
      UNION ALL SELECT tags_json FROM todos WHERE user_id = ?1
      UNION ALL SELECT tags_json FROM assets WHERE user_id = ?1 AND archived_at IS NULL AND state = 'ready'
        AND (expires_at IS NULL OR expires_at > unixepoch())
      UNION ALL SELECT tags_json FROM sources WHERE user_id = ?1 AND archived_at IS NULL
    ) AS record, json_each(record.tags_json) AS tag
    WHERE tag.value <> '' GROUP BY tag.value ORDER BY COUNT(*) DESC, tag.value`)
      .bind(userId),
  ]);
  return {
    projects: projects.results.map((row) => row.value),
    tags: tags.results.map((row) => row.value),
  };
}
