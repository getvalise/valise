import { data, redirect } from "react-router";
import { editTarget } from "~/components/editable";
import type { Attachment } from "~/concepts/attachments";
import { filtersFromRequest, listHref } from "~/concepts/list-filters";
import { infiniteWindow } from "~/concepts/pagination";
import { parseQuickAdd } from "~/concepts/quick-add";
import { mentionedTodoIds } from "~/concepts/todo-mentions";
import { emptyTodoRelations } from "~/concepts/todo-relations";
import type { ConsoleTodo } from "~/concepts/todos";
import {
  type ConsoleActor,
  requireConsoleActor,
  requireSameOriginAction,
} from "~/console/context.server";
import {
  afterSave,
  parseFileChange,
  parseTaskAdd,
  parseTaskToggle,
  parseTodoComment,
  parseTodoFieldEdit,
  parseTodoState,
} from "~/console/forms.server";
import { parseTodoRelationForm } from "~/console/todo-relations.server";
import { ADDING } from "~/features/todos/urls";
import { fileSize, MAX_OBJECT_BYTES, ObjectRefused } from "~/r2/objects";
import type { Route } from "../routes/+types/todos";

/** The MCP write's own limit on a body, `createTodoInput`. */
const MAX_BODY = 16 * 1024;

/**
 * The queue, as a list you can work rather than a list you can read.
 *
 * Two things carry it. A to-do is completed from its own checkbox, which
 * goes through the coordinator like every other transition and bumps the
 * fencing token on the way past, so overriding an agent's claim fences that
 * agent instead of racing it. And every field is edited where it sits: the
 * pen beside the value opens that one field in place, with no record-wide
 * edit form to overwrite the four things you did not mean to touch.
 */

export async function loader({ context, request }: Route.LoaderArgs) {
  const actor = await requireConsoleActor(context, request);
  const filters = filtersFromRequest(request);
  const todosStore = actor.store.todos;
  const params = new URL(request.url).searchParams;
  const opened =
    params.get("open") ?? editTarget(params.get("edit") ?? undefined);
  // Independent reads go out together; a D1 round trip is the unit of cost.
  const [counts, vocabulary, facets, projects, onboarding] = await Promise.all([
    todosStore.count(filters),
    actor.store.vocabulary(),
    actor.store.facets("todo"),
    todosStore.projects(filters),
    actor.store.onboarding.read(),
  ]);
  const window = infiniteWindow(counts.total, filters.page);
  filters.page = window.page > 1 ? window.page : undefined;
  const todos = await todosStore.list(filters, window);
  const detail =
    opened && !todos.some((todo) => todo.id === opened)
      ? await todosStore.get(opened.slice("todo:".length))
      : null;
  const ids = [...todos, ...(detail ? [detail] : [])].map((todo) =>
    todo.id.slice("todo:".length),
  );
  // One query each for every row's files and log, not one per row.
  const [files, updates, relations] = await Promise.all([
    todosStore.attachments(ids),
    todosStore.updates(ids),
    todosStore.relations(ids),
  ]);
  // Every to-do the loaded bodies and updates name, titled in one query;
  // the rows already listed answer for themselves.
  const listed = new Map(
    [...todos, ...(detail ? [detail] : [])].map((todo) => [
      todo.id,
      { title: todo.title, state: todo.state },
    ]),
  );
  const mentioned = mentionedTodoIds([
    ...[...todos, ...(detail ? [detail] : [])].flatMap((todo) => [
      todo.body,
      todo.blockedOn ?? "",
    ]),
    ...[...updates.values()].flat().map((update) => update.body ?? ""),
  ]);
  const mentions = {
    ...Object.fromEntries(
      mentioned.flatMap((id) => {
        const known = listed.get(id);
        return known ? [[id, known]] : [];
      }),
    ),
    ...(await todosStore.mentions(mentioned.filter((id) => !listed.has(id)))),
  };
  const enrich = (todo: ConsoleTodo) => ({
    ...todo,
    files: files.get(todo.id.slice(5)) ?? [],
    updates: updates.get(todo.id.slice(5)) ?? [],
    relations: relations.get(todo.id.slice(5)) ?? emptyTodoRelations(),
  });
  return {
    onboarding,
    doneCount: counts.done,
    blockedCount: counts.blocked,
    window,
    todos: todos.map(enrich),
    detail: detail ? enrich(detail) : null,
    mentions,
    now: Math.floor(Date.now() / 1000),
    vocabulary,
    facets,
    projects,
    filters,
    user: actor.user,
  };
}

/**
 * The list the request came from, with the to-do it had open still open, so
 * a document post from inside the dialog lands back in it (P3, P11).
 */
function backTo(request: Request): string {
  const params = new URL(request.url).searchParams;
  return listHref("/todos", filtersFromRequest(request), {
    open: params.get("open") ?? undefined,
    history: params.get("history") ?? undefined,
  });
}

export async function action({ context, request }: Route.ActionArgs) {
  requireSameOriginAction(request);
  const actor = await requireConsoleActor(context, request);
  // Refused before the body is read: every form here but a file is a few KB.
  if (
    Number(request.headers.get("content-length")) >
    MAX_OBJECT_BYTES + 64 * 1024
  ) {
    return data(
      { attachError: `Files are limited to ${fileSize(MAX_OBJECT_BYTES)}.` },
      { status: 413 },
    );
  }
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "relation") {
    const change = parseTodoRelationForm(form);
    const result = await actor.store.todos.editRelations(
      change.subject,
      change.edit,
    );
    if (!result.ok)
      return data(
        { relationId: change.id, relationError: result.reason },
        { status: 409 },
      );
    if (change.edit.reconcile)
      return data({
        relationId: change.id,
        relationNotice:
          "Interrupted relation writes are fenced. Inspect the graph before retrying; no edit was replayed.",
      });
    return afterSave(form, backTo(request));
  }

  if (intent === "detach-file" || intent === "restore-file") {
    const change = parseFileChange(form);
    if (!change.id.startsWith("todo:"))
      throw new Response("Invalid to-do id.", { status: 400 });
    const target = {
      concept: "todo",
      id: change.id.slice("todo:".length),
    } as const;
    const file = (await actor.store.todos.attachments([target.id]))
      .get(target.id)
      ?.find((file) => file.objectId === change.objectId);
    if (
      !(await actor.store.todos.setFileAttached(
        target.id,
        change.objectId,
        intent === "restore-file",
      ))
    ) {
      throw new Response("File not found.", { status: 404 });
    }
    if (intent === "detach-file" && form.get("via") !== "fetcher" && file) {
      return { removed: { id: change.id, file } };
    }
    return afterSave(form, backTo(request));
  }

  if (intent === "attach") {
    const id = String(form.get("id") ?? "").slice("todo:".length);
    // The picker posts one file; a drop on the dialog posts all it carried.
    const files = form
      .getAll("file")
      .filter((file): file is File => file instanceof File && file.name !== "");
    if (files.length === 0) {
      return data(
        { attachError: "Pick a file first.", id: `todo:${id}` },
        { status: 400 },
      );
    }
    const attached: Attachment[] = [];
    for (const file of files) {
      let one: Attachment | null;
      try {
        one = await actor.store.todos.attach(id, file);
      } catch (error) {
        if (!(error instanceof ObjectRefused)) throw error;
        return data(
          { attachError: error.message, id: `todo:${id}`, attached },
          { status: 400 },
        );
      }
      if (one === null) {
        throw new Response("To-do not found.", { status: 404 });
      }
      attached.push(one);
    }
    // A drop answers with the files, so the field it landed in can link them.
    return form.get("via") === "fetcher"
      ? { attached }
      : redirect(backTo(request));
  }

  if (intent === "create") {
    const filters = filtersFromRequest(request);
    const text = String(form.get("text") ?? "");
    const body = String(form.get("body") ?? "");
    const parsed =
      body.trim().length > MAX_BODY
        ? { error: `Keep the description under ${MAX_BODY / 1024} KB.` }
        : parseQuickAdd(text, filters.project);
    if ("error" in parsed) {
      return data({ error: parsed.error, text, body }, { status: 400 });
    }
    // The MCP tool's own write, so the row and its projection share one
    // batch (ADR-0001), and "Opened by" reads console · web.
    const todo = await actor.store.todos.create({
      ...parsed,
      body: body.trim(),
    });
    // The add row stays open for the next one, with scripting off as well.
    return form.get("via") === "fetcher"
      ? { created: { id: todo.id, title: todo.title } }
      : redirect(listHref("/todos", filters, { edit: ADDING }));
  }

  if (intent === "comment") {
    let comment;
    try {
      comment = parseTodoComment(form);
    } catch (error) {
      if (!(error instanceof Response)) throw error;
      return data(
        {
          commentError: await error.text(),
          id: String(form.get("id") ?? ""),
          body: String(form.get("body") ?? ""),
        },
        { status: error.status },
      );
    }
    const posted = await actor.store.todos.comment(
      comment.id.slice("todo:".length),
      comment.body,
    );
    if (posted === null)
      throw new Response("To-do not found.", { status: 404 });
    return afterSave(form, backTo(request));
  }

  if (intent === "set-state") {
    const change = parseTodoState(form);
    const moved = await actor.store.todos.overrideState(
      change.id,
      change.state,
      change.note || `set to ${change.state} from the console`,
    );
    if (!moved.ok)
      return data(
        { stateId: change.id, stateError: moved.reason },
        { status: 409 },
      );
    return afterSave(form, backTo(request));
  }

  const id = String(form.get("id") ?? "").slice("todo:".length);
  const changed = await applyContentIntent(actor.store.todos, id, intent, form);
  if (changed === null) {
    throw new Response(
      intent === "toggle-task"
        ? "That checkbox has moved. Reload the page."
        : "To-do not found.",
      { status: intent === "toggle-task" ? 409 : 404 },
    );
  }
  return afterSave(form, backTo(request));
}

function applyContentIntent(
  todos: ConsoleActor["store"]["todos"],
  id: string,
  intent: unknown,
  form: FormData,
): Promise<ConsoleTodo | null> {
  switch (intent) {
    case "toggle-task": {
      const toggle = parseTaskToggle(form);
      return todos.toggleTask(id, toggle.line, toggle.was);
    }
    case "add-task":
      return todos.addTask(id, parseTaskAdd(form).text);
    case "edit-field": {
      const edit = parseTodoFieldEdit(form);
      return todos.patch(id, edit.patch, edit.addTags);
    }
    default:
      throw new Response("Unknown form intent.", { status: 400 });
  }
}
