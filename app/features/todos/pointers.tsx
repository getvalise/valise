import { Fragment, useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import {
  setPendingValue,
  useEditMode,
  useLanded,
  usePendingValue,
  ViaFetcher,
} from "~/components/editable";
import { Icon } from "~/components/icon";
import { Modal } from "~/components/modal";
import { firstField, RefInput } from "~/components/refs-input";
import type { TodoRef } from "~/concepts/todo-contracts";

/**
 * Where the work is: a row per pointer, each with its own named remove, then
 * one "Add pointer" line. Adding is a kind and a value, two fields, so the
 * line opens a centred modal (P15). The modal is `?edit=<id>.refs`, so the
 * line is a link that works unhydrated (P3, P11); a hydrated click opens it
 * as state. Every write posts the whole set, the pairs that remain or the
 * pairs plus the new one, through a fetcher, painted from `usePendingValue`
 * before the round trip returns.
 */
export function RefSet({
  refs,
  action,
  hidden,
  editHref,
  adding,
}: {
  refs: TodoRef[];
  /** Where writes post and the modal closes back to: the open pane. */
  action: string;
  hidden: Record<string, string>;
  editHref: string;
  /** Whether `?edit=` names the add modal. */
  adding: boolean;
}) {
  const fetcher = useFetcher();
  const add = useFetcher();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const { open, start, close } = useEditMode(adding, action);
  const settle = () => {
    setPendingValue(editHref, undefined);
    savingRef.current = false;
    setSaving(false);
  };
  const removed = useLanded(fetcher, settle);
  const added = useLanded(add, () => {
    settle();
    close();
  });
  const posted = usePendingValue(editHref);
  const shown: TodoRef[] =
    posted === undefined ? refs : (JSON.parse(posted) as TodoRef[]);
  const opener = useRef<HTMLAnchorElement>(null);
  const addForm = useRef<HTMLFormElement>(null);
  const [removals, setRemovals] = useState(0);

  // `showModal()` focuses the dialog's first control, its Close button,
  // after the field's own autofocus has run; the kind is where typing starts.
  useEffect(() => {
    if (open) firstField(addForm.current)?.focus();
  }, [open]);

  // Removing a row takes its focused button out of the page. Keep focus in
  // the set, including when the last pointer is removed.
  useEffect(() => {
    if (removals > 0) opener.current?.focus();
  }, [removals]);

  function optimistic(next: TodoRef[]): boolean {
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setPendingValue(editHref, JSON.stringify(next));
    removed();
    return true;
  }

  const fields = (set: TodoRef[]) => (
    <>
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} name={name} type="hidden" value={value} />
      ))}
      <ViaFetcher />
      {set.map((rest) => (
        <Fragment key={`${rest.kind}:${rest.value}`}>
          <input name="ref-kind" type="hidden" value={rest.kind} />
          <input name="ref-value" type="hidden" value={rest.value} />
        </Fragment>
      ))}
    </>
  );

  return (
    <div className="todo-refs">
      {shown.length > 0 ? (
        <ul aria-busy={saving} aria-label="Pointers" className="refs">
          {shown.map((ref, index) => {
            const next = shown.filter((_, other) => other !== index);
            return (
              <li key={`${index}:${ref.kind}:${ref.value}`}>
                <span className="ref-kind" data-kind={ref.kind}>
                  {ref.kind}
                </span>
                {/^https?:\/\//.test(ref.value) ? (
                  <a href={ref.value} rel="noreferrer" target="_blank">
                    {ref.value}
                  </a>
                ) : (
                  <code>{ref.value}</code>
                )}
                <fetcher.Form
                  action={action}
                  method="post"
                  onSubmit={(event) => {
                    if (!optimistic(next)) event.preventDefault();
                  }}
                  preventScrollReset
                >
                  {fields(next)}
                  <button
                    aria-label={`Remove pointer ${ref.value}`}
                    className="chip-remove"
                    disabled={saving}
                    onClick={() => setRemovals((count) => count + 1)}
                    type="submit"
                  >
                    <Icon name="close" size={12} />
                  </button>
                </fetcher.Form>
              </li>
            );
          })}
        </ul>
      ) : null}
      <Link
        aria-disabled={saving}
        className="add-value"
        onClick={(event) => {
          if (savingRef.current) {
            event.preventDefault();
            return;
          }
          start(event);
        }}
        preventScrollReset
        ref={opener}
        to={editHref}
      >
        <Icon name="add" size={13} /> Add pointer
      </Link>
      {open ? (
        <Modal closeHref={action} onClose={close} open title="Add a pointer">
          <add.Form
            action={action}
            ref={addForm}
            className="stack gap-3 *:m-0"
            method="post"
            // The server infers a blank kind, so the new row arrives with the
            // revalidation rather than painted from a guess; the modal holds
            // with "Adding…" until then.
            onSubmit={(event) => {
              if (savingRef.current) {
                event.preventDefault();
                return;
              }
              savingRef.current = true;
              setSaving(true);
              added();
            }}
            preventScrollReset
          >
            {fields(shown)}
            <RefInput />
            <button
              className="small justify-self-start"
              disabled={saving}
              type="submit"
            >
              {saving ? "Adding…" : "Add pointer"}
            </button>
          </add.Form>
        </Modal>
      ) : null}
    </div>
  );
}
