#!/usr/bin/env node
// Bounded live integration evidence against an isolated loopback eval Worker.
// This never provisions, deploys, changes mode, or deletes an index.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { buildCorpus } from "../evals/retrieval/corpus.ts";

const args = process.argv.slice(2);
const option = (key, fallback) =>
  args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const size = Number(option("--size", "50"));
const batchDelay = Number(option("--batch-delay-ms", "10000"));
assert([50, 500, 5000].includes(size), "size must be 50, 500 or 5000");
assert(
  Number.isSafeInteger(batchDelay) && batchDelay >= 0 && batchDelay <= 60_000,
  "batch delay must be 0..60000 milliseconds",
);
const origin = process.env.VALISE_DEV_ORIGIN ?? "http://localhost:4474";
assert(
  ["localhost", "127.0.0.1"].includes(new URL(origin).hostname),
  "loopback only",
);
const fixture = JSON.parse(
  readFileSync(
    new URL("../evals/fixtures/retrieval-memories.json", import.meta.url),
  ),
);
const pool = JSON.parse(
  readFileSync(
    new URL("../evals/fixtures/retrieval-pool.json", import.meta.url),
  ),
);
const { memories, queries } = buildCorpus(size, fixture, pool);
const report = {
  size,
  startedAt: new Date().toISOString(),
  deliveries: [],
  queries: [],
  fallbacks: [],
  complete: false,
};
process.on("exit", () => {
  report.finishedAt ??= new Date().toISOString();
  writeFileSync(
    option("--output", ".wrangler/vector-rollout-proof.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
});
async function call(path, body) {
  const response = await fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    ...(body !== undefined && {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  assert(
    response.ok,
    `${path}: HTTP ${response.status}: ${await response.clone().text()}`,
  );
  return response.json();
}
const status = await call("/__dev/vector-status");
assert(
  status.namespace?.startsWith("rollout-eval-"),
  "deployment-owned eval namespace required",
);
report.namespace = status.namespace;
if (args.includes("--seed")) {
  assert.equal(
    status.total,
    0,
    "seed only before any vector backfill in this namespace",
  );
  await call("/__dev/seed", {});
  await call("/__dev/memories", memories);
}
let cursor = "";
for (let page = 0; page <= Math.ceil((size + 1) / 50); page++) {
  const result = await call(
    `/__dev/vectors?after=${encodeURIComponent(cursor)}`,
    {},
  );
  cursor = result.cursor;
  if (result.done) break;
  assert(page < Math.ceil((size + 1) / 50), "backfill exceeded bound");
}
for (let batch = 0; batch < Math.ceil((size + 1) / 20) + 5; batch++) {
  if (batch) await new Promise((resolve) => setTimeout(resolve, batchDelay));
  const result = await call("/__dev/vectors?drain=1", {});
  report.deliveries.push(result);
  console.log(JSON.stringify({ event: "delivery", ...result }));
  if (result.pending === 0) break;
  assert(
    result.delivered > 0 || result.attemptedFailed < 20,
    "whole delivery page failed; inspect configuration/provider before spending more",
  );
  if (!result.delivered && !result.attemptedFailed) break;
}
assert.equal((await call("/__dev/vector-status")).pending, 0);
const acceptedAt = Date.now();
const sentinel = fixture.targets[0];
let visible = false;
for (let attempt = 0; attempt < 18; attempt++) {
  const result = await call(
    `/__dev/vector-candidates?q=${encodeURIComponent(sentinel.title)}`,
  );
  if (result.heads.some((head) => head.conceptId === sentinel.id)) {
    visible = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}
assert(visible, "accepted sentinel did not become visible within 180s");
report.acceptanceToObservedVisibilityMs = Date.now() - acceptedAt;
const tally = {};
for (const labelled of queries.filter((row) => row.kind !== "id-fragment")) {
  const params = new URLSearchParams({ q: labelled.query });
  if (labelled.project) params.set("project", labelled.project);
  const result = await call(`/__dev/hybrid-search?${params}`);
  assert(result.rerank, "no rerank outcome");
  if (!result.rerank.reranked) {
    report.fallbacks.push({ ...labelled, rerank: result.rerank });
    assert(
      ["timeout 1500 ms", "vector timeout 2500 ms"].includes(
        result.rerank.fallback,
      ),
      `unexpected fallback: ${JSON.stringify(result.rerank)}`,
    );
  }
  const rank = result.hits.findIndex(
    (hit) => hit.docKey === `memory:${labelled.expect}`,
  );
  tally[labelled.kind] ??= { top5: 0, total: 0 };
  tally[labelled.kind].total++;
  if (rank >= 0 && rank < 5) tally[labelled.kind].top5++;
  report.queries.push({
    ...labelled,
    rank: rank + 1,
    rerank: result.rerank,
    ids: result.hits.slice(0, 5).map((hit) => hit.docKey),
  });
}
// Scope a real ANN query by project AND every target tag, not after global top50.
report.scoped = [];
for (const target of fixture.targets) {
  const params = new URLSearchParams({
    q: target.title,
    project: target.project,
  });
  for (const tag of target.tags) params.append("tag", tag);
  const { heads } = await call(`/__dev/vector-candidates?${params}`);
  assert(
    heads.some((head) => head.conceptId === target.id),
    `scoped ANN lost ${target.id}`,
  );
  assert(
    heads.every(
      (head) =>
        head.project === target.project &&
        target.tags.every((tag) => ` ${head.tags} `.includes(` ${tag} `)),
    ),
  );
  report.scoped.push({
    id: target.id,
    project: target.project,
    tags: target.tags,
    returned: heads.length,
  });
}
report.tally = tally;
report.finishedAt = new Date().toISOString();
console.log(
  JSON.stringify({
    tally,
    scoped: report.scoped.length,
    acceptanceToObservedVisibilityMs: report.acceptanceToObservedVisibilityMs,
  }),
);
if (size === 50) {
  assert(
    report.fallbacks.length <= 3,
    `hybrid availability below 95%: ${report.fallbacks.length}/75 fallbacks`,
  );
  for (const [kind, floor] of Object.entries({
    "exact-title": 25,
    paraphrase: 20,
    "project-question": 21,
  }))
    assert(
      tally[kind].top5 >= floor,
      `${kind}: ${tally[kind].top5} < ${floor}`,
    );
}
report.complete = true;
