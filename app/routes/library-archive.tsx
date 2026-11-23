import { assetIdOf } from "~/concepts/assets";
import { requireConsoleActor } from "~/console/context.server";
import type { Route } from "./+types/library-archive";

/**
 * An archived page, for its owner's session: a 303 to the signed viewer
 * path, which needs no cookie because the page renders with an opaque origin.
 */
export async function loader({ context, request, params }: Route.LoaderArgs) {
  const actor = await requireConsoleActor(context, request);
  const id = assetIdOf(params.assetId);
  const asset = id ? await actor.store.library.asset(id) : null;
  const folder =
    asset?.contentType === "text/html"
      ? await actor.store.library.folderOf(asset.assetId)
      : null;
  if (!asset || !folder)
    throw new Response("No archived page has this id.", { status: 404 });
  const location = await actor.store.library.archiveView(
    folder.folderId,
    asset.fileName,
    new URL(request.url).origin,
  );
  if (location === null)
    throw new Response("No archived page has this id.", { status: 404 });
  return new Response(null, {
    status: 303,
    headers: { location, "cache-control": "private, no-store" },
  });
}
