import { useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import {
  editKey,
  useEditMode,
  useHydrated,
  ViaFetcher,
} from "~/components/editable";
import { Icon } from "~/components/icon";
import { type ListFilters, listHref } from "~/concepts/list-filters";
import { setTaskItem } from "~/concepts/task-list";

/**
 * The row's sub-task count, which shows and hides its checklist under the
 * row, as in Todoist. Once hydrated it is a disclosure button. Before that it
 * is a link to the dialog, where the checklist also is (P11).
 */
export function SubtaskToggle({
  tasks,
  open,
  onToggle,
  controls,
  fallback,
}: {
  tasks: { done: number; total: number };
  open: boolean;
  onToggle: () => void;
  /** The id of the checklist this shows. */
  controls: string;
  /** Where the link goes before hydration: this to-do's dialog. */
  fallback: string;
}) {
  const label = `Sub-tasks, ${tasks.done} of ${tasks.total} done`;
  const inner = (
    <>
      <Icon name={open ? "expanded" : "expand"} size={12} />
      {tasks.done}/{tasks.total}
    </>
  );
  if (!useHydrated()) {
    return (
      <Link
        aria-label={label}
        className="task-count"
        preventScrollReset
        replace
        to={fallback}
      >
        {inner}
      </Link>
    );
  }
  return (
    <button
      aria-controls={controls}
      aria-expanded={open}
      aria-label={label}
      className="task-count"
      onClick={onToggle}
      type="button"
    >
      {inner}
    </button>
  );
}

/**
 * Which rows show their sub-tasks, per browser. It is a view of the list on
 * this screen rather than something to send someone, so it lives in
 * localStorage, keyed by to-do, and not in the URL beside `?open=` (P3). The
 * server cannot see it, so a reload paints folded and unfolds on hydration.
 */
export function useSubtasksOpen(id: string): [boolean, () => void] {
  const key = `valise.subtasks.${id}`;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(readStorage(key) === "1");
  }, [key]);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    writeStorage(key, next ? "1" : null);
  };
  return [open, toggle];
}

/** Storage can be off or full; a row that forgets is the worst case. */
function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Not remembered across a reload; the toggle still works.
  }
}

/** The body with the box a pending tick posted already flipped. */
export function ticked(body: string, form: FormData | undefined): string {
  const task = form?.get("task");
  if (typeof task !== "string") return body;
  const [line, was] = task.split(":");
  return setTaskItem(body, Number(line), was === "1") ?? body;
}

/**
 * One more `- [ ]` line at the end of the body. The field opens in place and
 * closes on Add; the new line arrives with the revalidation a moment later.
 */
export function AddSubtask({
  todoId,
  open: openInUrl,
  filters,
  back: closed,
}: {
  todoId: string;
  open: boolean;
  filters: ListFilters;
  /** Where Add posts and Cancel goes, with the to-do's dialog open. */
  back: string;
}) {
  const { open, start, close } = useEditMode(openInUrl, closed);
  const fetcher = useFetcher();
  const opener = useRef<HTMLAnchorElement>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) opener.current?.focus();
    wasOpen.current = open;
  }, [open]);
  return (
    <div className={`subtask-add${open ? " editing" : ""}`}>
      {/* Keep the small control's box when its editor opens (P6). */}
      <span aria-hidden={open || undefined} inert={open}>
        <Link
          className="add-value"
          onClick={start}
          preventScrollReset
          ref={opener}
          to={listHref("/todos", filters, { edit: editKey(todoId, "subtask") })}
        >
          <Icon name="add" size={13} /> Add sub-task
        </Link>
      </span>
      {open ? (
        <fetcher.Form
          action={closed}
          className="row"
          method="post"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
          onSubmit={close}
          preventScrollReset
        >
          <ViaFetcher />
          <input name="intent" type="hidden" value="add-task" />
          <input name="id" type="hidden" value={todoId} />
          <input
            aria-label="Sub-task"
            autoFocus
            name="text"
            placeholder="One step"
            type="text"
          />
          <button className="small" type="submit">
            Add
          </button>
          <Link
            className="cancel"
            onClick={(event) => {
              event.preventDefault();
              close();
            }}
            preventScrollReset
            to={closed}
          >
            Cancel
          </Link>
        </fetcher.Form>
      ) : null}
    </div>
  );
}
