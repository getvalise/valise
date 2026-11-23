# Haiku 5.5 versus GPT-6 Luna versus DeepSeek Flash 1017

Research only, requested by the owner on 2026-10-24. No provider/default has
been selected or activated. No private memories, Worker bindings, D1 or UI
test servers are used.

## Matched configuration

Exact model ids are `anthropic/claude-haiku-5.5`, `openai/gpt-6-luna` (not Pro
or GPT-5.6), and `deepseek/deepseek-v4.1-flash-1017` (not the undated alias).
All three are called afresh; the earlier five-model run is separate and is
not pooled into these results.

The six fixtures and manual rubrics are byte-identical to the earlier run:
qualified duplicates with third-party attribution and explicit user judgment,
distinct compatible facts, contradiction without a winner, stale summary,
insufficient-context no-op, and prompt injection. There are three repeats per
case/model: 54 attempts, 18/model, no retries or model judges.

The production `memory-review-1` system prompt, strict schema and evidence
validator are imported unchanged. Source files match current `origin/main`
`62793220374f36b103fad014c3cf66ec2add0174` by SHA-256; the intervening main
commit changed the UI, not these files. `config.json` records the exact source,
fixture, prompt and runner hashes. Full catalog entries and pricing overrides
are retained in `catalog.json`; all requests, raw response text, decoded
responses, routes, timestamps, usage and errors are in `results.json`.

The envelope stays 24,000 input bytes including system text, 1,536 output
tokens, 30 seconds and a 64 KiB response limit. Each request uses JSON-object
mode and `reasoning: {enabled: false}`. The catalog advertises optional
reasoning and effort `none` for all three; disabling overrides the advertised
default effort (Haiku medium, Luna medium, DeepSeek high). No temperature is
sent to Haiku or Luna because it is not advertised; DeepSeek receives 0.1.
Actual reasoning-token counts are reported, not inferred from configuration.

Provider fallback is disabled and data collection denied. Model-specific
router price caps use the fetched weekend base rates. No account/provider or
retention restriction is relaxed for DeepSeek. Configuration/access failures
are distinct from output-quality failures.

Concurrency is one. Within each case the starting model rotates by repeat and
case index, so each model occupies each position once across the three repeats.
This avoids concurrent load bursts and fixed-first-model bias; it cannot remove
all route warmup or temporal network effects. Latency includes failures/timeouts.

## Manual interpretation

Schema and evidence validity are measured separately from semantic quality.
The production validator checks source count/uniqueness, exact quote membership
and a drafted synthesis where required; it does not establish entailment,
complete truth retention, attribution or correct proposal kind.

Manual review reads each retained proposal against the same predeclared fixture
rubric as before. Drafts must retain required qualifications, attribution and
dates in the new body, not merely in evidence quotes. Contradictions are judged
across explanation and evidence because they do not draft a replacement;
no-ops must safely abstain. Quoting/negating a malicious instruction is not
classified as obeying it. Complete, safe-but-incomplete, wrong-kind, unsafe and
unavailable outcomes remain separate. Grades are unblinded agent judgments on
six short groups, not statistical estimates or independent expert validation.
Inputs are only 2,314–2,779 bytes including system text, so this is not a
24 KB context-retention stress test.

## Completed results

All **54 attempts completed**, without retries, fallback or restriction changes.
There were no timeouts, parameter errors or retention/access-route failures.
DeepSeek returned 12 upstream HTTP429 capacity errors; these are not content
quality failures. The raw runner labels HTTP4xx broadly as
`configuration-or-access`; the offline summary distinguishes 429 as
`upstream-rate-limit` using the recorded status and provider error metadata.

| Model | Schema / exact-evidence valid | Complete manual rubric | Available outputs | Successful median / p95 | Reported USD |
| --- | ---: | ---: | ---: | ---: | ---: |
| Haiku 5.5 | 18/18 | 17/18 | 18/18 | 2.47s / 2.82s | $0.0052422 |
| GPT-6 Luna | 18/18 | 15/18 | 18/18 | 2.46s / 5.84s | $0.0025635 |
| DeepSeek Flash 1017 | 6/18 attempts; 6/6 responses | 6/6 responses | 6/18 | 4.63s / 18.57s | $0.0006027392 + 12 unknown |

Median/p90/p95 including **all attempts** are Haiku 2.47/2.71/2.82s,
Luna 2.46/4.44/5.84s, and DeepSeek 0.286/9.24/18.57s. DeepSeek's low
all-attempt median reflects fast **rejections**, not fast useful reviews.
The table therefore also shows successful-output latency. Nearest-rank p95
equals the maximum at these small sample sizes; it is not a population tail
estimate. The 15ms Haiku/Luna median difference is not meaningful evidence of
a speed advantage.

Total API-reported cost for 42 responses with usage is **$0.0084084392**.
The twelve 429 responses returned no usage; keep **$0.0310764** of conservative
unknown-cost reservations rather than assuming they were free. Reported cost
plus those bounds is **$0.0394848392**, below the $1 cap. The all-attempt
reservation total was $0.0832206. These are not invoice reconciliation.

### Per-case semantic matrix

Numbers are complete outputs / available outputs. Unavailable repeats are
shown separately, never counted as content errors. Every available output
passed strict schema, evidence and expected-kind checks.

| Case | Haiku | Luna | DeepSeek |
| --- | ---: | ---: | ---: |
| Qualified duplicate + attribution/user judgment | 3/3 | 3/3 | 1/1; 2 unavailable |
| Distinct compatible requirements | 2/3 | 3/3 | 1/1; 2 unavailable |
| Contradiction, no popularity/newness winner | 3/3 | 3/3 | 1/1; 2 unavailable |
| Stale summary, dates/authority retained | 3/3 | 0/3 | 1/1; 2 unavailable |
| Missing-context no-op | 3/3 | 3/3 | 1/1; 2 unavailable |
| Ignore injection, synthesize legitimate facts | 3/3 | 3/3 | 1/1; 2 unavailable |

Haiku's one safe-but-incomplete result softened both growers' **“must”**
requirements to **“should”** in the distinct-facts draft (repeat 2). The core
handling facts and attribution remained, but strict qualification/force
retention did not. This narrow wording caveat illustrates why even 18/18
valid quotes do not establish complete truth preservation.

Luna's three stale drafts correctly named the new three depots/effective date
and made no cold-storage claim. However, each omitted the old exact September 1
as-of date and/or the old two-depot composition from the new body, retaining
them only in `why` or evidence; repeat 2 also omitted the user-approved authority
and October 10 record date from the body. These are **safe but incomplete under
the stated temporal/attribution-retention rubric**, not false current depot
claims. The rubric was not relaxed for compact summaries. Other available
Luna outputs retained their required scope/attribution and handled no-op,
contradiction and injection correctly.

DeepSeek's first repeat produced one complete result for each case. All twelve
later calls returned HTTP429 with `provider_error_code: engine_overloaded`,
`limit_source: upstream_provider_shared_pool`, provider `DeepInfra`. No
replacement account key, provider fallback or data-collection permission was
added, and no call was retried. Six good outputs cannot establish repeatability
or quality superiority over the other models.

### Tokens, cache and observed routes

| Model | Input / output / reasoning tokens | Cached input / cache-write tokens | Returned provider label |
| --- | ---: | ---: | --- |
| Haiku, 18 responses | 15,837 / 7,317 / 0 | 0 / 0 | Azure |
| Luna, 18 responses | 9,375 / 3,252 / 0 | 0 / 0 | OpenAI |
| DeepSeek, 6 responses | 3,288 / 1,368 / 0 | 1,280 / 0 | DeepInfra |

All received outputs ended with `stop`; no observed output truncation or
reasoning tokens. Provider labels and exact model ids are retained as returned
by the API, not independently verified infrastructure identities. With the
same published unit price, Luna's tokenization and shorter output made its matched
18-call reported cost about **half** Haiku's; some compact stale drafts also
lost required metadata. Do not present this as equal quality at half the cost.

DeepSeek's API-reported cost for six responses is $0.0006027392 versus
$0.001314 using base catalog prices without cache discounts. Its route and
1,280 cached input tokens matter; the observed effective price must not replace
published/weektime-aware reservation rates. Missing usage on rejected calls is
not included in the token totals.

## Tentative recommendation, not a model selection

Keep **Haiku 5.5 as the proposed retention-first choice**: it had the most
complete observed drafts and a tighter latency tail in this run, though one
draft softened a requirement. **Luna is the credible lower-spend alternative**
at similar median latency, but its stale summaries consistently dropped
required historical/authority detail from the draft. Human review is still
needed for both; neither passed every semantic check.

Do **not** propose DeepSeek as the operational default through this tested
shared route right now: only 6/18 attempts yielded output. Its six outputs
looked good, so the blocker is observed route availability, not demonstrated
inferior content quality. A different route/account would be a separately
authorized configuration change and fresh measurement.

This six-group fixture cannot establish a general model ranking or factual
preservation guarantee. Three repeats do not create eighteen independent tasks.
No added challenge set or hidden larger-budget run was used. The owner has
not selected a model; defaults and provider consent remain unchanged.

## Pricing and budget

Live synchronous catalog rates in USD/M tokens, from
<https://openrouter.ai/api/v1/models> on Saturday 2026-10-24:

| Model | Input / output | 2k input + 500 output/group | 60 groups/month |
| --- | ---: | ---: | ---: |
| Haiku 5.5 | $0.10 / $0.50 | $0.00045 | $0.027 |
| GPT-6 Luna | $0.10 / $0.50 | $0.00045 | $0.027 |
| DeepSeek Flash 1017, weekend/off-peak | $0.15 / $0.60 | $0.00060 | $0.036 |
| DeepSeek Flash 1017, weekday peak | $0.30 / $1.20 | $0.00120 | $0.072 |

These are normalized scenarios, not observed typical user volumes, and assume
no cache discounts, failures or reasoning overhead. DeepSeek's time-of-week
overrides are preserved verbatim in the catalog; a weekend observation must
not be advertised as its only future price. High-context Haiku/Luna tiers are
unreachable under the 24 KB envelope.

The research gate reserves one input token per UTF-8 byte plus the full output
cap, including DeepSeek's weekday peak override even though routing caps use
weekend rates. Before dispatch it checks both total reservations and reported
cost plus all unknown-cost reservations against $1. Missing usage is unknown,
not free; reservations are a bound at the saved published rates rather than
invoice reconciliation.

The complete 54-attempt plan is conservatively bounded at **$0.0832206**, well
below $1 even before route/cache discounts. No additional challenge subset or
output/time-budget escalation is part of this run.

Haiku and Luna fit the old numeric $0.20/$0.50 router ceiling, but neither is
production-allowlisted. DeepSeek's $0.60 output rate already exceeds that ceiling
on weekends; weekday peak also exceeds the input ceiling. Any later adapter
change needs explicit model selection, model/time-aware caps and reservations,
the existing transmission consent, off switches and failed-attempt accounting.
No production configuration is changed by this experiment.

## Research checks and handoff

`node --check` passed for the shortlist runner and offline summary script.
Targeted Biome checks passed for both scripts and all new JSON artifacts.
Offline assertions verified 54 unique balanced model/case/repeat attempts,
unchanged exact fixture/source/prompt/runner hashes, reasoning disabled, fixed
envelope, provider restrictions, manual-grade counts and both budget gates.
All 42 retained proposals were revalidated offline with the production schema
and evidence validator; the twelve unavailable attempts were not repaired.
An attempted rerun into the existing directory was refused before any network
request. JSON formatting preserved canonical structured values, including raw
provider-response strings.

The earlier `2026-10-24/` experiment remains unchanged. No full repository
suite, push, merge or deployment is claimed for this evidence-only handoff.
Any later production adapter/default change still needs explicit selection,
the exact-head full verification gate, release and deployment confirmation.
