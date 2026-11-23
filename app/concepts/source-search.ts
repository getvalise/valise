/**
 * The source's search rows beyond the one `projectSource` writes: its body
 * gains the summary and concepts, and when the article is split into
 * passages the body drops the article text, which then lives in one
 * `source:<id>#<n>` row per passage. Pair with every source projection, in
 * the same batch and after it. ADR-0001.
 */
export function sourceSearchStatements(
  db: D1Database,
  sourceId: string,
  userId: string,
): D1PreparedStatement[] {
  const enrichment = `(SELECT enrichment_id FROM source_enrichments
      WHERE source_id = ?1 AND user_id = ?2 AND state = 'ready'
      ORDER BY created_at DESC, rowid DESC LIMIT 1)`;
  return [
    db
      .prepare(
        `UPDATE search_docs SET body = (
           SELECT substr(
             COALESCE(s.url, '') || char(10) ||
             COALESCE((SELECT group_concat(value, ' ') FROM json_each(s.authors_json) WHERE type = 'text'), '') || char(10) ||
             s.notes || char(10) ||
             COALESCE(e.summary, '') || char(10) ||
             COALESCE((SELECT group_concat(value, '; ') FROM json_each(e.concepts_json) WHERE type = 'text'), '') || char(10) ||
             CASE WHEN e.passages_json IS NOT NULL THEN '' ELSE COALESCE((SELECT sa.text FROM source_articles sa
               WHERE sa.source_id = s.source_id AND sa.user_id = s.user_id AND sa.detected = 1
               ORDER BY sa.revision DESC LIMIT 1), '') END,
             1, 16000)
             FROM sources s LEFT JOIN source_enrichments e ON e.enrichment_id = ${enrichment}
            WHERE s.source_id = ?1 AND s.user_id = ?2)
         WHERE doc_key = 'source:' || ?1 AND user_id = ?2`,
      )
      .bind(sourceId, userId),
    db
      .prepare(
        `DELETE FROM search_docs WHERE user_id = ?2 AND concept = 'source' AND concept_id = ?1
           AND doc_key != 'source:' || ?1`,
      )
      .bind(sourceId, userId),
    db
      .prepare(
        `INSERT INTO search_docs (doc_key, user_id, concept, concept_id, project, title, body, tags, updated_at)
         SELECT 'source:' || s.source_id || '#' || p.key, s.user_id, 'source', s.source_id, s.project,
                COALESCE(json_extract(p.value, '$.label'), ''),
                substr(sa.text, json_extract(p.value, '$.start') + 1, json_extract(p.value, '$.length')),
                '', s.updated_at
           FROM sources s
           JOIN source_enrichments e ON e.enrichment_id = ${enrichment}
           JOIN source_articles sa ON sa.source_id = s.source_id AND sa.user_id = s.user_id
             AND sa.revision = e.article_revision AND sa.detected = 1
           JOIN json_each(e.passages_json, '$.passages') p
          WHERE s.source_id = ?1 AND s.user_id = ?2 AND s.archived_at IS NULL
            AND e.passages_json IS NOT NULL`,
      )
      .bind(sourceId, userId),
  ];
}
