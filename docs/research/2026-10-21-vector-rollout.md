# Vector rollout, 2026-10-21

## Resources and deployment boundary

`valise-memories-v1` was created at 07:07:46 UTC in the existing Cloudflare account:
1024 dimensions, cosine, string metadata indexes `project` and `docKey`.
`valise-prod-v1` and `h:valise-prod-v1` are reserved for the production database.
The production census was 76 live memories, three revisions, 11 snapshots and
zero pending rows. Provisioning did not bind or populate the index.

`valise-rollout-eval-20261021` is a separate disposable index. Eval databases
are local, namespaces are `rollout-eval-v1` and `rollout-eval-scale-v1`, and
source fixtures are `evals/retrieval/corpus.ts`. Only checked-in fixtures were
sent; no live production content was read or copied. Production code/config
changes require reviewed merges and Workers Builds; no laptop deployment or
hybrid activation occurred.

## Capacity and filtering

The minute handler resumes 50-source backfill pages and drains 20 jobs with
concurrency four. Nominal capacity is 28,800 attempts/day including daily repair.
Five-second provider waits, 120-second claims, epoch fencing, retained tombstones
and backoff up to one day remain. Fixed failure codes name the failing stage,
not a provider message or memory body. Queue age is not ANN visibility.
Full queue counters are sampled every five minutes, not every minute: 1.44
million ledger rows/day at 5,000 generations rather than 7.2 million. Unsampled
ticks explicitly omit counters. The regression failed before this change and
passed afterward; explicit operator drains keep their counters.

Projects use indexed SHA-256 keys instead of truncated strings. Tag scopes use
eligible published D1 keys, indexed `$in` partitions of 32, cosine merging and
then top 50. More than 256 eligible tag-scoped heads explicitly fall back to FTS;
the implementation does not claim exhaustive scoped ANN outside that bound.
Long Unicode projects/tags, concurrency, resumable backfill, queue age and
oversized-scope fallback have workerd/D1 regressions.

## Live 50-store result

Raw evidence: `evals/retrieval/rollout-2026-10-21/floors-50.json`.
The corpus has 50 memories, plus the runner's seed memory, skill and to-do.
It was backfilled through the shared outbox and queried through the real remote
Workers AI and Vectorize bindings, then Jev over the actual union.

| Query kind | Target in top five | Genuine hybrid responses |
| --- | --- | --- |
| Exact title | 25/25 | 25/25 |
| Paraphrase | 25/25 | 25/25 |
| Project question | 25/25 | 25/25 |

All 25 targets were also present in direct ANN queries scoped by their project
and every tag. All returned heads satisfied those filters. The 75 hybrid stages
took 580 ms median, 811 ms p95 and 1,893 ms maximum, measured through the local
remote-binding proxy. These are not deployed-Worker latency percentiles.

## Provider prefilter contract

`scoped-top50-contract.json` records 61 synthetic, manually specified vectors
in the eval index's separate `rollout-scope-contract` namespace. Sixty foreign
vectors have cosine 1; the eligible target has cosine 0.5. The target is absent
from the unfiltered top 50, but indexed project filtering and combined
project/`docKey` filtering each return that target alone. A mismatched project
plus its `docKey` returns zero. This demonstrates prefiltering before ANN top 50,
not merely safe post-filtering. Visibility was observed after 102 seconds.

The two original project strings are 100 Unicode characters and differ only
after their first 297 UTF-8 bytes. Their metadata stores distinct 64-byte SHA-256
keys. The script uses Wrangler authentication, performs no model inference, and
refuses non-eval index names. These provider fixtures are not production
backfill; actual corpus delivery uses the shared D1 outbox.

## Live 5,000-store result

`scale-5000.json` records complete delivery of 5,001 current heads (5,000 corpus
memories plus the seed), zero pending/failed rows, 75 genuine hybrid queries
with zero fallback, and 25/25 project/all-tag ANN inclusion checks.
The existing `relativesOf` rule from `evals/retrieval/rankings.mjs` counts a target
or its near-duplicate/superseded fixture copies as the claim, as ADR-0013 did.
Those copies are separate live fixture memory IDs, not old revision vectors in
the head namespace. Current-generation validation remains independently tested.

| Query kind | Exact target in top five | Claim in top five |
| --- | --- | --- |
| Exact title | 24/25 | 25/25 |
| Paraphrase | 16/25 | 17/25 |
| Project question | 17/25 | 22/25 |

This reproduces the accepted union's 25/17/22 claim counts using real Workers AI,
Vectorize ANN and Jev, not exact cosine over OpenRouter vectors. Stage latency
was 607 ms median, 1,061 ms p95 and 2,247 ms maximum through the local proxy.
The bulk attempt/retry artifacts remain alongside the successful report. These
operator drains do not measure deployed minute-cron freshness.

`index-info.json` records 5,115 visible vectors: 51 fifty-store heads, 5,001 scale
heads, 61 prefilter fixtures and two earlier synthetic provider fixtures.
Vectorize had processed through mutation `c55143af-fb39-4ea1-9db7-c3ec206bc3be`
at `2026-10-21T08:09:11.074Z`. Retried upserts did not create extra vector IDs.

## Failed attempts and corrections

- Vite's config hook changes vars after remote-binding discovery. An override
  there left the Vectorize binding local-only and delivery failed. The eval now
  generates an isolated Wrangler config before discovery.
- Secrets resolve beside that generated config. The first relocated setup had
  no Jev key and returned explicit lexical fallback; it was not scored as union.
- A five-second delivery timeout retained work and retried successfully later.
- Cold live bge-m3 requests exceeded the original one-second vector deadline.
  The vector stage now has 2.5 seconds, including ANN and hydration; Jev retains
  its independent 1.5-second deadline. One early Jev timeout also returned FTS.
  The passing 75-query run had no timeout or fallback.
- Two React Router dev servers in one checkout raced on generated type files
  during restart. The 50-store server was stopped before the scale server.
  Resource-specific generated config names also prevent cross-namespace rewrites.
- The first scale drain failed all 5,001 deliveries before any acceptance;
  `scale-5000-initial-failed.json` retains that negative result. A later isolated
  20-job retry accepted all 20. No precise provider/proxy cause is asserted.
  The probe now stops after a wholly failed page instead of processing the
  remaining paid allowance through a broken setup.
- The unpaced scale resume accepted 3,100 heads before a local proxy transport
  failure interrupted its HTTP drain. Durable pending state retained the rest.
  Mutation failures occurred during the unpaced load; no exact provider rate
  limit is asserted. Subsequent operator batches are paced; production runs only
  one bounded page per minute.

## Frozen fixture setup for model episodes

The existing runner re-seeds before measuring the store. That unrevisioned
loopback operation changes the default memory's update time and would invalidate
its immutable vector snapshot. `scripts/vector-eval-freeze.mjs` is a Node
preload, not a change to `evals/run.mjs` or `evals/harness.mjs`. It requires a
completed isolated backfill, verifies every requested fixture against the live
projection, and answers only the two setup requests without rewriting heads.
All MCP searches/fetches and model requests still execute against real services.
Its regression proves that altered fixtures are rejected and MCP calls forward.
`scripts/vector-eval-summary.mjs` leaves strict scores unchanged and recounts
terminal fetch requests using the same target/relative rule. Applied to the old
Jev run `2026-10-19T09-01-51`, it reproduces ADR-0013's 11/11/14 paraphrase claim
counts and 14/15 control. The existing runner ends before executing an accepted
terminal fetch; these are fetch-choice episodes, not proof of body consumption.

```sh
VALISE_MCP_URL=http://localhost:4475/mcp node --import ./scripts/vector-eval-freeze.mjs \
  evals/run.mjs --memories 5000 --rerank hybrid --repeat 3 \
  --case retrieval-contradiction-newest,retrieval-contradiction-brief,retrieval-paraphrase-logs,retrieval-paraphrase-dump,retrieval-paraphrase-homelab,retrieval-paraphrase-cost,retrieval-title-logs
```

## Repeated model episodes

Raw run `2026-10-21T08-35-20` has tool hash `d1451f8600f0`, store hash
`96f8afe18b7e`, six routine models, seven cases and three repeats: 126 episodes.
Sonnet was not included. Strict scores remain 37/126; target-or-relative terminal
fetch requests are 65/126. This is not an all-green model suite.

The four models shared with the older Jev run are Haiku, Gemini, Grok and Kimi.
Counts are claim fetch requests, with errors retained in the denominator:

| Case | Historical Jev/FTS, common four | Real ANN hybrid, common four |
| --- | --- | --- |
| Logs paraphrase | 8/12 | 12/12 |
| Homelab paraphrase | 8/12 | 11/12 |
| Cost paraphrase | 11/12 | 10/12 |
| Title control | 11/12 | 10/12 |
| Contradiction newest | 12/12 | 12/12 |
| Contradiction brief | 11/12 | 8/12 |
| Dump confound | 0/12 | 0/12 |

The three findable paraphrases reach 33/36 against historical 27/36. The two
cost misses and both control misses are Gemini 504s; every completed control
episode requested the claim. The brief case regressed and remains visible.
These are historical references, not a paired causal estimate on one tool hash.

Four OpenAI episodes failed with `400 No tool output found for function call`;
five Gemini episodes failed with provider 504s. The OpenRouter loop in
`evals/run.mjs` selects `message.tool_calls[0]` but appends the full assistant
message plus one tool output. Parallel calls can therefore leave an unanswered
call. That file is owned by the parallel harness agent and was not changed here.
There were also 14 capped episodes. Affected episodes need a bounded rerun after
the harness repair before claiming broad model coverage.

`model-search-calls.json` preserves 194 observed MCP search calls: 87 reranked,
105 empty and two lexical fallbacks (one 2.5-second vector timeout and one
provider error). Every empty search supplied a guessed nonexistent project;
70 used literal `*`, which is not a wildcard. Those are filter/tool-choice
failures, not missing indexed heads. The raw route arrays retain only 181
search labels; persisted call rows, not those arrays, are the call-count evidence.
Reranked stages measured 722 ms median, 1,155 ms p95 and 2,003 ms maximum.

The run reports $0.6492 in retained OpenRouter accounting. That is not a total
bill or spending ceiling: it excludes retrieval services and pre-error usage
can be missing when an episode throws. Raw errors and strict misses are retained.
Focused reports live outside `evals/runs/`; the console's existing full-run index
was restored byte-for-byte rather than making a partial matrix its newest run.

## Cleanup and deployment boundary

The local scheduled handler passed with `outcome: ok`, resumed a 50-source
checkpoint and reported 5,001 total, zero pending and zero failed. This is local
handler integration, not deployed cron evidence. `scheduled-handler.json`
records it.

Both eval dev servers were stopped. Only `valise-rollout-eval-20261021` was
deleted after retaining evidence; an account census then contained only the
new production index. `valise-memories-v1` was rechecked at zero vectors. The
temporary local Jev secret file and its ignored symlink were removed; the
workspace's authoritative credential stores and production secrets were untouched.

## Local integration gate

The initial full verify on pre-rebase `9025fe1` passed 146 D1, 247 MCP and 72
client tests, plus the UI server lifecycle tests, but only 91/92 browser tests.
The workbench primitive test stalled waiting for a `/login.data` POST response;
the trace shows a started fetch with no response, not a native `/login` POST.
The failed log and trace remain locally in `.wrangler/vector-rollout-verify-initial-failed.log`
and `.wrangler/vector-verify-initial-trace.zip`. It was a real gate failure.

Main then advanced to `83dde35`, including the single-worker Playwright fix
for files sharing one dev server/D1 store. The unpublished vector commits were
rebased onto that main without conflicts. No vector-branch UI/test workaround
or retry setting was added. The successful full gate must be recorded against
the resulting exact PR head; GitHub Actions billing is not part of that gate.

## Production gates

The binding/capacity PR deliberately keeps Jev-over-FTS. After its reviewed
merge, confirm Workers Build/deployment, migration 0021, completed namespace
backfill, no failed pending jobs, live current-head visibility and scoped recall.
Only then merge a separate hybrid-mode config change after reviewing retained
real-ANN and repeated retrieval evidence. Keep the rollout to-do open through
deployed verification; a provisioned index or accepted outbox is not completion.

## Production delivery and visibility

PR #145 merged as `9cb3d11`. Workers Build
`f91efba5-fdb2-409d-8625-f5c0ffa3b6f7` succeeded, migration 0021 was present,
and the deployed version `5c2a069c-4340-4887-adef-1c6e19f451d3` carried the
production index and namespace without a hybrid-mode setting. Smoke passed.

Read-only D1 observations saw the scheduled backfill checkpoint first at
09:24 UTC, scan completion at 09:25, and zero pending/failed jobs at 09:28:15.
The ledger held 79 heads and three historical generations. Three live memories
had arrived since the initial 76-memory census. No operator drain, production
fixture, manual vector write or laptop deployment was used.

A stamp calculated from one accepted authoritative head was queried against
the deployed index. The head appeared in the base namespace's top 50; combined
project and `docKey` prefilters returned only that head. The historical namespace
returned three other generations, excluding the head; an unrelated namespace
returned zero. The index-info endpoint still reported zero vectors while these
actual queries returned data, so its count was not used as a visibility gate.
Aggregate backfill and metadata-only query evidence remain in the operator's
private `valise-vector-production-{backfill,visibility}.json` files, not a
production-content export in this repository.

The four common-model brief-case misses were also inspected. Each answered
the correct current fixture model, `embeddinggemma-300m`, but omitted the
required fetch. They remain strict failures. This distinguishes the recorded
fetch-route regression from a wrong-answer or missing-candidate regression;
it does not turn the historical comparison into a paired experiment.

## Repaired-protocol compatibility reruns

PR #146 repairs the unanswered parallel-call protocol. The affected four errors
represent three model/case pairs; each was rerun three times on a fresh 50-memory
hybrid store, not the original 5,000-memory condition. All nine episodes completed
without provider or protocol errors. Two Luna episodes continued after real
three-call batches. Strict scores remain 0/9, with five caps: all 38 model
searches guessed nonexistent projects and returned empty. The runner repair
does not repair that tool-choice behavior or establish improved model quality.

Separate controls without invented projects recorded three genuine hybrid MCP
reranks. The repeated 50-store probe passed all 75 genuine hybrid queries and
25 scoped checks, with no fallback. The original 5,000-store scores/errors remain
unchanged and are not pooled with these smaller-store reruns. The complete
selection, route calls, control observations, cost limits and disposable-resource
cleanup are in `evals/retrieval/hybrid-protocol-rerun-2026-10-21/README.md`.
