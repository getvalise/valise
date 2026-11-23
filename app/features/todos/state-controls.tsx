import { type FormEvent, useContext } from "react";
import { Link } from "react-router";
import { editKey, useEditMode, ViaFetcher } from "~/components/editable";
import { Icon } from "~/components/icon";
import { TodoMentions } from "~/components/todo-mention";
import { type ListFilters, listHref } from "~/concepts/list-filters";
import { withMentionTitles } from "~/concepts/todo-mentions";
import { type ConsoleTodo } from "~/concepts/todos";
import type { RowForm } from "./types";

/**
 * The to-do's own completion, as a checkbox rather than a menu item. It is a
 * single submit button, so it works before hydration, and it carries the
 * checkbox role because that is what it looks like and how it behaves.
 */
export function CompleteBox({
  todo,
  done,
  filters,
  form: FetcherForm,
  onSubmit,
}: {
  todo: ConsoleTodo;
  done: boolean;
  filters: ListFilters;
  /** The row's fetcher, so the row can paint the state it is moving to. */
  form: RowForm;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <FetcherForm
      action={listHref("/todos", filters)}
      className="todo-check"
      method="post"
      onSubmit={onSubmit}
      preventScrollReset
    >
      <ViaFetcher />
      <input name="intent" type="hidden" value="set-state" />
      <input name="id" type="hidden" value={todo.id} />
      <input name="state" type="hidden" value={done ? "pending" : "done"} />
      <input
        name="note"
        type="hidden"
        value={
          done ? "reopened from the console" : "completed from the console"
        }
      />
      <button
        aria-checked={done}
        aria-label={`${done ? "Reopen" : "Complete"}: ${todo.title}`}
        className="check-circle"
        role="checkbox"
        type="submit"
      >
        <Icon name="check" size={12} />
      </button>
    </FetcherForm>
  );
}

/**
 * What a blocked row is waiting on, and the control that clears it, on the
 * row in the list. A reader scanning the list sees why without opening the
 * to-do, and the Unblock button is never behind a dialog (P8, P10).
 * It posts through the row's state fetcher, so the line goes the moment
 * Unblock is pressed.
 */
export function BlockedLine({
  todo,
  filters,
  back,
  form: RowForm,
  note,
  onSubmit,
}: {
  todo: ConsoleTodo;
  filters: ListFilters;
  back?: string;
  form: RowForm;
  /** The blocker being posted, before the server has stored it. */
  note: string | undefined;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const mentions = useContext(TodoMentions);
  return (
    <RowForm
      action={back ?? listHref("/todos", filters)}
      className="row todo-state todo-blocked"
      method="post"
      onSubmit={onSubmit}
      preventScrollReset
    >
      <ViaFetcher />
      <input name="intent" type="hidden" value="set-state" />
      <input name="id" type="hidden" value={todo.id} />
      <input name="state" type="hidden" value="pending" />
      <input name="note" type="hidden" value="unblocked from the console" />
      <span
        className="muted todo-blocked-on"
        title={note || todo.blockedOn || undefined}
      >
        Blocked on{" "}
        {withMentionTitles(note || todo.blockedOn || "something", mentions)}.
      </span>
      <button
        aria-label={`Unblock: ${todo.title}`}
        className="ghost small"
        type="submit"
      >
        Unblock
      </button>
    </RowForm>
  );
}

/**
 * Blocked is the one state that needs a sentence, so it gets a field. It
 * opens in place like a pen, and posts through the row's state fetcher, so
 * the row reads as blocked the moment Block is pressed.
 */
export function Blocker({
  todo,
  state,
  note,
  open: openInUrl,
  filters,
  back: closed,
  form: RowForm,
  onSubmit,
}: {
  todo: ConsoleTodo;
  /** The state the row shows, which a pending post may have moved. */
  state: string;
  note: string | undefined;
  open: boolean;
  filters: ListFilters;
  /** Where Block posts and Cancel goes, with the to-do's dialog open. */
  back: string;
  form: RowForm;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const { open, start, close } = useEditMode(openInUrl, closed);
  if (state === "done") return null;
  if (state === "blocked")
    return (
      <BlockedLine
        back={closed}
        filters={filters}
        form={RowForm}
        note={note}
        onSubmit={onSubmit}
        todo={todo}
      />
    );
  return (
    // The form covers the link's box and the lines under it rather than
    // pushing the body down (P6), as Add sub-task's field does.
    <div className={`todo-state-slot${open ? " editing" : ""}`}>
      <p aria-hidden={open || undefined} className="todo-state" inert={open}>
        <Link
          className="ghost-link"
          onClick={start}
          preventScrollReset
          to={listHref("/todos", filters, { edit: editKey(todo.id, "state") })}
        >
          Block this
        </Link>
      </p>
      {open ? (
        <BlockForm
          close={close}
          closed={closed}
          form={RowForm}
          onSubmit={onSubmit}
          todo={todo}
        />
      ) : null}
    </div>
  );
}

function BlockForm({
  todo,
  closed,
  close,
  form: RowForm,
  onSubmit,
}: {
  todo: ConsoleTodo;
  closed: string;
  close: () => void;
  form: RowForm;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <RowForm
      action={closed}
      className="row todo-state"
      method="post"
      onSubmit={(event) => {
        onSubmit(event);
        close();
      }}
      preventScrollReset
    >
      <ViaFetcher />
      <input name="intent" type="hidden" value="set-state" />
      <input name="id" type="hidden" value={todo.id} />
      <input name="state" type="hidden" value="blocked" />
      <input
        aria-label="Blocked on"
        autoFocus
        name="note"
        placeholder="Waiting on what?"
        type="text"
      />
      <button className="small" type="submit">
        Block
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
    </RowForm>
  );
}
