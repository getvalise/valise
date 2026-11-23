import { useEffect, useRef, useState } from "react";
import { Link, useActionData, useFetcher } from "react-router";
import { Choice } from "~/components/combobox";
import { Icon } from "~/components/icon";
import { Modal } from "~/components/modal";
import { firstField } from "~/components/refs-input";
import { TodoPicker } from "~/components/todo-picker";
import {
  type RelatedTodo,
  relationRows,
  TODO_RELATION_TYPES,
  type TodoRelations,
  type TodoRelationType,
} from "~/concepts/todo-relations";
import { useEditMode, useHydrated, useLanded, ViaFetcher } from "./editable";
import { DetailSection, Pill } from "./ui";

export type RelationAnswer = {
  relationError?: string;
  relationId?: string;
  relationNotice?: string;
};

const TYPE_OPTIONS = TODO_RELATION_TYPES.map((type) => ({
  value: type.key,
  label: type.label,
  hint: type.hint,
}));

/**
 * Every relation of one to-do as one list, typed, each with a named remove;
 * then one "Add relation" line. Adding is a type and a to-do searched for, so
 * the line opens a centred modal (P15) at `?edit=<id>.relation`: a link
 * unhydrated, state once hydrated (P3, P11). The type list is
 * `TODO_RELATION_TYPES`, so a new kind of relation shows up here without a
 * new section. One form posts one relation (P2, P7).
 *
 * Reconciling an interrupted relation write (ADR-0018) is offered only when
 * something says one is pending: a refusal from the coordinator, or `recover`
 * from the pane, which reads the same words in a state refusal or blocker.
 */
export function TodoRelationSection({
  id,
  relations,
  back,
  options,
  addHref,
  adding,
  recover = false,
}: {
  id: string;
  relations: TodoRelations;
  /** Where every form posts and the modal closes back to: the open pane. */
  back: string;
  options: RelatedTodo[];
  addHref: string;
  /** Whether `?edit=` names the add modal. */
  adding: boolean;
  recover?: boolean;
}) {
  const fetcher = useFetcher<RelationAnswer>();
  const action = useActionData<RelationAnswer>();
  const answer = fetcher.data ?? action;
  const hydrated = useHydrated();
  const { open, start, close } = useEditMode(adding, back);
  const [type, setType] = useState<TodoRelationType>("blocked-by");
  const [target, setTarget] = useState("");
  const added = useLanded(fetcher, () => {
    if (fetcher.data?.relationError) return;
    setTarget("");
    close();
  });

  const addForm = useRef<HTMLFormElement>(null);
  // `showModal()` focuses Close after mount; the relation is where to start.
  useEffect(() => {
    if (open) firstField(addForm.current)?.focus();
  }, [open]);

  const rows = relationRows(relations);
  const busy = fetcher.state !== "idle";
  const error = answer?.relationId === id ? answer.relationError : undefined;
  const needsRecovery = recover || asksToReconcile(error);
  const form = (
    operation: string,
    children: React.ReactNode,
    fields: Record<string, string> = {},
    className?: string,
  ) => (
    <fetcher.Form
      action={back}
      className={className}
      ref={operation === "add" ? addForm : undefined}
      method="post"
      onSubmit={operation === "add" ? added : undefined}
      preventScrollReset
    >
      <ViaFetcher />
      <input name="intent" type="hidden" value="relation" />
      <input name="id" type="hidden" value={id} />
      <input name="operation" type="hidden" value={operation} />
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} name={name} type="hidden" value={value} />
      ))}
      <fieldset className="contents" disabled={busy}>
        {children}
      </fieldset>
    </fetcher.Form>
  );
  const alert = error ? <p role="alert">{error}</p> : null;

  return (
    <DetailSection title="Related work">
      {rows.length ? (
        <ul className="m-0 grid list-none p-0">
          {rows.map((row) => (
            <li
              className="grid grid-cols-[6.5rem_minmax(0,1fr)_24px] items-start gap-3 py-1.5 leading-6 [&+&]:border-t [&+&]:border-border [&_fieldset]:contents [&_form]:contents"
              key={`${row.type}:${row.todo.id}`}
            >
              <span className="text-[0.6875rem] font-medium tracking-[0.14em] text-(--ink-3) uppercase">
                {row.label}
              </span>
              <RelatedLink todo={row.todo} />
              {form(
                "remove",
                <button
                  aria-label={`Remove ${row.label.toLowerCase()} ${row.todo.title}`}
                  className="chip-remove relative size-[24px] border-0 bg-transparent p-0 text-(--ink-3) hover:bg-transparent hover:text-(--trunk)"
                  title="Remove relation"
                  type="submit"
                >
                  <Icon name="close" />
                </button>,
                { type: row.type, target: row.todo.id },
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {relations.child_progress.total > 0 ? (
        <p className="muted small">
          {relations.child_progress.done} of {relations.child_progress.total}{" "}
          children done.
          {relations.child_progress.total > relations.child_progress.done
            ? " Unfinished children do not prevent completing this one."
            : null}
        </p>
      ) : null}
      {relations.children_truncated || relations.blocks_truncated ? (
        <p className="muted small">Showing the first 50 of each kind.</p>
      ) : null}

      <Link
        className="add-value"
        onClick={start}
        preventScrollReset
        to={addHref}
      >
        <Icon name="add" size={13} /> Add relation
      </Link>

      {busy && !open ? <p role="status">Saving relations…</p> : null}
      {open ? null : alert}
      {!busy && answer?.relationId === id && answer.relationNotice ? (
        <p role="status">{answer.relationNotice}</p>
      ) : null}
      {needsRecovery ? (
        <div className="grid justify-items-start gap-3">
          <p className="muted small">
            A relation write was interrupted. Reconciling fences any delayed
            original write and never replays the edit; inspect the relations
            before retrying. It restores availability, not a claim.
          </p>
          {form(
            "reconcile",
            <button className="small" type="submit">
              Reconcile relations
            </button>,
          )}
        </div>
      ) : null}

      {open ? (
        <Modal closeHref={back} onClose={close} open title="Add a relation">
          {form(
            "add",
            <>
              <Choice
                defaultValue={type}
                label="Relation"
                name="type"
                onChange={(value) => setType(value as TodoRelationType)}
                options={TYPE_OPTIONS}
              />
              <TodoPicker
                exclude={[id, ...rows.map((row) => row.todo.id)]}
                label="To-do"
                name="target"
                onChange={setTarget}
                seed={options}
              />
              <p className="muted small">
                {TODO_RELATION_TYPES.find((one) => one.key === type)?.hint}.
                Only “blocked by” holds a claim back.
              </p>
              {alert}
              <button
                className="small justify-self-start"
                disabled={hydrated && target === ""}
                type="submit"
              >
                {busy ? "Adding…" : "Add relation"}
              </button>
            </>,
            {},
            "stack gap-3 *:m-0",
          )}
        </Modal>
      ) : null}
    </DetailSection>
  );
}

/**
 * Whether any of these says a relation write is pending. Both coordinator
 * refusals for one (app/do/todo-coordinator.ts) say "reconcile relations".
 */
export function asksToReconcile(
  ...texts: (string | null | undefined)[]
): boolean {
  return texts.some((text) => /reconcile relations/i.test(text ?? ""));
}

function RelatedLink({ todo }: { todo: RelatedTodo }) {
  // A related item may be outside the loaded/filter prefix. Force its loader.
  return (
    <Link
      className="group/target min-w-0 text-foreground no-underline [overflow-wrap:anywhere] [&>.pill]:ml-2 [&>.pill]:align-[0.0625rem]"
      preventScrollReset
      reloadDocument
      to={`/todos?open=${encodeURIComponent(todo.id)}`}
    >
      <span className="group-hover/target:underline">{todo.title}</span>
      <Pill tone={pillTone(todo.state)}>{todo.state}</Pill>
    </Link>
  );
}

function pillTone(state: string) {
  return state === "claimed" || state === "blocked" || state === "done"
    ? state
    : "pending";
}
