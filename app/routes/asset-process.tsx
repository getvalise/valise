import { data, redirect, useActionData } from "react-router";
import { z } from "zod";
import {
  AssetProcessing,
  type AssetProcessingAnswer,
  useProcessingRefresh,
} from "~/components/asset-processing";
import { ApplicationShell } from "~/components/ui";
import {
  PROCESSING_SUPPORT,
  ProcessingRefused,
} from "~/concepts/asset-extraction";
import { assetIdOf } from "~/concepts/assets";
import {
  consoleContext,
  requireConsoleActor,
  requireSameOriginAction,
} from "~/console/context.server";
import { ExtractedText } from "~/features/library/extracted-text";
import type { Route } from "./+types/asset-process";

export function headers() {
  return { "cache-control": "private, no-store" };
}

export async function loader({ context, request, params }: Route.LoaderArgs) {
  const actor = await requireConsoleActor(context, request);
  const assetId = assetIdOf(params.assetId ?? "");
  const library = actor.store.library;
  const asset = assetId ? await library.asset(assetId) : null;
  if (!asset) throw new Response("Not found.", { status: 404 });
  return {
    asset,
    extracted: await library.assetText(asset.assetId),
    processing: await library.processing(asset.assetId),
    vocabulary: await actor.store.vocabulary(),
  };
}

export async function action({ context, request, params }: Route.ActionArgs) {
  requireSameOriginAction(request);
  const actor = await requireConsoleActor(context, request);
  const assetId = assetIdOf(params.assetId ?? "");
  const library = actor.store.library;
  if (!assetId || !(await library.asset(assetId)))
    throw new Response("Not found.", { status: 404 });
  if (Number(request.headers.get("content-length")) > 8192)
    throw new Response("Form too large.", { status: 413 });
  const form = await processingForm(request);
  try {
    if (form.get("intent") === "process") {
      const queued = await library.queueProcessing(assetId, true);
      if (queued?.processingId)
        context
          .get(consoleContext)
          .ctx.waitUntil(library.runQueued(queued.processingId));
    } else if (
      form.get("intent") === "accept" ||
      form.get("intent") === "dismiss"
    ) {
      const output = z.string().max(100).parse(form.get("output"));
      const value = z
        .string()
        .max(120)
        .parse(form.get("value") ?? "");
      if (form.get("intent") === "accept")
        await library.acceptSuggestion(
          assetId,
          output,
          z
            .enum(["title", "summary", "tag", "project"])
            .parse(form.get("field")),
          value,
          z
            .string()
            .max(4000)
            .optional()
            .parse(form.get("expected") ?? undefined),
        );
      // Concepts are derived text: they search until dismissed, with no accept.
      else
        await library.dismissSuggestion(
          assetId,
          output,
          z
            .enum(["title", "summary", "tag", "project", "concept"])
            .parse(form.get("field")),
          value,
        );
    } else
      throw new ProcessingRefused(
        "invalid_intent",
        "Unknown processing action.",
      );
    // A document post redirects, so reloading the page reads the decision
    // instead of submitting it again.
    if (form.get("via") !== "fetcher")
      return redirect(`/library/${encodeURIComponent(assetId)}/process`);
    return data<AssetProcessingAnswer>({
      processing: await library.processing(assetId),
    });
  } catch (error) {
    if (!(error instanceof ProcessingRefused) && !(error instanceof z.ZodError))
      throw error;
    return data<AssetProcessingAnswer>(
      {
        error:
          error instanceof ProcessingRefused
            ? error.message
            : "Invalid suggestion selection.",
        processing: await library.processing(assetId),
      },
      { status: 400 },
    );
  }
}

/** A chunked request cannot bypass the small-form limit. No file body here. */
async function processingForm(request: Request): Promise<URLSearchParams> {
  if (
    !request.headers
      .get("content-type")
      ?.startsWith("application/x-www-form-urlencoded")
  )
    throw new Response("Use an encoded form, not a file upload.", {
      status: 415,
    });
  const reader = request.body?.getReader();
  if (!reader) return new URLSearchParams();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > 8192) {
      await reader.cancel();
      throw new Response("Form too large.", { status: 413 });
    }
    text += decoder.decode(part.value, { stream: true });
  }
  return new URLSearchParams(text + decoder.decode());
}

export default function AssetProcess({ loaderData }: Route.ComponentProps) {
  const answer = useActionData<AssetProcessingAnswer>();
  const { asset, processing, vocabulary } = loaderData;
  useProcessingRefresh(
    processing?.state === "queued" || processing?.state === "running",
  );
  return (
    <ApplicationShell lede={PROCESSING_SUPPORT} title={asset.title}>
      <p>
        <a href="/library?view=documents">Back to library</a>
      </p>
      {answer?.error ? <p role="alert">{answer.error}</p> : null}
      {asset.objectId ? (
        <p>
          <a href={`/files/${asset.objectId}`} download={asset.fileName}>
            Download original
          </a>
        </p>
      ) : null}
      <ExtractedText asset={asset} extracted={loaderData.extracted} />
      <AssetProcessing
        assetId={asset.assetId}
        description={asset.description}
        processing={processing}
        project={asset.project}
        tags={asset.tags}
        title={asset.title}
        vocabulary={vocabulary}
        fileName={asset.fileName}
        contentType={asset.contentType}
        size={asset.size ?? asset.declaredSize}
      />
      {processing?.originalSha256 ? (
        <p className="asset-processing muted">
          Immutable original SHA-256: <code>{processing.originalSha256}</code>
        </p>
      ) : null}
    </ApplicationShell>
  );
}
