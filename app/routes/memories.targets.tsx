import type { PickerPage } from "~/components/async-picker";
import { requireConsoleActor } from "~/console/context.server";
import type { Route } from "./+types/memories.targets";

/**
 * The memory-link picker's options for `?for=<memory>&q=&after=`, as JSON:
 * one page of the memories that memory can point at, searched by title.
 */
export async function loader({
  context,
  request,
}: Route.LoaderArgs): Promise<PickerPage> {
  const actor = await requireConsoleActor(context, request);
  const params = new URL(request.url).searchParams;
  const from = (params.get("for") ?? "").replace(/^memory:/, "");
  const offset = Number.parseInt(params.get("after") ?? "0", 10);
  const page = await actor.store.memories.linkTargets(from, {
    query: params.get("q") ?? "",
    offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
  });
  return {
    options: page.targets.map((target) => ({
      value: target.id,
      label: target.title || target.id,
    })),
    next: page.next === null ? null : String(page.next),
  };
}
