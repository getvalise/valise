# Memory inbox

Claude Haiku 5.5 is the default review model. The owner released it on
2026-10-25 with the one recorded actual-adapter failure accepted as a known
prompt issue rather than a release blocker: in the
[journey evidence](../../evals/memory-review/2026-10-24-journey/report.md),
Haiku labelled compatible apple and pear claims a contradiction while its own
body said they did not conflict. Prompt `memory-review-2` (2026-10-29) defines
incompatible claims and asks for the explanation before the label; its
before-and-after results across all three offered models are in the
[October 29 section of the eval notes](../../evals/memory-review/README.md#october-29-prompt-fix-compatible-claims-are-not-contradictions).

The Review section at `/memories?tab=review` is a signed-in, tenant-private draft
queue beside All memories. Its URL carries the selected review, editor and
list depth. The old `/memory-inbox` address was removed on 2026-10-25 and now
answers 404. The action returns fetcher receipts or native-form redirects, including inline
validation refusals. Review is not a separate workspace destination.

Enabling reviews
authorizes sending the selected source text, revision stamps and attribution to
the selected provider. The switch defaults off. Turning reviews off prevents
future requests; it cannot recall one already sent.

## Nightly upkeep

Since 2026-11-04 (ADR-0012 amendment of that date, journey J-0 in
[memory consolidation](../design/memory-consolidation.md)) one switch, Tidy my
memories every night, sets `enabled`, `overnight` and `auto_apply` together,
bound to the displayed model, and makes the account due at once; the
manual-check-first rule is gone. It does not touch money: the cost caps are an
admin's (see Provider and budget). Off clears
`overnight` and `auto_apply`.

The minute cron calls `overnightMemoryReview`. It reads at most twenty due
settings and runs one ordinary pass for at most five admitted accounts, in
parallel. Claiming moves `next_run_at` five minutes out. After the pass the
account is due again in a minute while the pass stopped at its two-call cap,
lost admission, found the lock held, or left queued memories; otherwise, or
after forty passes, at the next 02:00 UTC. `last_run_json` keeps the run's
start, finish, passes, memories compared, calls, applied, questions, failures
and why it ended. A cron log line `memory_review` appears only for a minute
that ran an account.

With `auto_apply` on, a validated `summary` or `stale-summary` is applied
through `acceptMemoryReview` with `automatic: true`: author
`valise:memory-upkeep`, client `nightly`, model-asserted `related` links, a body
footer saying no person checked it, `applied_by = 'auto'`. The write requires
`auto_apply = 1` at commit. `consolidation` and `contradiction` stay
proposals. Undo archives the added memory, dismisses the group and clears the
pending rows its archive enqueued, so the same pair is not drafted again.
Candidate selection skips a pair of a `rollup` memory and a memory it already
links to, so a run does not summarize its own summary.

Automatic passes stop at `upkeep_memories` (1–200, default 50) and checks by
hand at `manual_memories` (1–100, default 25), each against its own counter in
`memory_review_budgets` (`upkeep_calls`, `manual_calls`; `calls` stays the
total). Both share one day's money cap. A pass that stopped at its two-ranked-
memory limit is due again the next minute, like one that stopped at two calls.

## Provider and budget

Three OpenRouter models and Workers AI GLM 5.3 Flash are offered for new selections. OpenRouter ids and rates come
from <https://openrouter.ai/api/v1/models>, read on 2026-10-25.

| Choice | OpenRouter id | Request shape |
| --- | --- | --- |
| Claude Haiku 5.5 (default) | `anthropic/claude-haiku-5.5` | reasoning disabled, no temperature |
| Claude Sonnet 5.5 | `anthropic/claude-sonnet-5.5` | reasoning effort `low` (the catalog marks reasoning mandatory), no temperature |
| DeepSeek V4.1 Flash 1017 | `deepseek/deepseek-v4.1-flash-1017` | reasoning disabled, temperature 0.1 |
| GLM 5.3 Flash | `@cf/zai-org/glm-5.3-flash` (Workers AI, not OpenRouter) | reasoning effort `low`, JSON-object mode |

GLM was read from `npx wrangler ai models list --json` on 2026-10-29:
$0.15/$0.50 per million input/output tokens. Reasoning cannot be disabled;
`none` maps to maximum effort, so use `low`. The adapter accepts its OpenAI-style
`choices` response as well as historical Workers AI `response` envelopes.
Haiku remains the default; GLM is an explicit alternative, never an automatic
fallback when OpenRouter is unavailable. [The context probe](../../evals/memory-review/2026-10-29-context-run1/report.md)
records eight synthetic GLM calls, not private-corpus or production J2 acceptance.

The owner selected Haiku on 2026-10-24 after the
[matched shortlist comparison](../../evals/memory-review/2026-10-24-shortlist/report.md)
and added Sonnet and DeepSeek as choices on 2026-10-25. "DeepSeek V4" resolves
to the dated V4.1 Flash snapshot the shortlist measured, not the undated alias
that can move underneath a saved choice. In that run its shared route returned
HTTP 429 on 12 of 18 attempts. All three use JSON-object mode, and routes must
support every requested parameter.
`OPENROUTER_API_KEY` remains an optional operator-managed Worker secret, not a
required deployment secret or permission to enable reviews. A missing/blank key
stops with a named configuration reason before budget admission or transmission,
even if Workers AI is available. This release does not provision a key.
There is no cheap-model, cross-model or cross-provider fallback and no
user-controlled endpoint. Router failures consume the existing reservation and
follow the same finite retry policy, never a different provider.

Existing saved Llama 3.1 8B, Llama 3.2 3B and Gemini 2.5 Flash Lite choices
remain exact legacy preferences, readable in settings and proposal history.
Their existing opt-ins and original provider remain unchanged: an opted-in
Llama user continues to use only the existing Workers AI binding, never Haiku
because a default changed. They are not offered as new selections. The picker
shows the three offered models plus the current saved legacy choice, when present; resaving that
unchanged choice is a no-op. A crafted attempt to select another legacy model
is refused.

Saving a different model atomically clears review and overnight execution
flags. The person must explicitly enable transmission to the selected provider
again, run a manual pass with that selected model, and separately opt into
overnight drafting. Saving the same choice does not toggle permission. Earlier
drafts/decisions/coverage, reserved budgets and source histories are not reset.
Permission-on forms name the model they displayed, checked atomically at the
write. A delayed old-provider form cannot enable the newly selected provider;
stale/unbound permission-on forms require reload. Turning permission off never
requires a matching model and remains available from a stale page.
An already-authorized in-flight request may finish under its original fence;
no further old-model or new-model dispatch is authorized by a choice change.

The frozen `0038` SQL/Drizzle default remains the historical Llama value for
compatibility; there is no table rebuild or data-rewriting migration. Every
application settings insert explicitly binds the new Haiku default, and reads
never replace an existing saved model. Restore also retains exact model values
rather than interpreting a new application default as provider consent.

Since 2026-11-04 (ADR-0012, review limits) a person sets counts and an admin
sets money. A check is one model call about one starting memory. Defaults are
25 checks by hand and 50 a night per UTC day. The money caps live in
`memory_review_cost_caps`, set per account on `/workbench?tab=costs`; with no
row an account gets $0.50 a day for review and $0.20 for ranking
(`app/concepts/memory-review-limits.ts`). An admin may set $0.001–$5.00 each.
The old `daily_calls`, `nightly_calls` and `daily_microusd` columns stay in the
table, unread. Reservations happen
atomically before inference and include failed, timed-out and interrupted
attempts. A reservation also stays spent if group admission or dispatch is
subsequently lost; a reserved attempt is not evidence of a provider call. They
use one input token per UTF-8 byte and the full output allowance, rounded up to
micro-USD, with an explicit fail-closed model/rate table:

| Model | Input/output USD per million tokens | Maximum reservation/group |
| --- | ---: | ---: |
| Claude Haiku 5.5 | $0.10 / $0.50 | $0.003168 |
| Claude Sonnet 5.5 | $2.00 / $10.00 | $0.063360 |
| DeepSeek V4.1 Flash 1017 | $0.30 / $1.20 (weekday peak override) | $0.009044 |
| Workers AI GLM 5.3 Flash | $0.15 / $0.50 | $0.005648 |
| Saved legacy Workers AI Llama 8B/3B | $0.20 / $0.50, rounded up | $0.005568 |
| Saved legacy Gemini 2.5 Flash Lite | $0.10 / $0.40 | $0.003015 |

Haiku's >=100k-token pricing tier is unreachable within 24 KB. The default 75
checks a day at Haiku's maximum reserve $0.2376, within the $0.50 default cap.
DeepSeek's catalog price doubles in weekday peak windows, so the reservation and
the router price cap both use the peak rate. Sonnet's output allowance alone
reserves $0.01536; at its $0.06336 maximum the default cap covers seven Sonnet
checks a day, and only an admin can raise it. The picker shows each model's maximum per-call reservation. Unknown
model ids cannot reserve money or dispatch. These are bounds at the documented
rates, not invoice reconciliation or a guarantee against future provider price
changes. OpenRouter caps input/output prices at the selected model's same rates
and disables provider fallbacks and data-collection routes. A price/parameter/
privacy-compatible route being unavailable fails closed, not at a higher rate.

One pass visits at most eight anchors, with at most four full memories in each
group and two model calls. System prompt plus source JSON must fit 24,000 UTF-8
bytes; no source is truncated to make a consolidation look complete. Output is
capped at 1,536 tokens, 4,096 for GLM, the request at 30 seconds, and an
OpenRouter response at 64 KiB. GLM counts its reasoning against `max_tokens`;
on 2026-11-05 a four-memory group (3,167 prompt tokens) took 234 to 1,465
completion tokens over eleven calls, and one production call past 1,536 was cut
off mid-string and recorded `invalid-json`. A reply that stops with
`finish_reason: "length"` now records `response-truncated` instead. Missing context or an oversized/singleton group becomes a recorded
local no-op, not paid inference.

Current model and API documentation consulted on 2026-10-23/24:

- <https://developers.cloudflare.com/workers-ai/models/llama-3.1-8b-instruct-fp8/>
- <https://developers.cloudflare.com/workers-ai/platform/pricing/>
- <https://developers.cloudflare.com/workers-ai/features/json-mode/>
- <https://openrouter.ai/google/gemini-2.5-flash-lite>
- <https://openrouter.ai/api/v1/models>
- <https://openrouter.ai/docs/features/provider-routing>
- <https://openrouter.ai/docs/api-reference/parameters>

## Actual-adapter synthetic journey

`scripts/memory-review-journey.mjs` is outside `verify`. It requires a separate
coordinated runtime grant and the operator's existing `OPENROUTER_API_KEY` in the
shell environment; a missing key fails before starting a server. It creates a
fresh local-only Worker configuration, private temporary `.dev.vars` and empty
D1/R2/KV/coordinator state. It never reuses a server or provisions remote resources.
The temporary config explicitly lists the optional key under `secrets.required`,
because Wrangler otherwise excludes it from local secret loading. It does not
change the production secrets list or provision a production secret.
The child removes any inherited dotenv-disable override so Wrangler can load its
explicit private secrets. Authenticated login, selected-provider availability and
persisted model/consent/caps are checked before the first paid request.

```sh
node scripts/memory-review-journey.mjs --allow-four-paid-synthetic-calls 4241 /absolute/new/private/evidence-directory
```

The runner saves synthetic attributed compatible/conflicting/insufficient-context
pairs through MCP, reads consent in the real review page, enables only manual
reviews and submits at most two bounded passes (four total provider attempts).
Its isolated settings cap calls at four and reservations at $0.02, inside the
owner's additional $0.25 target. It edits/accepts an actual adapter proposal,
fetches the accepted memory from a fresh loopback HTTP client and checks unchanged
original rows/history. A separate scriptless 320px browser dismisses/reopens and
confirms an actual contradiction without picking a winner. Both execution flags
are off before removing the private state.
There is no paid retry or substitute seeded proposal if inference fails.
Each pass must report zero failures, only an expected two-call pass-limit stop,
and matching bounded accounting before another pass is submitted. Any provider,
validation, admission, consent, budget or unrecognized-receipt failure persists
the report and exits through the same off/cleanup path without another paid pass.
Structured artifacts retain proposal/evidence, IDs, reservations, latency and
screenshots; invoice usage is explicitly unknown because the adapter returns
only the proposal. This local path is not deployed OAuth-client acceptance.
Record the separately confirmed release Build/version/traffic on the live J2
parent, `todo:tdo_dcd7f6e3-46b8-42d1-a4d9-fcfaf37e8b45`, and inspect screenshots
before reporting visual acceptance. Script source or a model rubric is not a run.

The [2026-10-24 actual-adapter attempt](../../evals/memory-review/2026-10-24-journey/report.md)
made three calls and reserved $0.003015, but did not complete the journey:
Haiku mislabeled compatible apple/pear claims as a contradiction even while its
explanation said they did not directly contradict. The strict compatible-summary
assertion stopped before human approval. This schema-valid semantic failure
was not repaired, retried or counted as successful edit/accept/retrieval proof.

## Historical Workers AI probe

On 2026-10-24, `scripts/memory-review-live.mjs` exercised the production
`draftMemoryReview` adapter and `validateReviewProposal` with three hard-coded
synthetic pairs through the existing Workers AI binding and then-default 8B model.
It does not bind D1/R2/KV/DO/Vectorize, read user memories or fetch Worker secrets.
Both review opt-ins remain off by default; no user setting was activated.

| Case | Live result | Strict validation |
| --- | --- | --- |
| Compatible grower claims about apples/pears | New summary retaining grower attribution, cool/never-frozen apples and dry transport for pears | Passed; both quotes were exact substrings of their respective sources |
| Conflicting 4°C/20°C transport claims | Contradiction explaining Ada versus Bo, choosing no winner | Passed; two distinct source ids and exact quotes |
| Two fragments with missing context | Model chose `noop` but omitted required `evidence` | Rejected by the production schema; not repaired or counted as coverage |

The first three invocation attempts failed locally because Wrangler's Node
proxy cannot serialize `AbortSignal`; no inference result or usage was returned.
The probe bridge was then corrected to enforce the adapter deadline in Node
rather than transport the signal. The final three attempts returned live usage:
1,514 input and 425 output tokens total (31.9649 reported neurons). Estimated
cost at the deliberately rounded-up $0.20/$0.50 per million rates is $0.000516;
full conservative reservations were $0.003709 for that run, or $0.007418 if
all six attempts are counted. These are estimates, not an invoice. No additional
calls, model fallback, quality retries or private-corpus benchmark were run.

This is two validated examples and one safely rejected malformed no-op, not a
quality guarantee. Model JSON can still fail and consumes its reservation;
the existing bounded failure/retry mechanism handles that without applying a
memory. Offline tests inject the drafter or mock AI and are not live proof.
The probe requires an explicit account and `--allow-three-paid-synthetic-calls`,
is excluded from `verify`, and always disposes its transient platform proxy.
It remains explicitly pinned to the legacy 8B model; a new default does not
silently turn that historical probe into an OpenRouter call. The later Haiku
comparison and owner selection are separate evidence, not a rerun of this probe.

## Eligibility and remembered decisions

The default console view excludes no-change results; All review activity includes
them. Accepted and dismissed rows stay in place; Hide decided (n) removes them
and Show decided (n) restores them. Model, limits and ranking sit in one
Settings disclosure. With reviews off the page leads with the consent switch;
with reviews on, a status line keeps Check waiting memories, both switches and
today's use visible. `?memory=<id>` narrows the list to one memory's groups,
and Check this memory now runs the same bounded pass with that memory as its
only starting memory and no due retry. The journeys are in
[memory consolidation](../design/memory-consolidation.md). Daily
cost is entered in USD; the server parses at most six decimal places into exact
integer micro-USD before applying the existing bounds. Legacy forms using
`dailyMicrousd` remain valid.

Prompt `memory-review-3` names the product, the reviewing person and the fresh
client that will later retrieve an accepted memory. Draft bodies must stand
alone; explanations name subjects/sources instead of input positions. No-change
results have no replacement text. Historical responses are not rewritten. Opening
a review shows saved source snapshots, selection methods for new runs, exact
quotes, the original model JSON and the latest fifty append-only human events.
Compact list queries return source names and proposal kind/explanation, not full
bodies/evidence; only the selected group loads its full snapshots and events.

New snapshots additionally record `selection.via` and `selection.anchorId`:
starting memory, existing link, keyword match, vector match or hybrid ranking.
Snapshots from before 2026-11-08 can also say recent same-project neighbor.
This is the branch that actually admitted the source, not a confidence score,
an exhaustive candidate ranking or authority. It is excluded from model input
and authoritative content fingerprints. Older snapshots have no selection trace.

New failures persist only `provider-http-NNN`, `provider-timeout`,
`provider-unavailable`, `provider-response`, `response-too-large`,
`response-truncated`, `invalid-json`,
`invalid-schema`, `invalid-evidence`, `invalid-draft` or `review-failed`. The UI
maps these to fixed explanations and never echoes arbitrary historical errors.
An unknown old failure cannot be diagnosed retroactively; the J2 insufficient-
context failure still needs an authorized rerun after release.

Migration `0038` backfills `memory_review_pending` once. Insert/content/archive
and typed-link triggers enqueue changed memories and affected linked neighbors.
Timestamp-only writes and reads do not enqueue anything. Every later pass uses
bounded oldest/recent queue windows, not a corpus walk or all-pairs generation.
Successful fetch frequency from the latest 100 tenant calls only prioritizes
that small eligible window. It confers no authority.

Memories already suppressed by a live human-confirmed supersession are skipped,
not sent back to a model to reconsider the person's decision. Removing that
supersession restores eligibility through the existing link-change trigger.

Each anchor retrieves up to three existing linked neighbors and fifty lexical
matches in its project, before choosing at most three neighbors. The lexical
search excludes the anchor and, when every term of its title finds nothing
else, asks for any term (`match: "any"`), because the anchor's own title always
satisfies the every-term pass. Until 2026-11-08 twelve recent same-project
neighbors filled the remaining slots; they produced most no-change results and
none of the benchmark's expected neighbors, so an anchor with no linked or
matching neighbor is now recorded as a no-change without a model call (ADR-0012
amendment of 2026-11-08).

Once the queue is drained, a nightly run also writes lesson lines: one call a
minute, at most eight a night, each sending up to sixteen memories whose current
revision has none, bodies cut to 900 characters, under the same consent, lock,
nightly count and cost cap. Lines land in `memory_lessons` keyed by memory and
revision, only while the memory is still on the revision sent. A failed lesson
call counts in the run's failures and ends that night's lesson lines.
After lesson lines, a weekly reflection drafts principle cards, one call a
minute and at most six a night; "This week's lessons" at the top of the
Review tab shows at most three, with Adopt, Not a rule and Reflect now.
`memory_reflections.ended` records why the last one stopped (`done`,
`nothing`, or a failure code). Candidate queries and snapshots always bind the
credential-selected user. Processing also requires the existing account-admission
policy: the user must still exist and be an owner or an email-verified member.
Unknown/deleted users and members whose verification/admission is withdrawn do
not reserve new budget or dispatch, even if orphaned settings remain opted in.
Invite revocation alone does not revoke an already-admitted account; this is
the same `accountAdmitted` policy used by authentication, not an invented role.
The helper checks pass entry, while the shared predicate guards the actual
lock, reservation, group admission and final dispatch statements against a
change after that check. An already-authorized in-flight request cannot be
recalled; prior conservative reservations are not refunded. User decision
history, preferences and queued work are not deleted by admission refusal.
A per-user five-minute lock serializes manual and
nightly passes.

A group's SHA-256 covers sorted source ids, immutable revision generations,
full-content/provenance/link fingerprints, model and prompt version. Full
snapshots and individual fingerprints remain in `sources_json`. The original
model JSON is retained; each human field edit and decision appends an event.
Proposals, accepted/dismissed decisions and no-ops are durable coverage. An
unchanged pair is not sent again under the same model even when other neighbors
rotate. `memory_review_sources` indexes each source id, revision and fingerprint
from retained group snapshots, including historical groups. All pairs in a chosen
group must be uncovered, not just anchor–neighbor pairs. Only the processed anchor
leaves the queue automatically; compared neighbors retain their own unseen work.
A singleton with terminal history for the same evidence/model is skipped instead
of generating another local no-op. This is bounded greedy coverage, not an
exhaustive comparison or a permanent per-memory consolidated flag. A meaningful
content revision, changed link evidence or new neighboring memory creates new
eligibility. A model/prompt change alone does not schedule a full-store rerun.
Accepted synthesis and its new links do not enqueue themselves for another
summary-of-a-summary loop; later actual edits still enqueue normally.

Provider/validation failures wait an hour and get at most one retry within the
same daily budgets. An interrupted running attempt becomes eligible after
15 minutes. Stale snapshots cancel the retry; new source eligibility handles
the change. Failure strings do not include source text, provider bodies or keys.

Admission uses the existing pass token and monotonic group attempt, not a new
schema. Every group admission, including a free local no-op, requires the current
unexpired per-user lock and execution permission inside the statement. D1's
`unixepoch()` checks expiry when the statement executes, not against a timestamp
captured by a delayed caller. A new group inserts only if its fingerprint is
still absent (`ON CONFLICT DO NOTHING`). Retry admission compares the exact due
failed/running state, attempt and retry time that was observed, and increments
that attempt only. It cannot reset a proposal, human decision or no-op to running.

The worker checks the admission's returned row before proceeding. Paid dispatch
then rechecks the admitted running attempt, token, model and opt-in in another
guarded write. Its returned deadline must still leave the full 30-second provider
window; no further asynchronous work occurs before invoking the drafter. Losing
either admission stops the pass without launching inference. The dispatch write
is authorization for an in-flight request, not a promise that an already
authorized request can be recalled by a later off switch.

Successful or failed model completion compares group id, attempt, running state
and current unexpired owner. Its actual returned row is checked too: an obsolete
result is discarded, not reported as a proposal/failure, and does not clear a new
owner's pending work. An authorized in-flight result can finish after reviews
are turned off only while its attempt and owner remain current. Retry
cancellation also compares the observed eligible state/attempt/time under the
current lock. Automatic pending cleanup additionally checks the live pass and
exact source stamps (or continued absence of an archived/missing source).
A delayed pass cannot revive terminal coverage, cancel a human
decision, or delete changed eligibility after lease takeover.

The minute cron inspects at most twenty opted-in settings using the
due-time index and processes at most five currently admitted accounts. Invalid
entries are conditionally deferred by 24 hours without changing their decisions,
consent flags or queue. That bounded prefix cannot permanently block admitted
accounts behind it. Valid accounts are advanced by five minutes under an atomic
admission guard before processing, and the processor checks admission again.
No corpus/account scan or filtering of unbounded accounts occurs before the
candidate limit. More accounts rotate across invocations; this is not a promise
of a daily pass for unlimited tenants.

## Approval and history

Each selected source has a Previous reviews line opening its latest ten rows
(eleven fetched to disclose more). The indexed query binds tenant and source,
and at most four source histories are loaded. History distinguishes compared
only, cited, incorporated, conflict-linked and superseded; being compared is not
evidence of incorporation. Accepted results link to their actual memory.

Accept and organize as subject is separate from ordinary acceptance and
supersession. It creates a named topic or uses an existing subject, confirms an
explicit subset of compared sources (cited sources selected initially), and
optionally makes the accepted memory the current summary. The picker holds at
most thirty subjects. A pasted id can add members without replacing an
undisplayed summary. A summary replacement checks the displayed pointer; all
subject changes share the source/draft approval batch and roll back together
on stale or foreign targets. Originals stay unchanged. Accepted activity links
to the subject, whose existing controls can remove membership or replace the
summary. Summary freshness still uses the existing conservative timestamp rule;
a same-second membership/summary write can show Needs review.

## Optional hybrid candidate ranking

Hybrid ranking defaults off independently of synthesis. Its permission names
`hybrid-bge-m3-jev-1.14.0-review1`: the anchor's complete title/body goes to
Workers AI bge-m3, and complete anchor/candidate titles, bodies and projects go
to TypeSafe `jev-1.14.0`. Existing current-vector hydration rejects stale,
foreign, unpublished and wrong-project heads before candidate text is ranked.
Vector retrieval contributes up to fifty current heads to a bounded hundred-row
pool. Jev input is at most 24,000 UTF-8 bytes and thirty candidates; full sources
are omitted, never truncated. Its saved selection record includes scores,
candidate origins and size/count omissions, outside model input and fingerprints.

The provisional 0.75 cutoff selects joint-review relevance, not truth, authority,
supersession or a conflict winner. It can miss useful compatible facts. This
implementation follows the synthetic experiment, not private-corpus acceptance:
`evals/memory-review/2026-10-29-candidates-run1/` records the measured boundary.
No new live inference is part of implementation verification.

One pass ranks at most two anchors, at most one embedding and one Jev request
each. Existing vector work has a 2.5 s deadline; Jev has a 1.5 s deadline and
64 KiB response bound. A 429 or 529 from Jev is retried with backoff inside
that deadline on the same reserved request. Missing configuration, failure,
timeout, malformed scores or revoked permission stop without lexical fallback or
clearing pending evidence. An anchor is not started with fewer than two ranking
requests left today, so the embedding cannot spend the request Jev needs.

Each stop is stored as one code in `memory_review_ranking_budgets.last_error`,
returned as the pass's `stopped`, and logged as `memory review ranking stopped`
with the code, the stage and the error class, never provider text or memory
content. The console shows each code as a sentence
(`rankingFailureLabel` in `app/concepts/memory-review-ranking.ts`).

| Code | Meaning |
| --- | --- |
| `ranking-http-<status>` | Jev answered with that HTTP status; 401 or 403 means the key |
| `ranking-timeout` | Jev did not answer within 1.5 s |
| `ranking-unreachable` | The request to Jev failed before a status arrived |
| `ranking-invalid-response`, `ranking-response-limit` | Jev answered without a score for every candidate, or over 64 KiB |
| `ranking-daily-limit` | Today's ranking requests, two per memory checked by hand or at night, are used up |
| `ranking-cost-limit` | Today's ranking cost cap, an admin's, is used up |
| `ranking-permission` | Ranking consent, model, account or pass lease changed before dispatch |
| `ranking-not-configured`, `ranking-input-limit` | A binding or the key is missing; the input passed 24 KB |
| `embedding-daily-limit`, `embedding-timeout`, `embedding-failed` | The Workers AI embedding or Vectorize stage, not Jev |

Rows written before these codes say `ranking-provider-failed` (any non-ranking
error from either stage) or `ranking-budget-or-permission`.
`AI`, `VECTOR_INDEX`, `VALISE_VECTOR_NAMESPACE` and `TYPESAFE_API_KEY` must all be
configured. The implementation does not provision credentials or enable users.

Ranking has no limits of its own for a person to set. Its requests derive from
the checks: two per memory (an embedding and a Jev request), counted by hand
and at night apart in `manual_requests` and `upkeep_requests`, so 50 by hand
and 100 a night by default. Its money cap is the admin's ranking cap, $0.20 by
default. `daily_requests` and `daily_microusd` on `memory_review_ranking` stay
unread. Each external dispatch atomically reserves one request
and conservative input-byte cost at bge-m3 $0.0118/M or Jev $0.042/M before
dispatch, with current consent revision, destination, synthesis model/permission,
account and pass-lease guards. Failed/interrupted reservations remain spent.
Unused synthesis budget cannot fund ranking or vice versa. Prices are pinned
catalog observations, not invoice reconciliation or a future-price guarantee.

Changing ranking permission clears overnight and its manual hybrid
qualification. A successful manual hybrid synthesis under that consent revision
is required before overnight can be re-enabled. Changing synthesis models
revokes ranking permission too. An explicit permission-on form checks the displayed revision/destination/model.
An already-authorized in-flight request cannot be recalled.

## Approval guards and supersession

Every non-no-op proposal includes exact source quotes and an explanation.
Kinds are duplicate consolidation, compatible summary, contradiction and stale
summary. Consolidation/summary/stale-summary must contain the actual drafted
new memory, not just a proposed relation. Quotes and ids are validated against
the tenant-scoped snapshots; invented evidence is a failed attempt.

Accepting a synthesis creates a new ordinary reference memory tagged `rollup`,
with the human actor's provenance, the source ids/revisions/fingerprints and
original attribution in its body. It adds confirmed `related` links. Originals
and their immutable revisions stay unchanged and searchable. It does not infer
a search boost, an authority score or a preferred winner.

A consolidation can instead supersede its contributing originals only when the
person separately selects supersession and attests that every still-true claim,
qualification and attribution is retained. A shorter compatible summary is not
enough. Model confidence, repetition and recency cannot select that option.
Contradiction approval confirms a `contradicts` link and chooses no winner.
Explicit user judgments stay attributed as judgments; third-party evidence is
not silently promoted to user authority.

Acceptance checks source revisions, full content/link stamps, proposal state
and the exact draft shown to the person inside the same D1 batch as the new
memory, confirmed links, decision event and all affected projections/vector
work. A stale or double approval cannot create an extra memory. A preflight
check provides a readable error; the write-time guard closes the race.

Dismissal retains the row and can be reversed with Reopen. Accepted memories
and links use the existing Memories archive/remove controls: archiving a new
successor republishes its superseded predecessors. Nightly upkeep applies only
additive summaries (above); no automatic supersession, deletion, content
overwrite, or model-asserted ranking change is implemented.

## Backup and verification

The managed operator backup explicitly names `memory_review_settings`,
`memory_review_groups`, `memory_review_events`, `memory_review_budgets` and
`memory_review_pending`, `memory_review_ranking` and
`memory_review_ranking_budgets` in `scripts/recovery-policy.mjs`. The queue is derived
eligibility but retaining it preserves exact review progress. Fresh memory/link
inserts fire eligibility triggers, so restore clears that destination-generated
queue before loading the captured queue; it does not schedule a corpus review.

Fresh recovery resets the review, overnight and automatic-application opt-ins off and clears
lock tokens, expiry and the operational next-run time. Model choices, limits,
budget reservations, full source snapshots/fingerprints, proposals, human
events and accepted/dismissed/no-op coverage survive. Interrupted `running`
attempts become failed with their spent attempt count and prior error retained;
there is no in-flight request to resume. A remaining retry requires new explicit
authorization. Other failed/terminal decisions are unchanged. Ranking restores
off with its permission revision incremented and manual qualification cleared;
its limits and spent reservations survive. The derived `memory_review_sources`
index is omitted from backup and rebuilt by restored group INSERT triggers.

Each user must explicitly enable review transmission again and separately opt
in to overnight drafting. Restoring provider configuration or a saved model
choice is not consent, proof of availability, or permission to spend. Restore
does not enable a provider or run inference. Review rows are not part of the
search projection and reindex does not publish drafts. See
[managed backup and recovery](backup-recovery.md); `test/backup.test.mjs` seeds
and compares all five tables, tests exact progress despite insertion triggers,
and asserts no inference/network call during its in-process recovery rebuild or
the real review entry points with synthetic configured-provider bindings.

`test/d1/memory-review.worker.test.ts` covers synthesis, duplicate consolidation,
contradictions, immutable evidence, accepted provenance, stale-source batch
rollback, no-op/dismissal coverage, changed-revision/new-evidence eligibility,
tenant isolation, authenticated same-origin actions, daily cost/failure limits,
finite retries, twelve lease-race scenarios, current-account admission and
overnight opt-in/bounds. `test/ui/memory-review.spec.ts` covers browser
cases: switches/provider selection, actual evidence-card editing and acceptance,
compatible-summary original retention, separate retained-truth attestation for
supersession, dismiss/reopen in place, stale refusal with saved draft, keyboard
actions, canonical tabs and legacy GET/POST compatibility, and complete
native-form review at 320px without scripts. Fixtures seed
only synthetic rows into the supervisor's isolated local D1 through Wrangler
`--local`; a private owned state descriptor is removed on teardown. No Worker
test endpoint or provider call is added. The real fresh-install recovery drill
checks 25 tables, including both to-do relation tables and all five review tables.
Full verification remains the repository's
`npm run verify`, including UI, against the exact PR head before any push.

For provider-free focused runs, remove the inherited `OPENROUTER_API_KEY` and
verify that no local `.dev.vars`/`.env` supplies one; remote bindings stay off in
the existing Vitest/Playwright configurations. Do not set
`CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false` when relying on Playwright's
synthetic process-env login secrets: Wrangler's required-secret process-env
fallback is inside that loader, so the flag removes the session secret too.
The setup asserts the authenticated login destination before changing settings.
