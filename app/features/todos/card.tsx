import { type FormEvent, useState } from "react";
import {
  useActionData,
  useFetcher,
  useNavigate,
  useSearchParams,
} from "react-router";
import {
  Editable,
  editKey,
  openField,
  useLanded,
  usePendingValue,
} from "~/components/editable";
import { TagInput, TagSet } from "~/components/tag-input";
import { Card } from "~/components/ui";
import { type ListFilters, listHref, withTag } from "~/concepts/list-filters";
import { parseQuickAdd, type QuickAddVocabulary } from "~/concepts/quick-add";
import { taskProgress } from "~/concepts/task-list";
import type { RelatedTodo } from "~/concepts/todo-relations";
import { type Vocabulary } from "~/concepts/vocabulary";
import { useDropAttach } from "./attachments";
import { ticked, useSubtasksOpen } from "./checklist";
import { TodoDetail } from "./detail";
import type { TodoNeighbors } from "./navigation";
import { TodoRow } from "./row";
import type { Todo, TodoCardView } from "./types";

export function TodoCard({
  todo,
  filters,
  editing,
  now,
  opened,
  vocabulary,
  detailOnly = false,
  relationOptions,
  neighbors = {},
  blocked = false,
}: {
  todo: Todo;
  relationOptions: RelatedTodo[];
  filters: ListFilters;
  editing: string | undefined;
  now: number;
  /** Whether `?open=` names this to-do: its dialog is open. */
  opened: boolean;
  /** Every tag, project and facet written anywhere, offered by their editors. P9. */
  vocabulary: Vocabulary & QuickAddVocabulary;
  detailOnly?: boolean;
  neighbors?: TodoNeighbors;
  /** Whether the row sits in the blocked section at the top of the list. */
  blocked?: boolean;
}) {
  const open = openField(editing, todo.id);
  const closed = listHref("/todos", filters);
  // Where everything inside the dialog posts and closes back to, so a
  // document post, or closing a field the URL opened, keeps it open (P3).
  // The history's order rides along, so posting a comment does not reset it.
  const [urlParams] = useSearchParams();
  const here = listHref("/todos", filters, {
    open: todo.id,
    history: urlParams.get("history") ?? undefined,
  });
  // Title, body and project paint the posted value at once; tags and
  // pointers are parsed on the server, so they hold the editor until it
  // answers (P11).
  const field = (name: string) => ({
    action: HEAD_FIELDS.has(name) ? closed : here,
    cancelHref: HEAD_FIELDS.has(name) ? closed : here,
    editHref: listHref("/todos", filters, { edit: editKey(todo.id, name) }),
    editing: open === name,
    hidden: { intent: "edit-field", id: todo.id, field: name },
    save: OPTIMISTIC.has(name) ? ("optimistic" as const) : ("fetch" as const),
  });
  const title =
    pendingTitle(usePendingValue(field("title").editHref)) ?? todo.title;
  const body = usePendingValue(field("body").editHref) ?? todo.body;
  const pendingProject = usePendingValue(field("project").editHref);
  const project =
    pendingProject === undefined ? todo.project : pendingProject.trim() || null;
  // The circle and the sub-task boxes write through fetchers, so a tick
  // repaints this row before the round trip returns and never navigates.
  // Without scripts they are the same forms posting the same fields (P11).
  // The circle, Block and Unblock share one fetcher, and the state each one
  // posts is held here from the submit handler until the write lands, so the
  // row paints it on the click's own frame (see `useLanded`).
  const completion = useFetcher<{ stateId?: string; stateError?: string }>();
  const returnedState = useActionData<{
    stateId?: string;
    stateError?: string;
  }>();
  const stateAnswer = completion.data ?? returnedState;
  const tick = useFetcher();
  const [sent, setSent] = useState<{ state?: string; note?: string } | null>(
    null,
  );
  const waitForState = useLanded(completion, () => setSent(null));
  const sendState = (event: FormEvent<HTMLFormElement>) => {
    const fields = event.currentTarget.elements;
    setSent({
      state: fields.namedItem("state")?.value,
      note: fields.namedItem("note")?.value,
    });
    waitForState();
  };
  const state = sent?.state ?? todo.state;
  const done = state === "done";
  // A ticked box paints before the write lands, in the row and the dialog.
  const shown = ticked(body, tick.formData);
  const tasks = taskProgress(shown);
  const [subtasks, toggleSubtasks] = useSubtasksOpen(todo.id);
  const subtasksId = `subtasks-${todo.id}`;

  // The dialog is open while the URL names the to-do, or a field inside it.
  // Opening it is a link and closing it a replace, and neither runs the
  // loader (see shouldRevalidate), so the list behind does not move (P4).
  const expanded = opened || (open !== null && !HEAD_FIELDS.has(open));
  const navigate = useNavigate();
  const dropFiles = useDropAttach(todo.id, here);
  const Container = detailOnly ? "div" : Card;
  const tags = (
    <Editable
      {...field("tags")}
      defaultValue={todo.tags.join(", ")}
      editor={
        <TagInput
          autoFocus
          defaultValue={todo.tags}
          name="value"
          options={vocabulary.tags}
        />
      }
      label="Tags"
      noPen
    >
      <TagSet
        action={field("tags").action}
        chipHref={(tag) => listHref("/todos", withTag(filters, tag))}
        editHref={field("tags").editHref}
        hidden={field("tags").hidden}
        options={vocabulary.tags}
        tags={todo.tags}
      />
    </Editable>
  );

  // Keep shared optimistic state and fetcher ownership above both views.
  // Neither extracting the pane nor closing it may cancel the row's writes.
  const view: TodoCardView = {
    todo,
    filters,
    now,
    title,
    body,
    project,
    state,
    done,
    here,
    closed,
    tags,
    field,
    open,
    stateForm: completion.Form,
    stateAnswer,
    relationOptions,
    tickForm: tick.Form,
    sendState,
    blockNote: sent?.state === "blocked" ? sent.note : undefined,
    shown,
    vocabulary,
  };
  return (
    <Container
      {...(detailOnly
        ? {}
        : {
            as: "li" as const,
            className: `todo-card${done ? " is-done" : ""}${expanded ? " is-open" : ""}${blocked ? " in-blocked" : ""}${state === "blocked" ? " is-blocked" : ""}`,
          })}
    >
      {detailOnly ? null : (
        <TodoRow
          opened={expanded}
          view={view}
          subtasks={subtasks}
          tasks={tasks}
          toggleSubtasks={toggleSubtasks}
          subtasksId={subtasksId}
        />
      )}
      {expanded ? (
        <TodoDetail
          neighbors={neighbors}
          view={view}
          detailOnly={detailOnly}
          onClose={() =>
            navigate(closed, { replace: true, preventScrollReset: true })
          }
          onFiles={dropFiles}
        />
      ) : null}
    </Container>
  );
}

/** Fields edited on the row in the list; every other one is in the dialog. */
const HEAD_FIELDS = new Set(["tags"]);

/** Fields whose posted value is what the row shows, so it can show it now. */
const OPTIMISTIC = new Set(["title", "body", "project"]);

/**
 * The title a pending title edit will leave, parsed the way the server
 * parses it, so `Fix ranking #duckdb` paints as "Fix ranking".
 */
function pendingTitle(line: string | undefined): string | undefined {
  if (line === undefined) return undefined;
  const parsed = parseQuickAdd(line);
  return "error" in parsed ? undefined : parsed.title;
}
