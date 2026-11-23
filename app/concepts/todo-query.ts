import { z } from "zod";
import {
  freshnessFields,
  NO_UPDATES,
  statusFields,
  todoFreshnessFor,
} from "./todo-activity";
import type { TodoRef } from "./todo-contracts";
import {
  todoDependenciesReadySql,
  todoEffectivelyBlockedSql,
} from "./todo-relations";
import type { TodoState } from "./todos";

export type TodoQuery = {
  project?: string;
  state?: TodoState;
  completed_since?: number;
  completed_before?: number;
  /** Null or empty starts a listing, as omission does. */
  cursor?: string | null;
  limit?: number;
};

const cursorSchema = z.object({
  version: z.literal(1),
  filter: z.string(),
  high: z.number().int().nonnegative(),
  at: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  id: z.string().min(1).max(200),
});

export class TodoCursorError extends Error {}

/**
 * Immutable creation-time/id keyset, with an insertion high-water mark. Edits
 * cannot move a row across pages; newly inserted (even backdated) rows wait for
 * a fresh listing. State/filter membership is live, not a database snapshot.
 * Cursor input never supplies the owner predicate. All surfaces can use this
 * compact read model without reading task bodies or whole histories.
 * `readyOnly` shares dependency readiness with listReady. Default/state
 * enumeration deliberately does not apply it: list_todos must not omit blocked
 * work just because its stored state is pending.
 * `effectiveBlockedOnly` is an internal orientation sample of stored blocked
 * tasks plus pending work waiting on manual reasons or unfinished dependencies.
 * It never changes the returned state or the public state-enumeration filter.
 */
export async function queryTodos(
  db: D1Database,
  userId: string,
  input: TodoQuery = {},
  now = Math.floor(Date.now() / 1000),
  {
    readyOnly = false,
    effectiveBlockedOnly = false,
    sampleBy,
  }: {
    readyOnly?: boolean;
    effectiveBlockedOnly?: boolean;
    sampleBy?: "activity" | "completion";
  } = {},
) {
  const limit = Math.min(100, Math.max(1, input.limit ?? 50));
  const filter = JSON.stringify([
    userId,
    input.project ?? null,
    input.state ?? null,
    input.completed_since ?? null,
    readyOnly,
    sampleBy ?? null,
    // Keep ordinary enumeration cursor signatures compatible with prior heads.
    ...(effectiveBlockedOnly ? ["effective-blocked"] : []),
    ...(input.completed_before === undefined
      ? []
      : [["completed-before", input.completed_before]]),
  ]);
  let cursor: z.infer<typeof cursorSchema> | null = null;
  if (input.cursor) {
    try {
      cursor = cursorSchema.parse(
        JSON.parse(
          new TextDecoder().decode(
            Uint8Array.from(atob(input.cursor), (c) => c.charCodeAt(0)),
          ),
        ),
      );
      if (cursor.filter !== filter) throw new Error("different filters");
    } catch {
      throw new TodoCursorError(
        "Invalid cursor; reuse it with the same project, state, completed_since and completed_before, or start a fresh listing.",
      );
    }
  }
  const high =
    cursor?.high ??
    (await db
      .prepare(
        "SELECT COALESCE(MAX(rowid), 0) AS high FROM todos WHERE user_id = ?",
      )
      .bind(userId)
      .first<number>("high")) ??
    0;
  const at = cursor?.at ?? now;
  const { results } = await db
    .prepare(
      `SELECT todo_id, substr(title, 1, 500) AS title, project, state,
            lease_holder, lease_expires_at, blocked_on, created_at, updated_at,
            completed_at, tags_json, refs_json
            ${
              sampleBy === "activity"
                ? `, MAX(updated_at,
              COALESCE((SELECT MAX(created_at) FROM todo_updates u WHERE u.todo_id = todos.todo_id), 0),
              COALESCE((SELECT MAX(created_at) FROM todo_comments c WHERE c.todo_id = todos.todo_id), 0)) AS active_at`
                : ""
            }
       FROM todos
      WHERE user_id = ?1 AND rowid <= ?2
        AND (?3 IS NULL OR project = ?3)
        AND (?4 IS NULL OR state = ?4)
        AND ((?5 IS NULL AND ?11 IS NULL) OR (state = 'done'
             AND completed_at >= COALESCE(?5, 0) AND completed_at <= ?6
             AND (?11 IS NULL OR completed_at < ?11)))
         AND (?7 = 0 OR (state = 'pending' AND blocked_on IS NULL AND ${todoDependenciesReadySql()}))
         AND ${effectiveBlockedOnly ? todoEffectivelyBlockedSql() : "1"}
        AND (?8 IS NULL OR created_at < ?8 OR (created_at = ?8 AND todo_id > ?9))
      ORDER BY ${sampleBy === "activity" ? "active_at" : sampleBy === "completion" ? "completed_at" : "created_at"} DESC, todo_id ASC LIMIT ?10`,
    )
    .bind(
      userId,
      high,
      input.project ?? null,
      input.state ?? null,
      input.completed_since ?? null,
      at,
      readyOnly ? 1 : 0,
      cursor?.created ?? null,
      cursor?.id ?? null,
      limit + 1,
      input.completed_before ?? null,
    )
    .all<{
      todo_id: string;
      title: string;
      project: string | null;
      state: TodoState;
      lease_holder: string | null;
      lease_expires_at: number | null;
      blocked_on: string | null;
      created_at: number;
      updated_at: number;
      completed_at: number | null;
      tags_json: string;
      refs_json: string;
      active_at?: number;
    }>();
  const rows = results.slice(0, limit);
  const freshness = await todoFreshnessFor(
    db,
    userId,
    rows.map((row) => row.todo_id),
  );
  const last = rows.at(-1);
  const next =
    !sampleBy && results.length > limit && last
      ? btoa(
          Array.from(
            new TextEncoder().encode(
              JSON.stringify({
                version: 1,
                filter,
                high,
                at,
                created: last.created_at,
                id: last.todo_id,
              }),
            ),
            (byte) => String.fromCharCode(byte),
          ).join(""),
        )
      : null;
  return {
    generated_at: now,
    as_of: at,
    limit,
    next_cursor: next,
    has_more: results.length > limit,
    todos: rows.map(
      ({
        todo_id,
        title,
        tags_json,
        refs_json,
        active_at: _active,
        ...row
      }) => {
        const one = freshness.get(todo_id) ?? NO_UPDATES;
        return {
          id: `todo:${todo_id}`,
          title,
          ...statusFields(one),
          ...row,
          tags: JSON.parse(tags_json) as string[],
          refs: JSON.parse(refs_json) as TodoRef[],
          ...freshnessFields(one),
        };
      },
    ),
  };
}
