# Memory review model comparison

The [completed context comparison](2026-10-29-context-complete/report.md) carries
forward the eight GLM cells and attempts the remaining sixteen Haiku/Sonnet
cells after BWS access was corrected. The original 24-call grant is exhausted.
The [candidate-selection experiment](candidate-selection.md) separately measures
vector recall, consolidation-specific Jev questions and repeated-source coverage.

The [October 29 context probe](2026-10-29-context-run1/report.md) tests
self-contained drafts, distracting source groups and GLM 5.3 Flash on prompt 3.
Its eight GLM calls passed; the linked completion records the later matched
Haiku/Sonnet attempt. Do not pool either with the prompt-2 evidence.

Research artifacts, not an automatic model-selection gate. No production defaults,
private memories, Worker bindings or user settings are changed.

`scripts/memory-review-compare.mjs` imports the production system prompt and
`validateReviewProposal` unchanged. It sends six synthetic groups, two repeats
each, to five explicitly named OpenRouter models. The request limit is 60 with
no retries. Each request has 24,000 input bytes including system text, 1,536 total
output tokens, 30 seconds and a 64 KiB response limit.

The script requires `OPENROUTER_API_KEY` in the inherited environment and the
explicit `--allow-sixty-paid-synthetic-calls` flag. Running it spends money and
requires separate authorization; it is excluded from `verify`. The optional
third argument selects a fresh artifact directory. Existing results are never
overwritten. Do not add secrets or private corpus inputs.

Before each request it reserves one input token per UTF-8 byte plus the full
output allowance at the saved live catalog rates. Sum of reservations cannot
exceed $1; the October 24 fixture plan bounds all 60 calls at $0.472607. This
is a conservative bound at published rates, not invoice reconciliation or a
guarantee against incorrect/future provider billing. Missing usage after a
timeout is unknown, not free.

Catalog entries, prompt/fixtures and full structured requests/responses are
retained alongside the report. Provider-reported `usage.cost` and catalog-rate
token estimates are separate: routes can charge differently from catalog list
rates. No fallback routes or data-collection routes are permitted. Price ceilings
are model-specific. No tools or web search are enabled.

Temperature is 0.1 only where advertised. Reasoning is disabled where optional;
the catalog marks Sonnet 5.5 and Gemini 3.8 Flash mandatory, so they request the
lowest advertised effort (`low`) within the same total output budget. This is
a deployable-envelope comparison, not identical internal compute or a
reasoning-free quality comparison.

Production validation checks strict top-level schema, evidence counts, distinct
source ids, exact source quotes and actual nonempty synthesis. It does not
establish factual entailment, complete truth retention, correct attribution or
appropriate contradiction handling. The report separately grades retained
outputs manually against each fixture's stated rubric. No other model judges
or quality retries are used. Six short groups cannot establish corpus-wide
quality, statistical superiority, large-context reliability or adversarial safety.

## October 24 shortlist follow-up

`2026-10-24-shortlist/` is a separate owner-authorized run: fresh Haiku 5.5,
GPT-6 Luna and exact DeepSeek V4.1 Flash 1017 snapshot, three repeats of the
same six cases (54 calls). Do not pool it with the earlier two-repeat run.

`scripts/memory-review-shortlist.mjs` requires the distinct
`--allow-54-paid-synthetic-calls` authorization flag and inherited key. It
retains the same limits, disables optional reasoning on all three, rotates model
order in a balanced sequential schedule, records source/fixture/runner hashes,
and gates both reservations and reported-plus-unknown costs below $1. Its
planned bound is $0.0832206, including DeepSeek weekday peak prices; routing
caps use the fetched weekend rates. It does not relax provider restrictions or
retry failed requests. Existing results cannot be overwritten.

`node scripts/memory-review-shortlist-summary.mjs` is offline: it summarizes
only a complete 54-attempt run, preserving schema/evidence/kind checks,
latency tails, failures, tokens/cache/route labels and unknown-cost bounds.
Semantic grades are separate manual review of the retained output.

## October 25 release route check

`2026-10-25-routes/` holds one call per offered model through the production
adapter, made before release to prove each route returns a valid proposal.
`scripts/memory-review-routes.mjs` needs `--allow-three-paid-synthetic-calls`,
an inherited `OPENROUTER_API_KEY` and a new evidence directory; it never
overwrites results. It is a route check, not a quality comparison.

## October 29 prompt fix: compatible claims are not contradictions

`2026-10-29-kinds/` holds the fix for the 2026-10-24 journey failure, where
Haiku 5.5 on `memory-review-1` labelled Ada's apple and pear claims a
`contradiction` while its own body said they did not directly contradict.

`memory-review-1` defined contradiction as "two incompatible claims" with no
test for incompatibility, and asked for `kind` as the first key, so the model
committed to a label before writing the reasoning that should decide it.
`memory-review-2` defines incompatible as both claims unable to be true at
once, for the same subject, scope and time. It says a shared source, date or
topic does not make claims incompatible, a general rule and a narrower
exception are compatible, and a why saying the claims could both be true rules
out `contradiction`. Keys now come in the order why, kind, title, body,
evidence, and a contradiction's why names what each claim asserts that the
other denies. The validator is unchanged: checking a contradiction's
explanation against its label means matching phrases in free text, which the
owner ruled out, as was relabelling outputs.

A first draft put `evidence` first. Haiku then appended a stray `]` after the
JSON object in 4 of 20 calls, so the parse failed. Moving `evidence` last
removed it. That draft's outputs are not retained.

`fixtures.json` has ten synthetic groups. The three `journey-*` groups copy
the 2026-10-24 journey sources exactly. Seven are new: three compatible (one
baker's proofing and baking on one day, a weekly deploy rule and its December
freeze exception, tea in the morning and coffee after lunch), two conflicting
(a backup at 02:00 versus 14:00, a peanut allergy versus no allergies) and two
insufficient-context fragment pairs. Compatible passes as `summary`,
`consolidation` or `noop`; conflicting needs `contradiction`; insufficient
needs `noop`. `scripts/memory-review-kinds.mjs` sends them through the
production adapter and validator, no retries, no model judge:

```sh
node scripts/memory-review-kinds.mjs --allow-paid-synthetic-calls 60 2 evals/memory-review/2026-10-29-kinds
node scripts/memory-review-kinds.mjs --allow-paid-synthetic-calls 20 5 evals/memory-review/2026-10-29-kinds \
  journey-compatible,scoped-exception-deploys anthropic/claude-haiku-5.5,deepseek/deepseek-v4.1-flash-1017
```

The second command repeats the two compatible cases that varied, on the two
cheap models. Passes, full and focus runs combined:

| Model | Prompt | Compatible | Conflicting | Insufficient | Invalid |
| --- | --- | ---: | ---: | ---: | ---: |
| Haiku 5.5 | memory-review-1 | 13/18 | 6/6 | 6/6 | 0 |
| Haiku 5.5 | memory-review-2 | 17/18 | 6/6 | 6/6 | 0 |
| Sonnet 5.5 | memory-review-1 | 8/8 | 6/6 | 6/6 | 0 |
| Sonnet 5.5 | memory-review-2 | 8/8 | 6/6 | 6/6 | 0 |
| DeepSeek V4.1 Flash 1017 | memory-review-1 | 14/18 | 6/6 | 6/6 | 0 |
| DeepSeek V4.1 Flash 1017 | memory-review-2 | 18/18 | 6/6 | 6/6 | 0 |

Every compatible failure was the deploy rule and its freeze exception: Haiku
0/7 and DeepSeek 1/7 before, Haiku 6/7 and DeepSeek 7/7 after. Under
`memory-review-1`, Haiku's failing bodies said the claims were "not
necessarily mutually exclusive" under a `contradiction` label, the journey's
mismatch. The one failure under `memory-review-2` argues a literal conflict
("never" excludes a Tuesday deploy in December) and its label agrees with its
explanation. The apple and pear group came back `summary` in all seven Haiku
calls on either prompt: the journey mislabel was one sample that does not
reproduce on demand, so the deploy pair is the regression case. Ten short
groups do not establish corpus-wide accuracy.

Cost, OpenRouter-reported billed against the adapter's reservations:

| Run | Calls | Reserved USD | Billed USD |
| --- | ---: | ---: | ---: |
| memory-review-1 full | 60 | 0.463728 | 0.100262 |
| memory-review-1 focus | 20 | 0.035065 | 0.003961 |
| evidence-first draft, not retained | 60 | 0.494064 | 0.111349 |
| two Haiku draft probes, not retained | 18 | 0.018897 | 0.005747 |
| memory-review-2 full | 60 | 0.492434 | 0.105109 |
| memory-review-2 focus | 20 | 0.037455 | 0.003924 |
| Total | 238 | 1.541643 | 0.330352 |

Haiku 5.5 stays the default. On `memory-review-2` it matches Sonnet on every
conflicting and insufficient case and misses one compatible call in 18, on the
ambiguous rule-and-exception pair, with a consistent explanation. It bills
about $0.0003 a call against Sonnet's $0.0067. DeepSeek was perfect here and
cheaper, but the October 24 shortlist recorded upstream HTTP 429s on 12 of its
18 calls, and a default that fails to answer is worse than one that sometimes
hands a pair to a human as a conflict.
