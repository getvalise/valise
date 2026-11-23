# Current-main handoff comparison

Fetched main `831d843` is the baseline. Orientation candidate `35b8cf9`
contains that exact commit; its production diff is the bounded brief and task
query implementation. Baseline server ran from eval-only merge `cac9ab7`, whose
application and Worker files are identical to `831d843`. Candidate ran from an
isolated detached checkout, without editing the owning agent's branch.

Mini, five cases, hookless and shipped-reminder arms, three repeats per cell,
64 published synthetic skills. Both runs use fixture hash
`3f58d87f5cdc48c06820878a85095200781e017a187f8297031bbf4154012786`
and runner/scorer source hash
`51f01a4ff298ac27d1014925e1cfe7dae419ee825692ba9ae5170d04ba628fb5`.
That runner/scorer pair is preserved exactly in commit `7728067` (also
`cac9ab7`); the later empty-store and malformed-answer guards do not rewrite
the recorded runs.
Fresh stores use different IDs, recorded in each artifact's fixture mapping.

| Head | Arm | Outcomes | Calls | Input / output tokens | Extra searches | Domain errors | Cost |
|---|---|---|---|---|---|---|---|
| main831d843 | hookless | 11/15 | 20 | 293324 / 2566 | 3 | 0 | $0.0450 |
| main831d843 | reminder | 8/15 | 47 | 341652 / 3437 | 20 | 0 | $0.0699 |
| orientation35b8cf9 | hookless | 10/15 | 36 | 487517 / 2585 | 0 | 18 | $0.0627 |
| orientation35b8cf9 | reminder | 7/15 | 37 | 321371 / 2902 | 14 | 2 | $0.0570 |

| Case | Main hookless | Candidate hookless | Main reminder | Candidate reminder |
|---|---|---|---|---|
| Recover partial work | 2/3 | 1/3 | 2/3 | 0/3 |
| Latest decision | 3/3 | 3/3 | 3/3 | 3/3 |
| Exact completion window | 0/3 | 0/3 | 0/3 | 1/3 |
| Known task ID | 3/3 | 3/3 | 3/3 | 3/3 |
| Arithmetic, no recall | 3/3 | 3/3 | 0/3 | 0/3 |

Main passes 19/30; candidate 17/30. This run does not demonstrate improved
handoff success. The difference is two episodes on one model, not a reliable
regression estimate. Candidate reduces extra searches from 23 to 14 but adds
20 domain errors and raises total calls from 67 to 73. Provider cost is
$0.1149 versus $0.1197. Neither run has a provider/transport error, attempted
write, or missed required deployment blocker. One candidate completion episode
hits the eight-round cap and remains a failure.

Main's hookless completion answers include all four done tasks from
`list_ready(activity:true)`, ignoring the exact completion window. The candidate
finds `list_todos` but invents an optional cursor on every hookless completion
attempt. It then returns incomplete context, includes the upper-boundary task
from `get_brief`, or runs out of rounds. One reminder episode successfully uses
`get_brief` and filters the exact two IDs; two others include the upper boundary.
The current candidate also has a deterministic API regression test for completion
windows across cursor pages, owned by the orientation agent. This outcome lane
adds evidence about whether a model actually uses those semantics correctly.

The retained tool schema has no `required` array, and the cursor description
explicitly says to omit it for a new listing. Provider response
`call_sOOS0mFfFAufmFCECZtPKVgk` already contains `"cursor":"."`; the next,
`call_f6YRVNjM9CHcWGGBljahbbZc`, contains `"cursor":"0"`. The runner parses
and forwards these arguments unchanged; it does not fill defaults or rewrite
optional fields. These are fabricated values in the provider/model output,
followed by the server's valid rejection, not evidence that the server required
a cursor. Provider-internal schema normalization is not visible in this trace.
The next targeted investigation is optional-argument omission compatibility in
Mini; accepting invented opaque cursors would conceal the failure. Findings
were recorded on the orientation ticket without editing its owner's files.

The candidate's partial-work misses often name a generic resume action instead
of the saved `integration-check` step. The known-ID control passes 12/12 across
both heads and arms, so the evidence survives storage and fetch. The reminder
causes searches and skill-list reads for arithmetic on both heads in all six
samples. Latest-decision answers are correct even when read from adequate
snippets; authoritative fetching is reported separately.

Artifacts under `evals/runs/outcomes/`:

- `2026-10-24T12-37-17.201Z-main831d843.json`
- `2026-10-24T12-39-47.496Z-orientation35b8cf9.json`

These are the comparable current-main pair. The earlier stale-local-main
experiment and Haiku diagnostic remain in `2026-10-24-results.md`, not pooled
into these rates. Total provider spend across all retained experiments is
approximately $0.5959. No further paid runs were needed for the final
empty-store guard and malformed-answer handling changes.

This remains the read-only fresh-agent assessment described in `README.md`:
correct resumption instructions, not autonomous task execution, and an injected
SessionStart reminder, not real client lifecycle acceptance. No orientation
wording, cursor schema, relationship implementation, or production deployment
was changed by the eval work.
