#!/usr/bin/env node
/**
 * Would vectors find what FTS misses? The same store and labelled queries as
 * `test/d1/retrieval.worker.test.ts`, ranked three ways: the live FTS
 * `search`, cosine over embeddings, and the two fused by reciprocal rank.
 * Counts the labelled memory in the top five, out of 25 per query kind, and
 * then the same claim: the target or one of its near-duplicates and
 * superseded copies, which the corpus writes up to six of per target at 5000
 * and which crowd the exact id out of a top five on every ranking alike.
 *
 * ADR-0013 rests on its numbers. It runs against the eval store already
 * seeded to the same size, and it calls the embedding models Workers AI serves
 * (bge-base-en-v1.5, bge-m3) through OpenRouter, so no Cloudflare account is
 * involved:
 *
 *   VALISE_STATE=.wrangler/evals npm run dev        # another terminal
 *   node evals/run.mjs --memories 5000 --case retrieval-title-logs
 *   VALISE_DEV_ORIGIN=http://localhost:5173 \
 *     node evals/retrieval/vectors.mjs --memories 5000 --model baai/bge-m3
 *
 * The eval run is there to seed the store at that size; any `--memories`
 * run does. `--model` defaults to bge-base-en-v1.5, the smaller of the two.
 *
 * Embedding 5000 memories costs under a cent with either and takes about two
 * minutes. Nothing is cached: the corpus is deterministic, so a rerun is the
 * cache.
 */
import {
  EMBED_BATCH,
  embed,
  ftsRanking,
  KINDS,
  loadStore,
  memoryText,
  relativesOf,
  TOP,
  vectorRanking,
} from "./rankings.mjs";

const METHODS = ["fts", "vector", "hybrid"];
// The constant from the RRF paper; it flattens the head so neither ranking
// alone decides the top five.
const RRF_K = 60;

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const size = Number(flag("--memories", "5000"));
const model = flag("--model", "baai/bge-base-en-v1.5");

const { memories, labelled } = loadStore(size);

// What a reindex of the whole store spends, which the embeddings ADR needs.
const spent = { tokens: 0, usd: 0 };

function fuse(...rankings) {
  const scores = new Map();
  for (const ranking of rankings) {
    ranking.forEach((id, rank) =>
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)),
    );
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

const started = Date.now();
const docVectors = await embed(model, memories.map(memoryText), spent);
const reindex = {
  ...spent,
  seconds: Math.round((Date.now() - started) / 1000),
};
const queryVectors = await embed(
  model,
  labelled.map((q) => q.query),
  { tokens: 0, usd: 0 },
);

const tally = Object.fromEntries(
  KINDS.map((kind) => [
    kind,
    {
      total: 0,
      ...Object.fromEntries(
        METHODS.flatMap((m) => [
          [m, 0],
          [`${m}Claim`, 0],
        ]),
      ),
    },
  ]),
);
const lines = [];
for (const [index, query] of labelled.entries()) {
  const fts = await ftsRanking(query);
  const vector = vectorRanking(
    memories,
    docVectors,
    queryVectors[index],
    query.project,
  );
  const hybrid = fuse(fts, vector);
  const row = tally[query.kind];
  row.total++;
  const claim = relativesOf(memories, query.expect);
  const hit = (ranking) => ranking.slice(0, TOP).includes(query.expect);
  const claimHit = (ranking) =>
    ranking.slice(0, TOP).some((id) => claim.has(id));
  const rankings = { fts, vector, hybrid };
  for (const method of METHODS) {
    if (hit(rankings[method])) row[method]++;
    if (claimHit(rankings[method])) row[`${method}Claim`]++;
  }
  if (query.kind === "paraphrase" && !claimHit(hybrid)) {
    lines.push(`- hybrid missed: ${query.query}`);
  }
}

console.log(
  [
    `${size} memories · ${model}`,
    `embedding the store: ${reindex.tokens} tokens, $${reindex.usd.toFixed(4)}, ${reindex.seconds}s in batches of ${EMBED_BATCH}`,
    "",
    "Exact id in the top five, then the claim (target or a copy of it):",
    "",
    "| Query | FTS | Vector | Hybrid (RRF) |",
    "| --- | --- | --- | --- |",
    ...KINDS.map((kind) => {
      const t = tally[kind];
      const cell = (m) => `${t[m]} · ${t[`${m}Claim`]}`;
      return `| ${kind} | ${METHODS.map(cell).join(" | ")} |`;
    }),
    "",
    ...lines,
  ].join("\n"),
);
