import { requireConsoleActor } from "~/console/context.server";
import type { Route } from "./+types/files";

/**
 * One stored file, for its owner's console session only. A resource route:
 * no component, the loader's Response is the page. ADR-0011.
 */
export async function loader({ context, request, params }: Route.LoaderArgs) {
  const actor = await requireConsoleActor(context, request);
  const served = await actor.store.files.serve(params.objectId);
  if (served === null) throw new Response("File not found.", { status: 404 });
  return served;
}
