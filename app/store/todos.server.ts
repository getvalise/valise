import {
  attachTodoFile,
  listTodoAttachments,
  setFileAttached,
} from "~/concepts/attachments";
import type { ListFilters } from "~/concepts/list-filters";
import type { Provenance } from "~/concepts/memories";
import type { ListWindow } from "~/concepts/pagination";
import { readProjectBrief } from "~/concepts/startup-brief";
import { listActivity, todoFreshnessFor } from "~/concepts/todo-activity";
import type {
  TodoClaim,
  TodoDraft,
  TodoUpdateRequest,
} from "~/concepts/todo-contracts";
import { readTodoMentions } from "~/concepts/todo-mentions";
import { queryTodos, type TodoQuery } from "~/concepts/todo-query";
import {
  editTodoRelations,
  readTodoRelations,
  readTodoRelationsFor,
  type TodoRelationEdit,
} from "~/concepts/todo-relations";
import { editTodoTags, type TodoTagEdit } from "~/concepts/todo-tags";
import {
  addTodoTask,
  type ConsoleTransition,
  claimTodo,
  commentTodo,
  completeTodo,
  countTodos,
  createTodo,
  getTodo,
  listReady,
  listTodoProjects,
  listTodos,
  listTodoUpdates,
  listTodoUpdatesFor,
  overrideTodoState,
  patchTodoContent,
  suggestTodos,
  type TodoContentEdit,
  toggleTodoTask,
  updateTodo,
} from "~/concepts/todos";
import type { TodoCoordinator } from "~/do/todo-coordinator";

export type TodoStoreData = {
  DB: D1Database;
  BUNDLES: R2Bucket;
  TODO_COORDINATOR: DurableObjectNamespace<TodoCoordinator>;
};

/**
 * To-do operations bound to one tenant. Ids are bare (`tdo_…`), as the
 * concepts take them. Transitions still go through the coordinator (ADR-0002):
 * `overrideState` and `editRelations` are the coordinator's, never a row write.
 */
export function todoStore(
  data: TodoStoreData,
  userId: string,
  provenance: Provenance,
) {
  const db = data.DB;
  return Object.freeze({
    list: (filters: ListFilters = {}, window?: ListWindow) =>
      listTodos(db, userId, filters, window),
    count: (filters: ListFilters = {}) => countTodos(db, userId, filters),
    projects: (filters: ListFilters = {}) =>
      listTodoProjects(db, userId, filters),
    get: (id: string) => getTodo(db, userId, id),
    suggest: (query: string) => suggestTodos(db, userId, query),
    updates: (ids: string[]) => listTodoUpdatesFor(db, userId, ids),
    /** One to-do's whole thread, newest first. */
    thread: (id: string) => listTodoUpdates(db, userId, id),
    relations: (ids: string[]) => readTodoRelationsFor(db, userId, ids),
    relationsOf: (id: string) => readTodoRelations(db, userId, id),
    /** Title and state of each `todo:tdo_…` named in prose. */
    mentions: (ids: string[]) => readTodoMentions(db, userId, ids),
    ready: (project?: string, limit?: number, includeBlocked?: boolean) =>
      listReady(db, userId, project, limit, includeBlocked),
    activity: (project?: string, limit?: number) =>
      listActivity(db, userId, project, limit),
    freshness: (ids: string[]) => todoFreshnessFor(db, userId, ids),
    query: (input?: TodoQuery) => queryTodos(db, userId, input),
    brief: (input?: { project?: string; since?: number }) =>
      readProjectBrief(db, userId, input),
    attachments: (ids: string[]) => listTodoAttachments(db, userId, ids),
    create: (draft: TodoDraft) => createTodo(data, draft, provenance),
    comment: (id: string, body: string, summary: string | null = null) =>
      commentTodo(data, id, body, provenance, summary),
    claim: (input: TodoClaim) => claimTodo(data, input, provenance),
    update: (input: TodoUpdateRequest) => updateTodo(data, input, provenance),
    complete: (id: string, token: number | undefined, summary: string) =>
      completeTodo(data, id, token, summary, provenance),
    editTags: (id: string, edit: TodoTagEdit) =>
      editTodoTags(db, userId, id, edit),
    overrideState: (id: string, next: ConsoleTransition, note: string) =>
      overrideTodoState(data, id, next, note, provenance),
    editRelations: (subject: string, edit: TodoRelationEdit) =>
      editTodoRelations(data, userId, subject, edit),
    toggleTask: (id: string, line: number, was: boolean) =>
      toggleTodoTask(data, userId, id, line, was),
    addTask: (id: string, text: string) => addTodoTask(data, userId, id, text),
    patch: (
      id: string,
      patch: Partial<TodoContentEdit>,
      addTags: readonly string[] = [],
    ) => patchTodoContent(data, userId, id, patch, addTags),
    attach: (id: string, file: File) => attachTodoFile(data, userId, id, file),
    setFileAttached: (id: string, objectId: string, attached: boolean) =>
      setFileAttached(db, userId, { concept: "todo", id }, objectId, attached),
  });
}
