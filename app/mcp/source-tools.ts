import type { McpServer } from "@modelcontextprotocol/server";
import { assetIdOf, assetRef } from "~/concepts/assets";
import { ListCursorError } from "~/concepts/list-cursor";
import type { SourceArticleSummary } from "~/concepts/source-articles";
import type { ImageCapture } from "~/concepts/source-images";
import {
  publishedSeconds,
  SOURCE_COVERAGE,
  type Source,
  SourceRefused,
  sourceIdOf,
  sourceRef,
} from "~/concepts/sources";
import {
  listSourcesInput,
  listSourcesOutput,
  saveSourceInput,
  saveSourceOutput,
} from "~/mcp/contracts";
import { textResult, toolError, withoutEmpty } from "~/mcp/results";
import type { TenantStore } from "~/store/tenant.server";

const VOCABULARY_LIMIT = 50;

/**
 * `save_source` and `list_sources`, ADR-0015. Finding a source by what it
 * says goes through search; reading one whole goes through fetch.
 */
export function registerSourceTools(server: McpServer, store: TenantStore) {
  server.registerTool(
    "list_sources",
    {
      title: "Page through Valise sources",
      description:
        "Enumerate saved sources (bookmarks, documents, images, references), newest saved first, by project, kind, tags (all must match), archived (default false), or saved_since (inclusive) and saved_before (exclusive), Unix seconds. Returns compact rows with url and authors, never notes or page text; fetch an id for the whole source. Follow next_cursor with the same filters until null for a complete listing. To find sources about a topic or by an author, use search instead.",
      inputSchema: listSourcesInput,
      outputSchema: listSourcesOutput,
    },
    async (input) => {
      try {
        const page = await store.sources.query(input);
        return textResult({ ...page, sources: page.sources.map(withoutEmpty) });
      } catch (error) {
        if (error instanceof ListCursorError) return toolError(error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    "save_source",
    {
      title: "Save a Valise source",
      description:
        "Keep a bookmark, a document, an image, or a reference as a durable knowledge source that any client can find with search type source: a URL, your notes on it, and uploaded files by asset id. Valise fetches a page at most once, only without a saved article and only where robots.txt allows, so write what matters in notes. To change a source, pass its id and the revision you last read; a stale revision is refused, never overwritten. Saving a bookmark again at the same URL without an id adds a revision to the one already saved, or changes nothing if nothing differs; images already linked are not kept twice. With check: true and a url it saves nothing and lists your sources already saved at that URL, with any archived page, and your most used projects and tags. Save when the person asks, or on your own only when the conversation has discussed a page at length and search shows it is not saved yet. A claim or lesson is save_memory instead.",
      inputSchema: saveSourceInput,
      outputSchema: saveSourceOutput,
    },
    async (input) => {
      if (input.check && input.url) {
        const [saved, vocabulary] = await Promise.all([
          store.sources.savedAt(input.url),
          store.vocabulary(),
        ]);
        return textResult({
          saved: saved.map((source) => ({
            id: sourceRef(source.sourceId),
            kind: source.kind,
            title: source.title,
            revision: source.revision,
            updated_at: source.updatedAt,
            notes: source.notes,
            archive_asset_id:
              source.archiveAssetId && assetRef(source.archiveAssetId),
          })),
          vocabulary: {
            projects: vocabulary.projects.slice(0, VOCABULARY_LIMIT),
            tags: vocabulary.tags.slice(0, VOCABULARY_LIMIT),
          },
        });
      }
      const sourceId =
        input.id === undefined ? undefined : (sourceIdOf(input.id) ?? "");
      const assetIds = input.asset_ids?.map((id) => assetIdOf(id) ?? id);
      let images: ImageCapture[] = [];
      try {
        if (input.images?.length) {
          const head =
            sourceId !== undefined
              ? await store.sources.get(sourceId)
              : input.kind === "bookmark" && input.url
                ? await store.sources.liveBookmarkAt(input.url)
                : null;
          if ((input.kind ?? head?.kind) !== "bookmark")
            return toolError("images are kept for bookmarks only.");
          images = await store.sources.captureImages(
            input.images,
            assetIds
              ? await store.library.assets(assetIds)
              : (head?.assets ?? []),
          );
        }
        const source = await store.sources.save({
          sourceId,
          expectedRevision: input.expected_revision,
          kind: input.kind,
          title: input.title,
          url: input.url,
          notes: input.notes,
          project: input.project,
          tags: input.tags,
          authors: input.authors,
          article: input.article && {
            detected: input.article.detected,
            markdown: input.article.markdown,
            text: input.article.text,
            truncated: input.article.truncated ?? false,
            wordCount: input.article.word_count,
            pageWordCount: input.article.page_word_count,
            extractor: input.article.extractor,
            published: input.article.published ?? null,
            siteName: input.article.site_name ?? null,
            canonicalUrl: input.article.canonical_url ?? null,
            leadImage: input.article.lead_image ?? null,
            description: input.article.description ?? null,
            language: input.article.language ?? null,
          },
          assetIds,
          addAssetIds: images.flatMap((image) =>
            "assetId" in image ? [image.assetId] : [],
          ),
          published:
            input.published === undefined
              ? undefined
              : publishedSeconds(input.published),
        });
        const result = textResult({
          ...sourceOutput(source),
          ...(input.images?.length
            ? {
                images: images.map((image) => ({
                  url: image.url,
                  id: "assetId" in image ? assetRef(image.assetId) : null,
                  refused: "refused" in image ? image.refused : null,
                })),
              }
            : {}),
        });
        return {
          ...result,
          content: [
            ...result.content,
            { type: "text" as const, text: SOURCE_COVERAGE },
          ],
        };
      } catch (error) {
        // Images fetched for a save that did not happen are not kept.
        for (const image of images)
          if ("created" in image && image.created)
            await store.library.deleteAsset(image.assetId);
        if (error instanceof SourceRefused) return toolError(error.message);
        throw error;
      }
    },
  );
}

export function sourceOutput(source: Source) {
  return {
    id: sourceRef(source.sourceId),
    revision: source.revision,
    kind: source.kind,
    title: source.title,
    url: source.url,
    notes: source.notes,
    project: source.project,
    tags: source.tags,
    authors: source.authors,
    assets: source.assets.map((asset) => ({
      id: assetRef(asset.assetId),
      title: asset.title,
      file_name: asset.fileName,
      available: asset.available,
    })),
    article: source.article && articleOutput(source.article),
    published_at: source.published,
    created_at: source.createdAt,
    updated_at: source.updatedAt,
    content_indexed: false as const,
  };
}

function articleOutput(article: SourceArticleSummary) {
  return {
    detected: article.detected,
    word_count: article.wordCount,
    page_word_count: article.pageWordCount,
    truncated: article.truncated,
    extractor: article.extractor,
    published: article.published,
    site_name: article.siteName,
    canonical_url: article.canonicalUrl,
    lead_image: article.leadImage,
    description: article.description,
    language: article.language,
    revision: article.revision,
  };
}

/**
 * `fetch` for a source: the head's notes in full, however long, then the
 * extracted article's Markdown when one was detected; linked assets as ids
 * and metadata, never bytes; and every revision. Archived
 * sources still fetch by id, like archived assets.
 */
export async function fetchSource(
  sources: Pick<TenantStore["sources"], "get" | "revisions">,
  id: string,
) {
  const sourceId = sourceIdOf(id);
  if (sourceId === null) return null;
  const source = await sources.get(sourceId);
  if (source === null) return null;
  const revisions = await sources.revisions(sourceId);
  const { id: ref, title, notes, ...metadata } = sourceOutput(source);
  const article =
    source.article && "markdown" in source.article && source.article.detected
      ? source.article.markdown
      : "";
  return {
    id: ref,
    title,
    text: article
      ? [notes, `## Article text, extracted at capture\n\n${article}`]
          .filter(Boolean)
          .join("\n\n")
      : notes,
    metadata: {
      ...metadata,
      assets: source.assets.map((asset) => ({
        id: assetRef(asset.assetId),
        title: asset.title,
        file_name: asset.fileName,
        content_type: asset.contentType,
        size: asset.size,
        available: asset.available,
      })),
      archived: source.archivedAt !== null,
      source_agent: source.sourceAgent,
      source_client: source.sourceClient,
      source_session: source.sourceSession,
      revisions: revisions.map((revision) => ({
        revision: revision.revision,
        title: revision.title,
        url: revision.url,
        assets: revision.assetIds.map(assetRef),
        source_agent: revision.sourceAgent,
        created_at: revision.createdAt,
      })),
      coverage: SOURCE_COVERAGE,
      bytes:
        "Linked files are assets: call get_asset_download with an asset id.",
    },
  };
}
