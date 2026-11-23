/**
 * The readable article behind a source: what a client extracted from the
 * live page at capture, with the page's own metadata. ADR-0015, amendment of
 * 2026-10-29. Append-only per revision; a source reads its newest row. The
 * linked HTML asset stays the archive original, and Valise still never
 * fetches the URL itself.
 */

/** What one save may carry; the extension caps itself below this. */
export const MAX_ARTICLE_CHARS = 200_000;
/** Below either bound the client reports that no article was found. */
export const MIN_ARTICLE_WORDS = 150;

export type ArticleInput = {
  detected: boolean;
  markdown: string;
  text: string;
  truncated: boolean;
  wordCount: number;
  pageWordCount: number;
  extractor: string;
  published: string | null;
  siteName: string | null;
  canonicalUrl: string | null;
  leadImage: string | null;
  description: string | null;
  language: string | null;
};

export type SourceArticle = ArticleInput & {
  revision: number;
  createdAt: number;
};

/** Metadata only, for list cards that never need the text. */
export type SourceArticleSummary = Omit<SourceArticle, "markdown" | "text">;

/** The newest article's text for a source row aliased `alias`, or NULL. */
export const ARTICLE_TEXT_SQL = (alias: string) =>
  `(SELECT sa.text FROM source_articles sa
     WHERE sa.source_id = ${alias}.source_id AND sa.user_id = ${alias}.user_id
       AND sa.detected = 1
     ORDER BY sa.revision DESC LIMIT 1)`;

export function articleInsert(
  db: D1Database,
  sourceId: string,
  revision: number,
  userId: string,
  article: ArticleInput,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO source_articles (
         source_id, revision, user_id, detected, markdown, text, truncated,
         word_count, page_word_count, extractor, published, site_name,
         canonical_url, lead_image, description, language, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      sourceId,
      revision,
      userId,
      article.detected ? 1 : 0,
      article.detected ? article.markdown : "",
      article.detected ? article.text : "",
      article.truncated ? 1 : 0,
      article.wordCount,
      article.pageWordCount,
      article.extractor,
      article.published,
      article.siteName,
      article.canonicalUrl,
      article.leadImage,
      article.description,
      article.language,
      now,
    );
}

type ArticleRow = Omit<SourceArticle, "detected" | "truncated"> & {
  detected: number;
  truncated: number;
};

const COLUMNS = `revision, detected, truncated, word_count AS wordCount,
  page_word_count AS pageWordCount, extractor, published,
  site_name AS siteName, canonical_url AS canonicalUrl,
  lead_image AS leadImage, description, language, created_at AS createdAt`;

/** The newest article row of an owned source, with its text, or null. */
export async function readSourceArticle(
  db: D1Database,
  userId: string,
  sourceId: string,
): Promise<SourceArticle | null> {
  const row = await db
    .prepare(
      `SELECT ${COLUMNS}, markdown, text FROM source_articles
        WHERE source_id = ? AND user_id = ?
        ORDER BY revision DESC LIMIT 1`,
    )
    .bind(sourceId, userId)
    .first<ArticleRow>();
  return row ? fromRow(row) : null;
}

/**
 * The newest article's metadata as one JSON column of a source row aliased
 * `alias`, so a list read stays one query however many cards it returns.
 */
export const ARTICLE_SUMMARY_SQL = (alias: string) =>
  `(SELECT json_object('revision', revision, 'detected', detected,
      'truncated', truncated, 'wordCount', word_count,
      'pageWordCount', page_word_count, 'extractor', extractor,
      'published', published, 'siteName', site_name,
      'canonicalUrl', canonical_url, 'leadImage', lead_image,
      'description', description, 'language', language,
      'createdAt', created_at)
     FROM source_articles sa
     WHERE sa.source_id = ${alias}.source_id AND sa.user_id = ${alias}.user_id
     ORDER BY sa.revision DESC LIMIT 1)`;

export function parseArticleSummary(
  json: string | null,
): SourceArticleSummary | null {
  if (!json) return null;
  const {
    markdown: _m,
    text: _t,
    ...summary
  } = fromRow({
    ...(JSON.parse(json) as Omit<ArticleRow, "markdown" | "text">),
    markdown: "",
    text: "",
  });
  return summary;
}

function fromRow(row: ArticleRow): SourceArticle {
  return { ...row, detected: !!row.detected, truncated: !!row.truncated };
}

/** "Saved article (1,240 words, by A and B)" or the not-detected line. */
export function describeArticle(
  article: Pick<SourceArticleSummary, "detected" | "wordCount">,
  authors: readonly string[],
): string {
  if (!article.detected) return "Article not detected; full page kept";
  const by = authors.length ? `, by ${joinNames(authors)}` : "";
  return `Article, ${article.wordCount.toLocaleString("en-US")} words${by}`;
}

export function joinNames(names: readonly string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
