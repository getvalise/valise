import { requireConsoleActor } from "~/console/context.server";
import type { Route } from "./+types/todos.suggest";

/**
 * A to-do picker's suggestions for `?q=`, as JSON. A resource route: no
 * component, so a fetcher can load it without touching the list's loader.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const actor = await requireConsoleActor(context, request);
  const query = new URL(request.url).searchParams.get("q") ?? "";
  return {
    query,
    todos: await actor.store.todos.suggest(query),
  };
}
