import { visibleAssetIds } from "~/concepts/assets";
import { visibleSourceIds } from "~/concepts/sources";
import type { SearchConcept } from "~/db/schema";
import { type SearchFilters, type SearchHit, search } from "~/search/query";
import { rerankedSearch, rerankMode } from "~/search/rerank";
import type { VectorBindings } from "~/search/vectors";

export type SearchData = VectorBindings & {
  DB: D1Database;
  AI?: Pick<Ai, "run">;
  TYPESAFE_API_KEY?: string;
  /** Which reranker runs; unset in production. `rerankMode`. */
  VALISE_RERANK?: string;
};

/**
 * The transport's search, bound to one tenant: the configured rerank stage
 * over lexical and vector candidates, then owned hydration, because the
 * projection has no owner or expiry column for files and bookmarks.
 */
export async function rankedSearch(
  data: SearchData,
  userId: string,
  filters: Omit<SearchFilters, "userId">,
) {
  const bound = { ...filters, userId };
  const mode = rerankMode(data);
  const ranked =
    mode && (mode === "jev" || data.AI)
      ? await rerankedSearch(data, mode, bound)
      : { hits: await search(data, bound), rerank: null };
  return {
    hits: await ownedHits(data.DB, userId, ranked.hits),
    rerank: ranked.rerank,
  };
}

/**
 * Drops asset and source hits this tenant may not see now. Each such hit is
 * checked against its row; the other concepts pass through unchanged.
 */
async function ownedHits(
  db: D1Database,
  userId: string,
  hits: SearchHit[],
): Promise<SearchHit[]> {
  const idsOf = (concept: SearchConcept) =>
    hits.filter((hit) => hit.concept === concept).map((hit) => hit.conceptId);
  const assetIds = idsOf("asset");
  const sourceIds = idsOf("source");
  if (assetIds.length === 0 && sourceIds.length === 0) return hits;
  const [assets, sources] = await Promise.all([
    visibleAssetIds(db, userId, assetIds),
    visibleSourceIds(db, userId, sourceIds),
  ]);
  return hits.filter((hit) =>
    hit.concept === "asset"
      ? assets.has(hit.conceptId)
      : hit.concept === "source"
        ? sources.has(hit.conceptId)
        : true,
  );
}
