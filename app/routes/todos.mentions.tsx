import { TODO_MENTION_LIMIT } from "~/concepts/todo-mentions";
import { requireConsoleActor } from "~/console/context.server";
import type { Route } from "./+types/todos.mentions";

/**
 * Titles and states for the `?id=todo:tdo_…` a body names, as JSON. A
 * resource route, loaded by a fetcher when a pane draws Markdown whose
 * mentions its page did not title, so no list loader pays for a pane that
 * was never opened.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const actor = await requireConsoleActor(context, request);
  const ids = new URL(request.url).searchParams
    .getAll("id")
    .filter((id) => /^todo:tdo_[0-9a-f-]{36}$/.test(id))
    .slice(0, TODO_MENTION_LIMIT);
  return { mentions: await actor.store.todos.mentions(ids) };
}
