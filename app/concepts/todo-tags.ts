import { routeReservedTags } from "~/concepts/facets";
import { MAX_BODY_BYTES } from "~/search/project";
import { projectionStatement } from "~/search/write";

export type TodoTagEdit = {
  add_tags?: readonly string[];
  remove_tags?: readonly string[];
};

/** Metadata only: no claim, state transition, or whole-content replacement. */
export async function editTodoTags(
  db: D1Database,
  userId: string,
  id: string,
  edit: TodoTagEdit,
): Promise<{ tags: string[]; updatedAt: number } | { error: string }> {
  const add = [...new Set(edit.add_tags ?? [])];
  const remove = [...new Set(edit.remove_tags ?? [])];
  const routed = routeReservedTags(add, {});
  if ("error" in routed) return routed;
  if (add.some((tag) => remove.includes(tag)))
    return { error: "A tag cannot be added and removed in the same call." };
  const updatedAt = Math.floor(Date.now() / 1000);
  const [updated] = await db.batch<{ tags_json: string }>([
    // Compute the delta from the row inside the transaction, not a fetched
    // snapshot. Concurrent disjoint edits keep each other's tags. Deduplicate
    // before checking the cap, and preserve the order of retained/new tags.
    db
      .prepare(
        `WITH next_tags AS (
         SELECT value, MIN(position) AS position FROM (
           SELECT value, CAST(key AS INTEGER) AS position
             FROM todos, json_each(todos.tags_json)
            WHERE todo_id = ?1 AND user_id = ?2 AND type = 'text'
              AND value NOT IN (SELECT value FROM json_each(?3))
           UNION ALL
           SELECT value, 1000000 + CAST(key AS INTEGER)
             FROM json_each(?4)
         ) GROUP BY value
       )
       UPDATE todos SET tags_json = (
         SELECT json_group_array(value) FROM (
           SELECT value FROM next_tags ORDER BY position
         )
       ), updated_at = ?5
       WHERE todo_id = ?1 AND user_id = ?2
         AND (SELECT COUNT(*) FROM next_tags) <= 20
       RETURNING tags_json`,
      )
      .bind(id, userId, JSON.stringify(remove), JSON.stringify(add), updatedAt),
    projectionStatement(
      db,
      { selectSql: todoTagProjectionSql, bindings: [id, userId] },
      `todo:${id}`,
    ),
  ]);
  const row = updated.results[0];
  if (!row) {
    const exists = await db
      .prepare("SELECT 1 FROM todos WHERE todo_id = ? AND user_id = ?")
      .bind(id, userId)
      .first();
    return {
      error: exists ? "A to-do takes at most 20 tags." : "To-do not found.",
    };
  }
  return { tags: JSON.parse(row.tags_json), updatedAt };
}

// Same body/refs/comments mapping and UTF-8 cap as projectTodo. Read inside
// the batch so a concurrent content/comment write is never projected from a
// stale snapshot. changes() skips publication when the preceding edit refused.
const byte = (back: number) =>
  `hex(substr(CAST(body AS BLOB), ${MAX_BODY_BYTES - back}, 1))`;
const continuation = (back: number) => `${byte(back)} BETWEEN '80' AND 'BF'`;
const trim = `CASE WHEN ${byte(0)} >= 'C0' THEN 1
  WHEN ${continuation(0)} AND ${byte(1)} >= 'E0' THEN 2
  WHEN ${continuation(0)} AND ${continuation(1)} AND ${byte(2)} >= 'F0' THEN 3 ELSE 0 END`;
const todoTagProjectionSql = `SELECT 'todo:' || todo_id, user_id, 'todo', todo_id,
  project, title,
  CASE WHEN length(CAST(body AS BLOB)) <= ${MAX_BODY_BYTES} THEN body
    ELSE CAST(substr(CAST(body AS BLOB), 1, ${MAX_BODY_BYTES} - (${trim})) AS TEXT) END,
  COALESCE((SELECT group_concat(value, ' ') FROM json_each(tags_json) WHERE type = 'text'), ''),
  updated_at
  FROM (
    SELECT t.todo_id, t.user_id, t.project, t.title, t.tags_json, t.updated_at,
      COALESCE((SELECT group_concat(value, char(10)) FROM (
        SELECT t.body AS value UNION ALL SELECT refs UNION ALL SELECT comments
      ) WHERE value <> ''), '') AS body
    FROM (
      SELECT todos.*,
        COALESCE((SELECT group_concat(json_extract(value, '$.value'), ' ')
          FROM json_each(refs_json) WHERE json_extract(value, '$.value') IS NOT NULL
            AND json_extract(value, '$.value') <> ''), '') AS refs,
        COALESCE((SELECT group_concat(body, char(10)) FROM (
          SELECT body FROM todo_comments WHERE todo_id = todos.todo_id
            ORDER BY created_at, comment_id)), '') AS comments
      FROM todos WHERE todo_id = ? AND user_id = ? AND changes() > 0
    ) t
  ) WHERE true`;
