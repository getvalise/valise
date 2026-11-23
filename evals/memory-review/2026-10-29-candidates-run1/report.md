# Candidate ranking results, 2026-10-29

Owner grant: 40 external inference requests and $0.10 combined reservations,
synthetic text only, no retries or production changes. Actual: eight bge-m3
embedding batches and 32 pinned Jev 1.14 requests, all finished. Count exhausted;
no more calls are authorized by the unused dollars. Full fixtures, scores,
thresholds, usage and reservations are retained in `results.json`.

Corpus SHA-256: `8da9e308cdab4e77b3733e2bb53fc67386e67ecf8aed2e5b622e842e4014f8bd`.
Eight groups, 42 synthetic memories, seven useful anchor-neighbor pairs. Labels
and the [offline baseline](../candidate-selection.md) predate inference. Jev state
contains full titles, bodies and project, never labels/ids/timestamps. Source
order is rotated per case and reversed for the second pass. No model judge.

| Retrieval/selection | Useful pairs | Unsuitable neighbors | Exact groups |
| --- | ---: | ---: | ---: |
| Current production selector, local D1 | 5/7 | 19 | 0/8 |
| Keyword depth 50, local D1 (unranked pool) | 5/7 | 3 | 3/8 |
| Live embeddings + local cosine top 3 (unranked pool) | 7/7 | 17 | 0/8 |

The vector result measures recall over each tiny synthetic group, not a
production-sized store or live Vectorize. Vectorize was not bound and no remote
resource was provisioned. Both missing keyword pairs were recovered. Top-3
similarity still fills with unsuitable neighbors: retrieval alone is not selection.

Jev results below use identical full pools, capped at three accepted neighbors.
They are not end-to-end retrieval results: the ranker sees even candidates
that a retrieval stage could miss. The saved vector-top3 intersection is a
post-hoc ablation, not a call made with a narrower state or proof that scores
would stay unchanged with that state.

| Question | Threshold | Original order: useful / unsuitable, exact | Reversed: useful / unsuitable, exact |
| --- | ---: | --- | --- |
| Search relevance | 0.50 | 6/7 / 1, 6/8 | 6/7 / 1, 6/8 |
| Search relevance | 0.75 | 6/7 / 1, 6/8 | 6/7 / 0, 7/8 |
| Search relevance | 0.90 | 6/7 / 0, 7/8 | 6/7 / 0, 7/8 |
| Joint review | 0.50 | 7/7 / 1, 7/8 | 7/7 / 0, 8/8 |
| Joint review | 0.75 | 6/7 / 0, 7/8 | 7/7 / 0, 8/8 |
| Joint review | 0.90 | 6/7 / 0, 7/8 | 6/7 / 0, 7/8 |

Joint review improves compatible-fact recall but does not yield a settled
production threshold. That positive pair scores 0.65 versus 0.79 with order
reversed; the insufficient-context negative scores 0.55 versus 0.43. Thus 0.50
admits that negative in one order, while 0.75 drops the compatible pair in one
order. These are different-order samples, not enough repeats to distinguish
order sensitivity from provider variation. High confidence is not source truth.
The malicious score instruction stayed below 0.17 in both joint-review samples;
the long-body duplicate and incompatible claim each scored 0.99. This is a
small adversarial probe, not a robustness or injection-security guarantee.

Reservations: 197 micro-USD for embeddings and 6,696 for Jev, $0.006893 total,
using one input token per request UTF-8 byte at the live catalog rates read
2026-10-29: bge-m3 $0.0118/M, Jev $0.042/M. Jev reported 46,252 input tokens
($0.001942584 at list rates); embedding token usage was not saved by this runner,
so do not manufacture a combined billed cost. No invoice was inspected.
Embedding batch latency ranged 110–334 ms; Jev requests ranged within the
saved ten-second bound, with a maximum 199 ms. Laptop/proxy timings do not
establish production end-to-end latency. The production search's 1.5-second Jev
deadline was not what this research runner enforced.

The runner has no D1/R2/KV/DO/Vectorize bindings, no input-file override and no
provider fallback or automatic retries. It persists reservations before dispatch,
refuses existing output directories, rejects incomplete/out-of-range or wrong-
model answers, bounds HTTP response bytes and disposes its transient proxy.
Only eight fixed synthetic embedding batches and 32 Jev requests ran. It has
no resume mode; a future run requires a new stated authorization.

Conclusion: proceed with a separately consented vector-recall plus joint-review
ranker design, retaining generative synthesis and human approval as separate
steps. Do not deploy a tuned threshold from these eight cases. Wider held-out
cases, realistic volume, per-memory/relationship coverage and subject-forming
review jobs remain necessary before changing production selection.
