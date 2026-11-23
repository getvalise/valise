# Memory review model comparison — 2026-10-24

Production defaults remain unchanged. This is bounded research for
`todo:tdo_90b0405a-0332-41d8-afbf-470cc00bf762`, not approval to transmit private
memories or activate a provider. Source prompt and validator are from main
`fdeffa8efbd02855029ec894355f25d7dd073617`.

## Method

Six matched synthetic groups × two repeats × five models = at most 60 direct
OpenRouter calls, no retries or model judges. Groups cover qualified duplicate
consolidation, distinct compatible facts, contradiction without choosing a
winner, stale summary with explicit replacement evidence, missing-context no-op,
and embedded prompt injection. Full production `REVIEW_SYSTEM` is unchanged.
Limits are 24 KB system plus source JSON, 1,536 total output tokens, 30 seconds
and 64 KiB response. No Worker, D1, user memories or UI test server is involved.

Requests are sequential and interleaved by case/model within each repeat.
Two repeats are a stability check, not independent evidence of statistical
significance; similar responses may repeat. Groups are short and well below
the maximum input size, not a stress test of 24 KB truth retention.

Live catalog and supported-parameter metadata are in `catalog.json`; full prompt
and rubrics are in `fixtures.json`; requests, raw responses, provider names,
finish reasons, usage, errors and validation are in `results.json`.

Optional reasoning is disabled. Sonnet 5.5 and Gemini 3.8 advertise mandatory
reasoning and use `low`, the lowest supported effort, inside the same output
cap. Temperature is 0.1 only where advertised, omitted for Haiku, Mini and
Sonnet. Routes deny data collection, disable fallback and cap model-specific
input/output rates. This compares usable configurations under the production
envelope, not identical hidden computation. Provider-reported reasoning counts
are retained rather than inferred from configuration.

Production validation checks the strict proposal schema, contributing-source
count and uniqueness, exact quote membership, and actual synthesis where
required. It does not prove factual preservation or correct attribution.
Manual grading separately reads the retained proposal against the predeclared
fixture rubric. A complete result must preserve required dates, qualifiers and
attribution in the drafted synthesis, not merely in an evidence quote. Safe
but incomplete drafts are distinguished from unsafe or unavailable outputs.

## Measured results

All 60 requests ran. Total API-reported cost for 59 calls with usage was
$0.09992365. One Gemini 3.8 timeout returned no usage; its conservative reserved
bound was $0.008628675. Thus reported cost plus that bound is $0.108552325 at
the saved rates, not a claim that the unknown request was free. No retries,
output-cap increases or quality-driven follow-up calls were made.

| Model | Production validator | Complete manual rubric | Median / max elapsed | API-reported USD (12 attempts) |
| --- | ---: | ---: | ---: | ---: |
| Haiku 5.5 | 12/12 | 12/12 | 2.44s / 2.73s | $0.003496 |
| GPT 5.4 Mini | 12/12 | 12/12 | 1.75s / 4.79s | $0.015204 |
| Gemini 3.8 Flash | 11/12 | 10/11 available | 3.72s / 30.00s | $0.012781 + one unknown |
| Sonnet 5.5 | 12/12 | 12/12 | 3.81s / 5.55s | $0.066760 |
| Gemini 2.5 Flash Lite | 10/12 | 8/12 | 1.05s / 1.49s | $0.001683 |

Latency includes failures and the timeout. With only 12 observations, a nearest
rank p95 is simply the maximum; no population latency claim is supported.
Inputs were 2,314–2,779 bytes including system text, much smaller than the cap.
All received completions ended with `stop`; no observed length truncation.

Manual grades and rationales are in `manual-grades.json`. Haiku, Mini and Sonnet
retained the tested facts, scope, dates, third-party attribution and explicit
user judgment across all six groups in both repeats. This small synthetic set
found no quality advantage for Sonnet over Haiku or Mini. It does not prove
complete factual preservation in arbitrary memories.

Gemini 3.8 timed out once on contradiction; the repeat succeeded. One stale
summary retained only “September 2026” instead of the exact September 1 date
in its drafted body (the exact date remained in a quote), so it is graded safe
but incomplete under the stated date-retention rubric. Its other available
outputs met the rubric.

Flash Lite's two injection outputs rejected the malicious shipment-approval
claim but misclassified the distinct legitimate facts as `consolidation` and
repeated a source in evidence. Both were rejected by production validation.
This is not proof that the injection was obeyed. Its two stale drafts omitted
the old as-of date, record date and user-approved authority from the new body;
these details survived only in evidence/why. Those are safe but incomplete
drafts, illustrating why exact quotes alone are not a truth-retention test.

Reported routes: Haiku/Sonnet `Azure`, Mini `OpenAI`, Gemini 3.8 `Google`, and
Flash Lite `Google AI Studio`. These are the provider labels returned by the
API, not independently verified infrastructure identities. All reported
reasoning-token counts were zero despite mandatory-reasoning catalog metadata
for Sonnet/Gemini 3.8; no hidden reasoning behavior is inferred. Gemini 3.8's
token estimate at catalog rates is $0.014058825 versus API-reported
$0.01278075 for 11 responses. Keep both numbers; the latter is not silently
substituted for the published reservation cap. No parameter/configuration errors
occurred.

## Recommendation, pending user selection

Choose **Haiku 5.5 as the proposed quality/cost replacement**, not an activated
default. It matched Mini and Sonnet on these rubric checks, cost 4.35× less
than Mini and 19.1× less than Sonnet for the matched 12 attempts, and fits the
existing numeric price ceiling. Mini is a reasonable explicitly chosen
lower-median-latency option (1.75s versus 2.44s) at higher spend. Sonnet's
premium bought no observed benefit here; Gemini 3.8 also had a timeout and
no observed quality advantage. Flash Lite is fastest/cheapest but its
injection-case contract/category failures make it a weaker proposed default.

Do not automatically cascade to Sonnet, retry for quality, or treat these
results as permission to route private memories through OpenRouter. Any
provider switch still needs explicit user selection and the existing
transmission consent. Production defaults and the UI task remain untouched.

## Pricing scenarios

Published synchronous USD/M tokens, fetched from
<https://openrouter.ai/api/v1/models> on 2026-10-24. Haiku's higher ≥100k-token
tier cannot apply inside this 24 KB envelope. Scenarios ignore discounts,
cache effects, reasoning overhead and failed attempts; they are not measured
typical user workload costs.

| Model | Input / output per M | 2k input + 500 output/group | 60 groups/month (2/day) | Maximum conservative reservation/group |
| --- | ---: | ---: | ---: | ---: |
| Haiku 5.5 | $0.10 / $0.50 | $0.000450 | $0.0270 | $0.003168 |
| GPT 5.4 Mini | $0.75 / $4.50 | $0.003750 | $0.2250 | $0.024912 |
| Gemini 3.8 Flash | $0.825 / $4.125 | $0.003713 | $0.2228 | $0.026136 |
| Sonnet 5.5 | $2 / $10 | $0.009000 | $0.5400 | $0.063360 |
| Gemini 2.5 Flash Lite | $0.10 / $0.40 | $0.000400 | $0.0240 | $0.003015 |

Reservations assume one input token per UTF-8 byte and the full output cap.
All 60 planned calls have a combined conservative bound of $0.472607 at the
saved catalog rates, below the $0.50 target and $1 hard research ceiling.
Actual billed-cost reconciliation is not implemented. Missing usage after a
timeout is unknown cost, not zero.

## Production implications

The existing OpenRouter ceiling of $0.20/$0.50 per M blocks Mini, Gemini 3.8
and Sonnet. Haiku fits the numeric ceiling but is not allowlisted; its absent
temperature parameter also needs a deliberate adapter change. The current
reservation rate must not be reused for more expensive models. Use an explicit
model-specific rate/cap table and keep failed-attempt reservations, consent,
off switches and no-fallback behavior.

The $0.01 default daily reservation budget can cover two maximum-size Haiku
groups ($0.006336). It cannot cover even one maximum-size Mini/Gemini3.8/Sonnet
group at conservative rates. Raising a cap is a separate explicit user choice,
not a hidden consequence of selecting a model. Switching model alone must not
schedule a corpus rerun or move private text to another provider silently.

The earlier Workers AI Llama 3.1 8B probe was only three different cases: two
validated outputs and one missing required `evidence` array on a no-op. It is
historical evidence, not a matched Llama result in this experiment. No claim of
measured superiority over Llama follows from these runs.

## Research verification

The live run exercised the imported production validator on every returned
proposal. `node --check scripts/memory-review-compare.mjs` and targeted
`biome check scripts/memory-review-compare.mjs evals/memory-review` passed.
Offline artifact checks confirmed 60 unique model/case/repeat tuples, unchanged
production system prompt per request, fixed input/output limits, no fallback,
data-collection denial, total bound below $0.50, and manual-grade count
consistency. Formatting retained byte-equivalent canonical JSON values.
An attempted rerun into the existing result directory
was refused before provider dispatch, verifying that evidence cannot be
silently overwritten. The guard was added while the authorized run was active;
it does not change its requests. No full repository suite, push, merge or
deployment was performed for this evidence-only handoff. A later production
change still needs the exact-head full `npm run verify` gate.
