import { byline } from "~/concepts/agent-names";
import type { SearchConcept } from "~/db/schema";

/**
 * When a hit was first saved and by whom, so an agent can judge whether a
 * result is stale without fetching it. Read from the authoritative rows after
 * ranking rather than projected into `search_docs`: the projection would need
 * a migration and a rewrite of every write path for two display fields.
 */
export type HitProvenance = { created_at: number; saved_by: string };

type Row = {
  concept: SearchConcept;
  id: string;
  created_at: number;
  agent: string | null;
  session_name: string | null;
};

/**
 * Keyed `concept:conceptId`. A passage hit shares its asset's or source's key.
 * A skill's agent is its first version's author; sources and assets record no
 * session name, so theirs is the client alone.
 */
export async function readProvenance(
  db: D1Database,
  userId: string,
  hits: readonly { concept: SearchConcept; conceptId: string }[],
): Promise<Map<string, HitProvenance>> {
  const out = new Map<string, HitProvenance>();
  if (hits.length === 0) return out;
  const ids = (concept: SearchConcept) =>
    JSON.stringify([
      ...new Set(
        hits.filter((hit) => hit.concept === concept).map((h) => h.conceptId),
      ),
    ]);
  const { results } = await db
    .prepare(
      `SELECT 'memory' AS concept, memory_id AS id, created_at,
              source_agent AS agent, source_session_name AS session_name
         FROM memories
        WHERE user_id = ?1 AND memory_id IN (SELECT value FROM json_each(?2))
       UNION ALL
       SELECT 'todo', todo_id, created_at, source_agent, source_session_name
         FROM todos
        WHERE user_id = ?1 AND todo_id IN (SELECT value FROM json_each(?3))
       UNION ALL
       SELECT 'skill', s.skill_id, s.created_at,
              (SELECT v.created_by FROM skill_versions v
                WHERE v.skill_id = s.skill_id ORDER BY v.version LIMIT 1),
              NULL
         FROM skills s
        WHERE s.user_id = ?1 AND s.skill_id IN (SELECT value FROM json_each(?4))
       UNION ALL
       SELECT 'source', source_id, created_at, source_agent, NULL
         FROM sources
        WHERE user_id = ?1 AND source_id IN (SELECT value FROM json_each(?5))
       UNION ALL
       SELECT 'asset', asset_id, created_at, source_agent, NULL
         FROM assets
        WHERE user_id = ?1 AND asset_id IN (SELECT value FROM json_each(?6))`,
    )
    .bind(
      userId,
      ids("memory"),
      ids("todo"),
      ids("skill"),
      ids("source"),
      ids("asset"),
    )
    .all<Row>();
  // D1's SQLite allows five terms in a compound SELECT, so the sixth concept
  // is its own query, run only when a transcript is among the hits.
  const transcriptRows = hits.some((hit) => hit.concept === "transcript")
    ? (
        await db
          .prepare(
            `SELECT 'transcript' AS concept, transcript_id AS id, created_at,
                    source_agent AS agent, NULL AS session_name
               FROM transcripts
              WHERE user_id = ?1 AND transcript_id IN (SELECT value FROM json_each(?2))`,
          )
          .bind(userId, ids("transcript"))
          .all<Row>()
      ).results
    : [];
  for (const row of [...results, ...transcriptRows])
    out.set(`${row.concept}:${row.id}`, {
      created_at: row.created_at,
      saved_by: byline(row.agent, row.session_name),
    });
  return out;
}
