import { Link } from "react-router";
import { Markdown } from "~/components/markdown";
import { ApplicationShell, Empty } from "~/components/ui";
import { assetIdOf, assetRef } from "~/concepts/assets";
import {
  requireConsoleActor,
  requireSameOriginAction,
} from "~/console/context.server";
import { afterSave } from "~/console/forms.server";
import { withoutRemoteImages } from "~/features/library/presentation";
import { postedStars, RatingControl } from "~/features/library/rating";
import {
  ReaderArticle,
  ReaderBody,
  ReaderFooter,
  ReaderHeader,
  ReaderLine,
} from "~/features/library/reader";
import type { Route } from "./+types/library-read-file";

export function headers() {
  return { "cache-control": "private, no-store" };
}

export async function loader({ context, request, params }: Route.LoaderArgs) {
  const actor = await requireConsoleActor(context, request);
  const id = assetIdOf(params.assetId);
  const asset = id ? await actor.store.library.asset(id) : null;
  if (!asset) throw new Response("No saved file has this id.", { status: 404 });
  // Reading an item is the use search orders by; it never fails the page.
  await actor.store.library.recordUse("asset", asset.assetId, "opened");
  const stars = await actor.store.library.rating("asset", asset.assetId);
  const extracted = await actor.store.library.assetText(asset.assetId);
  return {
    asset,
    stars,
    extracted: extracted
      ? { ...extracted, text: withoutRemoteImages(extracted.text) }
      : null,
  };
}

/** Sets or clears the file's rating; the only write the reader makes. */
export async function action({ context, request, params }: Route.ActionArgs) {
  requireSameOriginAction(request);
  const actor = await requireConsoleActor(context, request);
  const id = assetIdOf(params.assetId);
  const asset = id ? await actor.store.library.asset(id) : null;
  if (!asset) throw new Response("No saved file has this id.", { status: 404 });
  const form = await request.formData();
  const stars = postedStars(form);
  if (form.get("intent") !== "rate" || stars === null)
    throw new Response("A rating is 1 to 3 stars, or 0 to clear.", {
      status: 400,
    });
  await actor.store.library.setRating("asset", asset.assetId, stars || null);
  return afterSave(form, new URL(request.url).pathname);
}

export default function FileReader({ loaderData }: Route.ComponentProps) {
  const { asset, extracted, stars } = loaderData;
  const back = `/library?${new URLSearchParams({ view: "documents", processing: asset.assetId, ...(asset.archivedAt ? { archived: "1" } : {}) })}`;
  return (
    <ApplicationShell
      title="Library"
      lede={<Link to={back}>Back to this file in Library</Link>}
      measure="reading"
    >
      <ReaderArticle>
        <ReaderHeader
          eyebrow={
            asset.contentType.startsWith("image/")
              ? "Generated image description"
              : "Extracted file text"
          }
          title={asset.title}
        >
          <ReaderLine>{asset.fileName}</ReaderLine>
          <ReaderLine>
            <a href={`/files/${asset.objectId}`} download={asset.fileName}>
              Download original
            </a>
            {" · "}
            <Link
              to={`/library?${new URLSearchParams({ view: "documents", details: assetRef(asset.assetId), ...(asset.archivedAt ? { archived: "1" } : {}) })}`}
            >
              File details
            </Link>
          </ReaderLine>
          <RatingControl stars={stars} />
        </ReaderHeader>
        {extracted?.text ? (
          <>
            <ReaderBody label="File text">
              <Markdown>{extracted.text}</Markdown>
            </ReaderBody>
            <ReaderFooter>
              {asset.contentType.startsWith("image/")
                ? "Generated"
                : "Extracted"}{" "}
              by {extracted.extractor} ({extracted.processorVersion}) on{" "}
              {new Date(extracted.createdAt * 1000).toISOString().slice(0, 10)}.{" "}
              {extracted.truncated
                ? "Partial extraction: retained text is capped at 1 MiB. "
                : ""}
              Images are links; no remote resources load. The original is
              unchanged.
            </ReaderFooter>
          </>
        ) : (
          <Empty>
            No extracted text is available. Open this file in Library to process
            it, or download the original.
          </Empty>
        )}
      </ReaderArticle>
    </ApplicationShell>
  );
}
