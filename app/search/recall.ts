import type { SearchConcept } from "~/db/schema";

/**
 * Recall on a failed command: the hook sends the error's normalised words,
 * and gets back at most `RECALL_HITS` memories, skills or to-dos that share
 * most of the error's informative words, or nothing. Nothing is the common
 * answer, and the right one for a typo: the hook then injects no search
 * prompt at all. `todo:tdo_10c82604-6b86-4266-a523-1ebf6e2f1749`.
 *
 * The bar is term coverage, not a BM25 score, because BM25 values do not
 * compare across queries. A word that matches more than `COMMON_SHARE` of the
 * case's documents, or more than `COMMON_DOCS` of them, says nothing about
 * this error and is left out of both sides of the ratio. FTS5 decides what
 * matches, so porter stemming applies exactly as it does in `search`.
 */
export const RECALL_HITS = 2;
export const MAX_RECALL_TERMS = 12;
export const MAX_RECALL_QUERY = 500;
const COMMON_DOCS = 40;
const COMMON_SHARE = 0.2;
/** A hit matches at least this share of the informative words, and two. */
const COVERAGE = 0.6;
const MIN_MATCHED = 2;
const RECALL_CONCEPTS: SearchConcept[] = ["memory", "skill", "todo"];

export type RecallHit = {
  id: string;
  concept: SearchConcept;
  title: string;
  matched: number;
  terms: number;
};

/** Lowercased distinct words, at most `MAX_RECALL_TERMS`, in order. */
export function recallTerms(query: string): string[] {
  const terms: string[] = [];
  for (const word of query
    .slice(0, MAX_RECALL_QUERY)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)) {
    if (word.length < 3 || /^\p{N}+$/u.test(word) || terms.includes(word))
      continue;
    terms.push(word);
    if (terms.length === MAX_RECALL_TERMS) break;
  }
  return terms;
}

type DocRow = {
  doc_key: string;
  concept: SearchConcept;
  title: string;
  body: string;
};

export async function recall(
  db: D1Database,
  userId: string,
  query: string,
): Promise<RecallHit[]> {
  const terms = recallTerms(query);
  if (terms.length < MIN_MATCHED) return [];
  const concepts = JSON.stringify(RECALL_CONCEPTS);
  const perTerm = terms.map((term) =>
    db
      .prepare(`SELECT si.doc_key, si.concept, si.title, substr(si.body, 1, 200) AS body
  FROM search_docs_fts JOIN search_docs si ON si.id = search_docs_fts.rowid
 WHERE search_docs_fts MATCH ? AND si.user_id = ?
   AND si.concept IN (SELECT value FROM json_each(?))
 LIMIT ?`)
      .bind(
        `"${term.replaceAll('"', '""')}"`,
        userId,
        concepts,
        COMMON_DOCS + 1,
      ),
  );
  const total = db
    .prepare(
      "SELECT count(*) AS n FROM search_docs WHERE user_id = ? AND concept IN (SELECT value FROM json_each(?))",
    )
    .bind(userId, concepts);
  const [counted, ...matches] = await db.batch([total, ...perTerm]);
  const docs = (counted.results[0] as { n: number } | undefined)?.n ?? 0;

  const informative = (matches as D1Result<DocRow>[]).filter(
    ({ results }) =>
      results.length > 0 &&
      results.length <= COMMON_DOCS &&
      results.length <= Math.max(1, docs * COMMON_SHARE),
  );
  // A word no document holds still counts against coverage: the error says
  // it and no stored note does.
  const considered =
    informative.length +
    matches.filter(({ results }) => results.length === 0).length;
  if (considered < MIN_MATCHED) return [];

  const byDoc = new Map<
    string,
    { row: DocRow; matched: number; rarity: number }
  >();
  for (const { results } of informative) {
    for (const row of results) {
      const seen = byDoc.get(row.doc_key) ?? { row, matched: 0, rarity: 0 };
      seen.matched += 1;
      seen.rarity += 1 / results.length;
      byDoc.set(row.doc_key, seen);
    }
  }
  const bar = Math.max(MIN_MATCHED, Math.ceil(considered * COVERAGE));
  return [...byDoc.values()]
    .filter((doc) => doc.matched >= bar)
    .sort((a, b) => b.matched - a.matched || b.rarity - a.rarity)
    .slice(0, RECALL_HITS)
    .map(({ row, matched }) => ({
      id: row.doc_key,
      concept: row.concept,
      title: oneLine(row.title || row.body),
      matched,
      terms: considered,
    }));
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= 200 ? line : `${line.slice(0, 199).trimEnd()}…`;
}

const ERROR_LINE =
  /error|fatal|fail|cannot|can't|not found|denied|refused|invalid|unable|exception|no such|missing|conflict|not mergeable|unknown/i;

/**
 * The words of a failed command's error worth searching for: its error-shaped
 * lines, or its last lines when none look like one, without the `Exit code N`
 * line, URLs, paths, and any word holding a digit (numbers, hashes, ids,
 * ports, line numbers), which differ between two runs of the same failure.
 * "" when nothing is left. The plugin's `PostToolUseFailure` hook sends the
 * raw error through `search` with `hook`, so this runs here, not in the hook.
 */
export function normaliseError(error: string): string {
  const lines = error
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^Exit code \d+$/.test(line));
  const errorLines = lines.filter((line) => ERROR_LINE.test(line));
  const chosen = (errorLines.length ? errorLines : lines.slice(-3)).slice(0, 3);
  return chosen
    .join(" ")
    .replace(/\S+:\/\/\S+/g, " ")
    .replace(/\S*[/\\]\S*/g, " ")
    .replace(/\S*\d\S*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_RECALL_QUERY);
}

export const RECALL_HITS_TEXT =
  "This command failed. Valise holds notes that share most of this error's " +
  "words. Fetch the one that fits before trying something else:";

/** The hook text for recall hits: one line per hit, its id first. */
export function recallHitsText(hits: Pick<RecallHit, "id" | "title">[]) {
  return [
    RECALL_HITS_TEXT,
    ...hits.map((hit) => `- ${hit.id} ${hit.title}`),
  ].join("\n");
}

/**
 * The hook's per-session gate. `search` with `hook` and `session_id` injects
 * a given error once a session and at most `RECALL_SESSION_CAP` errors a
 * session; rows older than `RECALL_GATE_SECONDS` are pruned on write.
 * Without `session_id` there is no gate. ADR-0004, 2026-11-04.
 */
export const RECALL_SESSION_CAP = 3;
export const RECALL_GATE_SECONDS = 24 * 60 * 60;

/** SHA-256 hex of the normalised error, so two runs of one failure match. */
export async function recallFingerprint(normalised: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalised),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export type RecallGate = "open" | "seen" | "capped";

/** Whether this session may still inject this error, before searching. */
export async function readRecallGate(
  db: D1Database,
  userId: string,
  sessionId: string,
  fingerprint: string,
  now: number,
): Promise<RecallGate> {
  const row = await db
    .prepare(
      `SELECT count(*) AS injected,
              coalesce(sum(fingerprint = ?), 0) AS seen
         FROM hook_recall_injections
        WHERE user_id = ? AND session_id = ? AND created_at > ?`,
    )
    .bind(fingerprint, userId, sessionId, now - RECALL_GATE_SECONDS)
    .first<{ injected: number; seen: number }>();
  if (row?.seen) return "seen";
  if ((row?.injected ?? 0) >= RECALL_SESSION_CAP) return "capped";
  return "open";
}

/**
 * Records an injection, unless a concurrent call took the fingerprint or the
 * last slot first, and prunes the caller's rows past the window. True when
 * this call holds the slot and may inject.
 */
export async function recordRecallInjection(
  db: D1Database,
  userId: string,
  sessionId: string,
  fingerprint: string,
  now: number,
): Promise<boolean> {
  const cutoff = now - RECALL_GATE_SECONDS;
  const [, inserted] = await db.batch<{ ok: number }>([
    db
      .prepare(
        "DELETE FROM hook_recall_injections WHERE user_id = ? AND created_at <= ?",
      )
      .bind(userId, cutoff),
    db
      .prepare(
        `INSERT INTO hook_recall_injections (user_id, session_id, fingerprint, created_at)
         SELECT ?1, ?2, ?3, ?4
          WHERE (SELECT count(*) FROM hook_recall_injections
                  WHERE user_id = ?1 AND session_id = ?2) < ?5
         ON CONFLICT DO NOTHING
         RETURNING 1 AS ok`,
      )
      .bind(userId, sessionId, fingerprint, now, RECALL_SESSION_CAP),
  ]);
  return inserted.results.length === 1;
}
