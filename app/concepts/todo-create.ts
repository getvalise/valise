import { docKey, projectTodo } from "~/search/project";
import { projectionStatement } from "~/search/write";
import type { Provenance } from "./memories";
import type { TodoDraft } from "./todo-contracts";
import { TODO_GRAPH_FENCE_SQL } from "./todo-relations";

export type TodoCreation = TodoDraft;

/** Kept separate so the coordinator can atomically create a related ticket. */
export function todoCreateStatements(
  db: D1Database,
  todoId: string,
  input: TodoCreation,
  provenance: Provenance,
  now: number,
  graphToken?: string,
) {
  const body = input.body ?? "";
  const tagsJson = JSON.stringify(input.tags ?? []);
  const refsJson = JSON.stringify(input.refs ?? []);
  const projection = projectTodo({
    todoId,
    userId: provenance.userId,
    title: input.title,
    body,
    tagsJson,
    refsJson,
    project: input.project,
    updatedAt: now,
  });
  if (!projection)
    throw new Error("To-do creation must publish its projection");
  const guard =
    graphToken === undefined ? "" : ` WHERE ${TODO_GRAPH_FENCE_SQL}`;
  const guardBindings =
    graphToken === undefined ? [] : [provenance.userId, graphToken];
  return [
    db
      .prepare(`INSERT INTO todos (todo_id, user_id, title, body, project, tags_json, refs_json, state,
      fencing_token, source_agent, source_client, source_session, source_session_name, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?${guard}`)
      .bind(
        todoId,
        provenance.userId,
        input.title,
        body,
        input.project,
        tagsJson,
        refsJson,
        provenance.agent,
        provenance.client,
        provenance.session,
        provenance.sessionName ?? null,
        now,
        now,
        ...guardBindings,
      ),
    projectionStatement(
      db,
      graphToken === undefined
        ? projection
        : {
            selectSql: `SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?${guard}`,
            bindings: [
              projection.docKey,
              projection.userId,
              projection.concept,
              projection.conceptId,
              projection.project,
              projection.title,
              projection.body,
              projection.tags,
              projection.updatedAt,
              ...guardBindings,
            ],
          },
      docKey("todo", todoId),
    ),
  ];
}
