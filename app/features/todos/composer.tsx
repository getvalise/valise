import { type RefObject, useEffect, useRef, useState } from "react";
import { Link, useActionData, useFetcher } from "react-router";
import { type AttachAnswer } from "~/components/attachment-files";
import { type EditMode, useEditMode, ViaFetcher } from "~/components/editable";
import { AddRowLink } from "~/components/item-list";
import { QuickAddInput } from "~/components/quick-add";
import { type ListFilters, listHref } from "~/concepts/list-filters";
import { type QuickAddVocabulary } from "~/concepts/quick-add";
import { ADDING } from "./urls";

/**
 * The row at the top of the list that files a to-do: a title line, with
 * `key:value` facets and `#tags` in it, and an optional description. It is
 * closed until asked for (P8), and `?edit=new` opens it, so it works as a
 * plain link and form with scripting off (P3, P11).
 *
 * Enter on the title, or Cmd/Ctrl+Enter in the description, files it and
 * leaves both fields empty with the title focused for the next one. Through a
 * fetcher the page never navigates, so the list keeps its scroll (P4). The
 * New rows sort first in the list below it, after any blocked rows. The row says so and links to the
 * new to-do. Escape closes the row and keeps the draft.
 */
export function Composer({
  filters,
  mode,
  opener,
  listedTodoIds,
  vocabulary,
  belowBlocked = false,
}: {
  filters: ListFilters;
  /** Shared with the header's New to-do button, which opens it. */
  mode: EditMode;
  opener: RefObject<HTMLAnchorElement | null>;
  listedTodoIds: ReadonlySet<string>;
  vocabulary: QuickAddVocabulary;
  /** Blocked rows lead the list, so a new one lands beneath them. */
  belowBlocked?: boolean;
}) {
  const { open, close } = mode;
  const fetcher = useFetcher<Refusal | Created>();
  // With scripting off, a refusal comes back as the page's action data.
  // The page's action data may be a file refusal instead, which is not ours.
  const returned = useActionData<Refusal | AttachAnswer>();
  const actionData = returned && "text" in returned ? returned : undefined;
  const [refused, setRefused] = useState(actionData);
  const [created, setCreated] = useState<Created | undefined>(undefined);
  const [text, setText] = useState(actionData?.text ?? "");
  const [body, setBody] = useState(actionData?.body ?? "");
  // A fetcher keeps its last data through a later submission, so an answer
  // is only this submission's if the data changed while it was in flight.
  const [sent, setSent] = useState<Refusal | Created | undefined>(undefined);
  const form = useRef<HTMLFormElement>(null);
  const wasOpen = useRef(open);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || fetcher.data === sent) {
      return;
    }
    setSent(fetcher.data);
    if ("created" in fetcher.data) {
      setCreated(fetcher.data);
      return;
    }
    // A refused to-do comes back into the fields, so a typo costs one fix.
    setRefused(fetcher.data);
    setText(fetcher.data.text);
    setBody(fetcher.data.body);
  }, [fetcher.state, fetcher.data, sent]);

  // Closing hands focus back to the control that opened the row.
  useEffect(() => {
    if (wasOpen.current && !open) opener.current?.focus();
    wasOpen.current = open;
  }, [open]);

  const landed = created ? (
    <p className="todo-add-landed" role="status">
      {`Added "${created.created.title}" ${belowBlocked ? "beneath the blocked to-dos" : "at the top of the list"}. `}
      <Link
        preventScrollReset
        reloadDocument={!listedTodoIds.has(created.created.id)}
        replace
        to={listHref("/todos", filters, { open: created.created.id })}
      >
        Open it
      </Link>
    </p>
  ) : null;

  if (!open)
    return (
      <>
        <AddRowLink
          label="New to-do"
          onClick={mode.start}
          ref={opener}
          to={listHref("/todos", filters, { edit: ADDING })}
        />
        {landed}
      </>
    );

  return (
    <fetcher.Form
      action={listHref("/todos", filters, { edit: ADDING })}
      className="composer todo-add"
      method="post"
      onKeyDown={(event) => {
        // QuickAddInput takes Escape itself while its list is open.
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          close();
        }
      }}
      onSubmit={() => {
        setText("");
        setBody("");
        setRefused(undefined);
        setCreated(undefined);
        setSent(fetcher.data);
        // From the description too, the next to-do starts at its title.
        (
          form.current?.elements.namedItem("text") as HTMLElement | null
        )?.focus();
      }}
      preventScrollReset
      ref={form}
    >
      <ViaFetcher />
      <input name="intent" type="hidden" value="create" />
      <QuickAddInput
        autoFocus
        label="New to-do"
        name="text"
        onEscape={close}
        onValueChange={setText}
        // The project is the one shorthand that fills a column rather than a
        // tag, so the hint names it, with a project this store already has.
        // `@name` is its short form; `project:name` still works.
        placeholder={`Title, then @${filters.project ?? vocabulary.projects[0] ?? "valise"} priority:1 #research`}
        value={text}
        vocabulary={vocabulary}
      />
      <textarea
        aria-label="Description"
        name="body"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            form.current?.requestSubmit();
          }
        }}
        placeholder="Description, in Markdown. - [ ] lines are sub-tasks."
        rows={2}
        value={body}
      />
      <div className="actions">
        <button type="submit">Add to-do</button>
        <Link
          className="cancel"
          onClick={(event) => {
            event.preventDefault();
            close();
          }}
          preventScrollReset
          to={listHref("/todos", filters)}
        >
          Cancel
        </Link>
      </div>
      {refused ? <p role="alert">{refused.error}</p> : null}
      {landed}
    </fetcher.Form>
  );
}

type Refusal = { error: string; text: string; body: string };

type Created = { created: { id: string; title: string } };

/** The composer's open state, shared by the add row that opens it. */
export function useNewTodo(filters: ListFilters, editing: string | undefined) {
  const mode = useEditMode(editing === ADDING, listHref("/todos", filters));
  const opener = useRef<HTMLAnchorElement>(null);
  return { mode, opener };
}
