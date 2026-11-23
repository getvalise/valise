import { useEffect, useId, useRef, useState } from "react";
import {
  type QuickAddVocabulary,
  type Suggestion,
  suggestQuickAdd,
} from "~/concepts/quick-add";

/** The slice of an input this repo can name without the DOM lib. */
type Caret = {
  value: string;
  selectionStart: number | null;
  setSelectionRange(start: number, end: number): void;
};

/**
 * A text field that suggests for the word under the caret, as the APG
 * editable combobox with list autocomplete and manual selection.
 *
 * Manual, not automatic, because Enter is also the field's commit. The list
 * opens as you type, but visual focus stays on the textbox until Down or Up
 * moves it in, so Enter on "Fix search ranking" files the to-do rather than
 * picking whatever tag starts with "ranking". `Combobox` replaces its whole
 * value on a pick; this replaces one word, which is why it is its own widget.
 *
 * Tab is the completion: it takes the highlighted option, or with none
 * highlighted, the first one for a word that asked for suggestions (`#du`,
 * `project:`, `priority:h`). A bare word's list is an offer, so Tab there
 * moves on unless the person arrowed in. Focus stays after a completion.
 *
 * The textbox carries `name`, so with scripting off the form posts the line
 * as typed and the server parses it.
 */
export function QuickAddInput({
  label,
  name,
  value,
  onValueChange,
  vocabulary,
  placeholder,
  autoFocus,
  onEscape,
}: {
  label: string;
  name: string;
  value: string;
  onValueChange: (value: string) => void;
  vocabulary: QuickAddVocabulary;
  placeholder?: string;
  autoFocus?: boolean;
  /**
   * Escape with the list closed. The composer clears its line, as the APG
   * combobox does; an inline editor reverts instead, as every other pen does.
   */
  onEscape?: () => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(value.length);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(TEXTBOX);
  // Where the caret goes after a pick, applied once the value has rendered.
  const [placeAt, setPlaceAt] = useState<number | null>(null);

  const word = wordAt(value, caret);
  const matches = suggestQuickAdd(word.text, vocabulary);
  const showing = open && matches.length > 0;

  useEffect(() => {
    if (placeAt === null) return;
    (input.current as unknown as Caret | null)?.setSelectionRange(
      placeAt,
      placeAt,
    );
    setPlaceAt(null);
  }, [placeAt]);

  function choose(option: Suggestion) {
    const before = value.slice(0, word.start);
    // A finished word brings its own space, so drop the one already there.
    const after = value.slice(word.end);
    const rest = option.insert.endsWith(" ")
      ? after.replace(/^\s+/, "")
      : after;
    const next = before + option.insert + rest;
    const at = before.length + option.insert.length;
    onValueChange(next);
    setCaret(at);
    setPlaceAt(at);
    setActive(TEXTBOX);
    // `priority:` is half a facet: leave the list open on its values.
    setOpen(option.insert.endsWith(":"));
  }

  function track(event: { currentTarget: unknown }) {
    const field = event.currentTarget as Caret;
    setCaret(field.selectionStart ?? field.value.length);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (matches.length === 0) return;
      event.preventDefault();
      if (!showing) {
        setOpen(true);
        return;
      }
      if (active === TEXTBOX) {
        setActive(event.key === "ArrowDown" ? 0 : matches.length - 1);
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((active + step + matches.length) % matches.length);
      return;
    }
    if (CARET_KEYS.has(event.key)) {
      // APG: these move the caret, not the list. Home and End do nothing in
      // a macOS text field, so those are moved here.
      setActive(TEXTBOX);
      if ((event.key === "Home" || event.key === "End") && !event.shiftKey) {
        event.preventDefault();
        const field = event.currentTarget as unknown as Caret;
        const at = event.key === "Home" ? 0 : field.value.length;
        field.setSelectionRange(at, at);
        setCaret(at);
      }
      return;
    }
    if (event.key === "Enter") {
      const option = showing ? matches[active] : undefined;
      if (option) {
        event.preventDefault();
        choose(option);
      } else {
        setOpen(false);
      }
      return;
    }
    if (event.key === "Escape") {
      if (showing) {
        setOpen(false);
        setActive(TEXTBOX);
      } else if (onEscape) {
        event.preventDefault();
        onEscape();
      } else {
        onValueChange("");
        setCaret(0);
      }
      return;
    }
    if (event.key === "Tab" && !event.shiftKey && showing) {
      const option =
        active !== TEXTBOX
          ? matches[active]
          : ASKED.test(word.text)
            ? matches[0]
            : undefined;
      if (option) {
        event.preventDefault();
        choose(option);
        return;
      }
    }
    if (event.key === "Tab") setOpen(false);
  }

  return (
    <div
      className="combobox quick-add-input"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <label htmlFor={`${id}-input`}>{label}</label>
      <input
        aria-activedescendant={
          showing && matches[active] ? `${id}-option-${active}` : undefined
        }
        aria-autocomplete="list"
        aria-controls={`${id}-listbox`}
        aria-expanded={showing}
        autoComplete="off"
        autoFocus={autoFocus}
        id={`${id}-input`}
        name={name}
        onChange={(event) => {
          onValueChange(event.target.value);
          track(event);
          setOpen(true);
          setActive(TEXTBOX);
        }}
        onSelect={track}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        ref={input}
        role="combobox"
        type="text"
        value={value}
      />
      {showing ? (
        <ul
          aria-label={`${label} suggestions`}
          className="combobox-list"
          id={`${id}-listbox`}
          role="listbox"
        >
          {matches.map((option, index) => (
            <li
              aria-selected={index === active}
              className={index === active ? "active" : undefined}
              id={`${id}-option-${index}`}
              key={option.insert}
              // `mousedown` beats the textbox's blur, so the list is still
              // there when the pick lands. Hover does not move `active`: a
              // pointer resting where the list opens must not turn the next
              // Enter into a pick.
              onMouseDown={(event) => {
                event.preventDefault();
                choose(option);
              }}
              role="option"
            >
              <span>{option.insert.trim()}</span>
              {option.hint ? <small>{option.hint}</small> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** `active` when visual focus is on the textbox rather than an option. */
const TEXTBOX = -1;

const CARET_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

/** A word written to be completed: a `#tag`, an `@project` or a `key:` facet. */
const ASKED = /^(#|@|[a-z][a-z0-9_-]*:)/i;

/** The run of non-space characters the caret sits at the end of, or in. */
function wordAt(
  value: string,
  caret: number,
): { text: string; start: number; end: number } {
  const at = Math.min(caret, value.length);
  const start = value.slice(0, at).search(/\S*$/);
  const tail = /^\S*/.exec(value.slice(at))?.[0] ?? "";
  return { text: value.slice(start, at), start, end: at + tail.length };
}
