/**
 * How much the owner uses a library item, as an ordering signal for search.
 * Owner, 2026-10-25: "keep forever, but time decay on relevance unless
 * actively used"; highlights and notes mark an item worth more. Nothing here
 * hides or deletes an item: use only reorders hits whose relevance is close.
 * ADR-0015, amendment of 2026-11-01 (use).
 */

export type LibraryConcept = "source" | "asset";
export type UseKind = "opened" | "fetched";

/** Repeats inside this window are one event: a reload is not a second read. */
export const USE_COLLAPSE_SECONDS = 30 * 60;
/** A use counts half as much after this long, and keeps decaying. */
export const USE_HALF_LIFE_SECONDS = 90 * 24 * 60 * 60;
/** Hits whose relevance is this close are ordered by use (owner, 2026-11-01). */
export const NEAR_TIE = 0.05;

/**
 * Records one use. Never fails the caller: a refused write leaves the page
 * or the tool answer untouched, as the call log does (ADR-0006).
 */
export async function recordUse(
  db: D1Database,
  userId: string,
  concept: LibraryConcept,
  conceptId: string,
  kind: UseKind,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO library_use_events (event_id, user_id, concept, concept_id, kind, at)
         SELECT ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM library_use_events
            WHERE user_id = ?2 AND concept = ?3 AND concept_id = ?4 AND kind = ?5 AND at > ?6 - ?7)`,
      )
      .bind(
        `use_${crypto.randomUUID()}`,
        userId,
        concept,
        conceptId,
        kind,
        now,
        USE_COLLAPSE_SECONDS,
      )
      .run();
  } catch (error) {
    console.error("library use not recorded", error);
  }
}

/** Sets one to three stars, or clears the rating with null. */
export async function setRating(
  db: D1Database,
  userId: string,
  concept: LibraryConcept,
  conceptId: string,
  stars: 1 | 2 | 3 | null,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  if (stars === null) {
    await db
      .prepare(
        "DELETE FROM library_ratings WHERE user_id = ? AND concept = ? AND concept_id = ?",
      )
      .bind(userId, concept, conceptId)
      .run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO library_ratings (user_id, concept, concept_id, stars, rated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, concept, concept_id) DO UPDATE SET
         stars = excluded.stars, rated_at = excluded.rated_at`,
    )
    .bind(userId, concept, conceptId, stars, now)
    .run();
}

export async function readRating(
  db: D1Database,
  userId: string,
  concept: LibraryConcept,
  conceptId: string,
): Promise<1 | 2 | 3 | null> {
  const row = await db
    .prepare(
      "SELECT stars FROM library_ratings WHERE user_id = ? AND concept = ? AND concept_id = ?",
    )
    .bind(userId, concept, conceptId)
    .first<{ stars: 1 | 2 | 3 }>();
  return row?.stars ?? null;
}

/** The ratings of the items on one list page, in one query; unrated are absent. */
export async function readRatings(
  db: D1Database,
  userId: string,
  concept: LibraryConcept,
  conceptIds: string[],
): Promise<Record<string, 1 | 2 | 3>> {
  if (!conceptIds.length) return {};
  const { results } = await db
    .prepare(
      `SELECT concept_id AS conceptId, stars FROM library_ratings
        WHERE user_id = ? AND concept = ?
          AND concept_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(userId, concept, JSON.stringify(conceptIds))
    .all<{ conceptId: string; stars: 1 | 2 | 3 }>();
  return Object.fromEntries(results.map((row) => [row.conceptId, row.stars]));
}

/** Statements that forget an item's use and rating, for an explicit delete. */
export function forgetUseStatements(
  db: D1Database,
  userId: string,
  concept: LibraryConcept,
  conceptId: string,
): D1PreparedStatement[] {
  return ["library_use_events", "library_ratings"].map((table) =>
    db
      .prepare(
        `DELETE FROM ${table} WHERE user_id = ? AND concept = ? AND concept_id = ?`,
      )
      .bind(userId, concept, conceptId),
  );
}

export type UseSignals = {
  stars: number | null;
  /** Highlights the owner saved from this page: references sharing its URL. */
  highlights: number;
  noted: boolean;
  /** Each event's age in seconds, newest first. */
  opened: number[];
  fetched: number[];
};

const EMPTY: UseSignals = {
  stars: null,
  highlights: 0,
  noted: false,
  opened: [],
  fetched: [],
};

/** One query per concept for the items on a result page, however many. */
export async function useSignals(
  db: D1Database,
  userId: string,
  items: { concept: LibraryConcept; conceptId: string }[],
  now = Math.floor(Date.now() / 1000),
): Promise<Map<string, UseSignals>> {
  const signals = new Map<string, UseSignals>();
  const ids = (concept: LibraryConcept) => [
    ...new Set(
      items
        .filter((item) => item.concept === concept)
        .map((item) => item.conceptId),
    ),
  ];
  const entry = (concept: string, conceptId: string) => {
    const key = `${concept}:${conceptId}`;
    let found = signals.get(key);
    if (!found) {
      found = { ...EMPTY, opened: [], fetched: [] };
      signals.set(key, found);
    }
    return found;
  };
  const all = [...ids("source"), ...ids("asset")];
  if (!all.length) return signals;
  const [events, ratings, sources] = await Promise.all([
    db
      .prepare(
        `SELECT concept, concept_id AS conceptId, kind, at FROM library_use_events
          WHERE user_id = ? AND concept_id IN (SELECT value FROM json_each(?))
          ORDER BY at DESC`,
      )
      .bind(userId, JSON.stringify(all))
      .all<{ concept: string; conceptId: string; kind: UseKind; at: number }>(),
    db
      .prepare(
        `SELECT concept, concept_id AS conceptId, stars FROM library_ratings
          WHERE user_id = ? AND concept_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(userId, JSON.stringify(all))
      .all<{ concept: string; conceptId: string; stars: number }>(),
    ids("source").length
      ? db
          .prepare(
            `SELECT s.source_id AS sourceId, s.notes != '' AS noted,
                    (SELECT COUNT(*) FROM sources h WHERE h.user_id = s.user_id
                       AND h.kind = 'reference' AND h.archived_at IS NULL
                       AND s.url IS NOT NULL AND h.url = s.url
                       AND h.source_id != s.source_id) AS highlights
               FROM sources s
              WHERE s.user_id = ? AND s.source_id IN (SELECT value FROM json_each(?))`,
          )
          .bind(userId, JSON.stringify(ids("source")))
          .all<{ sourceId: string; noted: number; highlights: number }>()
      : Promise.resolve({ results: [] }),
  ]);
  for (const row of events.results) {
    const found = entry(row.concept, row.conceptId);
    found[row.kind].push(Math.max(0, now - row.at));
  }
  for (const row of ratings.results)
    entry(row.concept, row.conceptId).stars = row.stars;
  for (const row of sources.results) {
    const found = entry("source", row.sourceId);
    found.noted = Boolean(row.noted);
    found.highlights = row.highlights;
  }
  return signals;
}

const decay = (age: number) => 2 ** (-age / USE_HALF_LIFE_SECONDS);

/**
 * Lasting marks plus recent use. A highlight or a rating says the item was
 * worth something whenever it happened; opening and fetching say it matters
 * now, so they fade with a 90-day half-life.
 */
export function useScore(signals: UseSignals | undefined): number {
  if (!signals) return 0;
  return (
    (signals.stars ?? 0) +
    (signals.highlights > 0 ? 2 : 0) +
    (signals.noted ? 1 : 0) +
    signals.opened.reduce((sum, age) => sum + decay(age), 0) +
    signals.fetched.reduce((sum, age) => sum + decay(age), 0)
  );
}

const times = (n: number) => (n === 1 ? "once" : `${n} times`);

/** Why use moved an item, in the owner's words; empty when it did not count. */
export function useReasons(signals: UseSignals | undefined): string[] {
  if (!signals) return [];
  const recent = (ages: number[]) =>
    ages.filter((age) => age < USE_HALF_LIFE_SECONDS).length;
  return [
    signals.stars ? `you rated this ${signals.stars} of 3 stars` : null,
    signals.highlights
      ? `you highlighted this${signals.highlights > 1 ? ` ${signals.highlights} times` : ""}`
      : null,
    signals.noted ? "you wrote notes on this" : null,
    recent(signals.opened)
      ? `you opened this ${times(recent(signals.opened))} in the last 90 days`
      : null,
    recent(signals.fetched)
      ? `an agent fetched this ${times(recent(signals.fetched))} in the last 90 days`
      : null,
  ].filter((reason): reason is string => reason !== null);
}

/**
 * Orders near-ties by use. Hits stay in relevance order, except that within
 * a run whose scores are within `tolerance` of the run's best, more-used
 * items come first. No hit moves above one at least `tolerance` more
 * relevant, so a clearly better match is never buried. A tolerance of 0
 * orders exact ties only.
 */
export function orderByUse<T extends { score: number }>(
  hits: readonly T[],
  use: (hit: T) => number,
  tolerance: number,
): T[] {
  const ordered: T[] = [];
  let at = 0;
  while (at < hits.length) {
    const top = hits[at].score;
    let end = at + 1;
    while (
      end < hits.length &&
      (tolerance > 0
        ? Math.abs(top - hits[end].score) < tolerance
        : hits[end].score === top)
    )
      end++;
    const run = hits.slice(at, end);
    ordered.push(
      ...run
        .map((hit, index) => ({ hit, index, weight: use(hit) }))
        .sort((a, b) => b.weight - a.weight || a.index - b.index)
        .map(({ hit }) => hit),
    );
    at = end;
  }
  return ordered;
}
