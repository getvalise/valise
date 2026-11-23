import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useHydrated } from "~/components/editable";
import { Icon } from "~/components/icon";

export type ComboboxOption = {
  value: string;
  label: string;
  /** A second line under the label: a model's price, a skill's project. */
  hint?: string;
};

/**
 * A select you can type into, as the ARIA combobox-with-listbox pattern.
 *
 * A native `<select>` stops working somewhere around fifty options, and the
 * lists this console has to offer — every model on OpenRouter, every skill in
 * a registry — are past that. The pattern is one file, so taking a library
 * here would mean handing our keyboard behaviour to someone else to own.
 *
 * The chosen value rides in a hidden input, so it posts with a plain form the
 * same way `Field` and `Select` do and needs no client state above it.
 * Without a `name` there is no hidden input, for a caller such as `TagInput`
 * that posts its own value and only wants the picking.
 *
 * `creatable` offers what was typed as the first option whenever no option
 * has exactly that value, so Enter adds the text rather than the nearest
 * suggestion. P9: a free value is always accepted. Its options are a
 * vocabulary, label and value the same string, so the textbox itself carries
 * `name` and posts what it shows: typed and not yet picked, or with
 * scripting off, the form still gets the text.
 *
 * Tab completes, as Enter picks, once the person has typed or arrowed: the
 * highlighted option, or for a creatable box sitting on what was typed, the
 * first known option that matches it. Focus stays for the next word; a second Tab
 * leaves. A box Tab merely passes through picks nothing.
 *
 * `submitOnPick` submits the enclosing form once a picked option has
 * rendered into it, for a filter bar where a pick is the whole request.
 * Editors leave it off: a pick there is one step of an edit, not a save.
 *
 * `onQueryChange` hears every keystroke, for a caller that fetches its
 * options from the server; `status` is then read out politely, a count or
 * "Searching", since a list that changes under the caret says nothing to a
 * screen reader by itself (WCAG 4.1.3).
 */
export function Combobox({
  label,
  name,
  options,
  defaultValue = "",
  placeholder,
  onChange,
  creatable = false,
  autoFocus = false,
  openOnFocus = true,
  submitOnPick = false,
  readOnly = false,
  onQueryChange,
  status,
}: {
  label: string;
  name?: string;
  options: ComboboxOption[];
  defaultValue?: string;
  placeholder?: string;
  onChange?: (value: string) => void;
  creatable?: boolean;
  /** For a caller that mounts the box on a click and wants the caret in it. */
  autoFocus?: boolean;
  /**
   * Off where the box is focused on the person's behalf, an editor opening or
   * a box coming back after a pick, so the list does not cover the Save
   * beneath it. Down, the toggle, and typing still open it.
   */
  openOnFocus?: boolean;
  submitOnPick?: boolean;
  /** Temporarily lock the picker while its owning set write is in flight. */
  readOnly?: boolean;
  onQueryChange?: (query: string) => void;
  status?: string;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(defaultValue);
  // A creatable box starts from what was written, listed or not.
  const [query, setQuery] = useState(
    creatable ? defaultValue : labelFor(options, defaultValue),
  );
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Typed or arrowed since the list opened, so Tab is a completion and not
  // someone moving through the form.
  const [engaged, setEngaged] = useState(false);
  // Counts picks, so the effect below runs after the pick has rendered: the
  // form must post the picked value, not the text that was there before.
  const [picks, setPicks] = useState(0);

  useEffect(() => {
    if (!submitOnPick || picks === 0) return;
    // No DOM lib here, so React's element stub has no `form`; see onKeyDown.
    const field = input.current as unknown as {
      form: { requestSubmit(): void } | null;
    } | null;
    field?.form?.requestSubmit();
  }, [submitOnPick, picks]);

  useEffect(() => {
    if (readOnly) setOpen(false);
  }, [readOnly]);

  const typed = query.trim();
  // What was typed is offered first when it is not already an option.
  const fresh =
    creatable && typed !== "" && !options.some((o) => o.value === typed);
  // An untouched input shows the selection, and that selection must not then
  // filter the list down to itself the moment the box opens.
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const found =
      needle === "" || needle === labelFor(options, value).toLowerCase()
        ? options
        : options.filter(
            (option) =>
              option.label.toLowerCase().includes(needle) ||
              option.value.toLowerCase().includes(needle) ||
              option.hint?.toLowerCase().includes(needle),
          );
    if (!fresh) return found;
    return [{ value: typed, label: typed, hint: "Not used yet" }, ...found];
  }, [fresh, options, query, typed, value]);

  // An empty vocabulary and an empty box have nothing to say yet.
  const showing = open && (matches.length > 0 || query.trim() !== "");

  function choose(option: ComboboxOption) {
    setValue(option.value);
    setQuery(option.label);
    setOpen(false);
    setActive(0);
    setEngaged(false);
    setPicks((n) => n + 1);
    onChange?.(option.value);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      // From the textbox, Down enters the list at the top and Up at the
      // bottom; inside it, both wrap.
      if (active === TEXTBOX) {
        setActive(event.key === "ArrowDown" ? 0 : matches.length - 1);
        setEngaged(true);
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive(wrap(active + step, matches.length));
      setEngaged(true);
      return;
    }
    if (CARET_KEYS.has(event.key)) {
      // APG: these move the caret, not the list, and take visual focus back
      // to the textbox. The browser moves the caret for Left and Right. Home
      // and End do nothing in a macOS text field, so those are moved here.
      setActive(TEXTBOX);
      // This repo compiles without the DOM lib, so React's stub of the
      // element does not carry the selection API.
      const field = event.currentTarget as unknown as {
        value: string;
        setSelectionRange(start: number, end: number): void;
      };
      if ((event.key === "Home" || event.key === "End") && !event.shiftKey) {
        event.preventDefault();
        const at = event.key === "Home" ? 0 : field.value.length;
        field.setSelectionRange(at, at);
      }
      return;
    }
    if (event.key === "Enter" && open) {
      // Without this the Enter that picks an option also submits the form.
      event.preventDefault();
      const option = matches[active];
      if (option) choose(option);
      else setOpen(false);
      return;
    }
    if (event.key === "Escape") {
      if (open) {
        setOpen(false);
        setActive(0);
        setEngaged(false);
      } else {
        setValue("");
        setQuery("");
        onChange?.("");
      }
      return;
    }
    if (event.key === "Tab" && !event.shiftKey && showing && engaged) {
      const option =
        fresh && active === 0 ? (matches[1] ?? matches[0]) : matches[active];
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
      className="combobox"
      // Leaving for anything outside the widget closes it; moving between the
      // input and its own listbox does not.
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <label htmlFor={`${id}-input`}>{label}</label>
      {name && !creatable ? (
        <input name={name} type="hidden" value={value} />
      ) : null}
      <div className="combobox-control">
        <input
          aria-activedescendant={
            showing && matches[active] ? `${id}-option-${active}` : undefined
          }
          aria-autocomplete="list"
          aria-controls={`${id}-listbox`}
          aria-expanded={showing}
          autoComplete="off"
          autoFocus={autoFocus}
          readOnly={readOnly}
          id={`${id}-input`}
          name={creatable ? name : undefined}
          onChange={(event) => {
            setQuery(event.target.value);
            onQueryChange?.(event.target.value);
            setOpen(true);
            setActive(0);
            setEngaged(true);
          }}
          onFocus={() => {
            if (openOnFocus) setOpen(true);
            setEngaged(false);
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          ref={input}
          role="combobox"
          type="text"
          value={query}
        />
        <button
          aria-label={open ? `Hide ${label} options` : `Show ${label} options`}
          className="combobox-toggle"
          disabled={readOnly}
          onClick={() => {
            setOpen(!open);
            input.current?.focus();
          }}
          tabIndex={-1}
          type="button"
        >
          <Icon name={open ? "expanded" : "expand"} />
        </button>
      </div>
      {status !== undefined ? (
        <p aria-live="polite" className="combobox-status">
          {showing ? status : ""}
        </p>
      ) : null}
      {showing ? (
        <ul
          aria-label={label}
          className="combobox-list"
          id={`${id}-listbox`}
          role="listbox"
        >
          {matches.length === 0 ? (
            <li className="combobox-empty">No match for “{query}”.</li>
          ) : (
            matches.map((option, index) => (
              <li
                aria-selected={option.value === value}
                className={index === active ? "active" : undefined}
                id={`${id}-option-${index}`}
                key={option.value}
                // `mousedown` fires before the input's blur, so the click is
                // not racing the list being unmounted.
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(option);
                }}
                onMouseEnter={() => setActive(index)}
                role="option"
              >
                <span>{option.label}</span>
                {option.hint ? <small>{option.hint}</small> : null}
                {option.value === value ? <Icon name="check" /> : null}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

/** `active` when visual focus is on the textbox rather than an option. */
const TEXTBOX = -1;

const CARET_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

function labelFor(options: ComboboxOption[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? "";
}

function wrap(index: number, length: number): number {
  if (length === 0) return 0;
  return (index + length) % length;
}

/**
 * A short closed list, drawn as the console's own picker. Before hydration it
 * is a native `<select>` under the same name, so a form still posts a choice
 * with scripting off (P11); once hydrated it is a `Combobox`, which looks and
 * keys like every other picker on the page.
 */
export function Choice({
  label,
  name,
  options,
  defaultValue,
  onChange,
}: {
  label: string;
  name: string;
  options: ComboboxOption[];
  defaultValue: string;
  onChange?: (value: string) => void;
}) {
  const hydrated = useHydrated();
  if (!hydrated)
    return (
      <label className="choice">
        {label}
        <select defaultValue={defaultValue} name={name}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  return (
    <Combobox
      defaultValue={defaultValue}
      label={label}
      name={name}
      onChange={onChange}
      options={options}
    />
  );
}
