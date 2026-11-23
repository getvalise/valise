import { Link } from "react-router";
import { Markdown } from "~/components/markdown";
import { ApplicationShell, Empty } from "~/components/ui";
import { assetRef } from "~/concepts/assets";
import { authorSlug } from "~/concepts/authors";
import { FETCH_EXTRACTOR } from "~/concepts/source-fetch";
import { sourceIdOf, sourceRef } from "~/concepts/sources";
import {
  requireConsoleActor,
  requireSameOriginAction,
} from "~/console/context.server";
import { afterSave } from "~/console/forms.server";
import {
  pageHost,
  publishedDate,
  withoutRemoteImages,
} from "~/features/library/presentation";
import { postedStars, RatingControl } from "~/features/library/rating";
import {
  ReaderArticle,
  ReaderBody,
  ReaderFooter,
  ReaderHeader,
  ReaderLine,
} from "~/features/library/reader";
import type { Route } from "./+types/library-read";

/** One owned source and its newest article; nothing else is read. */
export async function loader({ context, request, params }: Route.LoaderArgs) {
  const actor = await requireConsoleActor(context, request);
  const sourceId = sourceIdOf(params.sourceId);
  const source = sourceId ? await actor.store.sources.get(sourceId) : null;
  if (!source)
    throw new Response("No saved item has this id.", { status: 404 });
  // Reading an item is the use search orders by; it never fails the page.
  await actor.store.library.recordUse("source", source.sourceId, "opened");
  const stars = await actor.store.library.rating("source", source.sourceId);
  const article =
    source.article && "markdown" in source.article ? source.article : null;
  const archive = source.assets.find(
    (asset) => asset.available && asset.contentType === "text/html",
  );
  return {
    stars,
    sourceId: source.sourceId,
    title: source.title,
    url: source.url,
    authors: source.authors,
    archivedAt: source.archivedAt,
    article: article
      ? {
          detected: article.detected,
          markdown: article.detected
            ? withoutRemoteImages(article.markdown)
            : "",
          truncated: article.truncated,
          wordCount: article.wordCount,
          pageWordCount: article.pageWordCount,
          extractor: article.extractor,
          published: article.published,
          siteName: article.siteName,
          language: article.language,
          createdAt: article.createdAt,
        }
      : null,
    archive: archive
      ? { assetId: archive.assetId, title: archive.title }
      : null,
  };
}

/** Sets or clears the item's rating; the only write the reader makes. */
export async function action({ context, request, params }: Route.ActionArgs) {
  requireSameOriginAction(request);
  const actor = await requireConsoleActor(context, request);
  const sourceId = sourceIdOf(params.sourceId);
  const source = sourceId ? await actor.store.sources.get(sourceId) : null;
  if (!source)
    throw new Response("No saved item has this id.", { status: 404 });
  const form = await request.formData();
  const stars = postedStars(form);
  if (form.get("intent") !== "rate" || stars === null)
    throw new Response("A rating is 1 to 3 stars, or 0 to clear.", {
      status: 400,
    });
  await actor.store.library.setRating("source", source.sourceId, stars || null);
  return afterSave(form, new URL(request.url).pathname);
}

export default function ReaderPage({ loaderData }: Route.ComponentProps) {
  const { sourceId, title, url, authors, article, archive, archivedAt, stars } =
    loaderData;
  const back = `/library?${new URLSearchParams({ q: title.slice(0, 200), details: sourceRef(sourceId) })}`;
  const published = publishedDate(article?.published ?? null);
  const facts = [
    published,
    article?.detected
      ? `${article.wordCount.toLocaleString("en-US")} words`
      : null,
  ].filter(Boolean);
  return (
    <ApplicationShell
      title="Library"
      lede={<Link to={back}>Back to this item in Library</Link>}
      measure="reading"
    >
      <ReaderArticle lang={article?.language ?? undefined}>
        <ReaderHeader
          eyebrow={article?.siteName ?? pageHost(url)}
          title={title}
        >
          {authors.length || facts.length ? (
            <ReaderLine>
              {authors.length ? "By " : null}
              {authors.map((name, index) => (
                <span key={name}>
                  {index === 0
                    ? ""
                    : index === authors.length - 1
                      ? " and "
                      : ", "}
                  <Link to={`/library/authors/${authorSlug(name)}`}>
                    {name}
                  </Link>
                </span>
              ))}
              {authors.length && facts.length ? " · " : null}
              {facts.join(" · ")}
            </ReaderLine>
          ) : null}
          <ReaderLine>
            {url ? (
              <a href={url} rel="noreferrer noopener" target="_blank">
                Original page
              </a>
            ) : null}
            {url && archive ? " · " : null}
            {archive ? (
              <Link
                to={`/library?${new URLSearchParams({ q: archive.title.slice(0, 200), view: "documents", details: assetRef(archive.assetId) })}`}
              >
                Archived copy
              </Link>
            ) : null}
            {archive ? " · " : null}
            {archive ? (
              <a href={`/library/archive/${archive.assetId}`}>
                Open archived page
              </a>
            ) : null}
          </ReaderLine>
          <RatingControl stars={stars} />
        </ReaderHeader>
        {article?.detected ? (
          <>
            <ReaderBody label="Article text">
              <Markdown>{article.markdown}</Markdown>
            </ReaderBody>
            <ReaderFooter>
              {article.extractor === FETCH_EXTRACTOR
                ? "Fetched from the page by Valise"
                : `Extracted from the page at capture by ${article.extractor}`}{" "}
              on{" "}
              {new Date(article.createdAt * 1000).toLocaleDateString("en-GB", {
                day: "numeric",
                month: "short",
                year: "numeric",
                timeZone: "UTC",
              })}
              .{" "}
              {article.truncated
                ? "The text was cut at 200,000 characters; the rest is in the original. "
                : ""}
              Images are links, so reading loads nothing from the original site.{" "}
              {archive
                ? "The archived copy keeps the whole page as it was."
                : "No page archive was kept; this text is the saved copy."}
            </ReaderFooter>
          </>
        ) : (
          <Empty>
            {article
              ? `No article was found on this page when it was saved (${article.wordCount.toLocaleString("en-US")} of ${article.pageWordCount.toLocaleString("en-US")} words looked like prose), so there is nothing to read here.`
              : "No article text was saved for this item."}{" "}
            {archive
              ? "The archived copy keeps the whole page."
              : url
                ? "Open the original page to read it."
                : ""}
          </Empty>
        )}
      </ReaderArticle>
    </ApplicationShell>
  );
}
