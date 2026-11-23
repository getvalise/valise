import { useFetchers, useSearchParams } from "react-router";
import { editTarget } from "~/components/editable";
import { InfiniteList, useLiveList } from "~/components/infinite-list";
import { OnboardingChecklist } from "~/components/onboarding-checklist";
import { TodoMentions } from "~/components/todo-mention";
import { AccountGreeting, ApplicationShell, Empty } from "~/components/ui";
import { listHref } from "~/concepts/list-filters";
import { action, loader } from "~/console/todos.server";
import { TodoCard } from "~/features/todos/card";
import { Composer, useNewTodo } from "~/features/todos/composer";
import { TodoListControls } from "~/features/todos/list-controls";
import { BlockedHeader, useSections } from "~/features/todos/sections";
import type { Route } from "./+types/todos";

export { shouldRevalidate } from "~/features/todos/urls";
export { action, loader };

export default function Todos({ loaderData }: Route.ComponentProps) {
  const { filters } = loaderData;
  const live = useLiveList(
    loaderData.todos,
    (todo) => `${todo.title}\n${todo.body}`,
    filters,
  );
  // From the URL, not the loader: shouldRevalidate skips `?open=` and
  // `?edit=` changes.
  const [params] = useSearchParams();
  const editing = params.get("edit") ?? undefined;
  const opened = params.get("open") ?? undefined;
  const newTodo = useNewTodo(filters, editing);
  // The rows this page is completing: the circle posts through a fetcher, and
  // the list it revalidates leaves done rows out unless `?done=show`.
  const completing = useFetchers().flatMap((fetcher) =>
    fetcher.formData?.get("intent") === "set-state" &&
    fetcher.formData.get("state") === "done"
      ? [String(fetcher.formData.get("id"))]
      : [],
  );
  const sections = useSections(
    live.rows,
    listHref("/todos", { ...filters, page: undefined }),
    // A blocked-only list is defined by the state, so an unblocked row leaves it.
    {
      fresh: loaderData.detail,
      rescue: !live.pending && !filters.blocked,
      completing,
    },
  );
  // j and k walk the order on screen, blocked rows first.
  const shown = [...sections.blocked, ...sections.rest];
  const vocabulary = { ...loaderData.vocabulary, facets: loaderData.facets };
  const card = (todo: (typeof shown)[number], blocked: boolean) => {
    const index = shown.indexOf(todo);
    return (
      <TodoCard
        blocked={blocked}
        neighbors={{
          previous: shown[index - 1]?.id,
          next: shown[index + 1]?.id,
        }}
        editing={editing}
        filters={filters}
        key={todo.id}
        now={loaderData.now}
        opened={todo.id === opened}
        vocabulary={vocabulary}
        todo={todo}
        relationOptions={loaderData.todos}
      />
    );
  };
  return (
    <TodoMentions.Provider value={loaderData.mentions}>
      <ApplicationShell
        lede={
          <>
            <AccountGreeting /> Completing a to-do here overrides whatever agent
            holds its lease, and fences that agent out of its next write.
          </>
        }
        title="To-dos"
      >
        <OnboardingChecklist onboarding={loaderData.onboarding} />
        <TodoListControls data={loaderData} live={live} />
        <ul className="card-list todo-list">
          <li className="add-row">
            <Composer
              belowBlocked={sections.blocked.length > 0}
              filters={filters}
              listedTodoIds={new Set(loaderData.todos.map((todo) => todo.id))}
              mode={newTodo.mode}
              opener={newTodo.opener}
              vocabulary={{
                ...loaderData.vocabulary,
                facets: loaderData.facets,
              }}
            />
          </li>
          {sections.blocked.length > 0 ? (
            <BlockedHeader count={loaderData.blockedCount} />
          ) : null}
          {sections.blocked.map((todo) => card(todo, true))}
          {sections.rest.map((todo) => card(todo, false))}
        </ul>
        {live.rows.length === 0 ? (
          <Empty>
            {live.pending
              ? "Searching all to-dos…"
              : "No to-dos match those filters."}
          </Empty>
        ) : null}
        <InfiniteList
          paused={live.pending}
          filters={filters}
          path="/todos"
          window={loaderData.window}
        />
        {loaderData.detail &&
        !shown.some((todo) => todo.id === loaderData.detail?.id) &&
        (opened === loaderData.detail.id ||
          editTarget(editing) === loaderData.detail.id) ? (
          <TodoCard
            detailOnly
            editing={editing}
            filters={filters}
            now={loaderData.now}
            opened
            todo={loaderData.detail}
            relationOptions={loaderData.todos}
            vocabulary={{ ...loaderData.vocabulary, facets: loaderData.facets }}
          />
        ) : null}
      </ApplicationShell>
    </TodoMentions.Provider>
  );
}
