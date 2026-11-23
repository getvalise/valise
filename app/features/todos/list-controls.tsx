import { Link } from "react-router";
import type { useLiveList } from "~/components/infinite-list";
import { ListToolbar } from "~/components/list-toolbar";
import { ListControls } from "~/components/ui";
import { Button } from "~/components/ui/button";
import { listHref } from "~/concepts/list-filters";
import type { loader } from "~/console/todos.server";
import type { Todo } from "./types";

export function TodoListControls({
  data,
  live,
}: {
  data: Awaited<ReturnType<typeof loader>>;
  live: ReturnType<typeof useLiveList<Todo>>;
}) {
  const { filters } = data;
  return (
    <ListControls>
      <ListToolbar
        filters={filters}
        live={live}
        path="/todos"
        projectCounts={data.projects}
        tagCounts={data.facets}
        vocabulary={data.vocabulary}
      >
        {/* Blocked rows drop out of list_ready, so this is where a person
            finds the ones whose blocker may have cleared. */}
        {data.blockedCount > 0 || filters.blocked ? (
          <Button asChild className="h-8" size="sm" variant="outline">
            <Link
              aria-pressed={filters.blocked ? "true" : "false"}
              className="todo-state-toggle"
              preventScrollReset
              to={listHref("/todos", filters, {
                page: undefined,
                state: filters.blocked ? undefined : "blocked",
              })}
            >
              {filters.blocked
                ? "Show every state"
                : `Only blocked (${data.blockedCount})`}
            </Link>
          </Button>
        ) : null}
        {/* Done rows are out of the list unless asked for: what is left to do
            is the working list. A blocked-only list holds none to show. */}
        {data.doneCount > 0 && !filters.blocked ? (
          <Button asChild className="h-8" size="sm" variant="outline">
            <Link
              className="todo-done-toggle"
              preventScrollReset
              to={listHref("/todos", filters, {
                page: undefined,
                done: filters.showDone ? undefined : "show",
              })}
            >
              {`${filters.showDone ? "Hide" : "Show"} done (${data.doneCount})`}
            </Link>
          </Button>
        ) : null}
      </ListToolbar>
    </ListControls>
  );
}
