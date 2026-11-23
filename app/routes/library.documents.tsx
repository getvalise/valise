import type { PickerPage } from "~/components/async-picker";
import { assetRef } from "~/concepts/assets";
import { requireConsoleActor } from "~/console/context.server";
import { fileKind } from "~/features/library/presentation";
import type { Route } from "./+types/library.documents";

/**
 * The document picker's options for `?q=&after=`, as JSON: one page of
 * saved documents, searched on the server, with the cursor for the next.
 * A resource route, so a fetcher loads it without the Library's loader.
 */
export async function loader({
  context,
  request,
}: Route.LoaderArgs): Promise<PickerPage> {
  const actor = await requireConsoleActor(context, request);
  const params = new URL(request.url).searchParams;
  if (params.get("folders") === "1") {
    const page = await actor.store.library.folders(false, {
      query: params.get("q") ?? undefined,
      after: params.get("after") ?? undefined,
    });
    const assets = await actor.store.library.assets(
      page.items.map((folder) => folder.assetId),
    );
    return {
      options: page.items.map((folder) => ({
        value: assetRef(folder.assetId),
        label:
          folder.title ??
          assets.find((asset) => asset.assetId === folder.assetId)?.title ??
          "Documents",
        hint: `${folder.count} ${folder.count === 1 ? "file" : "files"}`,
      })),
      next: page.next,
    };
  }
  const page = await actor.store.library.assetsPage(false, {
    durableOnly: true,
    query: params.get("q") ?? undefined,
    after: params.get("after") ?? undefined,
  });
  return {
    options: page.items.map((asset) => ({
      value: assetRef(asset.assetId),
      label: asset.title,
      hint: fileKind(asset.contentType),
    })),
    next: page.next,
  };
}
