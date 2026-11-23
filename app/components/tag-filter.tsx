import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useSubmit } from "react-router";
import { Combobox, type ComboboxOption } from "~/components/combobox";
import { Icon } from "~/components/icon";

/**
 * The filter bar's tags: several at once, each a chip inside the box with a
 * remove named "Remove {tag}", and a `Combobox` after them that types to
 * search and picks another. P7, P9.
 *
 * Each chip is a hidden `name` input, so the form posts `?tag=a&tag=b` and
 * the list matches every one (AND). A pick submits the form, as the other
 * filters do (#54). A remove is a link to the same list without that tag, so
 * it works with scripting off (P11).
 *
 * Backspace in the empty box is two presses, as Material 3 writes it: the
 * first selects the last chip, the second removes it. After a pick or a
 * remove the page lands with the caret back in the box, so picking three
 * tags is three picks rather than three clicks back into the field.
 */
export function TagFilter({
  name,
  label,
  defaultValue,
  options,
  removeHref,
}: {
  name: string;
  label: string;
  defaultValue: readonly string[];
  /** Tags worth offering, with their counts as hints. Picked ones drop out. */
  options: ComboboxOption[];
  /** The list's own URL without one tag, for that chip's remove. */
  removeHref: (tag: string) => string;
}) {
  const submit = useSubmit();
  const location = useLocation();
  const [tags, setTags] = useState(defaultValue);
  // Bumped after each pick, so the box remounts empty.
  const [picks, setPicks] = useState(0);
  const [armed, setArmed] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const landed = (location.state as { focus?: string } | null)?.focus === name;

  // Submit once the pick has rendered its hidden input into the form.
  useEffect(() => {
    if (picks === 0) return;
    // No DOM lib in this repo, so the form is named rather than typed.
    const form = (
      root.current as unknown as { closest(selector: string): unknown } | null
    )?.closest("form");
    if (form) {
      submit(form as Parameters<typeof submit>[0], {
        preventScrollReset: true,
        state: { focus: name },
      });
    }
  }, [picks, submit, name]);

  const offered = options.filter(
    (option) =>
      !tags.some((tag) => tag.toLowerCase() === option.value.toLowerCase()),
  );
  const last = tags[tags.length - 1];

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const box = event.target as { value?: string };
    if (event.key !== "Backspace" || box.value !== "" || last === undefined) {
      setArmed(false);
      return;
    }
    event.preventDefault();
    if (!armed) {
      setArmed(true);
      return;
    }
    // The second press is the same request as that chip's remove link.
    (
      root.current as unknown as {
        querySelector(selector: string): { click(): void } | null;
      } | null
    )
      ?.querySelector(".chip.is-armed .chip-remove")
      ?.click();
  }

  return (
    // `tag-input` for the chip and its 24px remove, shared with the editor.
    <div className="tag-input tag-filter" ref={root}>
      {/* The combobox keeps its own label for the screen reader; this one
          sits above the box, where the other filters put theirs. */}
      <span aria-hidden className="tag-filter-label">
        {label}
      </span>
      {/* Backspace is heard here, from the combobox inside it. */}
      <div className="tag-filter-box" onKeyDown={onKeyDown}>
        {tags.map((tag) => (
          <input key={tag} name={name} type="hidden" value={tag} />
        ))}
        {tags.length > 0 ? (
          <ul aria-label={`${label} filters`} className="tags">
            {tags.map((tag) => (
              <li
                className={`chip${armed && tag === last ? " is-armed" : ""}`}
                key={tag}
              >
                <span>{tag}</span>
                <Link
                  aria-label={`Remove ${tag}`}
                  className="chip-remove"
                  preventScrollReset
                  state={{ focus: name }}
                  to={removeHref(tag)}
                >
                  <Icon name="close" size={12} />
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
        <Combobox
          autoFocus={landed || picks > 0}
          creatable
          key={picks}
          label={label}
          // Typed and not picked, the text still posts with the Filter
          // button, and with scripting off.
          name={name}
          onChange={(value) => {
            const tag = value.trim();
            if (!tag || tags.includes(tag)) return;
            setTags([...tags, tag]);
            setPicks(picks + 1);
          }}
          openOnFocus={!landed && picks === 0}
          options={offered}
        />
      </div>
    </div>
  );
}
