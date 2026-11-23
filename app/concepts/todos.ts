import type { TodoCoordinator } from "~/do/todo-coordinator";
import { uuid7 } from "~/lib/uuid7";
import { docKey, projectTodo } from "~/search/project";
import { projectionStatement } from "~/search/write";
import { everyTagSql, type ListFilters, tagsParam } from "./list-filters";
import type { Provenance } from "./memories";
import type { ListWindow } from "./pagination";
import { appendTaskItem, setTaskItem } from "./task-list";
import type {
  TodoClaim,
  TodoDraft,
  TodoRef,
  TodoUpdateRequest,
} from "./todo-contracts";
import { todoCreateStatements } from "./todo-create";
import { todoDependenciesReadySql } from "./todo-relations";
import { updateSummary } from "./update-summary";

type TodoEnv = {
  DB: D1Database;
  TODO_COORDINATOR: DurableObjectNamespace<TodoCoordinator>;
};

type TodoFailure = {
  ok: false;
  reason: string;
  holder: string | null;
  token: number | null;
};

type TodoSuccess = { ok: true; token: number; expiresAt: number | null };

export async function createTodo(
  env: TodoEnv,
  input: TodoDraft,
  provenance: Provenance,
): Promise<{ id: string; title: string; createdAt: number }> {
  const todoId = `tdo_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  if (input.parent !== undefined || input.depends_on?.length) {
    const created = await coordinator(env, provenance.userId).createRelated(
      todoId,
      input,
      provenance,
    );
    if (!created.ok) throw new Error(created.reason);
  } else
    await env.DB.batch(
      todoCreateStatements(env.DB, todoId, input, provenance, now),
    );
  return { id: docKey("todo", todoId), title: input.title, createdAt: now };
}

/**
 * Pending, unblocked to-dos, newest first. `includeBlocked` adds blocked ones
 * with their blockers, so an agent can judge which have cleared and reopen
 * those by claiming them (ADR-0002).
 */
export async function listReady(
  db: D1Database,
  userId: string,
  project?: string,
  limit = 50,
  includeBlocked = false,
): Promise<ReadyTodo[]> {
  const { results } = await db
    .prepare(
      `SELECT todo_id, title, project, tags_json, refs_json, blocked_on,
              updated_at
         FROM todos
        WHERE user_id = ?
          AND ((state = 'pending' AND blocked_on IS NULL)
               OR (? AND state = 'blocked'))
          AND (? IS NULL OR project = ?)
          AND (? OR ${todoDependenciesReadySql()})
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .bind(
      userId,
      includeBlocked ? 1 : 0,
      project ?? null,
      project ?? null,
      includeBlocked ? 1 : 0,
      limit,
    )
    .all<{
      todo_id: string;
      title: string;
      project: string | null;
      tags_json: string;
      refs_json: string;
      blocked_on: string | null;
      updated_at: number;
    }>();
  return results.map((todo) => ({
    id: docKey("todo", todo.todo_id),
    title: todo.title,
    project: todo.project,
    tags: parseTags(todo.tags_json),
    refs: parseRefs(todo.refs_json),
    blockedOn: todo.blocked_on,
    updatedAt: todo.updated_at,
  }));
}

export async function claimTodo(
  env: TodoEnv,
  input: TodoClaim,
  provenance: Provenance,
): Promise<TodoSuccess | TodoFailure> {
  return coordinator(env, provenance.userId).claim(
    todoId(input.id),
    provenance.agent,
    input.ttl_seconds ?? 30 * 60,
    provenance.sessionName ?? null,
  );
}

export async function updateTodo(
  env: TodoEnv,
  input: TodoUpdateRequest,
  provenance: Provenance,
): Promise<TodoSuccess | TodoFailure> {
  const stub = coordinator(env, provenance.userId);
  const id = todoId(input.id);
  if (input.relations !== undefined)
    return stub.editRelations(id, {
      reconcile: input.relations.reconcile,
      parent:
        input.relations.parent === undefined
          ? undefined
          : input.relations.parent === null
            ? null
            : todoId(input.relations.parent),
      addDependsOn: input.relations.add_depends_on?.map(todoId),
      removeDependsOn: input.relations.remove_depends_on?.map(todoId),
    });
  if (input.token === undefined) throw new Error("fencing token required");
  const updated = await stub.update(
    id,
    provenance.agent,
    input.token,
    input.body ?? null,
    input.renew_ttl_seconds ?? null,
    provenance.sessionName ?? null,
    input.summary ?? null,
  );
  if (!updated.ok) return updated;
  // Pointers are content, like the title and the tags the console edits
  // unfenced. The coordinator has just checked the token on the same call,
  // which is as much of a guard as a content write gets here.
  if (input.refs !== undefined)
    await setTodoRefs(env, provenance.userId, id, input.refs);
  // The body, when given, is already the newest progress entry, so it is the
  // status the next claimant reads.
  if (input.release)
    return stub.release(
      id,
      provenance.agent,
      input.token,
      provenance.sessionName ?? null,
    );
  if (input.blocked_on === undefined) return updated;
  return stub.block(
    id,
    provenance.agent,
    input.token,
    input.blocked_on,
    provenance.sessionName ?? null,
    // The summary describes the progress body when there is one.
    input.body === undefined ? (input.summary ?? null) : null,
  );
}

/** Without a token, closes a to-do nobody holds; a live claim refuses. */
export async function completeTodo(
  env: TodoEnv,
  id: string,
  token: number | undefined,
  summary: string,
  provenance: Provenance,
): Promise<TodoSuccess | TodoFailure> {
  const stub = coordinator(env, provenance.userId);
  if (token === undefined)
    return stub.close(
      todoId(id),
      provenance.agent,
      summary,
      provenance.sessionName ?? null,
    );
  return stub.complete(
    todoId(id),
    provenance.agent,
    token,
    summary,
    provenance.sessionName ?? null,
  );
}

export type ConsoleTransition = "pending" | "blocked" | "done";

/**
 * The console's state change. It goes through the coordinator like every
 * other transition — ADR-0002 — but without a lease or a token, because the
 * person reading the page is not one of the agents racing for it.
 */
export async function overrideTodoState(
  env: TodoEnv,
  id: string,
  next: ConsoleTransition,
  note: string,
  provenance: Provenance,
): Promise<TodoSuccess | TodoFailure> {
  return coordinator(env, provenance.userId).override(
    todoId(id),
    provenance.agent,
    next,
    note,
  );
}

/**
 * Ticks or unticks one `- [ ]` in the body. `was` is the state the page drew;
 * a stale card or a body an agent rewrote underneath fails the check in
 * `setTaskItem` and lands here as null rather than as a silent reversal.
 */
export async function toggleTodoTask(
  env: { DB: D1Database },
  userId: string,
  id: string,
  line: number,
  was: boolean,
): Promise<ConsoleTodo | null> {
  const current = await getTodo(env.DB, userId, id);
  if (current === null) return null;
  const body = setTaskItem(current.body, line, was);
  if (body === null) return null;
  return editTodoContent(env, userId, id, { ...current, body });
}

export async function addTodoTask(
  env: { DB: D1Database },
  userId: string,
  id: string,
  text: string,
): Promise<ConsoleTodo | null> {
  const current = await getTodo(env.DB, userId, id);
  if (current === null) return null;
  return editTodoContent(env, userId, id, {
    ...current,
    body: appendTaskItem(current.body, text),
  });
}

/**
 * One field at a time, which is all the console's inline editor ever sends.
 * `addTags` joins the tags already there rather than replacing them: a title
 * edited to say `#duckdb` adds that tag and keeps the rest.
 */
export async function patchTodoContent(
  env: { DB: D1Database },
  userId: string,
  id: string,
  patch: Partial<TodoContentEdit>,
  addTags: readonly string[] = [],
): Promise<ConsoleTodo | null> {
  const current = await getTodo(env.DB, userId, id);
  if (current === null) return null;
  const next = { ...current, ...patch };
  if (addTags.length > 0) {
    next.tags = [...new Set([...next.tags, ...addTags])];
    if (next.tags.length > MAX_TODO_TAGS) {
      throw new Response(`A to-do takes at most ${MAX_TODO_TAGS} tags.`, {
        status: 400,
      });
    }
  }
  return editTodoContent(env, userId, id, next);
}

const MAX_TODO_TAGS = 20;

export type ReadyTodo = {
  id: string;
  title: string;
  project: string | null;
  tags: string[];
  refs: TodoRef[];
  blockedOn: string | null;
  updatedAt: number;
};

export type TodoState = "pending" | "claimed" | "done" | "blocked";

export type ConsoleTodo = {
  id: string;
  title: string;
  body: string;
  project: string | null;
  tags: string[];
  refs: TodoRef[];
  state: TodoState;
  leaseHolder: string | null;
  leaseExpiresAt: number | null;
  fencingToken: number;
  blockedOn: string | null;
  sourceAgent: string;
  sourceClient: string;
  sourceSession: string | null;
  sourceSessionName: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type TodoContentEdit = {
  title: string;
  body: string;
  project: string | null;
  tags: readonly string[];
  refs: readonly TodoRef[];
};

export type TodoUpdate = {
  id: string;
  kind: "progress" | "claim" | "release" | "complete" | "blocked" | "comment";
  author: string;
  /** The author's session name when its client sent one. ADR-0004. */
  sessionName: string | null;
  token: number | null;
  body: string;
  /** One line; the stored one, else the body's cut. Null for an empty body. */
  summary: string | null;
  createdAt: number;
};

/**
 * The console's list: blocked rows first, then the rest, each newest created
 * first. Blocked leads so a window prefix always holds every blocker; no
 * write but a state change moves a row, and the page holds that one in
 * place until the list is reopened (`useSections`, P4).
 */
export async function listTodos(
  db: D1Database,
  userId: string,
  filters: ListFilters = {},
  window?: ListWindow,
): Promise<ConsoleTodo[]> {
  const { results } = await todoListStatement(
    db,
    `SELECT todo_id, title, body, project, tags_json, refs_json, state,
              lease_holder, lease_expires_at, fencing_token, blocked_on,
              source_agent, source_client, source_session, source_session_name,
               created_at, updated_at, completed_at`,
    `AND (? = 0 OR state <> 'done')
       AND (? = 0 OR state = 'blocked')
       ORDER BY state = 'blocked' DESC, created_at DESC, rowid DESC
       LIMIT ? OFFSET ?`,
  )
    .bind(
      userId,
      ...todoListParams(filters),
      filters.showDone ? 0 : 1,
      filters.blocked ? 1 : 0,
      window?.limit ?? -1,
      window?.offset ?? 0,
    )
    .all<TodoRow>();
  return results.map(consoleTodo);
}

export async function countTodos(
  db: D1Database,
  userId: string,
  filters: ListFilters = {},
) {
  const { results } = await todoListStatement(
    db,
    "SELECT state, COUNT(*) AS count",
    "GROUP BY state",
  )
    .bind(userId, ...todoListParams(filters))
    .all<{ state: TodoState; count: number }>();
  return {
    done: results.find((row) => row.state === "done")?.count ?? 0,
    blocked: results.find((row) => row.state === "blocked")?.count ?? 0,
    total: results
      .filter(
        (row) =>
          !(!filters.showDone && row.state === "done") &&
          !(filters.blocked && row.state !== "blocked"),
      )
      .reduce((sum, row) => sum + row.count, 0),
  };
}

function todoListParams(filters: ListFilters) {
  return [
    filters.query ?? "",
    filters.query ?? "",
    filters.query ?? "",
    filters.project ?? null,
    filters.project ?? null,
    tagsParam(filters),
  ];
}

function todoListStatement(db: D1Database, select: string, tail: string) {
  return db.prepare(`${select} FROM todos
        -- instr, not LIKE: D1 rejects a LIKE pattern over 50 bytes, and
        -- a pasted title is longer than that. It also keeps % and _ literal.
        WHERE user_id = ?
          AND (
          ? = '' OR instr(lower(title), lower(?)) > 0
            OR instr(lower(body), lower(?)) > 0
        )
          AND (? IS NULL OR project = ?)
          AND ${everyTagSql("tags_json")} ${tail}`);
}

/**
 * Each project with how many rows picking it would list: the same search,
 * tags and state filters as `listTodos`, with the project filter left out, so
 * a chip's count is the length of the list one click on it shows.
 */
export async function listTodoProjects(
  db: D1Database,
  userId: string,
  filters: ListFilters = {},
): Promise<{ project: string; count: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT project, COUNT(*) AS count
         FROM todos
        WHERE user_id = ? AND project IS NOT NULL AND project <> ''
          AND (
            ? = '' OR instr(lower(title), lower(?)) > 0
              OR instr(lower(body), lower(?)) > 0
          )
          AND ${everyTagSql("tags_json")}
          AND (? = 0 OR state <> 'done')
          AND (? = 0 OR state = 'blocked')
        GROUP BY project
        ORDER BY project`,
    )
    .bind(
      userId,
      filters.query ?? "",
      filters.query ?? "",
      filters.query ?? "",
      tagsParam(filters),
      filters.showDone ? 0 : 1,
      filters.blocked ? 1 : 0,
    )
    .all<{ project: string; count: number }>();
  return results;
}

export async function getTodo(
  db: D1Database,
  userId: string,
  id: string,
): Promise<ConsoleTodo | null> {
  const row = await db
    .prepare(
      `SELECT todo_id, title, body, project, tags_json, refs_json, state,
              lease_holder, lease_expires_at, fencing_token, blocked_on,
              source_agent, source_client, source_session, source_session_name,
              created_at, updated_at, completed_at
         FROM todos
        WHERE todo_id = ? AND user_id = ?`,
    )
    .bind(id, userId)
    .first<TodoRow>();
  return row === null ? null : consoleTodo(row);
}

/** The pointer half of a content edit, for the agent path. */
export async function setTodoRefs(
  env: { DB: D1Database },
  userId: string,
  id: string,
  refs: readonly TodoRef[],
): Promise<ConsoleTodo | null> {
  const current = await getTodo(env.DB, userId, id);
  if (current === null) return null;
  return editTodoContent(env, userId, id, { ...current, refs });
}

/**
 * Content only: state, lease, and fencing token belong to the coordinator and
 * are not in this statement. The row and its search projection move together.
 */
export async function editTodoContent(
  env: { DB: D1Database },
  userId: string,
  id: string,
  edit: TodoContentEdit,
): Promise<ConsoleTodo | null> {
  const current = await getTodo(env.DB, userId, id);
  if (current === null) return null;

  const updatedAt = Math.floor(Date.now() / 1000);
  const tagsJson = JSON.stringify(edit.tags);
  const refsJson = JSON.stringify(edit.refs);
  const comments = await commentText(env.DB, id);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE todos
            SET title = ?, body = ?, project = ?, tags_json = ?,
                refs_json = ?, updated_at = ?
          WHERE todo_id = ? AND user_id = ?`,
    ).bind(
      edit.title,
      edit.body,
      edit.project,
      tagsJson,
      refsJson,
      updatedAt,
      id,
      userId,
    ),
    projectionStatement(
      env.DB,
      projectTodo({
        todoId: id,
        userId,
        title: edit.title,
        body: edit.body,
        tagsJson,
        refsJson,
        project: edit.project,
        updatedAt,
        comments,
      }),
      docKey("todo", id),
    ),
  ]);
  return getTodo(env.DB, userId, id);
}

/**
 * A comment on any to-do, by anyone with write access. It needs no lease and
 * no token because it changes nothing the coordinator guards: not the state,
 * not the holder. The row and the to-do's projection, now carrying the
 * comment, commit in one batch (ADR-0001).
 */
export async function commentTodo(
  env: { DB: D1Database },
  id: string,
  body: string,
  provenance: Provenance,
  summary: string | null = null,
): Promise<{ commentId: string; createdAt: number } | null> {
  const todo = await getTodo(env.DB, provenance.userId, id);
  if (todo === null) return null;
  const commentId = `tdc_${uuid7()}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const earlier = await commentText(env.DB, id);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO todo_comments (
          comment_id, todo_id, author, source_client, source_session,
          source_session_name, body, summary, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      commentId,
      id,
      provenance.agent,
      provenance.client,
      provenance.session,
      provenance.sessionName ?? null,
      body,
      updateSummary(body, summary),
      createdAt,
    ),
    projectionStatement(
      env.DB,
      projectTodo({
        todoId: id,
        userId: provenance.userId,
        title: todo.title,
        body: todo.body,
        tagsJson: JSON.stringify(todo.tags),
        refsJson: JSON.stringify(todo.refs),
        project: todo.project,
        updatedAt: todo.updatedAt,
        comments: [earlier, body].filter(Boolean).join("\n"),
      }),
      docKey("todo", id),
    ),
  ]);
  return { commentId, createdAt };
}

/** Every comment body on a to-do, oldest first, for its projection. */
async function commentText(
  db: D1Database,
  id: string,
): Promise<string | undefined> {
  const { results } = await db
    .prepare(
      `SELECT body FROM todo_comments
        WHERE todo_id = ?
        ORDER BY created_at, comment_id`,
    )
    .bind(id)
    .all<{ body: string }>();
  return results.length ? results.map((row) => row.body).join("\n") : undefined;
}

export async function listTodoUpdates(
  db: D1Database,
  userId: string,
  id: string,
): Promise<TodoUpdate[]> {
  return (await listTodoUpdatesFor(db, userId, [id])).get(id) ?? [];
}

/**
 * Every listed to-do's log in one query, keyed by bare id. The console list
 * read one log per row before, so a forty-row page cost forty round trips to
 * D1 on every load.
 */
export async function listTodoUpdatesFor(
  db: D1Database,
  userId: string,
  ids: string[],
): Promise<Map<string, TodoUpdate[]>> {
  const byTodo = new Map<string, TodoUpdate[]>();
  if (ids.length === 0) return byTodo;
  const { results } = await db
    .prepare(
      `WITH owned AS (
         SELECT todo_id FROM todos
          WHERE user_id = ?2 AND todo_id IN (SELECT value FROM json_each(?1))
       )
       SELECT * FROM (
         SELECT todo_id, update_id, kind, author, session_name, token, body,
                summary, created_at
           FROM todo_updates
          WHERE todo_id IN (SELECT todo_id FROM owned)
         UNION ALL
         SELECT todo_id, comment_id, 'comment', author, source_session_name,
                NULL, body, summary, created_at
           FROM todo_comments
          WHERE todo_id IN (SELECT todo_id FROM owned)
       )
       -- Ties inside a second break on the id past its tdu_/tdc_ prefix: a
       -- UUIDv7 sorts in write order across both tables.
       ORDER BY created_at DESC, substr(update_id, 5) DESC`,
    )
    .bind(JSON.stringify(ids), userId)
    .all<{
      todo_id: string;
      update_id: string;
      kind: string;
      author: string;
      session_name: string | null;
      token: number | null;
      body: string;
      summary: string | null;
      created_at: number;
    }>();
  for (const update of results) {
    const list = byTodo.get(update.todo_id) ?? [];
    list.push({
      id: update.update_id,
      kind: todoUpdateKind(update.kind),
      author: update.author,
      sessionName: update.session_name,
      token: update.token,
      body: update.body,
      summary: update.summary ?? updateSummary(update.body),
      createdAt: update.created_at,
    });
    byTodo.set(update.todo_id, list);
  }
  return byTodo;
}

type TodoRow = {
  todo_id: string;
  title: string;
  body: string;
  project: string | null;
  tags_json: string;
  refs_json: string;
  state: string;
  lease_holder: string | null;
  lease_expires_at: number | null;
  fencing_token: number;
  blocked_on: string | null;
  source_agent: string;
  source_client: string;
  source_session: string | null;
  source_session_name: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

function consoleTodo(row: TodoRow): ConsoleTodo {
  return {
    id: docKey("todo", row.todo_id),
    title: row.title,
    body: row.body,
    project: row.project,
    tags: parseTags(row.tags_json),
    refs: parseRefs(row.refs_json),
    state: todoState(row.state),
    leaseHolder: row.lease_holder,
    leaseExpiresAt: row.lease_expires_at,
    fencingToken: row.fencing_token,
    blockedOn: row.blocked_on,
    sourceAgent: row.source_agent,
    sourceClient: row.source_client,
    sourceSession: row.source_session,
    sourceSessionName: row.source_session_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function todoState(value: string): TodoState {
  switch (value) {
    case "pending":
    case "claimed":
    case "done":
    case "blocked":
      return value;
    default:
      throw new Error(`unknown todo state: ${value}`);
  }
}

function todoUpdateKind(value: string): TodoUpdate["kind"] {
  switch (value) {
    case "progress":
    case "claim":
    case "release":
    case "complete":
    case "blocked":
    case "comment":
      return value;
    default:
      throw new Error(`unknown todo update kind: ${value}`);
  }
}

function coordinator(env: TodoEnv, userId: string) {
  return env.TODO_COORDINATOR.getByName(`todos:${userId}`);
}

function todoId(id: string): string {
  return id.slice("todo:".length);
}

/** Tolerant by design: a hand-edited row never breaks the page. */
function parseRefs(value: string): TodoRef[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (ref): ref is TodoRef =>
        typeof ref === "object" &&
        ref !== null &&
        typeof (ref as TodoRef).kind === "string" &&
        typeof (ref as TodoRef).value === "string",
    );
  } catch {
    return [];
  }
}

function parseTags(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * A picker's suggestions: to-dos whose title or id contains `query`, open
 * work before done, newest first within each. Title and id only, not body, so
 * a word in a long description does not crowd out the to-do named by it.
 */
export async function suggestTodos(
  db: D1Database,
  userId: string,
  query: string,
  limit = 12,
): Promise<
  { id: string; title: string; project: string | null; state: string }[]
> {
  const needle = query.trim().replace(/^todo:/, "");
  const { results } = await db
    .prepare(
      `SELECT todo_id, title, project, state FROM todos
        WHERE user_id = ?
          AND (? = '' OR instr(lower(title), lower(?)) > 0
            OR instr(lower(todo_id), lower(?)) > 0)
        ORDER BY state = 'done', created_at DESC, rowid DESC
        LIMIT ?`,
    )
    .bind(userId, needle, needle, needle, limit)
    .all<{
      todo_id: string;
      title: string;
      project: string | null;
      state: string;
    }>();
  return results.map((row) => ({
    id: `todo:${row.todo_id}`,
    title: row.title,
    project: row.project,
    state: row.state,
  }));
}
