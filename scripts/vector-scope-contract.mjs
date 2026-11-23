#!/usr/bin/env node
// Deterministic provider prefilter proof. Synthetic vectors only; no inference,
// production binding, deployment, or deletion. Wrangler owns authentication.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const exec = promisify(execFile);
const index = process.argv[2];
assert(
  index?.startsWith("valise-rollout-eval-"),
  "explicit disposable eval index required",
);
const hash = (text) => createHash("sha256").update(text).digest("hex");
const namespace = "rollout-scope-contract";
const target = hash("valise-scope-contract-target-v1");
const project = hash(`${"界".repeat(99)}A`);
const foreignProject = hash(`${"界".repeat(99)}B`);
const values = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
const rows = Array.from({ length: 60 }, (_, i) => ({
  id: hash(`valise-scope-contract-foreign-v1-${i}`),
  namespace,
  values,
  metadata: { docKey: `memory:scope-foreign-${i}`, project: foreignProject },
}));
rows.push({
  id: target,
  namespace,
  values: values.map((_, i) => (i === 0 ? 0.5 : i === 1 ? Math.sqrt(0.75) : 0)),
  metadata: { docKey: "memory:scope-target", project },
});
mkdirSync(".wrangler", { recursive: true });
writeFileSync(
  ".wrangler/vector-scope-contract.ndjson",
  `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
);
async function wrangler(args) {
  const { stdout } = await exec(
    process.execPath,
    ["node_modules/wrangler/bin/wrangler.js", "vectorize", ...args],
    { maxBuffer: 2_000_000, timeout: 30_000 },
  );
  const start = stdout.indexOf("{");
  // Wrangler's query command prints a warning rather than JSON for zero hits.
  return start < 0
    ? { count: 0, matches: [] }
    : JSON.parse(stdout.slice(start));
}
const accepted = await wrangler([
  "upsert",
  index,
  "--file",
  ".wrangler/vector-scope-contract.ndjson",
  "--json",
]);
const started = Date.now();
const query = (filter) =>
  wrangler([
    "query",
    index,
    "--vector-id",
    rows[0].id,
    "--namespace",
    namespace,
    "--top-k",
    "50",
    "--return-metadata",
    "all",
    ...(filter ? ["--filter", JSON.stringify(filter)] : []),
  ]);
let unscoped;
for (let attempt = 0; attempt < 18; attempt++) {
  try {
    unscoped = await query();
  } catch {
    /* Mutation acceptance precedes query visibility. */
  }
  if (unscoped?.matches?.length === 50) break;
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}
assert.equal(
  unscoped?.matches?.length,
  50,
  "synthetic global top50 never became visible",
);
assert(
  !unscoped.matches.some((match) => match.id === target),
  "target must be below global top50",
);
const scoped = await query({ project });
assert.deepEqual(
  scoped.matches.map((match) => match.id),
  [target],
);
const both = await query({ project, docKey: { $in: ["memory:scope-target"] } });
assert.deepEqual(
  both.matches.map((match) => match.id),
  [target],
);
const wrong = await query({
  project: foreignProject,
  docKey: { $in: ["memory:scope-target"] },
});
assert.equal(wrong.matches.length, 0);
const report = {
  index,
  namespace,
  accepted,
  observedMs: Date.now() - started,
  target,
  projectsDifferAfterUtf8Byte: 297,
  unscoped,
  scoped,
  both,
  wrong,
};
writeFileSync(
  process.argv[3] ?? ".wrangler/vector-scope-contract.json",
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    global: unscoped.matches.length,
    scoped: scoped.matches.length,
    combined: both.matches.length,
    wrong: wrong.matches.length,
    observedMs: report.observedMs,
  }),
);
