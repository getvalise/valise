import type { SearchConcept } from "~/db/schema";
import { ALL_CONCEPTS } from "~/search/reindex";

/**
 * The one ranked BM25 query, per ADR-0001. One corpus, so scores compare
 * honestly across concepts. Filters are column predicates on `search_docs`,
 * never extra MATCH queries.
 *
 * `snippet()` and `bm25()` run in the same select over an FTS5 table; a window
 * function over `bm25()` does not, which is what sank arena candidate B.
 */

/** title, body, tags. Titles outweigh bodies; tags sit between them. */
const BM25_WEIGHTS = "4.0, 1.0, 2.0";
const SNIPPET_TOKENS = 20;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export type SearchFilters = {
  query: string;
  /** Whose case to search. Required: a search is never cross-user. ADR-0016. */
  userId: string;
  concepts?: SearchConcept[];
  project?: string;
  tags?: string[];
  /**
   * Only these sources, passages included: the `author` filter, resolved to
   * source ids once so every candidate path applies the same set.
   */
  sourceIds?: string[];
  limit?: number;
  /**
   * `any` skips the every-term pass. For a caller whose query always matches
   * its own document, such as memory review searching with a memory's title,
   * the every-term pass never comes back empty, so the fallback never runs.
   */
  match?: "all-then-any" | "any";
};

export type SearchHit = {
  docKey: string;
  concept: SearchConcept;
  conceptId: string;
  project: string | null;
  title: string;
  snippet: string;
  score: number;
  updatedAt: number;
};

type Row = {
  doc_key: string;
  concept: SearchConcept;
  concept_id: string;
  project: string | null;
  title: string;
  snip: string;
  score: number;
  updated_at: number;
};

function buildSearchStatement(
  db: D1Database,
  filters: SearchFilters,
  join: "AND" | "OR",
): D1PreparedStatement {
  const concepts = filters.concepts?.length ? filters.concepts : ALL_CONCEPTS;
  const binds: unknown[] = [
    literalMatchQuery(filters.query, join),
    filters.userId,
    JSON.stringify(concepts),
  ];
  const where = [
    "search_docs_fts MATCH ?",
    "si.user_id = ?",
    "si.concept IN (SELECT value FROM json_each(?))",
  ];
  if (filters.userId) {
    where.push(`(si.concept != 'asset' OR EXISTS (SELECT 1 FROM assets a
      WHERE a.asset_id = si.concept_id AND a.user_id = ? AND a.state = 'ready'
        AND a.archived_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > unixepoch())))`);
    binds.push(filters.userId);
    where.push(`(si.concept != 'source' OR EXISTS (SELECT 1 FROM sources s
      WHERE s.source_id = si.concept_id AND s.user_id = ? AND s.archived_at IS NULL))`);
    binds.push(filters.userId);
  }

  if (filters.project) {
    where.push("si.project = ?");
    binds.push(filters.project);
  }
  if (filters.sourceIds) {
    where.push(
      "si.concept = 'source' AND si.concept_id IN (SELECT value FROM json_each(?))",
    );
    binds.push(JSON.stringify(filters.sourceIds));
  }
  for (const tag of filters.tags ?? []) {
    // Tags are space-joined in the projection, so pad both sides to match whole
    // tags rather than prefixes. instr, not LIKE: D1 rejects a LIKE pattern
    // over 50 bytes, and a tag may be 100 characters.
    // A passage row carries no tags of its own; it has its asset's or source's.
    where.push(`(instr(' ' || si.tags || ' ', ' ' || ? || ' ') > 0
      OR (si.concept = 'asset' AND si.doc_key != 'asset:' || si.concept_id
        AND EXISTS (SELECT 1 FROM assets a, json_each(a.tags_json) t
          WHERE a.asset_id = si.concept_id AND a.user_id = si.user_id AND t.value = ?))
      OR (si.concept = 'source' AND si.doc_key != 'source:' || si.concept_id
        AND EXISTS (SELECT 1 FROM sources s, json_each(s.tags_json) t
          WHERE s.source_id = si.concept_id AND s.user_id = si.user_id AND t.value = ?)))`);
    binds.push(tag, tag, tag);
  }

  const limit = Math.min(filters.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  binds.push(limit);

  const sql = `
SELECT si.doc_key, si.concept, si.concept_id, si.project, si.title,
       snippet(search_docs_fts, 1, '[', ']', '…', ${SNIPPET_TOKENS}) AS snip,
       bm25(search_docs_fts, ${BM25_WEIGHTS}) AS score,
       si.updated_at
  FROM search_docs_fts
  JOIN search_docs si ON si.id = search_docs_fts.rowid
 WHERE ${where.join("\n   AND ")}
 ORDER BY score
 LIMIT ?`;

  return db.prepare(sql).bind(...binds);
}

/**
 * Every term first, so a precise query stays precise. When no document holds
 * every term, any term, and BM25 ranks: a document matching more of them, or
 * rarer ones, scores higher. That is what rescues a question-shaped query such
 * as "how should I write a memory", whose filler words no document needs to
 * contain. A stop-word list was rejected: it is a vocabulary to maintain.
 */
export async function search(
  env: { DB: D1Database },
  filters: SearchFilters,
): Promise<SearchHit[]> {
  let { results } =
    filters.match === "any"
      ? { results: [] as Row[] }
      : await buildSearchStatement(env.DB, filters, "AND").all<Row>();
  if (results.length === 0 && /\s/.test(filters.query.trim())) {
    ({ results } = await buildSearchStatement(
      env.DB,
      filters,
      "OR",
    ).all<Row>());
  }
  return results.map((r) => ({
    docKey: r.doc_key,
    concept: r.concept,
    conceptId: r.concept_id,
    project: r.project,
    title: r.title,
    snippet: r.snip,
    score: r.score,
    updatedAt: r.updated_at,
  }));
}

/**
 * Search input is free text, not an exposed FTS5 query language. Quote each
 * whitespace-delimited term so punctuation such as a hyphen cannot become an
 * FTS column/operator expression; `join` is the only operator that appears.
 */
function literalMatchQuery(query: string, join: "AND" | "OR"): string {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(` ${join} `);
}
