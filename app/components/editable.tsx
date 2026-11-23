import {
  createContext,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Form, Link, useFetcher, useLocation, useNavigate } from "react-router";
import { Icon } from "~/components/icon";
import { AddItemMark } from "~/components/ui";

/**
 * The console's one editing pattern: a value with a pen beside it, and the
 * editor in the value's own place. There is no edit mode for a record and no
 * second form holding every field at once, because a field you did not touch
 * should not be something you can overwrite by accident.
 *
 * Whether a field is open is component state once the page has hydrated, so
 * opening and closing it re-renders this one field and asks the server for
 * nothing. The pen is still an ordinary link to `?edit=<id>.<field>`: with
 * scripting off, or before hydration, it navigates there and the server
 * renders the field open, and a link can still be sent that opens one. P3.
 *
 * `save` picks how Save reaches the server. `optimistic` posts through a
 * fetcher, closes the field on submit, and leaves the caller to paint the
 * posted value from `usePendingValue`. `fetch` posts through a fetcher and
 * holds the field open, Save reading "Saving", until the write lands. Either
 * way the page keeps its URL and scroll. `navigate`, the default, is a
 * navigating `<Form>`, as on /hooks. P11.
 *
 * The pen is rendered always and hidden with opacity, never removed from the
 * markup — WCAG 2.1 SC 1.4.13 — and the hiding is gated behind a fine
 * pointer, so a touch screen that cannot hover shows it outright.
 */
export function Editable({
  editing,
  action,
  editHref,
  cancelHref,
  label,
  defaultValue,
  hidden,
  children,
  className = "",
  multiline = false,
  rows = 6,
  placeholder,
  empty,
  addItem = false,
  editor,
  noPen = false,
  save = "navigate",
  saveOnBlur = false,
}: {
  /** Whether `?edit=` names this field: the server's say, before hydration. */
  editing: boolean;
  /**
   * Where Save posts. Named rather than defaulted, because the list's
   * filters live in the query string and the action redirects back to them.
   */
  action: string;
  /** Opens this field. A link, so it works unhydrated. */
  editHref: string;
  /** Closes it again, keeping whatever filters the list is under. */
  cancelHref: string;
  /** Names the pen and the field: "Title", "Body", "Pointers". */
  label: string;
  /** The raw text the editor starts from, which is not always what is shown. */
  defaultValue: string;
  /** Posted alongside `value`: the intent, the record, the field. */
  hidden: Record<string, string>;
  /** The value as the page shows it when it is not being edited. */
  children?: ReactNode;
  className?: string;
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  /**
   * Set when there is no value: "Add a pointer". The phrase is then the
   * control that opens the editor, in place of the value and the pen, so
   * filling an empty field never depends on hovering over it (P8, P10).
   */
  empty?: string;
  /** A new list item, rather than an empty scalar field. */
  addItem?: boolean;
  /**
   * A control shaped like the data, in place of the text field: `TagInput`
   * for a set. It posts under `value`, and Save and Cancel stay. P7.
   */
  editor?: ReactNode;
  /**
   * How Save reaches the server. `fetch` and `optimistic` post `via=fetcher`
   * once hydrated, which `afterSave` answers with data instead of a redirect.
   */
  save?: "navigate" | "fetch" | "optimistic";
  /**
   * No pen: the value's own controls carry the editing, as a set's × and +
   * do (P7). The `?edit=` editor stays, because the `+` is a link to it
   * before hydration and a link can still be sent (P3).
   */
  noPen?: boolean;
  /**
   * Focus leaving the form saves a changed value and closes an unchanged one,
   * as a to-do's title and description do in Todoist. Save and Cancel stay,
   * so a keyboard or screen-reader user still has a labelled target (P6).
   * Focus leaving the window is not leaving the field, so it saves nothing.
   */
  saveOnBlur?: boolean;
}) {
  const mode = useEditMode(editing, cancelHref);
  const { open, close } = mode;
  const form = useRef<HTMLFormElement>(null);
  const fetcher = useFetcher({ key: editHref });
  const [holding, setHolding] = useState(false);
  const sent = useLanded(fetcher, () => {
    pending.set(editHref, undefined);
    if (holding) {
      setHolding(false);
      close();
    }
  });

  // A navigating save closes when the navigation it started lands.
  const location = useLocation();
  const [sentFrom, setSentFrom] = useState<string | null>(null);
  if (sentFrom !== null && location.key !== sentFrom) {
    setSentFrom(null);
    if (open !== editing) mode.reset();
  }

  const value =
    empty === undefined ? (
      children
    ) : (
      <EditLink
        title={addItem ? empty : undefined}
        className={addItem ? "add-item" : "add-value"}
        to={editHref}
      >
        {addItem ? (
          <AddItemMark label={empty} />
        ) : (
          <>
            <Icon name="add" size={13} /> {empty}
          </>
        )}
      </EditLink>
    );

  if (!open) {
    return (
      <EditableContext.Provider value={mode}>
        <div className={`editable ${className}`.trim()}>
          {value}
          {empty === undefined && !noPen ? (
            <EditLink
              aria-label={`Edit ${label.toLowerCase()}`}
              className="pen"
              to={editHref}
            >
              <Icon name="edit" size={14} />
            </EditLink>
          ) : null}
        </div>
      </EditableContext.Provider>
    );
  }

  /** Escape reverts, the way every inline editor worth copying behaves. */
  function onKeyDown(
    event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ): void {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    // A textarea owns Enter, so the keyboard save is the usual pair.
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      form.current?.requestSubmit();
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    if (save === "navigate") {
      setSentFrom(location.key);
      return;
    }
    sent();
    if (save === "fetch") {
      setHolding(true);
      return;
    }
    const posted = event.currentTarget.elements.namedItem("value");
    pending.set(editHref, posted?.value);
    close();
  }

  function onBlur(event: FocusEvent<HTMLFormElement>): void {
    if (!saveOnBlur || holding) return;
    // Save, Cancel, and a suggestion list are all inside the form.
    const next = event.relatedTarget as unknown as Parameters<
      typeof event.currentTarget.contains
    >[0];
    if (next !== null && event.currentTarget.contains(next)) return;
    const page = (globalThis as { document?: { hasFocus(): boolean } })
      .document;
    if (page && !page.hasFocus()) return;
    const posted = event.currentTarget.elements.namedItem("value");
    if (posted?.value === defaultValue) close();
    else event.currentTarget.requestSubmit();
  }

  const fetching = save !== "navigate";
  const SaveForm = fetching ? fetcher.Form : Form;

  // The value stays in the flow, invisible and inert, so the box keeps the
  // height it had; the editor is laid over it rather than in place of it.
  // Where the editor needs more than the value had, it covers what is below
  // instead of pushing it (P6). The spacer stands in for the pen, so the
  // value wraps at the same width it did a click ago.
  return (
    <EditableContext.Provider value={mode}>
      <div className={`editable editing ${className}`.trim()}>
        <div aria-hidden className="editable-held" inert>
          {value}
        </div>
        {empty === undefined && !noPen ? (
          <span aria-hidden className="pen-space" />
        ) : null}
        <SaveForm
          action={action}
          className={`editable-form${multiline ? " multiline" : ""}`}
          method="post"
          onBlur={onBlur}
          // An Escape an editor did not take still belongs to the field, not
          // to a dialog around it: the field closes first, the dialog next.
          onKeyDown={(event) => {
            if (event.key === "Escape") event.preventDefault();
          }}
          onSubmit={onSubmit}
          preventScrollReset
          ref={form}
        >
          {Object.entries(hidden).map(([name, value]) => (
            <input key={name} name={name} type="hidden" value={value} />
          ))}
          {fetching ? <ViaFetcher /> : null}
          {editor ? (
            editor
          ) : multiline ? (
            <textarea
              aria-label={label}
              autoFocus
              defaultValue={defaultValue}
              name="value"
              onKeyDown={onKeyDown}
              placeholder={placeholder}
              rows={rows}
            />
          ) : (
            <input
              aria-label={label}
              autoFocus
              defaultValue={defaultValue}
              name="value"
              onKeyDown={onKeyDown}
              placeholder={placeholder}
              type="text"
            />
          )}
          <div className="row">
            <button className="small" disabled={holding} type="submit">
              {holding ? "Saving" : "Save"}
            </button>
            <Link
              className="cancel"
              onClick={(event) => {
                event.preventDefault();
                close();
              }}
              preventScrollReset
              to={cancelHref}
            >
              Cancel
            </Link>
          </div>
        </SaveForm>
      </div>
    </EditableContext.Provider>
  );
}

export type EditMode = {
  open: boolean;
  /** A click handler for a link to `?edit=`: opens in place instead. */
  start: (event: MouseEvent) => void;
  close: () => void;
  /** Back to whatever the URL says. */
  reset: () => void;
};

/**
 * Open or closed, as component state seeded from the URL. A click on an edit
 * link opens the field without navigating; closing it navigates only when the
 * URL itself named the field, so the address bar stops claiming an editor
 * that is gone. Modified clicks are left to the browser, so Cmd-click still
 * opens the field in a new tab. Shared by `Editable` and the to-do's
 * sub-task and blocker forms, which open the same way.
 */
export function useEditMode(editing: boolean, cancelHref: string): EditMode {
  const navigate = useNavigate();
  const [open, setOpen] = useState(editing);
  // A navigation that changes what `?edit=` names wins over local state.
  const [seen, setSeen] = useState(editing);
  if (editing !== seen) {
    setSeen(editing);
    setOpen(editing);
  }
  return {
    open,
    start: (event) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      event.preventDefault();
      setOpen(true);
    },
    close: () => {
      setOpen(false);
      if (editing) {
        navigate(cancelHref, { replace: true, preventScrollReset: true });
      }
    },
    reset: () => setOpen(editing),
  };
}

const EditableContext = createContext<EditMode | null>(null);

/** The enclosing field's controls, for an editor that closes on Escape. */
export function useEditable(): EditMode | null {
  return useContext(EditableContext);
}

/**
 * A link to the enclosing field's `?edit=` URL that opens it in place once
 * hydrated. The pen, "Add tags", and a to-do's title are all one of these.
 */
export function EditLink({
  to,
  title,
  className,
  children,
  tabIndex,
  "aria-label": ariaLabel,
}: {
  to: string;
  title?: string;
  className?: string;
  children: ReactNode;
  tabIndex?: number;
  "aria-label"?: string;
}) {
  const mode = useEditable();
  return (
    <Link
      aria-label={ariaLabel}
      className={className}
      onClick={mode?.start}
      preventScrollReset
      tabIndex={tabIndex}
      title={title}
      to={to}
    >
      {children}
    </Link>
  );
}

/**
 * A value that opens its own editor on a click anywhere in it, as a to-do's
 * description does: the text is the target, not only the pen. A click on a
 * link, a button, or a field inside keeps its own meaning, and a click that
 * ends a text selection selects. The pen stays the keyboard's stop (P1).
 */
export function EditOnClick({ children }: { children: ReactNode }) {
  const mode = useEditable();
  return (
    // No role and no key handler: the pen is the keyboard's way in, and this
    // is a larger pointer target for the same action.
    <div
      className="edit-on-click"
      onClick={(event) => {
        const target = event.target as {
          closest?: (selector: string) => unknown;
        };
        if (target.closest?.("a, button, input, label, summary")) return;
        const selection = (
          globalThis as { getSelection?: () => { isCollapsed: boolean } | null }
        ).getSelection?.();
        if (selection && !selection.isCollapsed) return;
        mode?.start(event);
      }}
    >
      {children}
    </div>
  );
}

/**
 * Calls `onLanded` once the fetcher's next answer is in and the revalidation
 * after it has run; the returned function marks the submit to wait for. It
 * watches for a new `fetcher.data` rather than for `state` going busy and
 * back, because React Router renders fetcher state in a transition, and on a
 * long list the busy render can be superseded before it ever commits.
 */
export function useLanded(
  fetcher: { state: string; data: unknown },
  onLanded: () => void,
): () => void {
  const [waiting, setWaiting] = useState<{ before: unknown } | null>(null);
  const landed =
    waiting !== null &&
    fetcher.state === "idle" &&
    fetcher.data !== waiting.before;
  const latest = useRef(onLanded);
  latest.current = onLanded;
  useEffect(() => {
    if (!landed) return;
    setWaiting(null);
    latest.current();
  }, [landed]);
  return () => setWaiting({ before: fetcher.data });
}

/**
 * What an optimistic save posted, by the field's `editHref`, until it lands.
 * A store outside React Router rather than `fetcher.formData`, for the reason
 * on `useLanded`: written from the submit handler, it paints in the same
 * frame as the click.
 */
const pending = (() => {
  const values = new Map<string, string>();
  const listeners = new Set<() => void>();
  return {
    get: (key: string) => values.get(key),
    set(key: string, value: string | undefined) {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
})();

/**
 * The value an optimistic save of this field posted, until the write and the
 * revalidation after it have landed, so the read view shows it at once.
 */
export function usePendingValue(editHref: string): string | undefined {
  return useSyncExternalStore(
    pending.subscribe,
    () => pending.get(editHref),
    () => undefined,
  );
}

/**
 * Records what a write posted, for a field whose editor is not an `Editable`
 * form: a set's chip row posts on its own, and its read view paints the
 * posted set from the same store, clearing it when the write lands. P11.
 */
export function setPendingValue(
  editHref: string,
  value: string | undefined,
): void {
  pending.set(editHref, value);
}

/**
 * `via=fetcher`, once hydrated, for a form a fetcher submits: `afterSave`
 * answers it with data rather than a redirect. Before hydration the same
 * form posts as a document and wants the redirect, so it is left out.
 */
export function ViaFetcher() {
  return useHydrated() ? (
    <input name="via" type="hidden" value="fetcher" />
  ) : null;
}

const noSubscription = () => () => {};

/** False on the server and in the hydration render, true after. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
}

/** `?edit=todo:tdo_x.title` — the record, then the field. Ids carry no dot. */
export function editKey(id: string, field: string): string {
  return `${id}.${field}`;
}

export function openField(
  editParam: string | undefined,
  id: string,
): string | null {
  if (editParam === undefined) return null;
  const dot = editParam.lastIndexOf(".");
  if (dot < 0 || editParam.slice(0, dot) !== id) return null;
  return editParam.slice(dot + 1);
}

/** The record an `?edit=` points at, so a detail view can open itself. */
export function editTarget(editParam: string | undefined): string | null {
  if (editParam === undefined) return null;
  const dot = editParam.lastIndexOf(".");
  return dot < 0 ? null : editParam.slice(0, dot);
}
