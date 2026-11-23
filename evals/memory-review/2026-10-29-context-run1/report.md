# Memory review context probe, 2026-10-29

Owner grant: at most 24 calls and $0.50 total, synthetic memories only, no
production settings or private text. Eight calls ran through the production
`draftMemoryReview` adapter and `validateReviewProposal`, with prompt
`memory-review-3` retained in [results.json](results.json). No retries or model
judge. The supplied Workers AI binding had no D1/R2/KV/DO/Vectorize bindings.

| Model | Valid schema/evidence | Expected kind | Positional references | Latency median/max |
| --- | ---: | ---: | ---: | ---: |
| Workers AI GLM 5.3 Flash | 8/8 | 8/8 | 0/8 | 4.13 / 5.63 s |
| Haiku 5.5 | Not run | Not run | Not run | Not run |
| Sonnet 5.5 | Not run | Not run | Not run | Not run |

The cases cover compatible attributed facts, a genuine contradiction, missing
context, a rule with an exception, qualified duplicates, four memories with two
unrelated distractors, unrelated same-project facts and prompt injection.

Manual reading of all eight retained outputs found the substantive qualifiers
and attribution retained. The duplicate case preserves pilot-only scope,
October 2026, 4 degrees Celsius, never frozen, unverified grower advice and the
user's no-rollout judgment. The four-source case combines only the two console
width rules, retaining the long-quotation exception and excluding orchard and
backup facts. The injected instruction is ignored. No-change cases leave title
and body empty. Explanations name subjects rather than ordinal source positions;
one console explanation paraphrases a title rather than quoting it exactly, so
this is readable context, not proof of exact title reproduction.

Usage: 7,203 input and 1,454 output tokens, estimated $0.00180745 at catalog
rates. Reservations: 11,251 micro-USD ($0.011251). No provider invoice was read;
the rate estimate is not billed-cost evidence. GLM was selected from
`npx wrangler ai models list --json` on 2026-10-29 at $0.15/$0.50 per million,
with mandatory reasoning at `low` inside the 1,536-token cap.

Haiku/Sonnet comparison is blocked, not failed quality. The inherited OpenRouter
key's read-only key endpoint returned remaining limit 0. The owner then named
BWS `VALISE_OPENROUTER_DEV`, id `9a55736a-36ce-41aa-94e8-b4f20147fa6b`:
`bws secret get` returned 404, and the current service account's inventory had
no exact name match. No secret value was printed, written or sent to a provider.
Sixteen cells remain unrun under the original cap. Existing prompt-2 evidence
in the parent README is historical, not a matched comparison with this run.

The initial setup attempt in `../2026-10-29-context/results.json` stopped before
inference because `.wrangler/` did not exist. Its ledger has zero calls. The
runner now creates that parent and refuses to overwrite prior reports.

To finish after access is restored, inject the development key into the child
environment, not arguments or source, and use a new output directory:

```sh
node scripts/memory-review-context.mjs --allow-24-synthetic-calls-under-50-cents \
  <new-output-directory> evals/memory-review/2026-10-29-context-run1/results.json
```

The continuation checks identical prompt/fixtures, carries the spent calls and
reservations forward, and skips every attempted cell, including failures. The
original total cap remains 24/$0.50; this command does not grant more calls.

GLM is a reasonable optional provider on these measured cases; this does not
establish superiority, repeated-run reliability, long-memory quality, a private-
corpus benchmark or production consent-to-approval J2 acceptance. Haiku stays
the default, and no user's existing provider or execution consent changes.
