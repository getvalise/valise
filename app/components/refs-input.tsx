import { Combobox } from "~/components/combobox";
import { TODO_REF_KINDS } from "~/concepts/todo-contracts";

/**
 * One new pointer: its kind and its value. The kind is picked from the five
 * `create_todo` teaches, with create-on-miss (P7, P9); a blank kind is
 * inferred on the server, `url` for a link and `file` for anything else.
 * Posts `ref-kind` and `ref-value`, after the pairs the form already carries.
 */
export function RefInput() {
  return (
    <>
      <Combobox
        autoFocus
        creatable
        label="Pointer kind"
        name="ref-kind"
        openOnFocus={false}
        options={KIND_OPTIONS}
        placeholder="Blank infers url or file"
      />
      <label>
        Pointer
        <input
          autoComplete="off"
          name="ref-value"
          placeholder="owner/name, a path, or a URL"
          required
          type="text"
        />
      </label>
    </>
  );
}

const KIND_OPTIONS = TODO_REF_KINDS.map(([kind, means]) => ({
  value: kind,
  label: kind,
  hint: means,
}));

/**
 * The first field a person types in, for a modal form to focus once it is
 * open: `showModal()` moves focus to the Close button after mount.
 */
export function firstField(
  form: HTMLFormElement | null,
): { focus(): void } | null {
  // A string query, not the DOM lib's types: this repo compiles without it.
  const found = (
    form as { querySelector(selector: string): unknown } | null
  )?.querySelector("input:not([type=hidden]), select, textarea");
  return (found ?? null) as { focus(): void } | null;
}
