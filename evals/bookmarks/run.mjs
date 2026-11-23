/**
 * Do vectors help bookmark passages the way they helped a book's pages?
 * Ten public web pages, saved as bookmarks would be, split by the same
 * `app/concepts/asset-passages.ts` the Worker runs for bookmarks, and 20
 * paraphrased questions. Scored two ways, top three: the right passage, and
 * the right bookmark.
 *
 *   lexical  the question as asked, through Valise's BM25 query
 *   vector   bge-m3 cosine over passages
 *   hybrid   reciprocal rank fusion of the lexical and vector top 50
 *   jev      production's hybrid: the lexical top 50, then the vector top 50
 *            it lacks, reranked by Jev through `app/search/jev.ts`, each
 *            candidate's text built as `rerankedSearch` builds a source's
 *
 * Same shape and caveats as `evals/passages/run.mjs`: node:sqlite FTS5 with
 * search_docs_fts's tokenizer and weights, not D1. The pages are MediaWiki
 * plain-text extracts,
 * not the Worker's HTMLRewriter cut, so passage boundaries differ slightly
 * from production's.
 *
 *   node evals/bookmarks/run.mjs [--out evals/bookmarks/<date>-run.json]
 *
 * Embeddings go through OpenRouter (OPENROUTER_API_KEY), Jev through
 * TypeSafe (TYPESAFE_API_KEY, which also needs the embeddings); the run
 * prints the cost. Without OPENROUTER_API_KEY it runs lexical only.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { passageIndex } from "../../app/concepts/asset-passages.ts";
import { jev } from "../../app/search/jev.ts";
import { capBody } from "../../app/search/project.ts";
import { embed } from "../retrieval/rankings.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const flag = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const TOP = 3;
const DEPTH = 50;
const embedModel = "baai/bge-m3";
// Jev bills input tokens only, $0.042 per million (docs.typesafe.ai/models,
// 2026-10-18, as `evals/retrieval/rerank.mjs` records). The live timeout is
// 1.5 s; the eval waits longer so a slow call scores rather than falls back.
const JEV_PER_M = 0.042;
const JEV_EVAL_TIMEOUT_MS = 30_000;

const corpus = JSON.parse(readFileSync(join(HERE, "pages.json"), "utf8"));
const fixture = JSON.parse(readFileSync(join(HERE, "questions.json"), "utf8"));

const passages = [];
for (const page of corpus.pages) {
  const points = Array.from(page.text);
  for (const p of passageIndex(page.text).passages)
    passages.push({
      id: passages.length,
      page: page.title,
      label: p.label,
      body: points.slice(p.start, p.start + p.length).join(""),
    });
}

const squash = (s) => s.split(/\s+/).join(" ").toLowerCase();
const truth = fixture.queries.map((q) => {
  const ids = passages
    .filter(
      (p) => p.page === q.page && squash(p.body).includes(squash(q.phrase)),
    )
    .map((p) => p.id);
  if (!ids.length)
    throw new Error(`"${q.phrase}" is in no passage of ${q.page}`);
  return ids;
});

const db = new DatabaseSync(":memory:");
db.exec(`CREATE VIRTUAL TABLE fts USING fts5(title, body, tags,
  tokenize='porter unicode61 remove_diacritics 2')`);
const insert = db.prepare(
  "INSERT INTO fts(rowid, title, body, tags) VALUES (?, ?, ?, '')",
);
for (const p of passages) insert.run(p.id + 1, p.label ?? "", p.body);

function literal(query, join) {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(` ${join} `);
}
const lexicalStatement = db.prepare(
  `SELECT rowid - 1 AS id, snippet(fts, 1, '[', ']', '…', 20) AS snip
     FROM fts WHERE fts MATCH ? ORDER BY bm25(fts, 4.0, 1.0, 2.0) LIMIT ${DEPTH}`,
);
const snippets = new Map();
function lexical(query) {
  let rows = lexicalStatement.all(literal(query, "AND"));
  if (!rows.length && /\s/.test(query.trim()))
    rows = lexicalStatement.all(literal(query, "OR"));
  snippets.set(query, new Map(rows.map((row) => [row.id, row.snip])));
  return rows.map((row) => row.id);
}

// `rerankedSearch` in app/search/rerank.ts: the FTS top 50 in FTS order, the
// vector heads it lacks after them, and a source's text as its title, its
// lexical snippet (empty for a vector-only candidate) and its capped body.
const jevSpent = { calls: 0, inputTokens: 0, ms: [] };
async function jevRanking(query, lex, vector) {
  const ids = [...new Set([...lex, ...vector])];
  const texts = ids.map(
    (id) =>
      `${passages[id].label ?? ""}\n\n${snippets.get(query).get(id) ?? ""}\n${capBody(passages[id].body, 8192)}`,
  );
  const started = Date.now();
  const scores = await jev(process.env.TYPESAFE_API_KEY, query, texts, {
    timeoutMs: JEV_EVAL_TIMEOUT_MS,
    usage: jevSpent,
  });
  jevSpent.ms.push(Date.now() - started);
  return ids
    .map((id, i) => ({ id, score: scores[i] }))
    .sort((a, b) => b.score - a.score)
    .map(({ id }) => id);
}

const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
function fuse(...rankings) {
  const score = new Map();
  for (const ranking of rankings)
    ranking.forEach((id, rank) =>
      score.set(id, (score.get(id) ?? 0) + 1 / (60 + rank + 1)),
    );
  return [...score].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

const spent = { tokens: 0, usd: 0 };
const paid = Boolean(process.env.OPENROUTER_API_KEY);
const reranked = paid && Boolean(process.env.TYPESAFE_API_KEY);
const passageVectors = paid
  ? await embed(
      embedModel,
      passages.map((p) => p.body),
      spent,
    )
  : [];
const questionVectors = paid
  ? await embed(
      embedModel,
      fixture.queries.map((q) => q.question),
      spent,
    )
  : [];

const rows = [];
for (const [i, q] of fixture.queries.entries()) {
  const vector = paid
    ? passages
        .map((p) => [p.id, dot(questionVectors[i], passageVectors[p.id])])
        .sort((a, b) => b[1] - a[1])
        .slice(0, DEPTH)
        .map(([id]) => id)
    : [];
  const lex = lexical(q.question);
  const rankings = { lexical: lex, vector, hybrid: fuse(lex, vector) };
  if (reranked) rankings.jev = await jevRanking(q.question, lex, vector);
  rows.push({
    question: q.question,
    page: q.page,
    top: Object.fromEntries(
      Object.entries(rankings).map(([mode, ranking]) => {
        const top = ranking.slice(0, TOP);
        return [
          mode,
          {
            passage: top.some((id) => truth[i].includes(id)),
            bookmark: top.some((id) => passages[id].page === q.page),
            hits: top.map(
              (id) => `${passages[id].page} · ${passages[id].label ?? id}`,
            ),
          },
        ];
      }),
    ),
  });
}

const modes = paid ? ["lexical", "vector", "hybrid"] : ["lexical"];
if (reranked) modes.push("jev");
const summary = Object.fromEntries(
  modes.map((mode) => [
    mode,
    {
      passage: rows.filter((row) => row.top[mode].passage).length,
      bookmark: rows.filter((row) => row.top[mode].bookmark).length,
    },
  ]),
);
const report = {
  pages: corpus.pages.map(({ title, url, revision }) => ({
    title,
    url,
    revision,
  })),
  passages: passages.length,
  queries: rows.length,
  top: TOP,
  summary,
  model: paid ? embedModel : null,
  spent,
  ...(reranked && {
    reranker: {
      model: "jev-latest",
      calls: jevSpent.calls,
      inputTokens: jevSpent.inputTokens,
      usd: (jevSpent.inputTokens * JEV_PER_M) / 1e6,
      medianMs: jevSpent.ms.sort((a, b) => a - b)[jevSpent.ms.length >> 1],
    },
  }),
  rows,
};
const out = flag("--out", null);
if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`${corpus.pages.length} pages, ${passages.length} passages`);
for (const mode of modes)
  console.log(
    `${mode.padEnd(8)} passage ${summary[mode].passage}/${rows.length}, bookmark ${summary[mode].bookmark}/${rows.length} in the top ${TOP}`,
  );
console.log(`spent $${spent.usd.toFixed(5)} over ${spent.tokens} tokens`);
if (reranked)
  console.log(
    `jev: ${report.reranker.calls} calls, ${report.reranker.inputTokens} input tokens, $${report.reranker.usd.toFixed(5)}, median ${report.reranker.medianMs} ms per query`,
  );
for (const row of rows)
  if (modes.some((mode) => !row.top[mode].passage))
    console.log(
      `- ${row.page}: ${modes.map((m) => `${m} ${row.top[m].passage ? "yes" : "no"}`).join(", ")} :: ${row.question}`,
    );
