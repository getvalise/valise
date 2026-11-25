import type { AssetEnv } from "~/concepts/assets";
import { allowanceOf } from "~/concepts/attachment-limits";
import type { Provenance } from "~/concepts/memories";
import { readSourceArticle } from "~/concepts/source-articles";
import {
  dismissSourceTag,
  enrichmentStatus,
  readSourceEnrichment,
} from "~/concepts/source-enrichment";
import { captureImages } from "~/concepts/source-images";
import { type Capture, captureBookmark } from "~/concepts/source-paste";
import { querySources, type SourceQuery } from "~/concepts/source-query";
import {
  deleteSource,
  listSourceRevisions,
  listSourcesPage,
  liveBookmarkAt,
  readSource,
  type SaveSource,
  type SourcePageOptions,
  saveSource,
  setSourceArchived,
  sourcesSavedAt,
} from "~/concepts/sources";

/**
 * Sources (bookmarks, documents, references) bound to one tenant. Ids are
 * bare (`src_…`). Images a bookmark links are fetched and kept within this
 * tenant's allowance.
 */
export function sourceStore(
  data: AssetEnv & {
    AI?: Pick<Ai, "run">;
    VALISE_SOURCE_DAILY_USD?: string;
    VALISE_VECTOR_NAMESPACE?: string;
    VALISE_MEMBER_ALLOWANCE?: string;
    VALISE_ADMIN_EMAILS?: string;
  },
  userId: string,
  provenance: Provenance,
) {
  const db = data.DB;
  return Object.freeze({
    get: (sourceId: string) => readSource(db, userId, sourceId),
    page: (archived: boolean, options?: SourcePageOptions) =>
      listSourcesPage(db, userId, archived, options),
    /** `list_sources`: compact rows a keyset page at a time. */
    query: (input: SourceQuery) => querySources(db, userId, input),
    article: (sourceId: string) => readSourceArticle(db, userId, sourceId),
    enrichment: (sourceId: string) =>
      readSourceEnrichment(db, userId, sourceId),
    /** Today's enrichment spend against this tenant's daily allowance. */
    enrichmentStatus: () => enrichmentStatus(data, userId),
    revisions: (sourceId: string, recentLimit?: number) =>
      listSourceRevisions(db, userId, sourceId, recentLimit),
    savedAt: (url: string) => sourcesSavedAt(db, userId, url),
    liveBookmarkAt: (url: string) => liveBookmarkAt(db, userId, url),
    save: (input: SaveSource) => saveSource(data, input, provenance),
    setArchived: (sourceId: string, archived: boolean) =>
      setSourceArchived(db, userId, sourceId, archived),
    delete: (sourceId: string) => deleteSource(db, userId, sourceId),
    /** Turns down one suggested tag from one enrichment. */
    dismissTag: (sourceId: string, enrichmentId: string, tag: string) =>
      dismissSourceTag(db, userId, sourceId, enrichmentId, tag),
    /** A shared link and any pasted article text, saved as a bookmark. */
    captureBookmark: (capture: Capture) =>
      captureBookmark(data, capture, provenance),
    /** Fetches and keeps a bookmark's images, within the tenant's allowance. */
    captureImages: async (
      urls: readonly string[],
      linked: { assetId: string; size: number | null }[],
    ) =>
      captureImages(
        data,
        provenance,
        urls,
        await allowanceOf(db, userId, data),
        linked,
      ),
  });
}
