import type { TodoCoordinator } from "~/do/todo-coordinator";

export const MAX_TODO_DEPENDENCIES = 20;
export const TODO_GRAPH_LIMIT = 256;
export const TODO_RELATION_PAGE = 50;
/** Display readiness shared by work selection and bounded orientation. Claim uses live authority. */
export function todoDependenciesReadySql(table = "todos") {
  return `NOT EXISTS (
    SELECT 1 FROM todo_relations r LEFT JOIN todos prerequisite
      ON prerequisite.todo_id = r.to_todo_id AND prerequisite.user_id = ${table}.user_id
    WHERE r.from_todo_id = ${table}.todo_id AND r.kind = 'depends-on'
      AND (r.user_id <> ${table}.user_id OR prerequisite.todo_id IS NULL OR prerequisite.state <> 'done')
  )`;
}
/** Orientation category, not a stored state or a replacement manual reason. */
export function todoEffectivelyBlockedSql(table = "todos") {
  return `(${table}.state = 'blocked' OR (${table}.state = 'pending'
    AND (${table}.blocked_on IS NOT NULL OR NOT ${todoDependenciesReadySql(table)})))`;
}
export const TODO_GRAPH_FENCE_SQL =
  "EXISTS (SELECT 1 FROM todo_relation_fences WHERE user_id = ? AND token = ?)";

export type TodoRelationEdit = {
  parent?: string | null;
  addDependsOn?: string[];
  removeDependsOn?: string[];
  reconcile?: boolean;
};

export type RelatedTodo = {
  id: string;
  title: string;
  state: string;
  project: string | null;
};

export type TodoRelations = {
  parent: RelatedTodo | null;
  children: RelatedTodo[];
  depends_on: RelatedTodo[];
  blocks: RelatedTodo[];
  child_progress: { done: number; total: number };
  children_truncated: boolean;
  blocks_truncated: boolean;
  note: string;
};

/** Display only: claim uses live coordinator state, never these D1 mirrors. */
export async function readTodoRelations(
  db: D1Database,
  userId: string,
  id: string,
): Promise<TodoRelations> {
  return (
    (await readTodoRelationsFor(db, userId, [id])).get(id) ??
    emptyTodoRelations()
  );
}

export function emptyTodoRelations(): TodoRelations {
  return {
    parent: null,
    children: [],
    depends_on: [],
    blocks: [],
    child_progress: { done: 0, total: 0 },
    children_truncated: false,
    blocks_truncated: false,
    note: "States may lag. Children organize independent work; dependencies gate claims. Manual blocked_on is separate. No automatic completion or reopening.",
  };
}

/** One bounded payload query for the entire displayed prefix, not one per card. */
export async function readTodoRelationsFor(
  db: D1Database,
  userId: string,
  ids: string[],
) {
  const byTodo = new Map<string, TodoRelations>();
  if (!ids.length) return byTodo;
  const { results } = await db
    .prepare(`WITH owned AS (
    SELECT todo_id FROM todos WHERE user_id = ?1 AND todo_id IN (SELECT value FROM json_each(?2))
  ), pairs AS (
    SELECT o.todo_id AS root, r.kind, 0 AS inverse, r.to_todo_id AS target FROM owned o
      JOIN todo_relations r ON r.from_todo_id = o.todo_id AND r.user_id = ?1
    UNION ALL
    SELECT o.todo_id, r.kind, 1, r.from_todo_id FROM owned o
      JOIN todo_relations r ON r.to_todo_id = o.todo_id AND r.user_id = ?1
  ), ranked AS (
    SELECT p.*, t.title, t.state, t.project,
      ROW_NUMBER() OVER (PARTITION BY root, kind, inverse ORDER BY t.created_at, t.todo_id) AS rank,
      COUNT(*) OVER (PARTITION BY root, kind, inverse) AS total,
      SUM(t.state = 'done') OVER (PARTITION BY root, kind, inverse) AS done
    FROM pairs p JOIN todos t ON t.todo_id = p.target AND t.user_id = ?1
  ) SELECT * FROM ranked WHERE rank <= ?3 ORDER BY root, kind, inverse, rank`)
    .bind(userId, JSON.stringify(ids), TODO_RELATION_PAGE)
    .all<{
      root: string;
      target: string;
      kind: string;
      inverse: number;
      title: string;
      state: string;
      project: string | null;
      total: number;
      done: number;
    }>();
  for (const row of results) {
    const value = byTodo.get(row.root) ?? emptyTodoRelations();
    const related = {
      id: `todo:${row.target}`,
      title: row.title,
      state: row.state,
      project: row.project,
    };
    if (row.kind === "parent" && !row.inverse) value.parent = related;
    else if (row.kind === "parent") {
      value.children.push(related);
      value.child_progress = { done: row.done, total: row.total };
      value.children_truncated = row.total > TODO_RELATION_PAGE;
    } else if (!row.inverse) value.depends_on.push(related);
    else {
      value.blocks.push(related);
      value.blocks_truncated = row.total > TODO_RELATION_PAGE;
    }
    byTodo.set(row.root, value);
  }
  return byTodo;
}

export function editTodoRelations(
  env: { TODO_COORDINATOR: DurableObjectNamespace<TodoCoordinator> },
  userId: string,
  id: string,
  edit: TodoRelationEdit,
) {
  return env.TODO_COORDINATOR.getByName(`todos:${userId}`).editRelations(
    id,
    edit,
  );
}

/**
 * Every relation the console offers, read from the open to-do's side: "Blocked
 * by X" means this waits for X. The stored graph has two edge kinds, each
 * written on the to-do it points out of, so a type names which end the edit
 * lands on and what it changes there. A new kind is one entry here, one
 * branch in `relationEdit`, and its rows in `relationRows`.
 */
export const TODO_RELATION_TYPES = [
  {
    key: "blocked-by",
    label: "Blocked by",
    hint: "This waits until that one is done",
  },
  { key: "blocks", label: "Blocks", hint: "That one waits for this" },
  { key: "parent", label: "Parent", hint: "This sits under that one" },
  { key: "child", label: "Child", hint: "That one sits under this" },
] as const;

export type TodoRelationType = (typeof TODO_RELATION_TYPES)[number]["key"];

export function isTodoRelationType(value: unknown): value is TodoRelationType {
  return TODO_RELATION_TYPES.some((type) => type.key === value);
}

/**
 * The one coordinator edit that adds or removes `type` between the open to-do
 * and `target`. Bare ids, no `todo:` prefix. Parent and blocked-by edit the
 * open to-do; child and blocks edit the target, because that is where the
 * edge starts.
 */
export function relationEdit(
  type: TodoRelationType,
  operation: "add" | "remove",
  self: string,
  target: string,
): { subject: string; edit: TodoRelationEdit } {
  const add = operation === "add";
  switch (type) {
    case "parent":
      return { subject: self, edit: { parent: add ? target : null } };
    case "child":
      return { subject: target, edit: { parent: add ? self : null } };
    case "blocked-by":
      return {
        subject: self,
        edit: add ? { addDependsOn: [target] } : { removeDependsOn: [target] },
      };
    case "blocks":
      return {
        subject: target,
        edit: add ? { addDependsOn: [self] } : { removeDependsOn: [self] },
      };
  }
}

/** Every relation as one list, in the registry's order. */
export function relationRows(relations: TodoRelations) {
  const by: Record<TodoRelationType, RelatedTodo[]> = {
    "blocked-by": relations.depends_on,
    blocks: relations.blocks,
    parent: relations.parent ? [relations.parent] : [],
    child: relations.children,
  };
  return TODO_RELATION_TYPES.flatMap((type) =>
    by[type.key].map((todo) => ({ type: type.key, label: type.label, todo })),
  );
}
