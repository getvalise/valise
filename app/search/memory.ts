import {
  memoryAffectedSql,
  memorySourceSql,
  supersededMemorySql,
} from "~/search/memory-source";
import {
  type VectorAdmissionEnv,
  vectorAdmissionStatements,
  vectorSnapshotStatement,
} from "~/search/vector-outbox";
import { projectionStatement } from "~/search/write";

/** Only live, confirmed replacements from a live successor unpublish a claim. */
export { supersededMemorySql } from "~/search/memory-source";

/**
 * Refresh this memory and its direct predecessors from authoritative rows
 * inside the writer's batch. An archive can race a confirmation; selecting
 * affected ids here, not before the batch, keeps either ordering correct.
 * Embedding work is admitted against the owner's backlog cap; the content and
 * its FTS row commit either way.
 */
export function memoryProjectionStatements(
  db: D1Database,
  id: string,
  env: VectorAdmissionEnv,
): D1PreparedStatement[] {
  const affected = memoryAffectedSql;
  const published = `m.deleted_at IS NULL AND NOT ${supersededMemorySql("m")}`;
  return [
    projectionStatement(
      db,
      {
        selectSql: memorySourceSql(`(${affected}) AND ${published}`),
        bindings: [id, id],
      },
      `memory:${id}`,
    ),
    db
      .prepare(`DELETE FROM search_docs WHERE concept = 'memory'
      AND concept_id IN (SELECT m.memory_id FROM memories m WHERE (${affected}) AND NOT (${published}))`)
      .bind(id, id),
    vectorSnapshotStatement(db, id),
    ...vectorAdmissionStatements(db, id, env),
  ];
}
