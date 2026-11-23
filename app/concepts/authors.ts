/**
 * Authors as a lens on the Library. A source stores its byline as written
 * (`authors_json`); this module groups those spellings into people at read
 * time, so "Luke W", "luke wroblewski" and "Luke Wroblewski" are one author
 * without rewriting anyone's saved byline. ADR-0015, amendment of 2026-10-29.
 */

export type AuthorName = { name: string; sources: number };

export type Author = {
  /** URL-safe key of the display name, stable while the spellings are. */
  slug: string;
  /** The longest spelling, which is the most complete. */
  name: string;
  /** Every spelling grouped under this author. */
  spellings: string[];
  sources: number;
};

/** Lowercase, accents and punctuation removed, single spaces. */
export function authorKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function authorSlug(name: string): string {
  return authorKey(name).replaceAll(" ", "-");
}

/**
 * Whether `short` abbreviates `full`: same first name or its initial, and a
 * last name that is the full last name or its initial. "Luke W" and
 * "L Wroblewski" abbreviate "Luke Wroblewski"; "Luke" alone does not.
 */
function abbreviates(short: string[], full: string[]): boolean {
  if (short.length < 2 || full.length < 2) return false;
  const [first, last] = [short[0], short.at(-1) as string];
  const [fullFirst, fullLast] = [full[0], full.at(-1) as string];
  const part = (a: string, b: string) =>
    a === b || (a.length === 1 && b.startsWith(a));
  return (
    part(first, fullFirst) &&
    part(last, fullLast) &&
    (first.length === 1 || last.length === 1)
  );
}

/**
 * Groups spellings into authors. Exact keys merge first; then a spelling
 * that abbreviates exactly one longer author joins it. An abbreviation that
 * fits two people ("J Smith" for John and Jane) stays on its own.
 */
export function groupAuthors(names: AuthorName[]): Author[] {
  const byKey = new Map<string, Author>();
  for (const { name, sources } of names) {
    const key = authorKey(name);
    if (!key) continue;
    const author = byKey.get(key);
    if (author) {
      author.spellings.push(name);
      author.sources += sources;
      if (name.length > author.name.length) author.name = name;
    } else byKey.set(key, { slug: "", name, spellings: [name], sources });
  }
  const full = [...byKey.entries()].filter(([key]) =>
    key.split(" ").every((part) => part.length > 1),
  );
  for (const [key, author] of [...byKey.entries()]) {
    const parts = key.split(" ");
    if (parts.every((part) => part.length > 1)) continue;
    const matches = full.filter(([other]) =>
      abbreviates(parts, other.split(" ")),
    );
    if (matches.length !== 1) continue;
    const target = matches[0][1];
    target.spellings.push(...author.spellings);
    target.sources += author.sources;
    byKey.delete(key);
  }
  return [...byKey.values()]
    .map((author) => ({ ...author, slug: authorSlug(author.name) }))
    .sort((a, b) => b.sources - a.sources || a.name.localeCompare(b.name));
}

/** Every spelling the owner's unarchived sources carry, with counts. */
export async function listAuthorNames(
  db: D1Database,
  userId: string,
): Promise<AuthorName[]> {
  const { results } = await db
    .prepare(
      `SELECT trim(a.value) AS name, COUNT(DISTINCT s.source_id) AS sources
         FROM sources s, json_each(s.authors_json) a
        WHERE s.user_id = ? AND s.archived_at IS NULL
          AND a.type = 'text' AND trim(a.value) != ''
        GROUP BY trim(a.value)`,
    )
    .bind(userId)
    .all<AuthorName>();
  return results;
}

export async function listAuthors(
  db: D1Database,
  userId: string,
): Promise<Author[]> {
  return groupAuthors(await listAuthorNames(db, userId));
}

/**
 * The author a typed name means, grouped the way the Library groups bylines,
 * and the owner's unarchived sources that carry any of that author's
 * spellings. "Luke W" resolves to Luke Wroblewski's sources when he is the
 * only author it abbreviates; a name matching no saved byline resolves to
 * no author and no sources.
 */
export async function sourcesByAuthor(
  db: D1Database,
  userId: string,
  name: string,
): Promise<{ author: Author | null; sourceIds: string[] }> {
  const typed = name.trim();
  const author =
    groupAuthors([
      ...(await listAuthorNames(db, userId)),
      { name: typed, sources: 0 },
    ]).find((group) => group.spellings.includes(typed)) ?? null;
  if (!author || author.sources === 0) return { author: null, sourceIds: [] };
  const { results } = await db
    .prepare(
      `SELECT s.source_id AS sourceId
         FROM sources s
        WHERE s.user_id = ? AND s.archived_at IS NULL
          AND EXISTS (SELECT 1 FROM json_each(s.authors_json) a
                       WHERE trim(a.value) IN (SELECT value FROM json_each(?)))`,
    )
    .bind(userId, JSON.stringify(author.spellings))
    .all<{ sourceId: string }>();
  return { author, sourceIds: results.map((row) => row.sourceId) };
}

/**
 * The query without the author's own name, for a search already narrowed to
 * that author. Every query term must match before any term may, so "Luke
 * Wroblewski form labels" would miss the bookmark bylined "Luke W". A query
 * that is nothing but the name is kept as typed.
 */
export function withoutAuthorName(query: string, author: Author): string {
  const parts = new Set(
    author.spellings.flatMap((spelling) => authorKey(spelling).split(" ")),
  );
  const kept = query
    .trim()
    .split(/\s+/)
    .filter((term) => !parts.has(authorKey(term)));
  return kept.length ? kept.join(" ") : query;
}

export type AuthorItem = {
  sourceId: string;
  kind: string;
  title: string;
  url: string | null;
  notes: string;
  tags: string[];
  authors: string[];
  createdAt: number;
  siteName: string | null;
  published: string | null;
  description: string | null;
  wordCount: number | null;
  detected: boolean | null;
};

export type AuthorHighlight = {
  sourceId: string;
  title: string;
  url: string;
  notes: string;
  createdAt: number;
};

export type AuthorView = {
  author: Author;
  items: AuthorItem[];
  /** Selections the owner saved from the author's pages, newest first. */
  highlights: AuthorHighlight[];
  firstSavedAt: number | null;
  lastSavedAt: number | null;
};

/**
 * One author's page: the sources that name any of their spellings, and the
 * highlights the owner saved from those sources' URLs. Highlights are found
 * by URL because the extension saves a selection as its own reference with
 * the page URL; there is no stored link between the two.
 */
export async function readAuthor(
  db: D1Database,
  userId: string,
  slug: string,
): Promise<AuthorView | null> {
  const author = (await listAuthors(db, userId)).find((a) => a.slug === slug);
  if (!author) return null;
  const { results } = await db
    .prepare(
      `SELECT s.source_id AS sourceId, s.kind, s.title, s.url, s.notes,
              s.tags_json AS tagsJson, s.authors_json AS authorsJson,
              s.created_at AS createdAt,
              sa.site_name AS siteName, sa.published, sa.description,
              sa.word_count AS wordCount, sa.detected
         FROM sources s
         LEFT JOIN source_articles sa ON sa.source_id = s.source_id
          AND sa.user_id = s.user_id
          AND sa.revision = (SELECT MAX(revision) FROM source_articles x
                              WHERE x.source_id = s.source_id)
        WHERE s.user_id = ? AND s.archived_at IS NULL
          AND EXISTS (SELECT 1 FROM json_each(s.authors_json) a
                       WHERE trim(a.value) IN (SELECT value FROM json_each(?)))
        ORDER BY s.created_at DESC, s.source_id DESC
        LIMIT 200`,
    )
    .bind(userId, JSON.stringify(author.spellings))
    .all<
      Omit<AuthorItem, "tags" | "authors" | "detected"> & {
        tagsJson: string;
        authorsJson: string;
        detected: number | null;
      }
    >();
  const items = results.map(({ tagsJson, authorsJson, detected, ...row }) => ({
    ...row,
    tags: strings(tagsJson),
    authors: strings(authorsJson),
    detected: detected === null ? null : !!detected,
  }));
  const urls = [
    ...new Set(items.map((item) => item.url).filter((url) => url !== null)),
  ];
  const highlights = urls.length
    ? (
        await db
          .prepare(
            `SELECT source_id AS sourceId, title, url, notes, created_at AS createdAt
               FROM sources
              WHERE user_id = ? AND archived_at IS NULL AND kind = 'reference'
                AND url IN (SELECT value FROM json_each(?))
              ORDER BY created_at DESC, source_id DESC
              LIMIT 100`,
          )
          .bind(userId, JSON.stringify(urls))
          .all<AuthorHighlight>()
      ).results
    : [];
  const highlightIds = new Set(highlights.map((h) => h.sourceId));
  const own = items.filter((item) => !highlightIds.has(item.sourceId));
  const times = [...own, ...highlights].map((row) => row.createdAt);
  return {
    author,
    items: own,
    highlights,
    firstSavedAt: times.length ? Math.min(...times) : null,
    lastSavedAt: times.length ? Math.max(...times) : null,
  };
}

/** The quote out of a highlight's notes, as the extension writes them. */
export function highlightQuote(notes: string): string {
  const match =
    /Selected text:\n([\s\S]*?)(?:\n\nContext before:|\n\nContext after:|$)/.exec(
      notes,
    );
  return (match ? match[1] : notes).trim();
}

function strings(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}
