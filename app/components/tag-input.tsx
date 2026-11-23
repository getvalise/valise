import { type MouseEvent, useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import { Combobox } from "~/components/combobox";
import {
  setPendingValue,
  useHydrated,
  useLanded,
  usePendingValue,
  ViaFetcher,
} from "~/components/editable";
import { Icon } from "~/components/icon";

/**
 * A set edited as a set: a chip per tag with its own remove, and a `+` that
 * opens a `Combobox` over the known tags with create-on-miss. P7.
 *
 * WAI-ARIA has no tag pattern, so this is composed from the combobox and a
 * button per chip. The remove contract is Material 3's: the button is named
 * "Remove {tag}", never a bare "Remove", and its hit area is 24px. The chip
 * itself is not focusable, because remove is its only action.
 *
 * The set posts as one comma-separated hidden input under `name`, which is
 * what the field parsers already read. Nothing commits until the form does,
 * so the editor around it keeps its Save and Cancel. P2, P6.
 */
export function TagInput({
  name,
  defaultValue,
  options = [],
  autoFocus = false,
}: {
  name: string;
  defaultValue: string[];
  /** Tags worth suggesting. A tag already in the set is not offered again. */
  options?: string[];
  /** Open with the box rather than the `+`, for an editor opened to add. */
  autoFocus?: boolean;
}) {
  const hydrated = useHydrated();
  const [tags, setTags] = useState(defaultValue);
  const [adding, setAdding] = useState(autoFocus);
  // Bumped after each pick, so the box remounts empty and keeps the caret.
  const [round, setRound] = useState(0);
  const add = useRef<HTMLButtonElement>(null);
  const [removed, setRemoved] = useState(0);

  // A remove button takes itself out of the page, and focus with it. Hand
  // focus to the add control rather than dropping it on the body.
  useEffect(() => {
    if (removed > 0) add.current?.focus();
  }, [removed]);

  function remove(tag: string) {
    setTags(tags.filter((other) => other !== tag));
    if (adding) setRound(round + 1);
    else setRemoved(removed + 1);
  }

  const offered = options
    .filter((option) => !tags.includes(option))
    .map((option) => ({ value: option, label: option }));

  // The interactive chips need the combobox's client state. Without scripts,
  // the same field stays a plain, editable value so the ?edit= link still
  // works and the form can post the set.
  if (!hydrated) {
    return (
      <label className="tag-input-fallback">
        Tags
        <input
          autoFocus
          defaultValue={defaultValue.join(", ")}
          name={name}
          placeholder="tag, another tag"
          type="text"
        />
      </label>
    );
  }

  return (
    <div className="tag-input">
      <input name={name} type="hidden" value={tags.join(", ")} />
      <ul className="tags">
        {tags.map((tag) => (
          <li className="chip" key={tag}>
            <span>{tag}</span>
            <button
              aria-label={`Remove ${tag}`}
              className="chip-remove"
              onClick={() => remove(tag)}
              type="button"
            >
              <Icon name="close" size={12} />
            </button>
          </li>
        ))}
        <li className="chip-new">
          {adding ? (
            <Combobox
              autoFocus
              creatable
              key={round}
              label="Add tag"
              onChange={(value) => {
                const tag = value.trim();
                if (tag && !tags.includes(tag)) setTags([...tags, tag]);
                setRound(round + 1);
              }}
              openOnFocus={round === 0}
              options={offered}
              placeholder="tag"
            />
          ) : (
            <button
              aria-label="Add tag"
              className="chip-add"
              ref={add}
              onClick={() => setAdding(true)}
              type="button"
            >
              <Icon name="add" size={13} />
              <span aria-hidden="true" className="chip-add-label">
                Add tags
              </span>
            </button>
          )}
        </li>
      </ul>
    </div>
  );
}

/**
 * The set in the view, not behind a pen: a chip per tag, its own named
 * remove, and a `+` at the end of the row. P7 — the pencil that opened the
 * whole list is gone.
 *
 * Each add and remove posts on its own, through a fetcher, the same joined
 * `value` the whole-set editor posts; the posted set paints from
 * `usePendingValue` before the round trip returns (P11). Every form carries
 * `via=fetcher` once hydrated, so the action answers with data and the page
 * keeps its URL and scroll; with scripting off the same forms post as
 * documents (P11).
 *
 * The `+` is a link to the `?edit=` editor, because adding works without
 * scripts there (P3); hydrated, the click opens the combobox in place
 * instead and a pick saves at once. Escape closes it: the clear step the
 * APG gives a bare combobox folds into the close, because this box is a
 * control over the set, not a field mid-edit. An empty set shows the
 * phrase, which is the same control in words (P8).
 *
 * The chip and its × are two focusable elements, which is the contract for
 * a chip that is also a link: each tag chip is the filter for its value.
 */
export function TagSet({
  tags,
  action,
  hidden,
  editHref,
  options = [],
  chipHref,
  addLabel = "Add tags",
  addOneLabel = "Add tag",
  spelled = false,
}: {
  tags: string[];
  action: string;
  /** Posted alongside `value`: the intent, the record, the field. */
  hidden: Record<string, string>;
  /** Opens the whole-set editor, which is how adding works unhydrated. */
  editHref: string;
  /** Tags worth suggesting. A tag already in the set is not offered again. */
  options?: string[];
  /** Each chip is the filter for its value, where the route has one. */
  chipHref?: (tag: string) => string;
  /** Names the add controls when a page holds two sets, such as a folder's
   * tags beside its file's: "Add folder tags" and "Add folder tag". */
  addLabel?: string;
  addOneLabel?: string;
  /** Keep the add control's words in the row, in a box of their own, rather
   * than folding them to a `+` that unfolds in line, after the chips, on hover. The
   * Library pane, where the row also carries suggestions (P4, P8). */
  spelled?: boolean;
}) {
  const fetcher = useFetcher();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const landed = useLanded(fetcher, () => {
    setPendingValue(editHref, undefined);
    savingRef.current = false;
    setSaving(false);
  });
  const posted = usePendingValue(editHref);
  const shown =
    posted === undefined
      ? tags
      : posted
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean);
  const [adding, setAdding] = useState(false);
  // Bumped after each pick, so the box remounts empty and keeps the caret.
  const [round, setRound] = useState(0);
  const add = useRef<HTMLAnchorElement>(null);
  const [removed, setRemoved] = useState(0);
  const wasAdding = useRef(false);

  // A remove takes its own button out of the page, and focus with it. Hand
  // focus to the add control rather than dropping it on the body.
  useEffect(() => {
    if (removed > 0) add.current?.focus();
  }, [removed]);

  // Closing the combobox removes the focused input. Return to the control
  // that opened it rather than leaving keyboard focus on the document.
  useEffect(() => {
    if (wasAdding.current && !adding) add.current?.focus();
    wasAdding.current = adding;
  }, [adding]);

  function optimistic(next: string[]): boolean {
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setPendingValue(editHref, next.join(", "));
    landed();
    return true;
  }

  function addTag(next: string[]) {
    if (!optimistic(next)) return;
    const form = new FormData();
    for (const [name, value] of Object.entries(hidden)) {
      form.set(name, value);
    }
    form.set("via", "fetcher");
    form.set("value", next.join(", "));
    fetcher.submit(form, {
      action,
      method: "post",
      preventScrollReset: true,
    });
  }

  /** Hydrated, the add control opens the box in place; unhydrated the click
      never arrives, and the link navigates to the editor. P3, P11. */
  function startAdd(event: MouseEvent<HTMLAnchorElement>): void {
    if (savingRef.current) {
      event.preventDefault();
      return;
    }
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
    setAdding(true);
  }

  const offered = options
    .filter((option) => !shown.includes(option))
    .map((option) => ({ value: option, label: option }));

  return (
    <div aria-busy={saving} className="tagset tag-input">
      <ul className="tags">
        {shown.map((tag) => {
          const next = shown.filter((other) => other !== tag);
          return (
            <li className="chip" key={tag}>
              {chipHref ? (
                <Link
                  className="chip-link"
                  preventScrollReset
                  to={chipHref(tag)}
                >
                  {tag}
                </Link>
              ) : (
                <span>{tag}</span>
              )}
              <fetcher.Form
                action={action}
                method="post"
                onSubmit={(event) => {
                  if (!optimistic(next)) event.preventDefault();
                }}
                preventScrollReset
              >
                {Object.entries(hidden).map(([name, value]) => (
                  <input key={name} name={name} type="hidden" value={value} />
                ))}
                <ViaFetcher />
                <input name="value" type="hidden" value={next.join(", ")} />
                <button
                  aria-label={`Remove ${tag}`}
                  className="chip-remove"
                  disabled={saving}
                  onClick={() => setRemoved((count) => count + 1)}
                  type="submit"
                >
                  <Icon name="close" size={12} />
                </button>
              </fetcher.Form>
            </li>
          );
        })}
        <li
          className="chip-new"
          onKeyDown={(event) => {
            if (event.key === "Escape") setAdding(false);
          }}
        >
          {(shown.length === 0 || spelled) && !adding ? (
            <Link
              className="add-value"
              aria-disabled={saving}
              onClick={startAdd}
              ref={add}
              to={editHref}
            >
              <Icon name="add" size={13} />{" "}
              {shown.length === 0 ? addLabel : addOneLabel}
            </Link>
          ) : adding ? (
            <Combobox
              autoFocus
              creatable
              readOnly={saving}
              key={round}
              label={addOneLabel}
              onChange={(value) => {
                const tag = value.trim();
                if (tag && !shown.includes(tag)) addTag([...shown, tag]);
                setRound(round + 1);
              }}
              openOnFocus={round === 0}
              options={offered}
              placeholder="tag"
            />
          ) : (
            <Link
              aria-label={addOneLabel}
              aria-disabled={saving}
              className="chip-add"
              onClick={startAdd}
              ref={add}
              to={editHref}
            >
              <Icon name="add" size={13} />
              <span aria-hidden="true" className="chip-add-label">
                {addLabel}
              </span>
            </Link>
          )}
        </li>
      </ul>
    </div>
  );
}
