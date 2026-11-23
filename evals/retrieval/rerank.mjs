#!/usr/bin/env node
/**
 * Retrieve wide, rerank narrow. The candidates are the live FTS top N, alone
 * or unioned with the bge-m3 vector top N; a reranker reads each (query,
 * memory) pair and the top five come from its scores. N is 50 unless
 * `--depth 10,20,30,50` names one or more depths per side. Rank fusion, which
 * ADR-0013 measured and rejected, never reads the text; a reranker does, which
 * is what a paraphrase with no shared words needs.
 *
 * Same store, queries and top-five count as `vectors.mjs`. The Workers AI
 * rerankers go through the loopback `/__dev/rerank` route, which reaches the
 * account through wrangler's login, so no Cloudflare token is involved:
 *
 *   VALISE_STATE=.wrangler/evals npm run dev        # another terminal
 *   node evals/run.mjs --memories 5000 --case retrieval-title-logs
 *   VALISE_DEV_ORIGIN=http://localhost:5173 \
 *     node evals/retrieval/rerank.mjs --memories 5000
 *
 * Jev runs too when TYPESAFE_API_KEY is set; it is hosted by TypeSafe, so the
 * memory bodies leave Cloudflare. `--runs` (default 2) repeats every reranker
 * cell, because none of these providers promise determinism. Latency is what
 * the dev Worker measured around the AI call, so it includes the hop from
 * this machine's wrangler proxy to Cloudflare.
 */
import {
  DEPTH,
  embed,
  ftsRanking,
  KINDS,
  loadStore,
  memoryText,
  ORIGIN,
  relativesOf,
  TOP,
  vectorRanking,
} from "./rankings.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const size = Number(flag("--memories", "5000"));
const embedder = flag("--model", "baai/bge-m3");
const runs = Number(flag("--runs", "2"));
// `--rerankers jev` reruns one cell family without paying for the others.
const only = flag("--rerankers", null)?.split(",");
const depths = flag("--depth", String(DEPTH)).split(",").map(Number);

/**
 * Dollars per million input tokens, from each model's Workers AI page on
 * 2026-10-18. Clef bills input only; bge-reranker-base reports no usage, so
 * its tokens are estimated at four characters each.
 */
const RERANKERS = {
  "bge-reranker-base": { model: "@cf/baai/bge-reranker-base", perM: 0.00311 },
  clef: { model: "@cf/cloudflare/clef", perM: 0.24 },
  "clef-flash": { model: "@cf/cloudflare/clef-flash", perM: 0.038 },
};
// Jev bills input tokens only: $0.042 per million for jev-1.13.0 and
// jev-1.14.0 on https://docs.typesafe.ai/models, 2026-10-18. Thirty documents
// per call, as hev/jev-rerank batches them.
const JEV_PER_M = 0.042;
const JEV_BATCH = 30;

const typesafeKey = process.env.TYPESAFE_API_KEY;
const rerankers = [...Object.keys(RERANKERS), ...(typesafeKey ? ["jev"] : [])];
if (only) {
  rerankers.splice(
    0,
    rerankers.length,
    ...rerankers.filter((name) => only.includes(name)),
  );
}
if (!typesafeKey && (!only || only.includes("jev"))) {
  console.error(
    "skip jev: TYPESAFE_API_KEY is not set, and Jev is served only by TypeSafe's API",
  );
}
console.error(
  "skip hosted ceiling: OpenRouter serves Cohere, Voyage and Qwen rerankers, but this account's allowed providers exclude every one",
);

const { memories, labelled } = loadStore(size);
const byId = new Map(memories.map((m) => [m.id, m]));

const docVectors = await embed(embedder, memories.map(memoryText), {
  tokens: 0,
  usd: 0,
});
const queryVectors = await embed(
  embedder,
  labelled.map((q) => q.query),
  { tokens: 0, usd: 0 },
);

// The first stage is deterministic for FTS and fixed once embedded, so it is
// computed once and every reranker and run sees the same candidates.
const firstStage = [];
for (const [index, query] of labelled.entries()) {
  const vector = vectorRanking(
    memories,
    docVectors,
    queryVectors[index],
    query.project,
    Math.max(...depths),
  );
  const sets = {};
  for (const n of depths) {
    const fts = await ftsRanking(query, n);
    sets[`FTS ${n}`] = fts;
    sets[`FTS ${n} + vector ${n}`] = [
      ...new Set([...fts, ...vector.slice(0, n)]),
    ];
  }
  firstStage.push({
    query,
    claim: relativesOf(memories, query.expect),
    // The baselines read the top five, which no depth changes.
    fts: sets[`FTS ${depths[0]}`],
    vector,
    sets,
  });
}
const SETS = Object.keys(firstStage[0].sets);

async function jev(query, candidates) {
  const scores = [];
  let inputTokens = 0;
  let calls = 0;
  const started = Date.now();
  await Promise.all(
    Array.from(
      { length: Math.ceil(candidates.length / JEV_BATCH) },
      async (_, b) => {
        const slice = candidates.slice(b * JEV_BATCH, (b + 1) * JEV_BATCH);
        const ids = slice.map((_, j) => `D${String(j).padStart(2, "0")}`);
        const request = () =>
          fetch("https://api.typesafe.ai/v1/systemone", {
            method: "POST",
            headers: {
              authorization: `Bearer ${typesafeKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: "jev-latest",
              state: {
                query,
                documents: Object.fromEntries(
                  ids.map((id, j) => [id, slice[j]]),
                ),
              },
              questions: Object.fromEntries(
                ids.map((id) => [
                  id,
                  {
                    type: "noul",
                    instructions: `Document \`documents.${id}\` is relevant to \`query\`: it contains information that answers or directly addresses it.`,
                    criteria: {
                      true: "The document contains information that answers the query or directly addresses what it asks about.",
                      false:
                        "The document is only loosely related, on a similar topic, or does not address what the query asks.",
                    },
                  },
                ]),
              ),
            }),
          });
        // TypeSafe's API reference asks for backoff on 429 and 529. Any other
        // status, a rejected key included, fails the run at once.
        let response = await request();
        for (let wait = 1000; wait <= 16000; wait *= 2) {
          if (response.status !== 429 && response.status !== 529) break;
          await new Promise((done) => setTimeout(done, wait));
          response = await request();
        }
        const body = await response.json();
        if (!response.ok) {
          throw new Error(`jev ${response.status} ${JSON.stringify(body)}`);
        }
        calls++;
        inputTokens += body.usage?.input_tokens ?? 0;
        // A Noul answer's `noul` field is the probability of yes.
        ids.forEach((id, j) => {
          scores[b * JEV_BATCH + j] = body.answers[id].noul;
        });
      },
    ),
  );
  return { scores, calls, inputTokens, ms: Date.now() - started };
}

async function score(name, query, candidates) {
  if (name === "jev") return jev(query, candidates);
  const response = await fetch(new URL("/__dev/rerank", ORIGIN), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: RERANKERS[name].model, query, candidates }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${name} ${JSON.stringify(body)}`);
  if (name === "bge-reranker-base") {
    body.inputTokens = Math.ceil(
      candidates.reduce((sum, text) => sum + query.length + text.length, 0) / 4,
    );
  }
  return body;
}

const emptyTally = () =>
  Object.fromEntries(KINDS.map((k) => [k, { exact: 0, claim: 0 }]));
const count = (tally, stage, ranking) => {
  const top = ranking.slice(0, TOP);
  if (top.includes(stage.query.expect)) tally[stage.query.kind].exact++;
  if (top.some((id) => stage.claim.has(id))) tally[stage.query.kind].claim++;
};

const baselines = {
  "FTS alone": emptyTally(),
  [`Vector alone (${embedder})`]: emptyTally(),
};
const sizes = Object.fromEntries(SETS.map((s) => [s, []]));
// Recall reads the whole set: a reranker can lift anything in it, and
// nothing outside it.
const recall = Object.fromEntries(SETS.map((s) => [s, emptyTally()]));
for (const stage of firstStage) {
  count(baselines["FTS alone"], stage, stage.fts);
  count(baselines[`Vector alone (${embedder})`], stage, stage.vector);
  for (const set of SETS) {
    const candidates = stage.sets[set];
    sizes[set].push(candidates.length);
    const row = recall[set][stage.query.kind];
    if (candidates.includes(stage.query.expect)) row.exact++;
    if (candidates.some((id) => stage.claim.has(id))) row.claim++;
  }
}

// cells[name][set][run] is a tally; spend[name][set] collects per query.
const cells = {};
const spend = {};
const misses = [];
for (const name of rerankers) {
  cells[name] = {};
  spend[name] = {};
  for (const set of SETS) {
    cells[name][set] = [];
    spend[name][set] = { ms: [], tokens: [], calls: [] };
    for (let run = 0; run < runs; run++) {
      const tally = emptyTally();
      for (const stage of firstStage) {
        const ids = stage.sets[set];
        const result = await score(
          name,
          stage.query.query,
          ids.map((id) => memoryText(byId.get(id))),
        );
        const ranking = ids
          .map((id, i) => ({ id, s: result.scores[i] }))
          .sort((a, b) => b.s - a.s)
          .map(({ id }) => id);
        count(tally, stage, ranking);
        spend[name][set].ms.push(result.ms);
        spend[name][set].tokens.push(result.inputTokens);
        spend[name][set].calls.push(result.calls);
        if (
          run === 0 &&
          set.startsWith(`FTS ${Math.max(...depths)}`) &&
          stage.query.kind === "paraphrase" &&
          !ranking.slice(0, TOP).some((id) => stage.claim.has(id))
        ) {
          misses.push(`${name} over ${set}: ${stage.query.query}`);
        }
      }
      cells[name][set].push(tally);
      console.error(`${name} over ${set}, run ${run + 1} done`);
    }
  }
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const cell = (tally) => `${tally.claim} · ${tally.exact}`;
// Both runs when they disagree, so a one-off swing reads as one.
const runCell = (tallies, kind) => {
  const values = tallies.map((t) => cell(t[kind]));
  return new Set(values).size === 1 ? values[0] : values.join(" / ");
};

console.log(
  [
    `${size} memories · candidates from FTS and ${embedder} · ${runs} runs per reranker cell`,
    "",
    "Candidate recall: the claim, then the exact id, anywhere in the candidates, out of 25:",
    "",
    `| Candidates | Mean size | ${KINDS.join(" | ")} |`,
    `| --- | --- | ${KINDS.map(() => "---").join(" | ")} |`,
    ...SETS.map(
      (set) =>
        `| ${set} | ${Math.round(mean(sizes[set]))} | ${KINDS.map((k) => cell(recall[set][k])).join(" | ")} |`,
    ),
    "",
    "The claim, then the exact id, in the top five, out of 25:",
    "",
    `| Ranking | ${KINDS.join(" | ")} |`,
    `| --- | ${KINDS.map(() => "---").join(" | ")} |`,
    ...Object.entries(baselines).map(
      ([name, tally]) =>
        `| ${name} | ${KINDS.map((k) => cell(tally[k])).join(" | ")} |`,
    ),
    ...rerankers.flatMap((name) =>
      SETS.map(
        (set) =>
          `| ${set} → ${name} | ${KINDS.map((k) => runCell(cells[name][set], k)).join(" | ")} |`,
      ),
    ),
    "",
    "Per query, every query kind and run:",
    "",
    "| Reranker | Candidates | Median ms | p95 ms | Calls | Input tokens | $ per 1000 queries |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rerankers.flatMap((name) =>
      SETS.map((set) => {
        const s = spend[name][set];
        const perM = name === "jev" ? JEV_PER_M : RERANKERS[name].perM;
        const tokens = mean(s.tokens);
        return `| ${name} | ${set} | ${percentile(s.ms, 0.5)} | ${percentile(s.ms, 0.95)} | ${mean(s.calls).toFixed(1)} | ${Math.round(tokens)} | $${((tokens * perM * 1000) / 1e6).toFixed(4)} |`;
      }),
    ),
    "",
    ...misses.map((miss) => `- missed paraphrase: ${miss}`),
  ].join("\n"),
);
