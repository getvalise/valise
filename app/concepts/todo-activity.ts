import { docKey } from "~/search/project";
import type { TodoRef } from "./todo-contracts";
import type { TodoState, TodoUpdate } from "./todos";
import { updateSummary } from "./update-summary";

/**
 * How much a to-do's thread holds and what its newest entry said. State is
 * not progress: a pending to-do can carry four slices of verified work in its
 * updates, and an agent that reads only the state calls it idle. Every to-do
 * shape an agent reads carries these, so the thread is visible without
 * shipping it whole.
 */
export type TodoFreshness = {
  updateCount: number;
  lastUpdateAt: number | null;
  lastUpdateKind: TodoUpdate["kind"] | null;
  lastUpdateAuthor: string | null;
  lastUpdateSummary: string | null;
  status: string | null;
  statusAt: number | null;
};

export const NO_UPDATES: TodoFreshness = {
  updateCount: 0,
  lastUpdateAt: null,
  lastUpdateKind: null,
  lastUpdateAuthor: null,
  lastUpdateSummary: null,
  status: null,
  statusAt: null,
};

/**
 * The entries that say where the work stands: progress, comments, blockers
 * and the completion. A claim or a release says who holds it, not how far it
 * got, so it never becomes the status the way it becomes the last update.
 */
export const STATUS_KINDS: readonly TodoUpdate["kind"][] = [
  "progress",
  "comment",
  "blocked",
  "complete",
];

/**
 * A blocker or a completion describes a state, and a later claim or release
 * leaves that state: a reopen is a release, and claiming a blocked to-do
 * resolves its blocker. Past one, those entries are history, not status.
 */
const STATE_KINDS: readonly TodoUpdate["kind"][] = ["blocked", "complete"];
const TRANSITION_KINDS: readonly TodoUpdate["kind"][] = ["claim", "release"];

/** The newest entry that says where the work stands, if any. */
export function statusEntry(newestFirst: TodoUpdate[]): TodoUpdate | undefined {
  let movedOn = false;
  for (const update of newestFirst) {
    if (TRANSITION_KINDS.includes(update.kind)) movedOn = true;
    else if (!(movedOn && STATE_KINDS.includes(update.kind))) return update;
  }
  return undefined;
}

/**
 * A to-do's status, its one line saying where the work stands, and when it
 * was written: the summary of the newest progress, comment, blocker or
 * completion. The first thing every to-do read shows.
 */
export function todoStatus(
  newestFirst: TodoUpdate[],
): Pick<TodoFreshness, "status" | "statusAt"> {
  const entry = statusEntry(newestFirst);
  return entry
    ? { status: entry.summary, statusAt: entry.createdAt }
    : { status: null, statusAt: null };
}

/**
 * The freshness and status of every listed to-do in one query, keyed by bare
 * id. Bodies are read only for the newest row and the newest status row, and
 * only their head, to cut a summary for a row written before the summary
 * column.
 */
export async function todoFreshnessFor(
  db: D1Database,
  userId: string,
  ids: string[],
): Promise<Map<string, TodoFreshness>> {
  const byTodo = new Map<string, TodoFreshness>();
  if (ids.length === 0) return byTodo;
  const { results } = await db
    .prepare(
      `WITH owned AS (
         SELECT todo_id FROM todos
          WHERE user_id = ?2 AND todo_id IN (SELECT value FROM json_each(?1))
       ),
       thread AS (
         SELECT todo_id, update_id AS entry_id, kind, author, body, summary,
                created_at
           FROM todo_updates
          WHERE todo_id IN (SELECT todo_id FROM owned)
         UNION ALL
         SELECT todo_id, comment_id, 'comment', author, body, summary,
                created_at
           FROM todo_comments
          WHERE todo_id IN (SELECT todo_id FROM owned)
       ),
       ordered AS (
         SELECT *,
                COUNT(*) OVER (PARTITION BY todo_id) AS n,
                ROW_NUMBER() OVER (
                  PARTITION BY todo_id
                  ORDER BY created_at DESC, substr(entry_id, 5) DESC
                ) AS position
           FROM thread
       ),
       moved AS (
         SELECT *,
                MIN(CASE WHEN kind IN (SELECT value FROM json_each(?4))
                         THEN position END)
                  OVER (PARTITION BY todo_id) AS moved_at
           FROM ordered
       ),
       eligible AS (
         SELECT *,
                kind IN (SELECT value FROM json_each(?3))
                AND NOT (kind IN (SELECT value FROM json_each(?5))
                         AND moved_at IS NOT NULL AND moved_at < position)
                  AS is_status
           FROM moved
       ),
       ranked AS (
         SELECT *,
                ROW_NUMBER() OVER (
                  PARTITION BY todo_id, is_status ORDER BY position
                ) AS kind_position
           FROM eligible
       )
       SELECT todo_id, kind, author, summary,
              substr(body, 1, 2000) AS head, created_at, n, position,
              is_status AND kind_position = 1 AS is_newest_status
         FROM ranked
        WHERE position = 1 OR (is_status AND kind_position = 1)`,
    )
    .bind(
      JSON.stringify(ids),
      userId,
      JSON.stringify(STATUS_KINDS),
      JSON.stringify(TRANSITION_KINDS),
      JSON.stringify(STATE_KINDS),
    )
    .all<{
      todo_id: string;
      kind: TodoUpdate["kind"];
      author: string;
      summary: string | null;
      head: string;
      created_at: number;
      n: number;
      position: number;
      is_newest_status: number;
    }>();
  for (const row of results) {
    const one = byTodo.get(row.todo_id) ?? { ...NO_UPDATES };
    const summary = row.summary ?? updateSummary(row.head);
    if (row.position === 1)
      Object.assign(one, {
        updateCount: row.n,
        lastUpdateAt: row.created_at,
        lastUpdateKind: row.kind,
        lastUpdateAuthor: row.author,
        lastUpdateSummary: summary,
      });
    if (row.is_newest_status)
      Object.assign(one, { status: summary, statusAt: row.created_at });
    byTodo.set(row.todo_id, one);
  }
  return byTodo;
}

/** The status on the wire, snake_case, first in every to-do read. */
export function statusFields(freshness: TodoFreshness) {
  return { status: freshness.status, status_at: freshness.statusAt };
}

/** The wire shape, snake_case, as fetch and the activity lists send it. */
export function freshnessFields(freshness: TodoFreshness) {
  return {
    update_count: freshness.updateCount,
    last_update_at: freshness.lastUpdateAt,
    last_update_kind: freshness.lastUpdateKind,
    last_update_author: freshness.lastUpdateAuthor,
    last_update_summary: freshness.lastUpdateSummary,
  };
}

export type ActivityTodo = {
  id: string;
  title: string;
  project: string | null;
  state: TodoState;
  leaseHolder: string | null;
  blockedOn: string | null;
  tags: string[];
  refs: TodoRef[];
  updatedAt: number;
} & TodoFreshness;

/** How long a finished to-do stays in a project's status. */
export const ACTIVITY_DONE_DAYS = 7;

/**
 * What is going on in a project: every open to-do and those finished in the
 * last week, grouped claimed, pending, blocked, done, and within each group
 * the most recent activity first, whether that was an edit or an update.
 * The answer to "what is going on", which the ready queue is not: it hides
 * claimed work, and orders by row edits rather than by progress.
 */
export async function listActivity(
  db: D1Database,
  userId: string,
  project?: string,
  limit = 50,
  now = Math.floor(Date.now() / 1000),
): Promise<ActivityTodo[]> {
  const since = now - ACTIVITY_DONE_DAYS * 86_400;
  const { results } = await db
    .prepare(
      `SELECT t.todo_id, t.title, t.project, t.state, t.lease_holder,
              t.blocked_on, t.tags_json, t.refs_json, t.updated_at,
              MAX(t.updated_at, COALESCE(
                (SELECT MAX(created_at) FROM todo_updates u
                  WHERE u.todo_id = t.todo_id), 0),
                COALESCE((SELECT MAX(created_at) FROM todo_comments c
                  WHERE c.todo_id = t.todo_id), 0)) AS active_at
         FROM todos t
        WHERE t.user_id = ? AND (t.state <> 'done' OR t.completed_at >= ?)
          AND (? IS NULL OR t.project = ?)
        ORDER BY CASE t.state
                   WHEN 'claimed' THEN 0 WHEN 'pending' THEN 1
                   WHEN 'blocked' THEN 2 ELSE 3 END,
                 active_at DESC, t.todo_id
        LIMIT ?`,
    )
    .bind(userId, since, project ?? null, project ?? null, limit)
    .all<{
      todo_id: string;
      title: string;
      project: string | null;
      state: TodoState;
      lease_holder: string | null;
      blocked_on: string | null;
      tags_json: string;
      refs_json: string;
      updated_at: number;
    }>();
  const freshness = await todoFreshnessFor(
    db,
    userId,
    results.map((row) => row.todo_id),
  );
  return results.map((row) => ({
    id: docKey("todo", row.todo_id),
    title: row.title,
    project: row.project,
    state: row.state,
    leaseHolder: row.lease_holder,
    blockedOn: row.blocked_on,
    tags: parseList<string>(row.tags_json, (tag) => typeof tag === "string"),
    refs: parseList<TodoRef>(
      row.refs_json,
      (ref) =>
        typeof ref === "object" &&
        ref !== null &&
        typeof (ref as TodoRef).kind === "string" &&
        typeof (ref as TodoRef).value === "string",
    ),
    updatedAt: row.updated_at,
    ...(freshness.get(row.todo_id) ?? NO_UPDATES),
  }));
}

function parseList<T>(json: string, keep: (value: unknown) => boolean): T[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed.filter(keep) as T[]) : [];
  } catch {
    return [];
  }
}
