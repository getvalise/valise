# 0002. Claiming: one coordinator DO per user, lease + fencing, fence floor persisted in D1

Date: 2026-10-12
Status: accepted

## Context

Parallel agents must never work the same ticket. beads documents the failure class to avoid: claims that are only locally visible, and racing claims that both succeed. Session-end hooks cannot be trusted to fire, so expiry must not depend on the claiming agent coming back. D1 serializes writes but has no timers; Durable Objects are single-threaded and have durable alarms. All three arena candidates converged on DO compare-and-set with a lease TTL and a monotonic fencing token, differing in DO granularity and in what survives DO loss.

## Decision

- One `TodoCoordinator` Durable Object per user (`idFromName('todos:' + userId)`), SQLite-backed. Not one DO per ticket: claim-next would fan out across N objects, and per-ticket DOs reset their token counters on loss. Multi-tenant later means more instances, not a redesign.
- The DO is the sole authority for `state`, `lease_holder`, `lease_expires_at`, and `fencing_token`. Every transition (claim, release, complete, block, expiry) is a single-threaded DO method. D1 holds a write-through mirror of these fields for listing and search only; nothing reads D1 to grant or deny.
- `claim(todo_id, agent, ttl)` grants iff state is `pending`, `blocked` (amended below), or `claimed` with an expired lease. It increments the fencing token, sets holder and expiry, schedules the alarm at the earliest expiry, and returns `{token, expires_at}`. Default TTL 30 minutes; `update_todo` renews it.
- Guarded writes (`update_todo`, `complete_todo`) require the current token from the current holder. A stale caller gets a tool error naming the current holder.
- Expiry is the DO alarm, durable and retried. On fire: flip expired claims to `pending`, append a release entry to the progress log, write through. The progress log survives expiry so the next claimant inherits the findings.
- The fence floor lives in D1 and is written synchronously. A claim or state transition returns success only after the D1 update of `todos.fencing_token` (guarded `WHERE fencing_token < :token`) commits in the same request. If DO storage is ever lost, the coordinator reseeds lazily from D1 and resumes tokens at the stored floor plus one; because no token was ever handed out before its floor was durable, a rebuilt coordinator can never issue a token at or below an outstanding one. (Grafted from arena candidate A; made synchronous on the cross-vendor judge's correctness argument that an asynchronous floor leaks tokens issued between the last successful mirror and the loss.)
- Display fields (`lease_holder`, `lease_expires_at`, `state` for listing) may still mirror asynchronously with the unmirrored-flag retry. Only the fence floor is on the synchronous path, so claim latency grows by one D1 write and nothing else does. The mirror may lag by seconds; that is display staleness, not a correctness issue.

## Amendment, 2026-10-17: the console overrides without holding a lease

The decision above describes agents and says nothing about the person reading
the console, so the console could not change a to-do's state at all. That made
a checkbox impossible and left a to-do an agent claimed and then abandoned
unmovable for the rest of its TTL, with no reason beyond an omission.

`TodoCoordinator.override(todo_id, actor, next, note)` adds the human path.
`next` is `pending`, `blocked`, or `done`; `claimed` is deliberately absent,
because a person claiming on an agent's behalf means nothing. It takes no
token and requires no lease, and everything else holds: it is a method on the
same single-threaded object, it writes the D1 fence floor synchronously before
returning, and it appends to the progress log under the actor's name.

It increments the fencing token. That is the point rather than a side effect.
The displaced holder is not notified and does not need to be; its next
`update_todo` or `complete_todo` is refused for a stale token, which is the
outcome fencing exists to produce. A human closing a ticket is the same event
as a re-claim, as far as the agent that lost it is concerned.

The one thing it does differently is flush the display mirror on the call
instead of leaving it to the alarm. The caller is a browser that redirects
straight back into a read, and a second of lag reads as a dead checkbox rather
than as staleness. The decision above already permits either; this names which
path takes which.

## Amendment, 2026-10-17: an agent reopens a blocked to-do by claiming it

`claim` granted only on `pending` or an expired claim, and blocking drops the
lease, so once an agent blocked a to-do no agent could take it back after the
blocker resolved. Only the console's Unblock could. todo:tdo_124129e4 sat
blocked on a PR that had merged, unclaimable over MCP.

`claim` now also grants on `blocked`. The claim clears `blocked_on`, and its
`claim` row in `todo_updates` carries `resolved blocker: <the old blocked_on>`,
so the log says who judged the blocker resolved and what it was. It bumps the
token like any claim. No `unblock_todo` tool: reopening without taking the work
would hand back a pending to-do nobody holds, which the console already does.

`list_ready` still hides blocked to-dos by default. An agent reaches one through
`search` or `fetch`, because it blocked it, or with `list_ready`'s
`include_blocked` (amended below).

## Amendment, 2026-10-18: an agent can list blocked to-dos

Reopening by claim needs an id, and nothing over MCP listed blocked to-dos, so
an agent working the queue never saw one whose blocker had cleared. Three
to-dos sat blocked on merged PRs on 2026-10-17 for that reason.

`list_ready` takes an optional `include_blocked`. With it, the list also holds
blocked to-dos, newest first like the rest, each with its `blocked_on`; a
pending row carries no `blocked_on` field. The default is unchanged. A flag
rather than a `list_blocked` tool: a blocked to-do is claimable since the
amendment above, so it belongs in the list of claimable work. A second list
tool also cost the plain "what work is waiting" turn: in a probe,
`openai/gpt-6-luna` picked `list_ready` for it 1 time in 7 with `list_blocked`
beside it, against 6 in 8 without.

## Amendment, 2026-10-23: tenant identity fails closed

The coordinator requires the object name `todos:<user_id>`, with a nonempty
user ID containing neither whitespace nor colons. Unnamed and malformed
objects reject calls and alarms before accessing storage. The application
uses `getByName` with the authenticated principal; a raw object ID is not a
tenant identity. Cloudflare carries the original name into scheduled alarms.

Every D1 adoption, fencing write, progress-log insertion and display mirror
includes `user_id = ?`. A cached lease also checks D1 ownership before use:
restoring D1 must not leave an old local row authorizing another tenant's
to-do. Missing or foreign rows return the same missing result, without holder
or token, and their local rows and queued mirrors are discarded. Alarm writes
have the same tenant predicate, including expiration without a queued mirror.

D1 remains the ownership and fencing-floor authority; the coordinator remains
the live lease authority. Ownership reads do not replace local lease state
with the delayed display mirror. After the D1 read, the coordinator rereads
SQLite so an interleaved RPC's newer lease wins. Losing local storage still
adopts the owned D1 row and issues the next token above its durable floor.

`test/mcp/todo-tenant.worker.test.ts` exercises malformed and unnamed objects,
foreign IDs across all transitions, contaminated restored caches and alarms,
and independent same-title tenant lifecycles through expiry and restore.
Same-name skill isolation remains dependent on ADR-0016's separate per-user
skill uniqueness migration; these tests do not replace that acceptance check.

## Amendment, 2026-10-23: serialize each to-do across D1 awaits

Single-threaded execution does not serialize an entire async RPC. A completed
D1 log write can return late: an override advances the local token while the
older completion waits, then the completion overwrites SQLite with its captured
token. The D1 floor stays newer and subsequent transitions cannot advance.

Claim, renew, update, block, complete, release and override now share a FIFO
promise queue keyed by to-do ID inside the coordinator. The queue covers the
initial ownership/lease check through D1 writes, local lease updates, mirrors
and alarm scheduling. An update renews inside its existing queue slot rather
than acquiring it recursively. Each slot releases in `finally`, including
rejected D1 responses, and an idle key is removed. Different to-do IDs continue
concurrently; no external I/O is held under `blockConcurrencyWhile`.

Alarm expiry acquires the same queue and rereads the live lease after waiting.
An expired scan result cannot release a renewed or reclaimed lease. Mirror
writes keep their D1 token/generation predicates and generation-conditional
queue deletion, so overlapping flushes cannot replace or dequeue a newer
generation. SQLite and D1 remain the durable authorities; the in-memory queue
only orders in-flight calls and is not a persisted lock to recover on restart.

`test/mcp/todo-transition-races.worker.test.ts` uses real coordinator methods,
SQLite and D1, holding successful D1 responses after commit. It covers each
transition competing with an override, independent to-do progress, expiry
waiting behind a re-claim, same-token rejection after completion, and queue
release after a failed response.

## Amendment, 2026-10-23: historical deployment recovery uses fresh namespaces

`scripts/backup.mjs restore` inserts a D1 snapshot only into a fresh,
unpublished installation, never over an existing coordinator namespace. It
retains each to-do's owner and state snapshot, advances the stored fencing
floor by one, clears the lease holder and sets a claimed lease's expiry to
zero. The fresh coordinator adopts this expired claim and performs the next
transition above the advanced floor. No state-changing `UPDATE` is introduced
outside the coordinator. Its D1 display state may reflect the ordinary mirror
lag at capture; the snapshot is not a backup of live DO SQLite or alarms.

A historical backup cannot know floors issued after its capture. New Worker/DO
and OAuth KV namespaces, fresh session/pepper secrets, and reissued credentials
are therefore mandatory, rather than claiming an old snapshot's counters exceed
every outstanding old token. Sessions, bearer grants and live leases are not
restored. The local fresh-install exercise and coordinator recovery test are
described in `docs/operations/backup-recovery.md`. In-place D1 rollback while
reusing a coordinator remains unsupported.

## Amendment, 2026-10-26: an agent releases a claim it cannot finish

The coordinator has had a `release` transition since v1, but no MCP path
called it. An agent that stopped partway could complete, block, or leave the
lease to expire. On 2026-10-26 the J4 round-2 agent held
todo:tdo_6d92f8c4 until its lease lapsed, which hid it from `list_ready` for
hours. `update_todo`'s `relations` description already told agents to
"release it first", which no tool could do.

`update_todo` takes `release: true` with the current token. A `body`, when
given, is recorded first as a progress entry, then the coordinator releases:
the to-do is `pending` at once, the holder and expiry clear, and a `release`
entry follows in the log. The token is not bumped, so the releasing agent's
token is refused afterwards because it no longer holds the to-do, and the next
claim issues a higher one. A release is not a status entry, so the body's
opening sentences stay the status the next claimant reads, even after a later
bare release. `release` with `blocked_on` or `renew_ttl_seconds` is refused as
invalid input on `release`.

A flag rather than a `release_todo` tool, for the reason `include_blocked` is
one: it changes how an existing call ends, and one call carries both the note
and the hand-back. `test/mcp/claiming.worker.test.ts` covers both releases and
the refusals.

## Amendment, 2026-11-06: an agent closes a to-do nobody holds without claiming it

`complete_todo` required a token, so an agent that found a to-do already
finished elsewhere had to claim it only to complete it one call later. Agents
read that as a rule and handed the close back to the user instead ("Closing it
needs a claim first, so I left that step to you"). The claim protected nothing:
no work was in progress, and the coordinator serializes the close against any
concurrent claim either way.

`complete_todo` now takes the token as optional. Without one,
`TodoCoordinator.close` grants iff the to-do is `pending`, `blocked`, or
`claimed` with an expired lease. A live claim is refused with its holder, so
the lease still protects work in progress, and a `done` to-do is refused rather
than overwritten. The close runs the console override to `done` under the
agent's name and session: it bumps the token, writes the fence floor first,
logs a `complete` entry with the summary, and skips the dependency check, as
the console's close does. The console's reopen undoes it. With a token,
`complete_todo` behaves as before. `test/mcp/claiming.worker.test.ts` covers
the close and both refusals.

## Amendment, 2026-11-06: an agent reopens a done to-do by claiming it

`claim` refused `done`, so only the console could reopen a finished to-do. An
agent that found closed work unfinished had to ask the user, which is the same
hand-back the amendment above removed for closing.

`claim` now also grants on `done`. It reopens and claims in one call: the
token bumps, the lease goes to the claimant, `completed_at` clears, and the
`claim` row in `todo_updates` reads `reopened a done to-do`. The old holder's
token is refused afterwards, as after any re-claim. The claimant's own
prerequisites must still be done.

Reopening can make a done prerequisite unfinished under a dependent, so it
follows ADR-0018's reopen rules rather than the ordinary claim path. It takes
exclusive graph admission, it is refused while any direct dependent has a live
claim, and it persists `uncertain_reopens` before its D1 batch and clears it
once local state is installed. That batch writes `state = 'claimed'` with the
fence instead of leaving the state to the mirror, so a lost reply or lost
local storage never leaves `done` admitting a dependent's claim. A claim of a
to-do whose reopen outcome is uncertain is refused until the console retries.
`test/mcp/claiming.worker.test.ts` and `test/mcp/todo-relations.worker.test.ts`
cover the reopen, the stale token, and the dependent refusal.

## Consequences

ADR-0018 extends the per-ticket FIFO with shared readiness/exclusive graph
admission, structured prerequisite checks and conservative reopen handling.
Manual blocked-on resolution stays explicit; dependency completion never clears
it. The new record specifies cross-ticket ordering and unavailable behavior.

Gained: first claim wins exactly once under any concurrency; expiry needs no cooperation from the agent; losing the DO loses in-flight leases at worst (tickets revert to pending with their progress logs intact) and never breaks fencing. Given up: all to-do state transitions funnel through one object per user, a throughput ceiling that is irrelevant at personal scale. Inherited: the rule that to-do state writes go through the DO is a convention the schema cannot express; the repository layer is its only enforcement, and reviewers should treat any direct `UPDATE todos SET state` outside the coordinator as a bug.
