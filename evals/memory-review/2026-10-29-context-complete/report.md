# Matched context comparison completion, 2026-10-29

BWS access was corrected by the owner. The continuation carried all eight spent
GLM calls and reservations from `../2026-10-29-context-run1/results.json`, then
attempted only sixteen previously unrun Haiku/Sonnet cells. Same prompt 3,
production adapter, fixtures and strict validator; no retries or private text.
All 24 calls in the original $0.50 grant are now spent.

| Model | Strictly valid / attempted | Expected kind / attempted | Median / max latency |
| --- | ---: | ---: | --- |
| GLM 5.3 Flash | 8/8 | 8/8 | 4.13 / 5.63 s |
| Haiku 5.5 | 7/8 | 7/8 | 2.36 / 2.80 s |
| Sonnet 5.5 | 5/8 | 5/8 | 3.24 / 4.46 s |

Haiku failed the injected-instructions cell. Sonnet failed qualified duplicates,
four-source context and injected instructions. These failed attempts retain usage
but only `review-failed`, not their raw output or detailed cause. The original
runner bundled validator and failure reporter independently, duplicating the
`ReviewFailure` class: validation exceptions from one graph cannot pass the
other graph's `instanceof`. This explains a diagnostic loss, not the underlying
validation/internal failure or its quality severity. Do not assign a missing
quote, schema error or injection-compliance failure without the discarded output.
The runner is now single-graph, has a provider-free error-identity regression,
and retains synthetic original content before validation for future runs.
It was not rerun after that correction; no failed cell was repaired or retried.

Manual reading of the twelve new valid proposals/explanations found:

- Both models distinguish the compatible apple/pear claims from contradiction,
  retain grower attribution, and refuse to infer missing fragment referents.
- Haiku's qualified duplicate retains Ada, unverified pilot-only advice,
  October 2026, 4 degrees, never frozen and the user's no-rollout judgment.
- Haiku's four-source consolidation cites only the layout pair, retaining the
  long-quotation exception. Its explanation still uses `_1`/`_2` shorthand for
  the distractors; this is a readability defect even though titles also appear.
- Haiku's rule-plus-exception cell chooses a permitted no-op but its explanation
  first says a summary is appropriate and then calls the supported exception
  insufficient context. This is over-cautious and internally awkward, not a
  good synthesis result merely because its kind passes the fixture's broad set.
- Haiku refers to first/second sources in two explanations; the auto diagnostic
  flags three cells. Sonnet's valid explanations and durable bodies name subjects
  without positional dependence. Durable bodies in all valid new outputs retain
  standalone subject/scope and attribution; none apply a production memory.

Combined conservative reservations: 211,739 micro-USD ($0.211739), including all
failed attempts and the eight prior GLM calls. OpenRouter reported usage cost is
$0.0027614 for Haiku and $0.051914 for Sonnet. Together with GLM's original
list-rate usage estimate $0.00180745, the mixed-evidence estimate is $0.05648285;
this is not a reconciled invoice. Prompt/output tokens: GLM 7,203/1,454;
Haiku 11,109/3,301; Sonnet 11,117/2,968, including failed-attempt usage.

GLM is promising and Haiku faster on this single sample per cell. The small
sample and lost failure details do not establish a general quality winner or
authorize a production default change. Haiku remains the default; no provider,
permission, production draft or human decision changed. Production J2 acceptance
and the separate vector/Jev grant are not included in this comparison.
