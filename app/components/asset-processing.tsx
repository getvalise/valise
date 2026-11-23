import { useEffect, useRef } from "react";
import { useFetcher, useRevalidator, useSearchParams } from "react-router";
import { ViaFetcher } from "~/components/editable";
import {
  formatEstimate,
  PROCESSING_SUPPORT,
  processingEligibility,
  processingEstimate,
} from "~/concepts/asset-formats";
import type { AssetProcessingView } from "~/concepts/asset-processing";
import type { Vocabulary } from "~/concepts/vocabulary";

export type AssetProcessingAnswer = {
  processing: AssetProcessingView | null;
  error?: string;
};

/** Provisional controls stay on the file (P1), apply one field (P2), and are
 * real form buttons (P7/P10/P11). Existing vocabulary is labelled, not guessed. */
export function AssetProcessing({
  assetId,
  processing = null,
  vocabulary = { projects: [], tags: [] },
  title = "",
  description = "",
  tags = [],
  project = null,
  compact = false,
  fileName = "",
  contentType = "",
  size = 0,
  inPane = false,
  fileLabel,
}: {
  assetId: string;
  processing?: AssetProcessingView | null;
  vocabulary?: Vocabulary;
  title?: string;
  description?: string;
  tags?: string[];
  project?: string | null;
  compact?: boolean;
  fileName?: string;
  contentType?: string;
  size?: number;
  inPane?: boolean;
  fileLabel?: string;
}) {
  const fetcher = useFetcher<AssetProcessingAnswer>({
    key: `asset-processing:${assetId}`,
  });
  const [params, setParams] = useSearchParams();
  const revalidator = useRevalidator();
  const details = compact && params.get("processing") === assetId;
  function pane(open: boolean, review = false) {
    const next = new URLSearchParams(params);
    if (open) next.set("details", `asset:${assetId}`);
    next.delete("edit");
    if (open) next.set("processing", assetId);
    else next.delete("processing");
    if (open && review) next.set("review", "1");
    else next.delete("review");
    setParams(next, { replace: true, preventScrollReset: true });
  }
  const view = processing;
  const action = `/library/${encodeURIComponent(assetId)}/process`;
  const busy = fetcher.state !== "idle";
  const unavailable = processingEligibility(fileName, contentType, size);
  const estimate = processingEstimate(fileName, contentType, size);
  const suggestions =
    view?.outputId === view?.processingId ? view?.suggestions : null;
  const decided = (field: string, value = "") =>
    view?.decisions?.some(
      (decision) => decision.field === field && decision.value === value,
    );
  const choice = (
    intent: "accept" | "dismiss",
    field: string,
    label: string,
    value?: string,
  ) => (
    <fetcher.Form action={action} method="post" preventScrollReset>
      <ViaFetcher />
      <input name="intent" type="hidden" value={intent} />
      <input name="output" type="hidden" value={view?.outputId ?? ""} />
      <input name="field" type="hidden" value={field} />
      {value ? <input name="value" type="hidden" value={value} /> : null}
      <input
        name="expected"
        type="hidden"
        value={
          field === "title"
            ? title
            : field === "summary"
              ? description
              : field === "project"
                ? (project ?? "")
                : JSON.stringify(tags)
        }
      />
      <button className="ghost small" disabled={busy} type="submit">
        {label}
      </button>
    </fetcher.Form>
  );
  const accept = (field: string, label: string, value?: string) =>
    choice("accept", field, label, value);
  const dismiss = (field: string, value?: string) =>
    choice(
      "dismiss",
      field,
      `Dismiss suggested ${field}${value ? `: ${value}` : ""}`,
      value,
    );
  const pendingSuggestions = Boolean(
    suggestions &&
      ((suggestions.title !== title && !decided("title")) ||
        (suggestions.summary !== description && !decided("summary")) ||
        (suggestions.project &&
          suggestions.project !== project &&
          !decided("project")) ||
        suggestions.tags.some(
          (tag) => !tags.includes(tag) && !decided("tag", tag),
        )),
  );
  const content = (
    <>
      <p className="muted">
        Suggested, not saved. Apply or dismiss each field individually; applying
        a title, summary or project replaces that field.
      </p>
      {suggestions && pendingSuggestions ? (
        <div aria-label="Provisional metadata suggestions" className="stack">
          {suggestions.title !== title && !decided("title") ? (
            <div className="stack">
              <p>Suggested title: {suggestions.title}</p>
              <div className="row">
                {accept("title", "Accept suggested title")}
                {dismiss("title")}
              </div>
            </div>
          ) : null}
          {suggestions.summary !== description && !decided("summary") ? (
            <div className="stack">
              <p>Suggested summary: {suggestions.summary}</p>
              <div className="row">
                {accept("summary", "Accept suggested summary")}
                {dismiss("summary")}
              </div>
            </div>
          ) : null}
          {suggestions.project &&
          suggestions.project !== project &&
          !decided("project") ? (
            <div className="row">
              <span className="asset-suggestion-ghost">
                Suggested project: {suggestions.project} (
                {vocabulary.projects.includes(suggestions.project)
                  ? "existing"
                  : "new suggestion"}
                )
              </span>
              {accept("project", `Accept project: ${suggestions.project}`)}
              {dismiss("project")}
            </div>
          ) : null}
          {suggestions.tags
            .filter((tag) => !tags.includes(tag) && !decided("tag", tag))
            .map((tag) => (
              <div className="row" key={tag}>
                <span className="asset-suggestion-ghost">
                  {tag} (
                  {vocabulary.tags.includes(tag)
                    ? "existing"
                    : "new suggestion"}
                  )
                </span>
                {accept("tag", `Accept tag: ${tag}`, tag)}
                {dismiss("tag", tag)}
              </div>
            ))}
        </div>
      ) : (
        <p>No unreviewed suggestions.</p>
      )}
      {fetcher.data?.error ? <p role="alert">{fetcher.data.error}</p> : null}
    </>
  );
  const status = (
    <p aria-live="polite" className="muted" role="status">
      {compact && fileLabel ? `${fileLabel}: ` : null}
      {busy
        ? fetcher.formData?.get("intent") === "process"
          ? "Queuing extraction…"
          : "Saving your choice…"
        : view?.state === "ready"
          ? "Extracted content is searchable."
          : view?.state === "running"
            ? "Extracting content from the saved original. Your metadata will not change."
            : view?.state === "queued"
              ? "Queued for processing. The original is saved and available."
              : view?.state === "failed"
                ? processingFailure(view.errorCode)
                : (unavailable ??
                  `Not processed — metadata-only search. ${estimate ? formatEstimate(estimate) : ""}`.trim())}
    </p>
  );
  const controls = (
    <div className="row">
      <fetcher.Form
        action={action}
        method="post"
        preventScrollReset
        onSubmit={() => {
          if (compact) pane(true);
        }}
      >
        <ViaFetcher />
        <button
          className="ghost small"
          disabled={
            !!unavailable ||
            busy ||
            view?.state === "running" ||
            view?.state === "queued" ||
            (view?.retryAfter ?? 0) > Math.floor(Date.now() / 1000)
          }
          name="intent"
          type="submit"
          value="process"
        >
          {view?.processingId ? "Reprocess file" : "Process file"}
        </button>
      </fetcher.Form>
    </div>
  );
  const provenance = (
    <>
      {view?.retryAfter ? (
        <p role="status">
          The conversion service may still be working. Refresh after{" "}
          {new Date(view.retryAfter * 1000).toISOString()} before retrying; the
          earlier request may still be billed.
        </p>
      ) : null}
      {view?.outputId ? (
        <p className="muted">
          {view.truncated
            ? "Partial extraction: only the first 1 MiB is searchable."
            : "Extracted text is retained up to 1 MiB."}
          {view.passages
            ? ` Searchable in ${view.passages} ${view.passages === 1 ? "passage" : "passages"}${
                view.passageKind ? `, each citing its ${view.passageKind}` : ""
              }.`
            : ""}
          {view.semanticFailed
            ? " Semantic indexing is delayed; exact text search is available."
            : view.semanticPending
              ? " Semantic indexing is pending; exact text search is available."
              : " Semantic results depend on index visibility."}
        </p>
      ) : null}
      {suggestions?.concepts.length ? (
        <div aria-label="Key concepts" className="stack">
          <p className="muted">
            Key concepts, searchable with the extracted text. Dismiss any that
            do not fit; titles and tags stay as you set them.
          </p>
          {suggestions.concepts
            .filter((concept) => !decided("concept", concept))
            .map((concept) => (
              <div className="row" key={concept}>
                <span>{concept}</span>
                {dismiss("concept", concept)}
              </div>
            ))}
        </div>
      ) : null}
      {view?.suggestionError ? (
        <p role="status">
          Summary and label suggestions could not be generated. Extracted text
          remains searchable; reprocess to try suggestions again.
        </p>
      ) : null}
    </>
  );
  const panel = (
    <div className="stack" data-processing-live>
      {status}
      {unavailable && view?.outputId ? (
        <p className="muted">
          Reprocessing is not available for this file&apos;s type or size. The
          text already extracted stays searchable.
        </p>
      ) : null}
      {provenance}
      {controls}
      <a
        className="button ghost small"
        href={action}
        onClick={(event) => {
          if (
            !inPane ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          void revalidator.revalidate();
        }}
      >
        Refresh processing status
      </a>
      <details>
        <summary>Supported files and limits</summary>
        <p className="muted">{PROCESSING_SUPPORT}</p>
      </details>
      {suggestions ? (
        content
      ) : (
        <p className="muted">
          Suggestions appear after extraction. Titles, descriptions and labels
          change only when you accept them.
        </p>
      )}
      {fetcher.data?.error && !suggestions ? (
        <p role="alert">{fetcher.data.error}</p>
      ) : null}
    </div>
  );
  return (
    <section aria-label="Content processing" className="asset-processing stack">
      {compact ? status : <h4>Searchable content</h4>}
      {compact && pendingSuggestions ? (
        <div className="row">
          <span role="status">Suggestions ready.</span>
          <a
            className="button ghost small"
            href={action}
            onClick={(event) => {
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              pane(true, true);
            }}
          >
            Review suggestions
          </a>
        </div>
      ) : null}
      {compact && !details && fetcher.data?.error ? (
        <p role="alert">{fetcher.data.error}</p>
      ) : null}
      {compact ? (
        <div className="row">
          {!unavailable && !view?.outputId ? controls : null}
          {view?.outputId ? (
            <a
              className="button ghost small"
              href={`/library/read-file/${encodeURIComponent(assetId)}`}
            >
              Read file
            </a>
          ) : null}
          <a
            className="button ghost small"
            href={action}
            onClick={(event) => {
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              pane(true);
            }}
          >
            Processing details
          </a>
        </div>
      ) : (
        panel
      )}
    </section>
  );
}

function processingFailure(code: string | null | undefined): string {
  switch (code) {
    case "no_text":
      return "No readable text was found. This may be a scanned PDF; scanned-page OCR is not supported. The original is unchanged.";
    case "conversion_failed":
      return "The conversion service could not read this document. It may be encrypted or damaged. The original is unchanged.";
    case "provider_timeout":
    case "conversion_unconfirmed":
      return "Conversion did not confirm completion in time. Wait for the cooldown, refresh, then retry. The original is unchanged.";
    case "original_missing":
      return "The original file could not be read. Try downloading it before retrying extraction.";
    case "interrupted":
    case "restored_interrupted":
      return "Extraction was interrupted. You can explicitly retry; the original is unchanged.";
    default:
      return "Extraction failed. The original is unchanged; open processing details to review the limits and retry.";
  }
}

/** Bounded observation only; GET never starts inference. No-script uses Refresh. */
export function useProcessingRefresh(active: boolean) {
  const { revalidate, state } = useRevalidator();
  const current = useRef({ revalidate, state });
  current.current = { revalidate, state };
  useEffect(() => {
    if (!active) return;
    let checks = 0;
    const timer = setInterval(() => {
      if (++checks > 60) {
        clearInterval(timer);
        return;
      }
      if (
        document.visibilityState === "visible" &&
        !document.querySelector(
          "dialog[open]:not(.modal-pane):not(:has([data-processing-live])), .editable.is-editing",
        ) &&
        current.current.state === "idle"
      )
        void current.current.revalidate();
    }, 2000);
    return () => clearInterval(timer);
  }, [active]);
}
