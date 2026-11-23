import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { Combobox, type ComboboxOption } from "~/components/combobox";
import { useHydrated } from "~/components/editable";
import type { RelatedTodo } from "~/concepts/todo-relations";

/** Algolia's measured sweet spot; past 300ms typing starts to feel late. */
const DEBOUNCE_MS = 200;

/**
 * Pick one to-do by title or id. Before anything is typed it offers `seed`,
 * the open rows already on screen; typing asks `/todos/suggest`, so a to-do
 * outside the loaded page is still one search away. The local filter answers
 * on the keystroke and the server's list replaces it when it lands.
 *
 * The chosen id posts as `name`. With scripting off the field is a plain
 * text box that takes a pasted `todo:` id under the same name (P11).
 */
export function TodoPicker({
  label,
  name,
  seed,
  exclude = [],
  onChange,
}: {
  label: string;
  name: string;
  seed: RelatedTodo[];
  /** Ids not to offer: the open to-do and those already related. */
  exclude?: string[];
  onChange?: (id: string) => void;
}) {
  const hydrated = useHydrated();
  const fetcher = useFetcher<{ query: string; todos: RelatedTodo[] }>();
  const [query, setQuery] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  if (!hydrated)
    return (
      <label>
        {label}
        <input autoComplete="off" name={name} placeholder="todo:…" required />
      </label>
    );

  const skip = new Set(exclude);
  const found =
    query.trim() !== "" && fetcher.data
      ? fetcher.data.todos
      : seed.filter((todo) => todo.state !== "done").slice(0, 12);
  const options = found.filter((todo) => !skip.has(todo.id)).map(todoOption);
  return (
    <Combobox
      label={label}
      name={name}
      onChange={onChange}
      onQueryChange={(next) => {
        setQuery(next);
        clearTimeout(timer.current);
        const needle = next.trim();
        if (needle === "") return;
        timer.current = setTimeout(
          () => fetcher.load(`/todos/suggest?q=${encodeURIComponent(needle)}`),
          DEBOUNCE_MS,
        );
      }}
      options={options}
      placeholder="Search by title or id"
      status={
        fetcher.state === "idle"
          ? `${options.length} ${options.length === 1 ? "to-do" : "to-dos"}`
          : "Searching"
      }
    />
  );
}

function todoOption(todo: RelatedTodo): ComboboxOption {
  return {
    value: todo.id,
    label: todo.title,
    hint: [todo.project, todo.state, todo.id.slice(5, 17)]
      .filter(Boolean)
      .join(" · "),
  };
}
