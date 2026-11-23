import { useContext } from "react";
import { Link } from "react-router";
import { ViaFetcher } from "~/components/editable";
import { Icon } from "~/components/icon";
import { TodoMentions } from "~/components/todo-mention";
import { Pill, ProjectChip } from "~/components/ui";
import { type Attachment } from "~/concepts/attachments";
import { listTaskItems } from "~/concepts/task-list";
import { withMentionTitles } from "~/concepts/todo-mentions";
import { type ConsoleTodo, type TodoUpdate } from "~/concepts/todos";
import { SubtaskToggle } from "./checklist";
import { StatusLine } from "./progress-thread";
import { BlockedLine, CompleteBox } from "./state-controls";
import type { TodoCardView } from "./types";
import { projectHref } from "./urls";

export function TodoRow({
  view,
  subtasks,
  tasks,
  toggleSubtasks,
  subtasksId,
  opened,
}: {
  view: TodoCardView;
  subtasks: boolean;
  tasks: { done: number; total: number };
  toggleSubtasks: () => void;
  subtasksId: string;
  opened: boolean;
}) {
  const {
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
    stateForm,
    tickForm: TickForm,
    sendState,
    blockNote,
    shown,
  } = view;
  const mentions = useContext(TodoMentions);
  return (
    <>
      <div className="todo-head">
        <CompleteBox
          done={done}
          filters={filters}
          form={stateForm}
          onSubmit={sendState}
          todo={todo}
        />
        {/* A click on a to-do opens it, as in Todoist; its title edits in
            the dialog. Replace, so Back leaves the list rather than stepping
            through every to-do read on the way. */}
        <h2 className="todo-title">
          <Link
            aria-current={opened ? "true" : undefined}
            className="todo-open"
            preventScrollReset
            replace
            to={here}
          >
            {title}
          </Link>
        </h2>
        {tasks.total > 0 ? (
          <SubtaskToggle
            controls={subtasksId}
            fallback={here}
            onToggle={toggleSubtasks}
            open={subtasks}
            tasks={tasks}
          />
        ) : null}
      </div>

      {/* One line of what the to-do is filed under, on the title's edge: the
          project, its tags, and its state at the far end. The project chip
          stays outside the editable, so the pen beside the tags means the
          tags. The project has its own, in the facts. */}
      <div className="todo-tags">
        {/* Each chip is the filter for its value, as on /memories. */}
        {project ? (
          <ProjectChip
            href={projectHref(filters, project)}
            preventScrollReset
            project={project}
            selected={filters.project === project}
          />
        ) : null}
        {tags}
        {/* Here rather than beside the title, so a pill appearing never
            narrows the title and rewraps the row (P4). Blocked needs no pill:
            the strap, the wash and the line saying what it waits on already
            say so. */}
        {state === "pending" || state === "blocked" ? null : (
          <Pill tone={tone(state)}>{state}</Pill>
        )}
      </div>

      {/* The rest of the row is the same door as the title, a larger one,
          so it leaves the tab order to the title. */}
      <Link
        className="todo-summary"
        preventScrollReset
        replace
        tabIndex={-1}
        to={here}
      >
        <span className="todo-preview">
          {withMentionTitles(preview(body), mentions)}
        </span>
        <span className="todo-meta">{rowMeta(todo)}</span>
      </Link>
      {/* A blocked row's second line is what it waits on, with Unblock; the
          status line would only repeat the blocker, so it gives way unless
          someone has written since. */}
      {state === "blocked" ? (
        <BlockedLine
          filters={filters}
          form={stateForm}
          note={blockNote}
          onSubmit={sendState}
          todo={todo}
        />
      ) : null}
      <StatusLine
        now={now}
        omitBlocked={state === "blocked"}
        updates={todo.updates}
      />

      {subtasks && tasks.total > 0 ? (
        <TickForm
          action={closed}
          className="todo-subtasks"
          id={subtasksId}
          method="post"
          preventScrollReset
        >
          <ViaFetcher />
          <input name="intent" type="hidden" value="toggle-task" />
          <input name="id" type="hidden" value={todo.id} />
          <ul>
            {listTaskItems(shown).map((item) => (
              <li
                className={item.checked ? "is-done" : undefined}
                key={item.line}
              >
                <button
                  aria-checked={item.checked}
                  aria-label={item.text || "Task"}
                  className="task-box"
                  name="task"
                  role="checkbox"
                  type="submit"
                  value={`${item.line}:${item.checked ? "1" : "0"}`}
                >
                  <Icon name="check" size={12} />
                </button>
                {item.text}
              </li>
            ))}
          </ul>
        </TickForm>
      ) : null}
    </>
  );
}

const TONES = {
  pending: "pending",
  claimed: "claimed",
  blocked: "blocked",
  done: "done",
} as const;

function tone(state: string) {
  return TONES[state as keyof typeof TONES] ?? "pending";
}

/** The body's first line as plain text, for the row in the list. */
function preview(body: string): string {
  const line = body
    .split("\n")
    .map((one) => one.replace(/^[\s>#*+-]*(\[[ xX]\]\s*)?/, "").trim())
    .find((one) => one.length > 0);
  return line ?? "No description";
}

/** What the dialog holds, counted, so the row says what opening it shows. */
function rowMeta(
  todo: ConsoleTodo & { updates: TodoUpdate[]; files: Attachment[] },
): string {
  return [
    todo.refs.length ? plural(todo.refs.length, "pointer") : null,
    todo.files.length ? plural(todo.files.length, "file") : null,
    todo.updates.length ? plural(todo.updates.length, "update") : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
