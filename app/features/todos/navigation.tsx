import { useEffect } from "react";
import { Link, useFetchers, useNavigate, useSearchParams } from "react-router";

export type TodoNeighbors = { previous?: string; next?: string };

/** Navigate the displayed order, never a new sort or a hidden result. P3/P4. */
export function TodoNavigation({ previous, next }: TodoNeighbors) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const pending = useFetchers().some((fetcher) => fetcher.state !== "idle");
  const href = (id: string) => {
    const query = new URLSearchParams(params);
    query.set("open", id);
    query.delete("edit");
    return `/todos?${query}`;
  };
  const previousHref = previous ? href(previous) : undefined;
  const nextHref = next ? href(next) : undefined;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        pending ||
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      const target = event.target as {
        closest?(selector: string): unknown;
      } | null;
      if (
        target?.closest?.(
          "input, textarea, select, [contenteditable], [role=combobox], [role=textbox]",
        )
      )
        return;
      // An editor or an unsent comment still owns its draft after focus leaves it.
      if (
        document.querySelector(
          "dialog:modal, .editable.editing, .subtask-add.editing, .modal-pane .todo-state input[type=text]",
        )
      )
        return;
      const comment = document.querySelector(
        ".modal-pane .todo-comment textarea",
      ) as { value: string } | null;
      if (comment?.value.trim()) return;
      const to =
        event.key === "j"
          ? nextHref
          : event.key === "k"
            ? previousHref
            : undefined;
      if (!to) return;
      event.preventDefault();
      navigate(to, { replace: true, preventScrollReset: true });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [previousHref, nextHref, navigate, pending]);
  return (
    <nav aria-label="To-do navigation" className="todo-pane-navigation">
      {previousHref ? (
        <Link to={previousHref} replace preventScrollReset>
          <kbd>k</kbd> Previous
        </Link>
      ) : (
        <span>
          <kbd>k</kbd> Previous
        </span>
      )}
      {nextHref ? (
        <Link to={nextHref} replace preventScrollReset>
          <kbd>j</kbd> Next
        </Link>
      ) : (
        <span>
          <kbd>j</kbd> Next
        </span>
      )}
    </nav>
  );
}
