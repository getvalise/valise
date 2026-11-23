# 0012. Typed links between memories, each with who asserted it

Date: 2026-10-18
Status: accepted

## Context

A memory stands alone. Nothing records that one replaces another, sits under
another, or disagrees with another, so `search` ranks a stale memory beside
its replacement and the model picks one. Production has the case already: on
2026-10-18 `mem_9840ca8c` restated the lesson `mem_5a30e0af` had saved
seventeen hours earlier, and `mem_53d23ad8` and `mem_ed7fe32d` both say
workflow subagents cannot merge pull requests. Both pairs share a project and
have overlapping titles, and the check-on-save to-do's comment reports the
newer one outranking the older in both.

The check-on-save to-do wants `save_memory` to list similar memories and ask
the model to link, supersede, or confirm the save is new. It can only ask for
a textual reference until a link has somewhere to live. This ADR is that
place.

Three things constrain the shape. ADR-0001 pairs every write that changes
searchable content with its projection statement, and freezes the
projection's content columns. `memory_revisions` is append-only, and
`editMemory` writes a revision whenever it updates the `memories` row. ADR-0003
makes every tool description a product surface with an eval behind it.

## Decision

Links are rows in their own table, `memory_links`, inside the memory concept.
Both ends are memories, so no concept learns about another.

```
memory_links(
  link_id         text primary key,      -- mln_<uuid>
  from_memory_id  text not null references memories,
  to_memory_id    text not null references memories,
  kind            text not null,         -- CHECK: part-of, supersedes, contradicts, related
  asserted_by     text not null,         -- CHECK: model, person
  source_agent    text not null,
  source_client   text not null,
  source_session  text,
  created_at      integer not null,
  confirmed_at    integer,
  confirmed_by    text,                  -- user id
  removed_at      integer,
  removed_by      text,
  unique (from_memory_id, to_memory_id, kind)
)
```

- Four kinds, a closed vocabulary. `supersedes` points from the newer memory
  to the one it replaces. `part-of` points from child to parent.
  `contradicts` and `related` are symmetric and store the lower memory id as
  `from`, so one pair has one row. The server acts on `supersedes`, and a kind
  no code reads is a tag, so the CHECK stays closed where `memory_type` is
  open.
- `supersedes` means the newer memory carries everything still true in the
  older one. A memory that refines part of another is `part-of` or `related`.
- The write path sets `asserted_by`. Every MCP write is `model`, including the
  one a person dictated, because the server cannot tell the difference. A
  console write is `person` and is confirmed when it is created. The
  provenance triple has the same names as on `memories`.
- A model-asserted link is a suggestion until a person confirms it in the
  console. Only a confirmed link changes ranking. Unconfirmed links still show
  in `fetch`, flagged, because an agent that opens the older memory is better
  off knowing a newer one may replace it.
- Removing a link sets `removed_at`; the row stays. A person's "no" is then
  remembered: a model asserting the same link again gets the existing row back
  with its removal date, not a fresh suggestion. Restoring a removed link
  clears `removed_at`. Neither touches `memories` or `memory_revisions`, which
  is why links are not a column: a `superseded_by` column would allow one
  successor, carry no provenance, and write a content revision for a change
  that did not touch the claim.
- A memory with a live, confirmed `supersedes` link from a live successor
  projects null. It leaves `search`, the way a superseded SKILL.md never
  enters the ranking, and stays readable by id. `projectMemory` takes one more
  input, whether the memory is superseded, and the reindex query reads it with
  a `NOT EXISTS` over `memory_links`. Five writes change that input, and each
  pairs with the predecessor's projection statement in one `db.batch`:
  confirming a `supersedes`, removing a confirmed one, restoring a removed
  confirmed one, a person asserting one, and archiving a successor, which
  republishes what it superseded.
- Nothing else moves the ranking. `contradicts` is a prompt for a person, who
  resolves it by asserting a `supersedes` or archiving one side. `part-of` and
  `related` are navigation.
- Over MCP, `save_memory` takes an optional `relates`, a list of
  `{ id: "memory:mem_…", kind }` with the new memory as `from`. The memory and
  its links go in one batch. An id that does not resolve to a live memory
  fails the whole call and names the id, because a save that lands without
  its link is the duplicate this exists to prevent. `fetch` on a memory, and
  the `save_memory` result, carry `metadata.links`: one entry per live link,
  `{ kind, id, title, confirmed, asserted_by }`, with `kind` read from the
  fetched memory's side (`supersedes`, `superseded-by`, `part-of`, `has-part`,
  `contradicts`, `related`). Links to archived memories are left out.
- No new tool. The `relates` field description is a description change, so it
  ships with the check-on-save case pair in `evals/cases.json` and a baseline
  run before it, not on its own.

Three questions the to-do left open, settled here:

- Search ranking: `supersedes` changes it by unpublishing, as above. A rank
  penalty would need a column the frozen projection does not have, and BM25
  scores do not take an additive penalty without per-query tuning.
- A per-project timeline needs nothing new. `project` and `created_at` on
  `memories` already order one project's memories, and a `supersedes` chain
  is the history of one claim. `part-of` is a hierarchy, not a time axis, so
  a view over it would answer a question nobody has asked.
- Embeddings would not make `related` computed. `memory_links` holds claims
  someone made. Similarity from a vector index, if the retrieval-at-scale
  numbers justify one, is a query result, and the check-on-save line reads it
  as one. It is never written into this table, so the embeddings decision
  cannot change this schema.

Rejected:

- A model-asserted `supersedes` that unpublishes on save. A wrong one hides a
  true memory from every later session, and no person sees it happen. The
  opposite error, a duplicate that ranks until someone confirms the link, is
  the state today.
- Hard-deleting a removed link. A rejected suggestion would return on the next
  save that resembles it.
- An open `kind` vocabulary. See above.
- Traversal: transitive `supersedes`, cycle detection beyond refusing the
  direct reverse of a `supersedes` or `part-of`, and nested `part-of` trees.
  `fetch` returns direct links and the agent follows them by id.

## Consequences

An agent that fetches a stale memory learns which memory replaced it, and once
a person confirms the link the stale one stops competing in `search`. The
check-on-save nudge gets an action beyond "mention it in the body".

The maintainer inherits one more authoritative table, which backups have to
name with the rest. The supersession input becomes part of publish
discipline: the five writes above are new projection-changing paths, and the
existing rule in `AGENTS.md` covers them. The reindex query for memories grows
a subquery.

The confirmation step can be ignored. If nobody confirms, unconfirmed
`supersedes` links change what `fetch` says and nothing else, so the store is
no worse than before.

Not in this decision: a per-project rollup memory written on an explicit
`capture-this` request, which is a cache and belongs with the capture skill,
and links from a memory to a to-do or a skill. Linking two memories that both
already exist, over MCP, stays open in `docs/adr/README.md`.

## Amendment, 2026-10-19

`edit_memory` takes optional content fields and the same `relates` list as
`save_memory`. This settles linking two existing memories over MCP. A
link-only call adds no content revision. A separate `link_memories` tool was
rejected: one existing-memory operation covers both needs without another
entry on every client's tool list. The earlier "No new tool" decision
applies to save-time links, not to editing existing memories.

Retrying a removed suggestion does not restore it. The edit response reports
those attempted assertions under `metadata.removed_links`, including their
removal dates, while `metadata.links` continues to contain live links only.

MCP always asserts `model`; its input cannot select assertion authority,
confirmation, removal, or restoration. Those operations require the signed-in
console user and same-origin action check. `memories:write` covers editing,
including another connected client's memory, because v1 is one user's store
and authorization is per-concept (ADR-0004), not per-agent.

Content snapshots select the live row and next revision inside the same batch
as the partial update, including the previous project and the editing client's
provenance. `memory_revisions` remains append-only. Memory publication selects
authoritative content and link state inside that batch rather than projecting
a pre-write snapshot, so concurrent edits, confirmations, removals, and
successor archives cannot republish stale content or a superseded memory.
The SQL byte cap is checked against `projectMemory` and reindex in D1 tests.

Backups must include `memory_links` with `memories` and `memory_revisions`.
The projection and FTS are rebuilt from those authoritative tables; link rows
are never inferred from search similarity.

Application INSERT and restore statements check live endpoints and direct
reverse links inside the write itself. A failed check produces a null link id,
whose NOT NULL constraint aborts the entire batch, including content, revisions,
and projection changes. Preflight checks give a readable conflict; a write-time
conflict becomes the same domain error. Removed assertions remain no-ops on
retry, even when an active reverse exists.

These are application-write rules, not INSERT triggers on historical rows.
Restore loads authoritative INSERTs with deferred foreign keys: links may precede
memories, keep archived endpoints, or contain a removed directional assertion
beside its live reverse, in either row order. The table constraints still check
the row shape and foreign keys; reindex derives publication from the restored
history.

## Amendment, 2026-10-21

`save_memory` no longer puts links in its structured receipt. PR134's required
`metadata.links` broke clients caching the older closed output schema after a
write had already committed. The receipt returns to its pre-PR134 shape; live
links, when present, are an extra JSON text block. `fetch` and `edit_memory`
retain `metadata.links` in their open metadata object. Link authority, batching,
confirmation and publication are unchanged. ADR-0003 and
`docs/operations/mcp-catalog-refresh.md` record the one-time refresh required
for clients caching PR134's intermediate required-links schema and why the
stateless handler does not promise list-change notifications.

## Amendment, 2026-10-24: model-drafted memory inbox

Owner approval of 2026-10-23 authorizes bounded model drafting, not automatic
application. The Review section of Memories (`/memories?tab=review`, first
shipped as `/memory-inbox`, removed 2026-10-25) holds consolidation, compatible new summary,
contradiction and stale-summary proposals with exact source evidence and why.
The model writes the actual proposed synthesis. Drafts and no-op/dismissed
decisions live outside `memories`, `memory_links` and search until a person acts.

Migration `0038_memory_review` adds per-user opt-in/provider/limit settings,
incremental eligibility, fingerprinted review groups, append-only human events
and daily reservations. Insert/content/link triggers enqueue meaningful changes;
one initial backfill replaces repeated corpus walks. Group coverage includes
source ids, revision generations, full content/provenance/link fingerprints,
model and prompt version. An unchanged accepted, dismissed or no-op group is
not prompted again. Changed revisions or new neighboring evidence can reopen
eligibility. The bounded selection and finite retry mechanism are specified in
`docs/operations/memory-inbox.md`.

The default provider is the existing Workers AI binding with Llama 3.1 8B FP8;
Llama 3.2 3B and explicitly selected OpenRouter Gemini 2.5 Flash Lite are
allowlisted alternatives. There is no provider fallback. All drafting defaults
off; a manual pass precedes separate overnight opt-in. Per-user call and
conservative money reservations happen before requests, failed attempts included.

Accepting a synthesis creates a new memory, preserves original attribution and
revision fingerprints, and confirms `related` links without hiding originals.
Only a consolidation with a separate human full-retained-truth attestation may
confirm `supersedes`. A compatible summary is not that attestation. Accepting a
contradiction confirms `contradicts`, never a winner. Explicit user judgments
and attributed third-party claims retain their attribution; popularity and
model confidence do not confer authority.

Source revision/content/link stamps, exact displayed draft and pending state
are checked inside the publication batch. A stale source or concurrent approval
aborts the memory, links, event and projections together. Original memories and
append-only revisions are never rewritten by this feature. Dismissal is
remembered and reversible; accepted links/memories retain the existing removal
and archive semantics. Automatic merge, deletion or application remains outside
approved scope.

Managed deployment recovery includes all five review tables. It retains human
decisions/events, original model drafts, revision-aware coverage, exact queued
progress, model/limit choices and budget reservations. Fresh-install restore
resets review and overnight opt-ins off, clears locks/tokens/next-run time, and
marks interrupted running attempts failed without refunding their attempt or
cost. Replaying memories and links must not create a new corpus-wide review
queue: the destination's trigger-generated eligibility is cleared before the
captured queue loads. Only fresh explicit user consent can permit transmission
and spending again; restored provider configuration is not that consent.
`docs/operations/backup-recovery.md` records the policy and fixture assertions.

Admission is fenced independently of budget reservation. New groups use
insert-if-absent, never an UPSERT that resets existing coverage. Every admission,
including a free local no-op, checks the current unexpired pass token and
execution permission in D1. Retry admission compares the observed due
failed/running state, attempt and retry time before incrementing the attempt.
The actual returned row is required before proceeding. Paid dispatch checks the
running attempt/token/model/permission again and requires the complete provider
time window to remain. Expiry is evaluated at statement execution, not from a
caller's earlier bound timestamp. Losing admission launches no model call;
uncertain budget reservations are retained, not refunded.

Late successes/failures require the same current owner, running state and
attempt. A failed write cannot report a proposal or clear another owner's
eligibility. Retry cancellation and automatic queue cleanup are fenced too.
The existing token and monotonic attempts suffice; no additional schema or
terminal-state reset is permitted. Deterministic D1 regression sources delay
real read/write responses, force lease/backoff expiry and interleave a real
winning pass with human acceptance/dismissal. They assert accepted, dismissed
and no-op coverage survives, local no-ops cannot bypass ownership, dispatch
requires successful current admission, and obsolete completions leave history
and the successor's queue intact. They are not live-provider proof.

Settings are not account admission. Manual and scheduled processing call the
existing `accountAdmitted` helper; its shared SQL predicate also guards lock
acquisition, reservations, group admission and final provider dispatch within
the write. An existing owner or email-verified member is admitted; an unknown,
deleted or no-longer-verified member is not. Revoking an invite deliberately
does not withdraw an already-admitted member's access. No new role/revocation
framework is introduced. Refusal preserves decisions and does not reserve new
budget; already-authorized in-flight requests and their earlier reservations
cannot be recalled.

The cron reads at most twenty due settings and processes at most ten admitted
accounts. Invalid entries are conditionally moved out of that due window for
24 hours without deleting history or queued progress. This bounds point
admission checks and prevents orphaned settings from permanently starving
valid accounts; it does not scan the corpus or all accounts.

The inbox uses shared page blocks and one-field draft editors (P1/P2/P6), URL
evidence disclosure (P3), stable created-order rows retained after decisions
(P4/P5), native provider/limit controls and visible switches (P7/P10), fetcher
forms with the no-script path (P11), and dismissal/Reopen on the same row
(P12). There is no separate stylesheet or change to existing object routes.

## Amendment, 2026-10-29: understandable review and inspectable decisions

The user job is to decide whether a proposed memory improves future retrieval,
not to operate a model queue. The populated default shows actionable drafts,
failed attempts and prior human decisions. Unchanged/no-change results live in
the explicitly linked All review activity view; an accepted or dismissed row
stays in place. Shared ItemList/ItemRow rows open a URL-addressable right-hand
pane (bottom sheet on phones) revealing the actual draft,
named source memories, exact supporting quotes and the model's explanation.

The primary action is Accept new memory (or Confirm contradiction link), after
reading and optionally editing the draft. Originals remain searchable unless a
consolidation receives both separate supersession attestations. Dismiss/Reopen
remain on the same row. P1/P2/P3/P4/P5/P10/P11/P12 govern these interactions.

A short introduction explains find → draft → human review. Provider, explicit
transmission permission and Run review remain visible; rate arithmetic, advanced
limits and overnight scheduling are secondary disclosures. Money is entered in
USD, converted exactly to integer micro-USD at the console boundary. Turning
reviews off, selecting a new destination and prior-manual-pass requirements keep
their existing semantics. No browse or disclosure invokes a provider.

The explanation must name its subject and source titles rather than input order
(“first and fourth”) or unbound pointers (“these memories”). A new-memory body
must stand alone when retrieved by a fresh client. No-change decisions have no
replacement draft. Historical model JSON is never rewritten or relabelled.

Process inspection distinguishes observed evidence from implementation policy:
show saved source snapshots, recorded selection methods on new runs, original model output, human-edited draft and
append-only human events, with model/prompt/attempt identifiers disclosed below
the decision. Explain current links → keyword → recent-project selection, not
vector/Jev selection that this path does not run. Without a stored selection
trace, do not claim a specific neighbor was chosen for a particular reason. New
snapshots record the selection branch and starting-memory id as derived run
metadata, outside the authoritative source stamp and outside model input.

Initial loading remains bounded to thirty compact groups (maximum one hundred
on explicit Load more), with full snapshots/events only for the selected group.
A manual pass retains eight-anchor/two-call/24 KB/30-second-per-call limits.
Provider failure, timeout, invalid JSON, invalid schema and unsupported evidence
are distinguishable fixed categories; never persist provider bodies or exception
messages. A failed call does not apply a memory or refund its reservation.

Evidence boundaries: deterministic D1 tests establish integrity and refusal;
desktop and 390/320px native/enhanced browser walkthroughs establish interaction;
synthetic live comparison establishes only the measured model cases. Production
J2 acceptance remains separate, including the unresolved insufficient-context
attempt. No private-corpus benchmark or change to execution consent is implied.

### Candidate ranking, still open

The owner proposed vector retrieval plus Jev ranking, then Haiku or Sonnet for
synthesis. This separates recall, relevance and generation correctly. Existing
search research (ADR-0013) measures better paraphrase recall from the lexical/
vector union, but it does not measure consolidation groups. The current Jev
question ranks answers to a query, not whether two memories can usefully be
consolidated. Topical similarity is neither redundancy nor contradiction.

A consolidation-specific experiment should compare labeled duplicate, compatible,
conflicting and unrelated pairs with long-body distractors, include stale-vector
and tenant-isolation cases, and record candidate provenance, relevance and total
cost before changing selection. Existing confirmed links stay evidence, not
automatic permission to supersede. A second provider destination also needs its
own disclosed transmission consent: opting into OpenRouter synthesis does not
authorize private text going to Jev/TypeSafe. This keeps implementation open
until measured group quality and the destination/budget contract are approved.

The [October 29 candidate experiment](../../evals/memory-review/candidate-selection.md)
measures the unchanged selector on eight synthetic groups: five of seven useful
neighbors retrieved, nineteen unsuitable neighbors among twenty-four selected.
Keyword depth 50 still misses the paraphrase and compatible pair because the
anchor's own exact-title match prevents the OR-query fallback. These are a small
adversarial baseline, not production prevalence or live vector/Jev evidence.
The owner then approved forty synthetic-only requests under $0.10. Eight
embedding batches recovered seven of seven useful pairs in local cosine top
three. Thirty-two matched Jev calls compared generic relevance with joint-review
questions in both source orders. Joint review at threshold 0.50 retained seven
of seven useful pairs but admitted the missing-context negative in one order;
at 0.75 it dropped the compatible pair in one order. The experiment reserved
$0.006893 and exhausted its call cap. These measurements justify continuing the
design, not a production threshold, private-content transmission or default
change. The experiment records the separate destination/budget contract and
the limits of full-pool ranking versus actual retrieved-pool input.

The owner's follow-up asks for subject formation and a per-memory coverage
track record. Seven unchanged synthetic notes produce four distinct groups in
two passes, with three unchanged notes repeated in all four. Exact-group
coverage exists; relationship/source-level progression and visibility are the
missing layer. Compared input is not necessarily cited, consolidated or
superseded. A global covered bit would hide genuinely new evidence and
multi-subject membership. Keep the source revision, prior group/decision,
citation status and reason for revisiting inspectable. Subject proposals and
attaching accepted summaries remain human-approved actions against the existing
subject identity/membership model; Review must not silently infer membership.
The [experiment contract](../../evals/memory-review/candidate-selection.md#subjects-and-repeat-coverage)
records this open implementation boundary. No production subject or coverage
behavior changes in the experimental slice.

GLM 5.3 Flash is offered as an explicit Workers AI alternative after the bounded
synthetic context probe. Haiku remains the default; changing to GLM revokes both
execution flags exactly like any other destination change. No fallback is added.

## Amendment, 2026-10-24: owner-selected Haiku default

The owner selected `anthropic/claude-haiku-5.5` with “Excellent let's go for
haiku!” after the matched shortlist comparison recorded in
`evals/memory-review/2026-10-24-shortlist/report.md`. Haiku replaces Llama as the
application default and the only newly offered model. The selection changes
code, not any person's execution opt-ins or the operator's secrets. Human
approval, source/revision/evidence fencing and the `memory-review-1` prompt
remain unchanged. The synthetic rubric does not prove complete truth retention.

Historical Llama and Gemini choices remain exact saved destinations rather
than silently moving opted-in users across providers. Only an unchanged saved
legacy choice can be retained; it is not available as a new choice. Selecting
a different model clears both execution flags atomically and requires explicit
transmission consent, a manual pass with the selected model and separate
overnight opt-in. Existing history, coverage and spent reservations survive.
This is a consent revocation coupled to a destination change, not a new broad
settings-save operation. An earlier authorized in-flight call may finish under
its original fence, but the change authorizes no further dispatch.
Permission-on writes are bound to the model displayed in that form and compare
it atomically with current settings. A delayed old-provider consent cannot
authorize a new destination; off remains unconditional from a stale form.

Haiku uses optional OpenRouter configuration, JSON mode, reasoning off, no
unsupported temperature and only parameter/privacy/price-compatible routes.
Missing configuration stops before spending or sending; no cheap-provider
fallback is permitted. Per-model reservations and matching router caps use
$0.10/$0.50 per million for Haiku within the unchanged 24 KB/1536-token/30-second
envelope. The >=100k-token rate tier cannot apply inside it. The operation guide
names legacy rates and the maximum reserves. Failed/unknown attempts remain
spent; a default change never triggers a corpus sweep or user-data benchmark.

The frozen migration's SQL default is not rewritten or used for new application
settings: inserts bind Haiku explicitly. Existing/restored model values and
historical proposal model ids stay readable. Recovery still clears both opt-ins
and live locks, retains attempt/budget/history and never resumes private-text
transmission merely because the selected model or operator configuration exists.

## Amendment, 2026-10-25: Haiku released with two alternatives

The owner released Haiku as the default and added `anthropic/claude-sonnet-5.5`
and `deepseek/deepseek-v4.1-flash-1017` as new choices. Haiku is no longer the
only newly offered model; the legacy rules above are unchanged, and switching
between any two offered models clears both execution flags the same way.

The actual-adapter journey in `evals/memory-review/2026-10-24-journey/` labelled
compatible claims a contradiction. The owner ruled that a prompt-quality issue,
not a release blocker; the evidence stays as recorded and the prompt fix is a
separate to-do. Each model keeps its own reservation rate and router cap:
Sonnet $2/$10 per million with the lowest reasoning effort it accepts, DeepSeek
$0.30/$1.20 per million, its weekday peak rate.

## Amendment, 2026-10-26: only a supersession asks for confirmation

Owner, 2026-10-26: confirming every model-asserted link is excessive. Only a
confirmed `supersedes` changes anything; it takes the older memory out of
`search` (`app/search/memory-source.ts`). For `related`, `part-of` and
`contradicts`, confirming changed one label in the console and `fetch`, and
the "model suggestion" label read like a chore for the owner.

The memory detail pane now labels and offers Confirm only for `supersedes`
and `superseded-by`. Any other live link shows "added by an agent" when
`asserted_by` is `model`, and nothing extra when a person added it. Remove and
restore are unchanged for every kind. The data and the API do not change:
`confirmed` stays in `fetch`, still false for these links, and the console
action still accepts a confirmation. The review inbox's "Confirm contradiction
link" accepts a review proposal and is unchanged. The decision above still
holds for `supersedes`: a model-asserted one never unpublishes on its own.
`test/ui/console.spec.ts` covers a `related` link with no Confirm button
beside the existing confirm-and-reverse test for `supersedes`.

## Amendment, 2026-10-27: memory subjects

### Implementation contract, 2026-10-30: review progression and subject formation

The owner requested overnight implementation, using best judgment rather than
waiting for another design review. P1–P5, P7–P11, P14 and P15 apply. The job is
to work through new evidence without paying to compare the same unchanged pair,
inspect each source's previous reviews, and optionally turn a coherent proposal
into a stable subject with source membership and current understanding.

The populated Review view keeps its thirty-row list and side pane. Source
evidence adds a compact previous-review line and at most ten prior rows per
source on request; four sources bound this at forty rows. An indexed projection
of saved group sources provides revision/fingerprint-aware relationship coverage
and per-source history, including older groups. Proposal, no-op, dismissed and
accepted groups cover compared pairs; failed attempts retain their existing
finite retry path. Compared is not incorporated: history distinguishes cited
contributors from uncited input and links to the actual decision/result. New
revisions or previously uncompared neighbors remain eligible. No global covered
flag, corpus walk, or automatic deletion is introduced.

Ordinary Accept remains the primary action. A second named action, Accept and
organize as subject, opens a centred form (P15) with new-topic name or existing
subject id, explicit source membership and an optional current-summary choice.
Only cited sources are initially selected. It does not imply supersession or
choose a conflict winner. Creating the subject, confirming selected membership,
accepting the memory and optionally replacing a summary pointer share the same
optimistic batch as source/draft approval. An existing pointer must still equal
the value shown; stale, foreign or missing subjects refuse the entire batch.
An accepted review links to its subject through recorded human history. Existing
subject controls provide removal and summary replacement; originals remain.

Failures stay in the same form with the draft intact. Existing subject choices
are bounded at thirty; the full subject id remains usable outside that window.
No inference is required to organize a proposal. Default-view, modal primary
action and native 320px evidence must be retained before a ready PR. Integrity,
retrieval, browser usability and production observation are reported separately.

Hybrid candidate ranking is a separate opt-in to Workers AI query embedding and
TypeSafe Jev, not permission inherited from synthesis. Its destination/version,
separate request/USD limits and conservative provisional relevance cutoff must
be disclosed. Existing users stay on the lexical path until they opt in. A
ranking failure stops without clearing pending evidence or silently falling back.
Authorization, account, lease and budget must be rechecked immediately before
each external dispatch; no paid experiment is authorized by this implementation.

A subject is a stable, user-owned identity, not a memory type, tag, project or
`part-of` link. A summary memory alone cannot represent an empty subject or
survive summary replacement while retaining identity and memberships. Add
`memory_subjects` (id, user, name, kind, description, optional current summary)
and `memory_subject_members` (subject, source, assertion and removal metadata).
Membership is many-to-many and authoritative only here. Tags help find
candidates, and existing `related`/`part-of` links still navigate memories;
neither is silently promoted to membership. All reads and writes bind the
signed-in user and guard both endpoints in SQL, including summary assignment.
No broad migration of tags or old links runs. Both tables are authoritative
backup inputs; summaries remain ordinary projected, revisioned memories.

The user job is to find the current understanding of a person, topic, area or
profile and inspect its supporting memories with original dates, provenance and
history. `/memories/subjects` defaults to a bounded index showing name,
kind, description, confirmed member count and summary state; its primary action
creates a subject. A stable `/memories/subjects/:subjectId` URL shows a summary
or explicit missing state, then a bounded list of source links, and offers
single-field edits, add/remove membership and setting or clearing an ordinary
memory as summary. Candidate discovery is a bounded title/body or tag filter;
global search stays the default on All memories. The current Review tab and its
provider consent, evidence snapshots, approval and rejection behavior remain
unchanged. Accepted model-drafted summaries may be selected as current summary
by a person; a proposal is never current merely because the model suggested
it. A manually created summary is a new ordinary memory, not a supersession.
Summary replacement changes the pointer, never archives or supersedes sources.

Freshness is conservative: missing or archived summary means `missing`; any
current source updated, added or removed at or after the summary's update
second means `needs review`; otherwise `current against linked evidence` means
only temporal coverage, not verified truth. Confirmed contradictions among live
members are shown as conflicts, not silently resolved. The existing Review
pipeline can suggest new or stale summaries independently; it has no asserted
subject membership and does not automatically attach its results. An invalid,
missing or cross-user target returns a refusal, not an optimistic success.
Index and member queries cap each response at 30 + 1 rows; the member finder
also caps its result. A no-script form works, with enhanced fetcher actions
preserving scroll and field context (P1–P4, P7–P11). Validate at desktop and
390px/320px with realistic metadata variants and volume. Observe production
separately from data integrity, retrieval and browser evidence.

## Amendment, 2026-10-30: consolidation journeys for a new user

The owner asked for the review UI to serve a person who is not the owner and
not an engineer. [Memory consolidation journeys](../design/memory-consolidation.md)
holds three interaction contracts: a morning skim of overnight suggestions
(J-A), checking one memory now (J-B), and turning reviews on (J-C).
Consolidating a whole subject is recorded there as not built, with what would
force it.

The Review tab leads with a status line, or a setup panel when reviews are
off. Model, limits and ranking move into one Settings disclosure. The pane
puts the proposed memory and its decision above the source evidence, and
collapses revision, agent and selection metadata per source (P1, P13, P14).
Hide decided (n) follows P5. After a decision the pane offers the next
waiting suggestion (P3, P4).

J-B adds `?memory=<id>`, which narrows the list through the existing
`memory_review_sources` index, and an optional starting memory for
`runMemoryReview`. A check of one memory replaces the queue windows and the
due retry with that memory. Consent, the lock, daily limits, the two-call cap,
the 24 KB bound and pair coverage are unchanged. Only that memory leaves the
queue. A memory the person does not own is refused before the lock is taken.
No migration, no new provider destination, and no change to consent or
supersession semantics.

## Amendment, 2026-11-04: nightly upkeep applies what only adds

Owner, 2026-11-04: "there is still no coherent, end-to-end workflow ... In the
end this should work overnight, consolidate automatically where possible, and
only surface user questions if needed." That supersedes the 2026-10-24 line
"automatic application remains outside approved scope" for additive results,
and the rule that overnight drafting needs a manual check first. The journey
and its contract are J-0 in
[memory consolidation journeys](../design/memory-consolidation.md).

A run applies `summary` and `stale-summary` results itself. Each becomes a new
`rollup` memory written by `valise:memory-upkeep` through the same guarded
acceptance batch a person's Accept uses: source stamps, the unchanged draft
and the pending state are checked at the write, the projection statements ride
in the same `db.batch`, and the batch also requires `auto_apply = 1` and
`enabled = 1` at that moment, so a person who turns upkeep off mid-run stops
the next application. Its `related` links are asserted by the model, not
confirmed by a person, and its body says no person checked it. Originals and
`memory_revisions` are untouched. `memory_review_groups.applied_by` records
`auto` or `person`; the decision event is an ordinary `accept` with
`automatic: true`, because the event kind CHECK is frozen in `0038`.

Undo on an applied row archives the added memory and turns the group to
`dismissed` in one batch, with a `dismiss` event carrying `undo: true`. The
group stays coverage, so the same unchanged sources are not proposed again.

`consolidation` and `contradiction` stay questions. A consolidation applied by
a person may still supersede its originals with the retained-truth check; a run
never supersedes. Whether a run may merge duplicates itself is an owner
question on `todo:tdo_c312ae39-c8e1-4a41-89ed-6ec0ab6a2134`; until it is
answered, it asks.

One switch, Tidy my memories every night, sets `enabled`, `overnight` and the
new `auto_apply` together, bound to the displayed model, sets the daily cost
limit to $0.10 (the console's existing maximum) and makes the account due at
once. Off clears `overnight` and `auto_apply` and leaves checks by hand as
they were. A model change clears all three. A row that opted into overnight
drafts before this amendment keeps drafting without applying until the person
turns the new switch on; an earlier consent is not stretched to cover writes
it did not name. Fresh-install recovery clears `auto_apply` with the other
two.

A run is no longer one two-call pass from the nightly cron. The minute cron
picks at most five due accounts, each gets one ordinary bounded pass, and
while that pass stopped at its call cap or left queued memories, the account
is due again the next minute. The run ends when the queue is empty, today's
limit is used, the pass stops for another reason, or forty passes have run;
`next_run_at` then moves to the next 02:00 UTC. Claiming a minute moves
`next_run_at` five minutes out, the pass lock's length, so overlapping minutes
do not stack passes. A run's totals are kept in
`memory_review_settings.last_run_json` for the status line.

Automatic runs have their own call cap, `nightly_calls` (1–30, default 20),
because `daily_calls` keeps its frozen `0038` CHECK of 1–8; a manual check
still stops at `daily_calls`, counted against the same day's total. The money
limit is unchanged and covers both. At Haiku's maximum reservation of
$0.003168 a call, twenty calls reserve $0.063. Migration `0060` adds the four
columns without a table rebuild; the application bounds them.

## Amendment, 2026-11-04: review limits are counts, money caps are an admin's

Owner, 2026-11-04: memory review was hard to test because the limits were
tiny, and a per-user USD limit is the wrong control in user settings. The
Review tab showed "Today: 0 of 8 model calls used" next to "Candidate ranking
stopped: Today's candidate ranking limit is used up". Ranking had its own
counter, four requests a day by default, and each memory spends two (an
embedding and a Jev request), so two memories ended a day of ranking while the
model-call counter beside it read zero.

A person now sets two counts and nothing else: memories checked by hand a day
(`manual_memories`, 1–100, default 25) and memories checked each night
(`upkeep_memories`, 1–200, default 50). One check is one model call about one
starting memory. The two have their own counters, `manual_calls` and
`upkeep_calls` on `memory_review_budgets`, with `calls` kept as their total, so
a nightly run no longer uses up the day's checks by hand. This supersedes the
2026-11-04 nightly-upkeep paragraph that made a manual check stop at
`daily_calls` against the same day's total.

Ranking has no limit of its own for a person to set. Its requests derive from
the counts: two per memory, counted apart by hand and at night
(`manual_requests`, `upkeep_requests` on `memory_review_ranking_budgets`). The
pass checks `requests + 2 > 2 × memories` before an anchor, and the reservation
statement in `rankingAuthorization` enforces `requests < 2 × memories` at
dispatch, as before with the old `daily_requests`.

Money is an admin's control. `memory_review_cost_caps` holds one row per
account with a review cap and a ranking cap, written only from
`/workbench?tab=costs` behind `requireConsoleAdmin` (`isAdmin()`: the owner or
an address `VALISE_ADMIN_EMAILS` lists). No row means the operator defaults in
`app/concepts/memory-review-limits.ts`: $0.50 a day for review, $0.20 for
ranking. At Haiku's largest reservation, $0.003168, the default 75 checks
reserve $0.2376; 150 ranking requests at Jev's largest, $0.001008, plus their
embeddings stay under $0.20. An admin may set $0.001–$5.00 each. Both caps are
enforced inside the same reservation statements as before, in
`runMemoryReview` and `rankingAuthorization`, now reading the cap row with the
default as `COALESCE`. A person cannot read another account's caps or write
their own; their Advanced section states their caps read-only.

A stop names the limit that caused it, in the counter shown beside it. A count
stop is "daily budget" and the report says today's memory checks are used up;
a money stop is "cost limit" and says the cost cap, set by an admin, is used
up. Ranking adds `ranking-cost-limit` beside `ranking-daily-limit`. With
ranking on, the status line shows "Candidate ranking today: N of M requests by
hand", so a ranking stop always sits next to the ranking count it hit. A
nightly pass that stopped at its two-ranked-memory limit is now due again the
next minute like one that stopped at two calls; before, it ended the night's
run.

Turning on nightly upkeep no longer sets a money limit; it used to write
$0.10 to `daily_microusd`. The old `daily_calls`, `nightly_calls`,
`daily_microusd` on `memory_review_settings` and `daily_requests`,
`daily_microusd` on `memory_review_ranking` keep their frozen CHECKs and are no
longer read or written. Migration `0061` only adds the new columns and the
caps table (ADR-0008); restore keeps the caps as they were, since a cap is a
limit, not consent. The journeys are J-0 to J-D in
[memory consolidation journeys](../design/memory-consolidation.md).

## Amendment, 2026-11-04: deleting a subject, and one live subject per name

On 2026-11-03 an agent read page 1 of `/memories/subjects` (30 rows), missed
an existing "garden-site" subject, and created a second one
(`sub_5c0c2d9c-7737-402c-b1cd-11d751103cf9`). The console had no delete, so
the duplicate stayed. To-do `tdo_ff53f610`.

A user has at most one live subject per name, compared trimmed and
case-insensitive. Creating, renaming, or "Accept and organize as subject" with
a new name is refused when a live subject holds the name. The create form
stays open with the typed values and links to the existing subject. The SQL
insert and rename carry the same guard, so a race inserts nothing rather than
a duplicate. Another user's subject of the same name is not a conflict.

Deletion is soft (`memory_subjects.deleted_at`, migration `0062`). Per P12 the
subject page's Delete subject button becomes Restore subject in the same
place. A deleted subject leaves the index, the review subject picker and a
memory's subject list. Its page stays reachable at its URL and shows only the
deletion date and the Restore control. Edits, membership changes, summary
changes and organizing a review into it are refused. Memberships and memories
are untouched by delete and are all there again after a restore. A restore is
refused while another live subject holds the name. No hard delete is offered;
the row and its members remain backup inputs.

The same operations are on MCP as `list_subjects`, `save_subject` and `edit_subject`, with `fetch` reading `subject:` ids; ADR-0003's amendment of 2026-11-04 has the contract.

## Amendment, 2026-11-05: suggested subject members

Owner, 2026-11-05: "all next steps sound good. let's do that!", approving
memory:mem_1d16ac5e-3e59-4de6-a6e3-fbe08cd222d5. Until now only a person in
the console, or an agent naming a subject id, added a member. The schema
allowed an unconfirmed `asserted_by: model` row, but nothing wrote one. Asked
which source should suggest members, the owner chose "Both, tags first": tag
matches ship now, and Review-model proposals are to-do `tdo_0fed5889`.

A suggestion is not a membership. It is never counted, never listed among
supporting memories, never part of freshness, and never shown on a memory's
subject list. Supporting memories are the confirmed rows only. The rule that
Review "must not silently infer membership" (2026-10-27) holds: a person or
an agent acting for one confirms each suggestion.

Suggestions are computed when read, from two sources:

- A live memory with a tag that equals the subject's name. Both sides are
  compared lowercased in SQL, with spaces and underscores read as hyphens and
  outer hyphens trimmed, so `Ada Lovelace`, `ada-lovelace` and `Ada_Lovelace`
  are one name. SQLite's `lower()` folds ASCII only, which applies to both
  sides alike. The reason shown is `tagged <tag>`.
- An unconfirmed, unremoved member row, the shape the Review proposals will
  write. The reason shown is `suggested by an agent`.

A memory that has any row for the subject (confirmed, removed or dismissed)
is not suggested again, and neither is the subject's summary. Nothing is
stored until someone acts, so a suggestion cannot go stale. There is no
corpus walk: one query, scanning one user's memories the way a tag filter
does, bounded at ten rows, newest first.

Interaction contract, subject page:

- User job: decide which tagged memories belong to the subject without
  searching for them.
- Default populated view: subject details, current understanding, supporting
  memories, then a `Suggested` section listing up to ten memories with
  title, opening text, type, reason and date. The section is absent when
  there are none.
- Primary action: `Add`, which confirms the membership through the existing
  member intent. `Dismiss` is secondary and writes a removed, never-confirmed
  row (`asserted_by: model`), so the memory is not suggested again. Adding
  that memory later through `Add supporting memory` revives the same row.
  That is the reversal (P12): the add control the page already has.
- Disclosed details: the full memory one link away; the reason on every row.
- Failure states: a stale or deleted subject or memory returns the existing
  refusal in the row. A deleted subject shows no suggestions.
- Loading budget: one bounded query beside the existing member query.
- Evidence: `test/ui/memory-subjects.spec.ts` adds and dismisses at 1280px and
  320px, with no horizontal overflow.
  Screenshots of the default view and the view after Add at both widths were
  taken and removed before publication, because the fixture named a personal
  project.

MCP parity (ADR-0003): `fetch` on a `subject:` id lists `suggested` (first
page only) with each memory's id, title and reason. `edit_subject`'s
`add_members` confirms one, and `remove_members` dismisses one. Its
description says so, and no new argument is added.

Evals (Claude Code harness, Haiku, three repeats): run `2026-11-05T00-33-04`
matches or beats item-2 run `2026-11-04T23-29-39` on every subject cell. A
case for dismissing a suggestion was dropped (`2026-11-05T00-34-36`). Its ids
are not in the eval store, so Haiku fetched them, got not-found, and never
wrote. `subject-delete-duplicate` fails the same way; to-do `tdo_b793dc0b`
seeds those ids.

## Amendment, 2026-11-08: no same-project filler, and lesson lines

The owner asked on 2026-11-08 for memory review that produces future-oriented
principles rather than memories that relate to the same file. J-E in
`docs/design/memory-consolidation.md` is that journey. This amendment ships
its first slice; the weekly reflection, principle cards and transcript
evidence are not built.

Selection. On 2026-11-05 production held 19 review groups, 10 of them
`noop`, and 6 of those 10 were filled by the same three same-project memories.
Two causes, both fixed:

- The keyword search ran with the anchor's own title, which the anchor always
  matches, so `search()` never fell back from every-term to any-term matching.
  Review now drops the anchor from the hits and, when nothing else matched,
  searches again with `match: "any"`, a new `SearchFilters` field.
- Twelve recent same-project memories filled whatever slots remained. They are
  gone. An anchor with no linked, matching or ranked neighbor becomes a local
  no-change with no model call and no budget.

`test/d1/memory-review-candidates.worker.test.ts` on its eight fixtures, main
at `64ed185` against this branch: recall is unchanged on every fixture with an
expected neighbor (duplicate, conflict, injection, long-qualifier at 1,
paraphrase and compatible at 0); precision rises from 0.33 to 1 on duplicate
and conflict, 0.33 to 0.5 on injection and 0.67 to 1 on long-qualifier;
paraphrase and compatible stop sending three unrelated memories and make no
call. The same-project branch never supplied an expected neighbor.

Lesson lines. A nightly run whose queue is drained spends up to eight calls,
one a minute, writing `memory_lessons` rows: one per memory revision, holding
a lesson sentence with project nouns removed, two to five mechanism keywords
and a "do differently" sentence (`app/concepts/memory-lessons.ts`,
`LESSON_PROMPT_VERSION = "memory-lessons-1"`). The rules:

- Same consent, lock, nightly count and admin cost cap as a review call
  (`reserveReviewCall`); nightly only, never by hand.
- Up to sixteen memories per call, bodies cut to 900 characters, inside the
  existing 24 KB input bound and 1,536-token output cap. The setup sentence
  names the batch.
- A line is written only while its memory is still on the revision sent; an
  edit in flight leaves it for the next night.
- An empty lesson records reference or taste data, so it is not sent again.
- A failed call is not refunded and ends that night's lesson lines.
- `memory_lessons` is in the backup's `TABLES`: each line cost a call.

Where lines live answers J-E's first open question: their own table, keyed by
memory and revision, not a column on `memories`, so the person's text and the
model's reading of it never share a row or a revision. They are not projected
into `search_docs` yet. The offline run showed search over lesson lines is a
candidate generator for the reflection, not its clusterer, and nothing reads
them until the reflection is built. The person sees a coverage count on the
Review status line, not the lines themselves, which leaves J-E's second open
question open.

## Amendment, 2026-11-08: weekly reflection and principle cards

Slice 2 of J-E in `docs/design/memory-consolidation.md`. Once lesson lines
are done for the night, a nightly run steps the weekly reflection, one call a
minute and at most six a night, under the same consent, lock, nightly count
and cost cap as review and lesson lines. A reflection is due when the last
one started at least seven days ago and at least three non-empty lines have
been written since; Reflect now starts one over every line at once.

The first call (`CLUSTER_SYSTEM`) reads the lines and the rules already
adopted, proposed or rejected, and names at most five mechanisms with at
least three line ids each. Each mechanism gets one draft call
(`DRAFT_SYSTEM`) over its own lines and at most 24 in total, older ones
ranked by keyword overlap. A draft becomes a card only when its evidence
holds in code: three memories, two distinct sessions (a memory without one
counts as its own) and two distinct projects, with no project counting as
one. Unknown ids and a memory that is both evidence and counterexample
fail the call as `invalid-evidence`.

Cards live in `memory_principles`; runs in `memory_reflections`. A card is
not a memory. Adopt writes, in one batch, a `decision` memory tagged
`principle` with the card's rule as the person worded it, `part-of` links
from each evidence memory and `contradicts` links to counterexamples, all
person-asserted, and optionally a to-do carrying the card's "what would
change". An archived evidence memory refuses the whole batch. Not a rule
keeps the card and its optional reason, and the next cluster call receives
the rule as known. Transcripts are not read; the card says so.

## Amendment, 2026-11-23: Cloudflare retired GLM 5.3 Flash

Cloudflare retired `@cf/zai-org/glm-5.3-flash`,
`@cf/meta/llama-3.1-8b-instruct-fp8` and `@cf/meta/llama-3.2-3b-instruct`
on 2026-11-20 (Workers AI changelog, 2026-11-05). Calls answer HTTP 410,
error 5028. The binding throws it, and `providerRequest` recorded it as
`provider-unavailable`, so the owner's nightly upkeep, saved on GLM, failed
every group from 2026-11-20 02:10 UTC with "The provider could not be
reached or the request failed."

The owner chose `@cf/deepseek-ai/deepseek-v4.1-flash-1017` on 2026-11-23 as
the offered Workers AI model, in GLM's place. The three retired ids stay
in `REVIEW_MODELS` so history keeps its labels. A saved setting naming one
is not moved, because consent names a model (2026-11-04). The provider
counts as unavailable, so a check or nightly run stops before admission
with "Cloudflare retired <model> on 2026-11-20" and sends nothing, and the
Review page shows the same line. A 5028 from a model retired later is
recorded as `model-retired`, not `provider-unavailable`.
