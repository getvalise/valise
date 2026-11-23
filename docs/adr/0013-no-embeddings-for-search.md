# 0013. Search stays BM25 only; vectors did not earn a second index

Date: 2026-10-18
Status: accepted

## Context

The v1 spec settled "BM25 only, no embeddings" before any store was large
enough to test it. Cloudflare serves the parts for hybrid search: Workers AI
embedding models (`bge-base-en-v1.5`, `bge-m3`) and Vectorize. The open
question was whether FTS fails a case that matters, and what vectors would
buy back.

Four measurements, all on the 5000-memory store `evals/retrieval/corpus.ts`
builds (store hash `0b7b26c3f7b5`). Each of the 25 labelled targets has six
copies in that store: three near-duplicates and three superseded versions.
"The claim" below means the target or one of its copies.

FTS alone, `test/d1/retrieval.worker.test.ts`, target in the top five out of
25: exact title 25, paraphrase 4, project-scoped question 7. A paraphrase
shares almost no content words with the memory. The ANDed query matches
nothing, the ORed fallback matches on filler words, and 5000 documents share
those.

Vectors on the same queries, `evals/retrieval/vectors.mjs`, claim in the top
five out of 25. Hybrid is reciprocal rank fusion of the FTS top 50 and the
vector top 50:

| Model | Served by Workers AI | Paraphrase, vector | Paraphrase, hybrid | Project question, vector | Project question, hybrid |
| --- | --- | --- | --- | --- | --- |
| `bge-base-en-v1.5` | yes | 7 | 10 | 14 | 15 |
| `bge-m3` | yes | 14 | 12 | 19 | 16 |
| `text-embedding-3-large` | no | 18 | 13 | 20 | 16 |

FTS on the same rows is 4 and 9. Every model holds exact titles at 24 or 25.
Reruns move a cell by one, because the provider is not deterministic.

A model in the loop, with FTS only. Cases `retrieval-paraphrase-*` send the
fixture paraphrase as the user's request and expect a `fetch` of the target.
`retrieval-title-logs` is the control, the same target asked in its own words.
Runs `2026-10-18T15-50-20` (seven models, n=1) and `2026-10-18T16-01-05`
(Haiku, Gemini, Grok and Kimi, n=3). Counting Sonnet, Haiku, Gemini, Grok and
Kimi, which is 17 episodes per case. The counts are re-read from the ids each
episode fetched, mapped through `buildCorpus`, so a copy of the target counts
as found. They differ from the scores in the run reports, which credit only
the exact id:

| Case | Fetched the claim | What the rest did |
| --- | --- | --- |
| `retrieval-paraphrase-homelab` | 15 | searched and stopped, or ran out of rounds |
| `retrieval-paraphrase-dump` | 17 | 16 fetched a docs memory stating the same fact, which the case counts as wrong |
| `retrieval-paraphrase-cost` | 10 | fetched a different eval note, or ran out of rounds |
| `retrieval-paraphrase-logs` | 8 | fetched a nightly-cron memory or the logs-tab ADR |
| `retrieval-title-logs` (control) | 16 of 16 | one row errored |

Models mostly search with the user's own words. When the first search
misses, they rewrite: a guessed project filter (`homelab`), a guessed term
(`NAS`), or words lifted from the snippets of the miss. That covered 50 of
68 paraphrase episodes, or 33 of 51 without the confounded dump case. Hybrid search on the same four paraphrases, with no
model, put the claim in the top five for none of them with
`bge-base-en-v1.5` or `text-embedding-3-large`, and for one with `bge-m3`.
gpt-5.4-mini and gpt-6-luna failed the control too: they fill
`project` with guesses such as `"*"`, `"default"` and `"home"`, and the
exact-match filter returns nothing. Vectors do not reach that failure.

## Decision

Search stays one BM25 query over the projection, as ADR-0001 has it. No
embedding call on save, and no vector index.

The hybrid shape the question proposed was FTS for ids, names and exact
terms, and vectors for paraphrase. It does the job worse than either half
alone. With either model Workers AI serves, fusion moves paraphrase recall
from 4 to 10 or 12 of 25. Through a model, FTS already reaches the claim on
roughly two paraphrase episodes in three. With `bge-m3`, fusion scores below
vectors alone, because FTS's filler-word matches take the fused top five.
ADR-0001 rejected rank fusion across indexes for the same reason: scores
from two rankings do not compare.

## Consequences

Not paid:

- An embedding call on every `save_memory` and every revision. Revisions are
  append-only, so each one needs its own vector, and the search head would
  have to follow the latest.
- A second index that cannot share the projection's batch. A Vectorize
  upsert is a network call, not a D1 statement, so the "authoritative write
  and projection in one `db.batch`" rule in ADR-0001 would no longer hold for
  it. It would need a queue or the weekly reconciliation to catch up, and a
  failed embed would leave a memory findable by words but not by meaning.
- A reindex at 5000 memories. `vectors.mjs` embeds the store in 0.50 to 0.61
  million tokens. In batches of 128 that took 101 seconds with
  `bge-base-en-v1.5`, 115 with `bge-m3`, and 142 with
  `text-embedding-3-large`, at $0.003, $0.006 and $0.065 through OpenRouter.
  The FTS rebuild is one statement.
- A backup gap. D1 export cannot include a Vectorize index. The index would
  be rebuilt from the authoritative tables, as the FTS index is now.

Given up: a paraphrase with no shared word and no guessable term still
misses. `retrieval-paraphrase-logs` is the case to watch. "Where can I see
what the nightly job printed yesterday" never reached "Past Worker logs are
readable in the Cloudflare dashboard" in hybrid with any embedding model
either. Two of five capable models instead fetched a memory about the
nightly backup cron, which shares the word "nightly". A confident wrong
fetch is worse than an empty result, and vectors do not fix it.

What the numbers point at instead, each cheaper than an index:

- The superseded copy with the same title ranks first about half the time
  from 500 memories on. BM25 does not see dates, and ADR-0012's `supersedes`
  link unpublishes the old copy.
- Guessed `project` values empty the result for two OpenAI models. That is a
  tool-description or filter-semantics change, with
  `retrieval-contradiction-newest` and `retrieval-title-logs` to score it.

Reopened by a save-time similarity check that misses a restated memory. The
check-on-save line, "similar memories exist", compares a new memory with the
store. No model rewrites that query, so it is a paraphrase with no rescue,
and it is where vectors would have to earn their place. The README's open
questions carry it.

## Amendment, 2026-10-18: a reranker over FTS candidates earns its call

The decision above rejected one hybrid shape, rank fusion, which never reads
the text. Retrieve-then-rerank does: a first stage collects candidates, and a
reranker scores each (query, memory) pair. `evals/retrieval/rerank.mjs`
measured it on the same 5000 memories, 25 targets and top-five count. The
store hash is `c91f41e639e0`: the memories are those of `0b7b26c3f7b5`, and
the capture-this skill, which the hash also covers, changed in between.

Candidates are the FTS top 50 alone (34 memories on average, since the ANDed
query often matches fewer), or unioned with the `bge-m3` top 50 (78). Three
rerankers run on Workers AI. `bge-reranker-base` is a cross-encoder. Clef and
Clef-flash are decision models, and so is Jev, which TypeSafe hosts and which
runs in batches of 30 as `hev/jev-rerank` does. Each decision model gets one
yes-or-no relevance question per candidate, a `noul` question worded as in
`hev/jev-rerank`'s `prompt.yaml`, and the score is the probability of yes,
read from the answer's `noul` field. Every reranker cell ran twice. Both runs
agreed everywhere but one Jev cell, which shows both.

A reranker cannot surface what the first stage missed. The claim anywhere in
the candidates, out of 25:

| Candidates | Exact title | Paraphrase | Project question |
| --- | --- | --- | --- |
| FTS top 50 | 25 | 9 | 17 |
| FTS top 50 + `bge-m3` top 50 | 25 | 17 | 22 |

The claim in the top five, then the exact id, out of 25:

| Ranking | Exact title | Paraphrase | Project question |
| --- | --- | --- | --- |
| FTS alone | 25 · 25 | 4 · 4 | 9 · 7 |
| `bge-m3` alone | 25 · 24 | 14 · 9 | 19 · 12 |
| FTS 50 → `bge-reranker-base` | 25 · 25 | 9 · 8 | 15 · 9 |
| FTS 50 → Clef | 25 · 25 | 9 · 9 | 17 · 15 |
| FTS 50 → Clef-flash | 25 · 25 | 9 · 8 | 17 · 13 |
| FTS 50 → Jev | 25 · 25 | 9 · 9 / 9 · 8 | 17 · 15 |
| FTS 50 + `bge-m3` 50 → `bge-reranker-base` | 25 · 24 | 11 · 9 | 14 · 8 |
| FTS 50 + `bge-m3` 50 → Clef | 25 · 22 | 17 · 16 | 22 · 19 |
| FTS 50 + `bge-m3` 50 → Clef-flash | 25 · 20 | 16 · 14 | 20 · 17 |
| FTS 50 + `bge-m3` 50 → Jev | 25 · 24 | 17 · 16 | 21 · 18 |

Clef puts every claim its candidates hold into the top five, in every cell.
Over FTS candidates the paraphrase count doubles and the project questions
nearly do, with no index. The 16 paraphrases still missed have no copy of
the claim in the FTS top 50 at all. Jev ties Clef over FTS candidates and
loses one project question over the union, so it adds no hits Clef lacks.

Per search, over all 75 queries and both runs. Latency for the Workers AI
rows is what the dev Worker measured around the AI call, through wrangler's
proxy from a laptop, so a deployed Worker should see less. Jev's
is the laptop calling TypeSafe directly, its batches in parallel, with no
proxy hop, so the two are not like for like. Cost is the input-token price on
each model's Workers AI page, and for Jev the $0.042 per million input tokens
on https://docs.typesafe.ai/models; `bge-reranker-base` reports no usage, so
its tokens are estimated at four characters each:

| Reranker | Candidates | Median | p95 | Input tokens | Per 1000 searches |
| --- | --- | --- | --- | --- | --- |
| `bge-reranker-base` | FTS 50 | 427 ms | 686 ms | 4,107 | $0.013 |
| `bge-reranker-base` | FTS + `bge-m3` | 667 ms | 1,010 ms | 9,493 | $0.030 |
| Clef | FTS 50 | 1,162 ms | 1,576 ms | 7,770 | $1.86 |
| Clef | FTS + `bge-m3` | 1,325 ms | 1,849 ms | 17,657 | $4.24 |
| Clef-flash | FTS 50 | 2,375 ms | 2,670 ms | 7,770 | $0.30 |
| Clef-flash | FTS + `bge-m3` | 2,439 ms | 2,695 ms | 17,657 | $0.67 |
| Jev | FTS 50 | 454 ms | 648 ms | 7,175 | $0.30 |
| Jev | FTS + `bge-m3` | 775 ms | 1,041 ms | 16,200 | $0.68 |

The union with Clef passed 15 paraphrases, so the paraphrase cases ran with a
model in the loop. `VALISE_RERANK=fts` or `hybrid` on the dev server reranks
the MCP `search` tool with Clef. Sonnet, Haiku, Gemini, Grok and Kimi,
`--repeat 3`, 15 episodes per case, the claim fetched, re-read from the ids
through `buildCorpus` as above:

| `search` | `logs` | `homelab` | `cost` | `dump` | Control | Turns per episode | Out of rounds |
| --- | --- | --- | --- | --- | --- | --- | --- |
| FTS, run `2026-10-18T21-28-32` | 7 | 11 | 10 | 0 | 15 | 2.56 | 5 |
| FTS 50 → Clef, `2026-10-18T21-19-04` | 11 | 13 | 13 | 0 | 15 | 2.40 | 1 |
| FTS 50 + `bge-m3` 50 → Clef, `2026-10-18T21-08-12` | 15 | 15 | 15 | 0 | 15 | 2.08 | 0 |

Over the three cases with a findable claim, models reach it in 28 of 45
episodes on FTS, 37 with the reranker, and 45 with vectors and the reranker.
`retrieval-paraphrase-logs`, the case the decision above gave up on, goes
from 7 to 11 to 15. Every arm fetched a docs memory stating the same fact on
`dump`, as before, which no ranking changes.

The same five models and cases with `search` reranked by Jev, as production
runs it, counted the same way:

| `search` | `logs` | `homelab` | `cost` | `dump` | Control | Turns per episode | Out of rounds |
| --- | --- | --- | --- | --- | --- | --- | --- |
| FTS 50 → Jev, `2026-10-19T09-01-51` | 11 | 11 | 14 | 0 | 14 | 2.40 | 5 |

That is 36 of 45 on the three findable cases, against 28 on FTS and 37 with
Clef. Three episodes ended on a 504 from Gemini's provider rather than in a
fetch, one of them the control's only miss, so the control held on every
episode that finished. Over the 124 searches in that run the rerank stage
took 264 ms median, 403 ms p95 and 752 ms at most, measured by the dev
Worker around the TypeSafe call; none fell back. Two searches matched
nothing in FTS, so there was nothing to rerank.

### Decision

Shipped 2026-10-19: `search` reranks the FTS top 50 with Jev whenever the
Worker holds the `TYPESAFE_API_KEY` secret, and returns the reranked order.
Jev, not Clef: the two tie on every measured cell, and Jev costs $0.30 per
1000 searches against Clef's $1.86. The vector
index stays out. The union is the best shape measured, but it pays every item
under "Not paid" above, and the reranker over FTS alone recovers 8 of the 17
episodes FTS lost while paying one: a model call on every search. Nothing on
the write path changes, so ADR-0001's batch rule, reindex and backups are
untouched. The 2026-10-19 depth amendment below keeps 50 for the FTS half.

How it runs, `app/search/rerank.ts`:

- The FTS top 50 go to TypeSafe's `/v1/systemone` with model `jev-latest`,
  30 documents per call and the calls in parallel, one `noul` question per
  document as above. A limit past 50 gets the FTS hits below 50 after the
  reranked ones.
- The stage has 1.5 s, `JEV_TIMEOUT_MS`, through one `AbortSignal.timeout`
  shared by every call and retry. That is more than twice the 0.65 s p95
  measured from a laptop. A 429 or 529 retries inside it, backing off from
  100 ms and doubling, as TypeSafe asks.
- Anything else returns the FTS order: a missing key, a network error, any
  other status, an answer without a `noul` score, or the timeout. A failed
  rerank never fails the search.
- `VALISE_RERANK` picks the reranker. Unset, it is Jev when the key is set
  and FTS when it is not, so setting the secret is the switch, and an empty
  secret turns it off. `off` forces FTS order, which is how an eval measures
  the baseline on a machine that holds the key. `fts` and `hybrid` keep the
  Clef experiment for the dev server.
- The search result carries `_meta["valise/rerank"]`: the backend, whether
  the order is the reranker's, the stage's milliseconds, and why it fell
  back. `observeCall` copies it into `mcp_calls.rerank_json`, and the logs
  tab shows it on the row and in the call pane, so production and an eval
  transcript say the same thing about what a search did. ADR-0006.
- `test/mcp/rerank.worker.test.ts` stubs TypeSafe: a reorder, a 429 then
  success, a 401 and a timeout that both return FTS order and record why,
  and no call without a key. Ranking quality stays an eval measurement.

What it costs:

- Latency on every search with a hit: about 0.26 s median from the dev
  Worker, capped at 1.5 s.
- About $0.30 per 1000 searches at TypeSafe's input-token price.
- A third-party dependency in the read path, which the fallback contains.
- Where memory bodies go. On Workers AI they would stay with Cloudflare,
  which "does not retain inputs or outputs" of standard inference requests
  and "does not use Customer Content processed by Workers AI to train AI
  models" (https://developers.cloudflare.com/workers-ai/platform/data-usage/).
  With Jev, the title and body of up to 50 memories leave Cloudflare for
  TypeSafe on every search. TypeSafe says Jev is not trained on customer
  requests, and offers zero data retention to enterprise customers only
  (https://docs.typesafe.ai/models). The owner accepted that for this
  workspace. A workspace with stricter rules sets no key, or runs Clef.

Still open:

- An honest empty result. Jev's score is a probability, so a threshold could
  return nothing rather than a confident wrong fetch. Not measured.
- No hosted ceiling was run. OpenRouter serves Cohere, Voyage and Qwen3
  rerankers on `/api/v1/rerank`, but this account's allowed providers exclude
  all of them.

## Amendment, 2026-10-19: candidate depth

The amendment above measured one depth, 50 per side. Depth sets the cost,
because a reranker bills per candidate token, and it sets the ceiling,
because a reranker cannot lift what the candidates lack.
`evals/retrieval/rerank.mjs --depth 10,20,30,50` measured both on the same
store, `c91f41e639e0` at 5000 memories, with Clef, Jev and
`bge-reranker-base`. Clef-flash is left out: a later probe found it about
twice as slow per input token as Clef from this account, and it ranks
differently. Every reranker cell ran twice.

The claim, as paraphrase · project question, out of 25. Recall is the claim
anywhere in the candidates; a reranker column is the claim in its top five.
Exact titles hold at 25 in every cell. Latency is the dev Worker around the
AI call through wrangler's proxy for Clef and `bge-reranker-base`, and the
laptop calling TypeSafe directly for Jev, as above. Cost is input tokens at
$0.24 per million for Clef, $0.042 for Jev and $0.0031 for
`bge-reranker-base`, whose tokens are estimated at four characters each:

| Candidates | Mean size | Recall | Clef | Jev | `bge-reranker-base` | Input tokens, Clef · Jev · bge | Median ms, Clef · Jev · bge | Per 1000 searches, Clef · Jev · bge |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| FTS 10 | 8 | 6 · 11 | 6 · 11 | 6 · 11 | 6 · 11 | 1,869 · 1,839 · 939 | 313 · 241 · 261 | $0.45 · $0.077 · $0.0029 |
| FTS 10 + `bge-m3` 10 | 15 | 15 · 20 | 15 · 20 | 15 · 20 | 14 · 17 | 3,395 · 3,166 · 1,738 | 413 · 241 · 256 | $0.81 · $0.13 · $0.0054 |
| FTS 20 | 15 | 7 · 14 | 7 · 14 | 7 · 14 | 7 · 13 | 3,338 · 3,121 · 1,730 | 459 · 244 · 298 | $0.80 · $0.13 · $0.0054 |
| FTS 20 + `bge-m3` 20 | 31 | 16 · 20 | 16 · 20 | 16 · 20 | 12 · 16 | 6,926 · 6,431 · 3,652 | 764 · 480 · 365 | $1.66 · $0.27 · $0.011 |
| FTS 30 | 21 | 9 · 15 | 9 · 15 | 9 · 15 | 9 · 15 | 4,807 · 4,402 · 2,514 | 642 · 259 · 347 | $1.15 · $0.18 · $0.0078 |
| FTS 30 + `bge-m3` 30 | 46 | 17 · 20 | 17 · 20 | 17 · 20 | 12 · 14 | 10,453 · 9,485 · 5,547 | 1,097 · 507 · 480 | $2.51 · $0.40 · $0.017 |
| FTS 50 | 34 | 9 · 17 | 9 · 17 | 9 · 17 | 9 · 15 | 7,770 · 7,175 · 4,107 | 1,141 · 501 · 420 | $1.86 · $0.30 · $0.013 |
| FTS 50 + `bge-m3` 50 | 78 | 17 · 22 | 17 · 22 | 17 · 21 / 17 · 22 | 11 · 14 | 17,657 · 16,202 · 9,493 | 1,280 · 855 · 687 | $4.24 · $0.68 · $0.030 |

The two runs never differed by more than one hit. Only one claim cell
differed at all, Jev over the union at 50 on project questions, which shows
both runs.

Clef and Jev put every claim the candidates hold into the top five at every
depth, so recall is the whole story for them. `bge-reranker-base` gets worse
over the union as it grows, from 14 · 17 at 10 to 11 · 14 at 50: the vector
half adds candidates it ranks above the claim.

### Decision

The union keeps 50 per side. It is the only measured depth within one hit of
the 50-per-side recall on both paraphrases and project questions: 10, 20 and
30 each hold 15 to 17 paraphrases but stop at 20 project questions against
22. At 50 a search costs $4.24 per 1000 with Clef, $0.68 with Jev and $0.030
with `bge-reranker-base`. `DEPTH` in `app/search/rerank.ts` is already 50, so
nothing live changes.

Two readings for whoever picks the union up. A recall-only pass at 35, 40
and 45 found the two missing project questions enter between 40 and 45, so
the whole gap between 30 and 50 is two of 25 queries. And the union at 10 already
beats FTS 50 → Clef on both kinds, 15 · 20 against 9 · 17, at $0.81 per 1000
searches against $1.86, so a cost-bound rollout should start there rather
than at FTS alone.

## Amendment, 2026-10-19: current-head vector read boundary

Status: read path and durable delivery implemented locally; rollout blocked.
This unit provisions no Vectorize binding or index. Production's default Jev-over-FTS
path is unchanged. This does not establish the measured union recall in a live
Vectorize index.

Amended 2026-10-20: the supporting implementation shipped in PR #134. Live
bge-m3 text input, 1024-dimensional output, Vectorize metadata/namespace output,
same-ID moves between head/history, isolation and eventual deletion now pass a
synthetic disposable-index probe. `docs/operations/vector-rebuild.md` records
mutation IDs and observed visibility delays. That index was deleted; production
remains unprovisioned. Capacity, backfill and scoped recall are remaining rollout
work, not a pending architecture decision or GitHub Actions billing blocker.

`VALISE_RERANK=hybrid` uses Jev over the FTS top 50 plus up to 50 Vectorize
memory candidates. It needs `TYPESAFE_API_KEY`, `AI`, optional `VECTOR_INDEX`,
and a fixed `VALISE_VECTOR_NAMESPACE` belonging to the deployment's workspace.
It never embeds a store during search or GET `/__dev/rerank`. The latter
answers 503 for an unconfigured hybrid mode so the eval runner cannot label a
lexical-only fallback as a union run. `fts` keeps the Clef-over-FTS experiment;
`jev` and the unset mode remain Jev over FTS, and `off` remains plain FTS.

`app/search/vectors.ts` defines the envelope. A vector's id is its 64-character
SHA-256 stamp. Its namespace is the fixed workspace partition; its metadata
contains `docKey` and `stamp`, not memory text. The stamp covers a format version,
the bge-m3 model, namespace, doc key, live generation, and every projected head
field. Memory revisions snapshot the pre-edit head, so the live generation is
`1 + MAX(memory_revisions.revision)`, or 1 before the first edit. This rejects
same-second edits and identical-content revisions without depending on timestamp
uniqueness. A body-only digest would not detect project moves or changed tags.

Vectorize is not authority. Each returned reference must have the expected
namespace and id/stamp format. One bounded D1 query hydrates current live memory
heads that are still published in `search_index`; their generation and freshly
computed projection must match the stamp. D1 also enforces the requested project
and every tag. Skills and to-dos stay lexical. Vector candidates keep that
validated D1 snapshot through reranking, and the lexical tail excludes keys
already in the union. As with lexical search, a concurrent edit after the D1
read can change the head before the caller fetches it; search is not a lock.

The vector stage has 1 second including query embedding, ANN retrieval and
hydration. It aborts the AI request on timeout. Vectorize's query binding has no
abort parameter, so a late answer is ignored before hydration. A query embedding
must be exactly one finite, nonzero, 1024-dimensional vector. A missing capability,
invalid embedding, timeout or service error returns FTS order. A reranker failure
does the same; failures never expose error messages containing memory text.

The D1 database is workspace-wide, with no per-memory owner column. Provenance
is not ownership; neither project nor a caller's user id selects a namespace.
Sharing one database between independent tenants requires an ownership model
first. Separate deployments sharing a Vectorize index require distinct stable
namespaces and namespace-covered vector ids. Reusing a namespace across unrelated
databases is a deployment error, not supported tenant isolation.

### Delivery and rebuild, implemented locally

The delivery unit uses the existing nightly cron and a D1 outbox, not Queues.
A bare post-commit Queue send loses work if the Worker stops after commit but
before sending. A Queue plus outbox would close that gap but add provisioning,
a second consumer and duplicate retry state. At personal scale the outbox alone
is smaller. No request starts untracked asynchronous delivery.

Migration `0019_vector_outbox.sql` adds `vector_snapshots` and `vector_pending`.
`memoryProjectionStatements` appends snapshots and pending statements to the
same batch as authoritative content, revision insertion, links and FTS. The
partial-edit transaction and supersession publication rules are unchanged.
The shared `memorySourceSql` maps authoritative rows identically for FTS and
snapshot capture, including UTF-8 truncation and embedded NUL. Before an edit
or archive, the batch captures any missing pre-change generation too.

Snapshots are keyed by memory and generation and never overwritten. Their
projection retains original routing and timestamp fields even after another
edit. Capturing is independent of whether an index is configured or the memory
is superseded. Pending rows are keyed by base namespace, memory and generation;
their target is `head`, `history` or `delete`. A publication change increments
that row's epoch. Changes also invalidate previously used namespaces if vector
configuration is temporarily absent. Adding a namespace requires a backfill.

There is one vector id per snapshot and base namespace: its immutable stamp.
The currently published generation belongs to the base namespace; older or
superseded generations belong to `h:<base>`. Upsert replaces the vector's
namespace, so history stops consuming head top-50 slots after catch-up. Base
namespaces must be deployment-owned, at most 62 UTF-8 bytes, and allocated
together with their `h:` partition. Archives target deletion of every recorded
generation, including history. Snapshots and completed tombstones remain in D1;
they are not removed when Vectorize accepts a mutation. Confirming/removing a
supersession and archiving its successor update predecessor delivery state in
the same publication batch. D1 rejects unpublished vectors immediately, before
any external cleanup lands.

`drainVectors` attempts at most 20 jobs per invocation. Each is claimed with a
random token and a 120-second D1 lease; a crashed worker's lease expires. The
embedding call has a 5-second abort signal. Errors retain work and back off
from 60 seconds, doubling to a maximum of one day. Error storage contains a
fixed code, never provider messages or memory text. Completion compares the
lease token and exact epoch. An edit/archive racing an old upsert leaves a dirty
epoch. A late worker that lost its lease reopens repair work rather than clearing
the newer result. Deterministic ids make repeated upserts/deletes idempotent.
The cron logs accepted deliveries, pending rows and failed rows. There is no
terminal retry count: persistent failures remain visible and retryable.

Accepted rows become eligible for a bounded repair pass after one day. This
also repairs an ambiguous remote write whose worker died after losing its
lease, before it could report the late mutation. Dirty work has a zero/earlier
due time and runs ahead of settled repair work. Repairs re-embed head/history
rows and repeat deletes; they share the same 20-job bound, not an unbounded
nightly full-store sweep. This recurring inference must be included in the
rollout's capacity and cost decision.

Vectorize operations acknowledge durable acceptance, not ANN visibility. They
have no binding cancellation parameter; the batch bounds job count, not total
wall time. The runtime lease and D1 validation establish local recovery and read
safety, not external mutation ordering. Authorized live proof must include
same-id namespace moves, delayed/duplicate mutations and visibility after a
crash before rollout. No contract double establishes those facts.

The unchanged `0 4 * * *` cron gives at most 20 attempts per day. A backlog of
5000 generations would take at least 250 runs without operator drains. This is
a recovery mechanism, not an acceptable production freshness promise. A shorter
schedule or Queue delivery and a measured lag bound remain rollout blockers.

`node scripts/reindex.mjs --vectors` rebuilds memory publication and enqueues
heads and append-only revisions in resumable pages of 50 sources. It does not
call a model or mutate Vectorize. `--all --vectors` first rebuilds every lexical
concept. The reported cursor can resume POST `/__dev/vectors?after=<cursor>`;
restarting the script from the beginning is idempotent. `--vectors --drain`
explicitly attempts one provider batch after enqueueing; it does not silently
loop through paid inference. `pending: 0` means accepted, never proof of query
visibility or retrieval quality. These routes remain loopback-only and writes
require POST.

Backups name authoritative D1 tables, including `memory_revisions` and
`memory_links`, not Vectorize or `vector_pending`. Including `vector_snapshots`
preserves exact historical stamps; without them backfill reconstructs history
from immutable revisions. Revision project is retained when recorded; a legacy
null stays null. Revision `created_at` is the snapshot time, not the original
head update time, so reconstructed historical stamps need not match an old index.
No revision row is rewritten. Restore rebuilds FTS first and enqueues all
generations into a fresh index/base namespace, never a reused index carrying
unrecorded stale vectors. See `docs/operations/vector-rebuild.md`.

### Open questions

`test/d1/vector-candidates.worker.test.ts` runs in workerd with real D1 and real
memory save/edit/archive paths. It covers vector-only and union hits, current
generation validation, archives/missing heads, workspace isolation, filters,
malformed embeddings, missing capabilities, timeouts, service failures, and a
deduplicated lexical tail. AI, Vectorize and Jev are external contract doubles;
these tests establish neither live service integration nor ranking quality.

The earlier vector evidence used exact cosine over OpenRouter embeddings, not
Vectorize ANN. The read boundary currently post-filters namespace top 50 in D1;
this is safe but can underfill scoped searches. It does not promise the same
recall as prefiltering the entire corpus before top 50. Before rollout, settle
metadata indexing/prefilter semantics (including 100-character tags/projects),
real bge-m3 input/output compatibility, and real Vectorize
namespace/metadata return shape. The current bge-m3 docs' usage example uses
`text`, while their linked raw schemas describe an asynchronous response; the
adapter rejects that response rather than treating it as vectors.

Enabling the hybrid mode forces these decisions and checks. They remain open
because an authorized index/backfill and live provider checks are not
part of this unit. The intended index is 1024-dimensional cosine; no current
account/index configuration has been inspected or certified here.

`test/d1/vector-delivery.worker.test.ts` adds real D1/workerd recovery, atomic
rollback, duplicate and reordered delivery, stale same-second edits, archive
tombstones, history routing, namespace isolation, supersession and paginated
backfill regressions. External services remain doubles. Local schema and
backfill code are implemented; no remote service check, paid batch, index
creation, production backfill, deploy or `retrieval-* --repeat 3` run is claimed.
Keep the ticket open until live integration, the delivery lag decision, retrieval
floors over a real union and paid retrieval episodes have evidence.

## Amendment, 2026-10-21: rollout capacity and scoped candidates

The rollout keeps the D1 outbox and adds a dedicated minute cron. Each tick
attempts 20 jobs with concurrency four; existing leases, five-second provider
deadlines, epoch fencing, 60-second-to-one-day backoff and daily repair remain.
Nightly jobs retain their schedule. Nominal capacity is 28,800 attempts/day;
5,000 daily repairs leave 23,800 for writes/retries. Queue age and acceptance
are reported separately from ANN visibility. Five minutes is the healthy-store
backlog investigation threshold, not a provider-outage SLA. The operations
guide records capacity and bounded recurring cost estimates.

Full outbox counters are sampled every five minutes, while delivery attempts
are logged each minute. At 5,000 generations that bounds the steady telemetry
scan to 1.44 million D1 rows/day rather than 7.2 million. Unsampled ticks omit
the counters explicitly; zero and not measured are different states. Initial
backfill pages and explicit operator drains still return full status.

Migration 0021 adds enqueue/acceptance timestamps and a per-namespace resumable
backfill checkpoint. The minute handler calls the existing 50-source backfill
and shared snapshot/publication outbox, then drains one page. No separate
import path or hand-written production vector upsert is introduced. Completed
scans stay complete; ordinary atomic application writes enqueue new heads.

Scoped ANN prefilters projects using an indexed SHA-256 key, avoiding
Vectorize's 64-byte string-index truncation of 100-character project names.
For all-tag queries D1 selects published eligible keys first, then Vectorize
queries indexed `docKey` partitions of 32 and merges by cosine score before
top 50. This supports full-length Unicode tags without assuming array-index
semantics. Fan-out is bounded at eight queries/256 eligible heads under the
same 2.5-second deadline. Broader tag scopes explicitly return FTS fallback,
not a silently underfilled global top 50. D1 freshness/publication and every
filter are still checked after ANN. Skills and to-dos remain lexical.

The provisioned production index is `valise-memories-v1`, 1024/cosine, with
string metadata indexes `project` and `docKey`. Its reserved base namespace
is `valise-prod-v1`. Provisioning alone does not bind, backfill or activate it;
runtime changes are reviewed merges deployed by Workers Builds. Binding and
capacity deliberately retain Jev-over-FTS. Hybrid activation is a separate
config merge after live recall, repeated retrieval episodes, backfill and
visibility evidence. Keep the ticket open through that gate.

The original one-second vector deadline timed out on cold live bge-m3 calls
through the local remote-binding proxy. The rollout raises it to 2.5 seconds,
including embedding, ANN and hydration; the Jev stage retains its separate
1.5-second bound. A timeout still returns lexical order. This is a bounded
latency tradeoff, not evidence that every production request finishes in time.

## Amendment, 2026-10-21: production hybrid mode

Select `VALISE_RERANK=hybrid` for production. Real Workers AI, Vectorize and
Jev reproduce the accepted union's 25/17/22 claim counts at 5,000 memories;
the 50-memory floors and all 25 project/all-tag checks pass at both sizes.
The repeated model episodes improve the common-four findable paraphrases from
27/36 to 33/36, with errors retained. Their brief-case fetch count regresses,
although the four missed common-model episodes answer the correct fixture fact
without fetching. Neither those failures nor provider/protocol errors are
relabeled as an all-green suite. The report records each limitation.

After the parallel-call repair, nine affected-case compatibility episodes at
50 memories have zero protocol/provider errors but zero strict passes: guessed
nonexistent project filters empty every search. Separate valid-scope controls
and the repeated 50-store floors genuinely rerank. These observations isolate
the remaining tool-choice issue; they do not replace the 5,000-store quality
condition or relax its scoring. The activation accepts the measured union
recall gain, not a claim that vectors fix invented filters or every model route.

PR #145's binding/capacity deployment completed its automatic namespace
backfill with 79 heads, three historical generations, zero pending/failed
jobs, and actual scoped/current-head query visibility before this mode change.
`docs/research/2026-10-21-vector-rollout.md` records the production observations.
The authoritative/FTS write batch, append-only revisions, repair ledger and
lexical failure fallback are unchanged. Wider tag scopes retain the explicit
256-head fallback boundary. Roll mode back to `jev` through a verified PR if
production regresses; preserve the index and ledger for diagnosis and repair.

## Amendment, 2026-10-23: explicit self-host search choices

Independent installations select `VALISE_RERANK=lexical`, `clef` or `jev` at
setup. `lexical` runs BM25 without an inference binding or key. `clef` reranks
the lexical top 50 with `@cf/cloudflare/clef` on Workers AI. `jev` reranks the
same candidates on TypeSafe and is the only setup choice requiring
`TYPESAFE_API_KEY`. Setup provisions no vectors and no minute outbox cron.

Keep the old `off` and `fts` names for existing evals and installations;
`fts` still means Clef, not lexical-only search. Unset still selects Jev when
a key exists. Production's explicit `hybrid` mode is unchanged. These are
configuration names, not new ranking algorithms or new quality measurements.

`scripts/first-deploy.sh` now prepares an independent installation rather than
deploying from a laptop. It saves account, app, discovered Workers subdomain
and a random installation suffix before provisioning. Resources are found by
those exact names on retry, including after a lost create response. A saved
resource that disappears is an error, not permission to create an empty
replacement. The generated config uses an allowlist, so production resource
IDs, origins, vector namespaces and previews cannot become self-host defaults.
Code still deploys from the installation fork's `main` through Workers Builds.
`docs/operations/self-hosting.md` names the remaining operator steps and the
provider data flows; no live clean-account proof is implied by contract tests.

## Amendment, 2026-10-29: whole books are a different corpus

The paraphrase finding above was measured on memories, where a model
rewriting its own query recovered most misses. On 129 page-sized passages
of a public-domain book, `evals/passages/` found the right page in the top
three for 12 of 20 author questions lexically, 12 with model-rewritten
terms, 17 with bge-m3 alone and 18 with rank fusion. Asset passages
therefore get one vector each through the existing asset ledger
(ADR-0015, amendment of 2026-10-29). Memories, skills and to-dos are
unchanged.
