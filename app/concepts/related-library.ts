import type { SearchFilters, SearchHit } from "~/search/query";
import type { RerankOutcome } from "~/search/rerank";

/**
 * At most one library item related to what the agent is working on, offered
 * beside a to-do or the brief so it "maybe can influence the answer a bit"
 * (owner, 2026-10-25). The owner found forced mentions contrived, so the bar
 * is high and absence is the normal answer: nothing is offered unless the
 * reranker scored it at least RELATED_BAR, and nothing the owner used in the
 * last RECENT_USE_DAYS, since that one is already in mind. Lexical order has
 * no calibrated score, so without a reranker nothing is offered.
 * ADR-0015, amendment of 2026-11-02 (related item).
 */

/**
 * The reranker's probability that the item bears on the to-do. 0.5 let an
 * unrelated code passage through in production (2026-11-02: Jev scored a
 * "Cookbook: RAG Agent" snippet 0.65 for a Library journey to-do, while the
 * relevant to-dos scored 0.70 to 0.94). 0.8 is from that one observation;
 * the owner's surfacing eval is what tunes it.
 */
export const RELATED_BAR = 0.8;
export const RECENT_USE_DAYS = 30;
const QUOTE_CHARS = 200;
const CANDIDATES = 5;

export type RelatedLibraryItem = {
  id: string;
  title: string;
  /** One line: what it relates to and when it was last used. */
  reason: string;
  /** A verbatim span of the item, cut to a line. */
  quote: string;
};

/** A tenant's ranked search: reranked when configured, owned hits only. */
export type RankedSearch = (
  filters: Omit<SearchFilters, "userId">,
) => Promise<{ hits: SearchHit[]; rerank: RerankOutcome | null }>;

export async function relatedLibraryItem(
  db: D1Database,
  userId: string,
  ranked: RankedSearch,
  about: string,
  now = Math.floor(Date.now() / 1000),
): Promise<RelatedLibraryItem | null> {
  const query = about.replace(/\s+/g, " ").trim().slice(0, 300);
  if (!query) return null;
  try {
    const { hits, rerank } = await ranked({
      query,
      concepts: ["source", "asset"],
      limit: CANDIDATES,
    });
    if (!rerank?.reranked) return null;
    const strong = hits.filter(
      (hit) =>
        (hit.concept === "source" || hit.concept === "asset") &&
        hit.score >= RELATED_BAR,
    );
    if (!strong.length) return null;
    const used = await lastUse(
      db,
      userId,
      strong.map((hit) => hit.conceptId),
    );
    const since = now - RECENT_USE_DAYS * 86_400;
    const titles = await itemTitles(db, userId, strong);
    // A passage hit is titled by its locator, often empty: name the item
    // itself, and offer nothing that cannot be named.
    const pick = strong.find(
      (hit) =>
        (used.get(hit.conceptId) ?? 0) < since &&
        (titles.get(hit.conceptId) ?? "").trim() !== "",
    );
    if (!pick) return null;
    const last = used.get(pick.conceptId);
    return {
      id: `${pick.concept}:${pick.conceptId}`,
      title: line(titles.get(pick.conceptId) ?? "", 160),
      reason: `Related to "${line(query, 80)}"; ${
        last
          ? `last opened or fetched ${Math.floor((now - last) / 86_400)} days ago`
          : "not opened or fetched since it was saved"
      }.`,
      quote: line(pick.snippet.replace(/[[\]]/g, ""), QUOTE_CHARS),
    };
  } catch (error) {
    // Orientation and fetch never fail for want of a suggestion.
    console.error("related library item skipped", error);
    return null;
  }
}

async function itemTitles(
  db: D1Database,
  userId: string,
  hits: { concept: string; conceptId: string }[],
): Promise<Map<string, string>> {
  const ids = (concept: string) =>
    JSON.stringify(
      hits.filter((hit) => hit.concept === concept).map((hit) => hit.conceptId),
    );
  const { results } = await db
    .prepare(
      `SELECT source_id AS id, title FROM sources
        WHERE user_id = ?1 AND source_id IN (SELECT value FROM json_each(?2))
       UNION ALL
       SELECT asset_id AS id, title FROM assets
        WHERE user_id = ?1 AND purpose IS NULL AND asset_id IN (SELECT value FROM json_each(?3))`,
    )
    .bind(userId, ids("source"), ids("asset"))
    .all<{ id: string; title: string }>();
  return new Map(results.map((row) => [row.id, row.title]));
}

async function lastUse(
  db: D1Database,
  userId: string,
  conceptIds: string[],
): Promise<Map<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT concept_id AS conceptId, MAX(at) AS at FROM library_use_events
        WHERE user_id = ? AND concept_id IN (SELECT value FROM json_each(?))
        GROUP BY concept_id`,
    )
    .bind(userId, JSON.stringify(conceptIds))
    .all<{ conceptId: string; at: number }>();
  return new Map(results.map((row) => [row.conceptId, row.at]));
}

function line(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}
