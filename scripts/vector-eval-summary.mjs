#!/usr/bin/env node
// Recount pinned retrieval episodes without changing their strict scores.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { buildCorpus } from "../evals/retrieval/corpus.ts";
import { relativesOf } from "../evals/retrieval/rankings.mjs";

const run = JSON.parse(readFileSync(process.argv[2], "utf8"));
assert(
  run.memories === 5000 &&
    run.cases.every((row) => row.id.startsWith("retrieval-")),
  "expected focused 5000-memory retrieval run",
);
const fixture = JSON.parse(
  readFileSync("evals/fixtures/retrieval-memories.json", "utf8"),
);
const pool = JSON.parse(
  readFileSync("evals/fixtures/retrieval-pool.json", "utf8"),
);
const { memories } = buildCorpus(5000, fixture, pool);
const expected = new Map(
  run.cases.map((row) => [row.id, row.expectArgs.id.replace(/^memory:/, "")]),
);
const cases = {};
const rows = run.rows.map((row) => {
  const relatives = relativesOf(memories, expected.get(row.case));
  const claimFetch =
    !row.error &&
    !row.capped &&
    row.chose === "fetch" &&
    relatives.has(row.args?.id?.replace(/^memory:/, ""));
  const tally = (cases[row.case] ??= {
    total: 0,
    strictPass: 0,
    claimFetches: 0,
    capped: 0,
    errors: 0,
    models: {},
  });
  const model = (tally.models[row.model] ??= {
    total: 0,
    strictPass: 0,
    claimFetches: 0,
    capped: 0,
    errors: 0,
  });
  for (const cell of [tally, model]) {
    cell.total++;
    if (row.pass) cell.strictPass++;
    if (claimFetch) cell.claimFetches++;
    if (row.capped) cell.capped++;
    if (row.error) cell.errors++;
  }
  return {
    model: row.model,
    case: row.case,
    repeat: row.repeat,
    strictPass: row.pass,
    claimFetch,
    requestedId: row.chose === "fetch" ? row.args?.id : null,
    capped: row.capped,
    error: row.error,
  };
});
const result = {
  at: run.at,
  toolsHash: run.toolsHash,
  storeHash: run.storeHash,
  repeat: run.repeat,
  models: run.models,
  cases,
  rows,
  costUsd: run.rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
  scoring:
    "Strict scores unchanged. Claim counts terminal fetch requests for target/relativesOf; the existing runner stops before executing an accepted fetch. Dump's documented same-fact confound is not relabelled.",
};
writeFileSync(
  process.argv[3] ?? ".wrangler/vector-eval-summary.json",
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(JSON.stringify({ cases, costUsd: result.costUsd }));
