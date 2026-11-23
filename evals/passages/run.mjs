/**
 * Does a book passage come back on the right page? Four ways to search the
 * same passages of one public-domain book, scored by whether the page that
 * holds the answer is in the top three.
 *
 *   lexical    the question as the user asked it, through Valise's BM25 query
 *   rewritten  a model turns the question into search terms first, as
 *              agents do when a search misses (ADR-0013)
 *   vector     bge-m3 cosine over passages
 *   hybrid     reciprocal rank fusion of the lexical and vector top 50
 *
 * The passages come from `app/concepts/asset-passages.ts`, the same code the
 * Worker runs. The index is node:sqlite FTS5 with search_docs_fts's tokenizer
 * and BM25 weights, not D1; the query is query.ts's AND-then-OR literal
 * query. Production hybrid reranks the union with Jev instead of fusing
 * ranks, so `hybrid` here is the cheaper shape ADR-0013 measured first.
 *
 * Ground truth is layout, not the splitter: the PDF has two unnumbered
 * front-matter pages, so the printed page is the file page minus two.
 *
 *   gunzip -k evals/passages/on-liberty.md.gz
 *   node evals/passages/run.mjs [--rewrite-model anthropic/claude-haiku-4.5]
 *
 * Paid calls go through OpenRouter (OPENROUTER_API_KEY); the run prints
 * their cost. Without the key it runs lexical only.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { passageIndex } from "../../app/concepts/asset-passages.ts";
import { embed } from "../retrieval/rankings.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const flag = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const TOP = 3;
const DEPTH = 50;
const rewriteModel = flag("--rewrite-model", "anthropic/claude-haiku-4.5");
const embedModel = "baai/bge-m3";

const fixture = JSON.parse(readFileSync(join(HERE, "on-liberty.json"), "utf8"));
const text = readFileSync(join(HERE, "on-liberty.md"), "utf8");
const index = passageIndex(text);
const points = Array.from(text);
const passages = index.passages.map((p, i) => ({
  ...p,
  id: i,
  body: points.slice(p.start, p.start + p.length).join(""),
}));

// Truth: every printed page whose text holds the phrase.
const squash = (s) => s.split(/\s+/).join(" ").toLowerCase();
const filePages = new Map();
for (const [, n, body] of text.matchAll(
  /^### Page (\d+)\n([\s\S]*?)(?=^### Page \d+\n|$(?![\s\S]))/gm,
))
  filePages.set(Number(n), squash(body));
const truth = fixture.queries.map((q) =>
  [...filePages]
    .filter(([, body]) => body.includes(squash(q.phrase)))
    .map(([n]) => n - fixture.front_matter_pages),
);
if (truth.some((pages) => pages.length === 0))
  throw new Error("a phrase is on no page; the fixture and text disagree");

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
  `SELECT rowid - 1 AS id FROM fts WHERE fts MATCH ? ORDER BY bm25(fts, 4.0, 1.0, 2.0) LIMIT ${DEPTH}`,
);
function lexical(query) {
  let rows = lexicalStatement.all(literal(query, "AND"));
  if (!rows.length && /\s/.test(query.trim()))
    rows = lexicalStatement.all(literal(query, "OR"));
  return rows.map((row) => row.id);
}

const spent = { tokens: 0, usd: 0 };
async function rewrite(question) {
  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: rewriteModel,
        max_tokens: 40,
        temperature: 0,
        usage: { include: true },
        messages: [
          {
            role: "user",
            content: `You search a book's full text with a keyword search engine that ranks passages by shared words. Write the 2 to 5 words most likely to appear in the passage that answers this question. Reply with the words only.\n\nQuestion: ${question}`,
          },
        ],
      }),
    },
  );
  const body = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(body).slice(0, 300));
  spent.usd += body.usage?.cost ?? 0;
  spent.tokens += body.usage?.total_tokens ?? 0;
  return body.choices[0].message.content.trim().replace(/["\n]/g, " ");
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

const covers = (p, page) =>
  p.label !== null &&
  !p.label.startsWith("PDF") &&
  p.first <= page &&
  page <= p.last;
const found = (ranking, pages) =>
  ranking
    .slice(0, TOP)
    .some((id) => pages.some((page) => covers(passages[id], page)));

const paid = Boolean(process.env.OPENROUTER_API_KEY);
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
  const lex = lexical(q.question);
  const terms = paid ? await rewrite(q.question) : null;
  const rewritten = terms ? lexical(terms) : [];
  const vector = paid
    ? passages
        .map((p) => [p.id, dot(questionVectors[i], passageVectors[p.id])])
        .sort((a, b) => b[1] - a[1])
        .slice(0, DEPTH)
        .map(([id]) => id)
    : [];
  rows.push({
    question: q.question,
    pages: truth[i],
    terms,
    top: Object.fromEntries(
      Object.entries({
        lexical: lex,
        rewritten,
        vector,
        hybrid: fuse(lex, vector),
      }).map(([mode, ranking]) => [
        mode,
        {
          found: found(ranking, truth[i]),
          labels: ranking.slice(0, TOP).map((id) => passages[id].label),
        },
      ]),
    ),
  });
}

const modes = paid ? ["lexical", "rewritten", "vector", "hybrid"] : ["lexical"];
const summary = Object.fromEntries(
  modes.map((mode) => [mode, rows.filter((row) => row.top[mode].found).length]),
);
const report = {
  book: fixture.book,
  passages: passages.length,
  labelled: passages.filter((p) => p.label && !p.label.startsWith("PDF"))
    .length,
  author: index.author,
  queries: rows.length,
  top: TOP,
  summary,
  models: paid ? { rewrite: rewriteModel, embed: embedModel } : null,
  spent,
  rows,
};
const out = flag("--out", null);
if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `${report.passages} passages (${report.labelled} with printed pages), author ${report.author}`,
);
for (const mode of modes)
  console.log(
    `${mode.padEnd(10)} ${summary[mode]}/${rows.length} in the top ${TOP}`,
  );
console.log(`spent $${spent.usd.toFixed(5)} over ${spent.tokens} tokens`);
for (const row of rows)
  if (modes.some((mode) => !row.top[mode].found))
    console.log(
      `- p. ${row.pages.join("/")}: ${modes.map((m) => `${m} ${row.top[m].found ? "yes" : "no"}`).join(", ")} :: ${row.question}${row.terms ? ` [${row.terms}]` : ""}`,
    );
