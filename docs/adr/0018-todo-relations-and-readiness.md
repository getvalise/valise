# 0018. To-do relations share the coordinator's readiness boundary

Date: 2026-10-24
Status: accepted

## Context

The owner approved first-class parent-child work and blocking prerequisites on
2026-10-23, after reviewing todo:tdo_d1765759-286e-4a84-a52a-9f863f634f1d.
Markdown checklist steps, unvalidated refs and manual `blocked_on` reasons are
not independently claimable tasks or validated scheduling edges.

ADR-0002 serializes one ticket across D1 awaits. An edge spans tickets. Reading
a prerequisite before acquiring a claim does not prevent a simultaneous edge
addition or prerequisite reopen from invalidating that read.

## Decision

### Graph and ownership

Additive migration 0037 creates authoritative `todo_relations(user_id,
from_todo_id, to_todo_id, kind, created_at)`. `parent` points child to parent;
`depends-on` points dependent to prerequisite. Both endpoints must exist under
the coordinator's authenticated owner. Projects may differ. Missing and foreign
endpoints receive the same refusal. Self edges are refused. A partial unique
index permits one parent; a primary key deduplicates edges. No prose, refs or
checklist lines are migrated.

Parent organizes work only. Children remain independently claimable; neither
claim nor completion nor reopening cascades. Completing a parent with unfinished
children is allowed. The console shows completed/total children and says that
unfinished children do not prevent parent completion. This count reads D1's
display states, not live scheduling authority.

Each task has at most 20 outgoing dependencies. Each graph separately rejects
cycles using recursive `UNION` traversal, including a prospective target's
reachable set. At 257 visited nodes the whole edit is refused explicitly;
256 is the accepted maximum traversal, not an assumption that the unseen tail
is acyclic. New UUID creation has no incoming edges, so cannot close a cycle.
An edit containing several changes validates all before committing one D1 batch.

The schema cannot enforce tenant ownership, acyclicity or scheduling races.
All application relation writes go through `TodoCoordinator`. Read joins scope
both endpoints; a corrupt foreign relation is hidden in display responses, but
authoritative claim refuses rather than ignoring its prerequisite.

### Ordering across tickets

The existing per-ticket FIFO is acquired before a tenant-local read/write graph
gate. Claim, completion, renewal and progress/renewal hold shared admission
through their D1 waits and local state updates. Independent shared operations
can still progress concurrently. Relation writes, done-to-unfinished console
overrides and claims of a done to-do take exclusive admission; the last
follows ADR-0002's amendment of 2026-11-06, which applies every reopen rule
below. A queued writer prevents later readers overtaking it. No network
operation runs under `blockConcurrencyWhile`.

Ordinary overrides that cannot invalidate a completed prerequisite use shared
admission. Block, release and expiry cannot turn `done` into unfinished or extend
a lease, so remain covered by their per-ticket FIFO. Gate operations never
acquire another ticket's FIFO; prerequisite/dependent hydration reads live local
SQLite after D1's owner check. This fixed acquisition order avoids inversion.

Claim derives readiness from all direct prerequisite states in coordinator
SQLite, lazily adopted from owned D1 rows only when absent locally. It does not
use a possibly delayed D1 completion mirror. Every prerequisite must be `done`.
It retains shared admission until the claim's durable fence and local lease are
written, so no exclusive relation mutation or reopen can intervene between
check and grant. A concurrent completion may produce a conservative refusal
before its local state lands; retry succeeds without waiting for its mirror.

Adding an unfinished prerequisite to an active claimed dependent is refused;
release or finish the lease first. A prerequisite's reopen is refused while any
direct dependent has a live claim; release or finish those leases first. The
dependent scan refuses beyond 256 rows. Reopen never silently invalidates,
revokes or changes other tasks. Expired leases do not prevent reopening, and
renewal shares the gate so it cannot extend one across the reopen's check.

Manual `blocked_on` remains independent. Completing/removing dependencies does
not clear it or change the dependent's stored state. An explicit claim may
still resolve a manual blocker under ADR-0002, but only after all structured
prerequisites are done. No mass state fanout is needed.

### Failure and recovery

An unavailable relation query, ownership read, traversal or prerequisite state
does not grant a claim. There is no permissive fallback to the list mirror.

Before either related creation or relation editing awaits a write, it persists
one `uncertain_graph_write` row in coordinator SQLite: operation UUID, attempted
to-do and kind. The singleton key bounds this to one outstanding graph attempt
per owner. Claims, later graph writes and done-to-unfinished overrides refuse
while the marker exists, including after object reconstruction. Existing lease
holders may finish, release or renew; recovery never implicitly revokes them.

Migration 0037 also creates `todo_relation_fences(user_id, token)`, one opaque
operation admission token per owner. The marked operation first writes its
fresh token and awaits acknowledgement. Only then does it send its mutation
batch. Every statement in that batch checks the token, including parent/dependency
deletes and inserts, and related creation's authoritative task and projection.
The batch's final token read must match before the local marker is cleared.
A rejected reservation or mutation response retains the marker; it is not
interpreted as cancellation, even when a subsequent primary read sees no edge.

Explicit `update_todo(relations: {reconcile: true})`, or the console's Reconcile
relations form, writes a different fresh fence and awaits acknowledgement before
clearing the marker. It never replays the operation. The refusal names the
attempted to-do, including a possibly created UUID, so the caller can fetch that
record and inspect what actually committed before deciding to retry. A fresh
retry goes through all endpoint/cycle/live-claim checks again; reconciliation
does not authorize adding an unfinished prerequisite to a now-claimed task.
A lost recovery acknowledgement leaves the marker and can be retried explicitly.

The ordering argument is conditional writes in one D1 transaction, not ordering
between independent HTTP calls. An original mutation that commits before the
recovery fence is retained for inspection. One that arrives afterwards cannot
change any row because its old token no longer matches. Its reservation had to
be acknowledged before its mutation was sent, so there is no still-pending
reservation for that same UUID that can restore its admission after recovery.
If a reservation itself failed before acknowledgement, no mutation was sent;
a late reservation can cause a later guarded batch to refuse, not resurrect a
mutation. Tokens are never reused. D1's documented `batch` transaction/rollback
semantics establish atomicity within a batch; no documented cancellation or
cross-request arrival ordering is assumed.

A done-to-unfinished override persists `uncertain_reopens(todo_id)` in local
SQLite before awaiting its D1 batch. That batch writes the new state and fence
together synchronously. On success the local state is installed and the marker
is cleared before releasing exclusive admission. The display mirror still uses
its existing token/generation guards and retry alarm.

If the response is lost after D1 commits, local `done` cannot authorize a
dependent claim: the marker makes readiness unavailable across reconstruction.
An explicit console override retry reads the durable floor and writes a new
token above both floors, even if the requested local state appears unchanged.
It rechecks active dependents before restoring an unfinished state. A complete
loss of local storage adopts D1's synchronous reopened state rather than a stale
`done` mirror. A failed completion leaves the old local unfinished state and
therefore cannot incorrectly admit a dependent.

This is not a distributed transaction between D1 and SQLite. Unknown graph-write
or reopen outcomes sacrifice availability until explicit reconciliation. Restores and
tenant moves still require ADR-0017's quiescence and fencing-floor protocol;
editing ownership/graph/fence rows or deleting coordinator SQLite beneath an
in-flight uncertain request is unsupported. Reconstruction retains SQLite and
its markers; destructive restore is not ordinary reconstruction.

Provider mechanism: [D1 Database, batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch),
checked 2026-10-24. It documents sequential nonconcurrent execution within the
batch, SQL transaction rollback and primary-bound access without Sessions. It
does not document that a caller-side rejected promise cancels an admitted write.

### MCP, console and backup

`create_todo` adds optional `parent` and `depends_on`. Related creation validates
endpoints and commits the new row, its search projection and all edges together.
A refused endpoint leaves no task behind. The ordinary unrelated creation path
is unchanged.

`update_todo` adds a relation-only mode: `relations.parent` (null clears),
`relations.add_depends_on`, `relations.remove_depends_on`. This mode omits token,
body, renewal, refs and manual blocking; mixed edits are refused before writes.
It cannot grant or revoke a lease. The receipt keeps the existing three fields;
its token is the current floor, zero before the first claim, not a new authority
to update progress. Only the explicit new mode receives zero; legacy callers
still receive positive lease tokens, satisfying their cached closed schema.
No separate relation or queue tool is introduced.
`relations.reconcile: true` is a separate recovery-only form of that mode; it
cannot be combined with relation changes and mints no claim.

`fetch` adds bounded relations to open metadata: parent, children, dependencies,
inverse blocks, child progress and truncation flags. Children and inverse blocks
show at most 50 each; outgoing dependencies at most 20. Titles/states stay
owner-scoped. `list_ready` excludes unresolved dependencies by default;
`include_blocked` includes them for inspection, without replacing manual prose.
Lists remain display hints; the coordinator is the readiness gate.
After the bounded orientation/enumeration merge, `queryTodos` uses the same
dependency predicate only for `readyOnly`; `get_brief.ready` inherits it.
Default and explicit-state `list_todos` enumeration deliberately retain tasks
with unfinished dependencies. A scoped regression compares ready selection and
brief samples before/after prerequisite completion and keeps an independent
manual reason blocked throughout.

### Amendment, 2026-10-24: blocked orientation is effective, not a state filter

PR178 review found that filtering the brief's blocked sample to stored
`state = 'blocked'` hid pending tasks whose unfinished dependencies already
excluded them from ready. The brief now calls the internal
`queryTodos(..., {effectiveBlockedOnly: true})` option, sharing the dependency
readiness predicate. Effective blocked means stored blocked tasks, plus pending
tasks with a non-null manual reason or an unfinished dependency. Claimed and
done tasks remain in their own sections. Returned `state` and `blocked_on` are
the stored values: a dependency-waiting pending task still says pending, and a
null manual reason stays null. No state fanout or invented manual reason occurs.

The sample keeps its owner/project filters, activity ordering, five-item limit
and `has_more` from the sixth row. A prerequisite in another project still
blocks the dependent in its own scoped sample. Completion makes a pending task
ready unless a manual reason remains; dependency removal has the same read
semantics. `get_brief.note`, also rendered in hook text, explains the effective
category and unchanged stored values. Existing output enums already allow
pending items; no output field or tool description changes. Public
`list_todos(state: 'blocked')` remains exact stored-state enumeration; default
and pending enumeration still include dependency-waiting tasks. Ordinary cursor
filter signatures remain unchanged; the internal effective-blocked filter has
its own signature so its cursor cannot be used for public enumeration.

The prior `9a742d4` verification receipt covers the old implementation, not this
correction. The bounded 15/16 description eval remains evidence for the unchanged
tool descriptions, not a new-head behavior test or full-client E2E claim.
Targeted runtime verification of this correction passed 75/75 across the brief,
relations, transition races, tenancy and fresh-coordinator recovery suites;
log: `.context/evidence/todo-relations/effective-blocked-targeted-1.log`.
The full exact-head gate remains required before pushing the correction.

The console integrates one separate relation component in the merged docked
pane. One form changes one relation, not a stale repost of the whole set (P2,
P7); linked items have URLs (P3); fetcher forms hold with Saving and keep the
plain POST path (P4, P11). Existing loaded task IDs are suggested through a
native datalist, and an off-prefix ID can be pasted. No pane, icon or stylesheet
rewrite is included.

`todo_relations` and `todo_relation_fences` belong in every authoritative SQL backup.
Both live in additive migration 0037 and its snapshot; 0038 remains reserved for
the memory feature. Following PR173, `scripts/recovery.mjs` classifies both in
the managed backup's authoritative `TABLES`, preserving all relation endpoints,
kinds, owners and timestamps. Task `blocked_on` and append-only update/comment
history are unchanged by relation recovery. No prose or checklist reconstruction
is involved.

The restore serializer invalidates each captured graph-operation fence with
`recovery:` plus a digest of owner, NUL separator and token. Deterministic
invalidation keeps capture's dry run and restore comparable. Fresh Worker/DO,
D1 and credential namespaces remain mandatory: unknown original operations
target the old D1 binding and cannot mutate the new database. The next graph
mutation reserves a new UUID, not the transformed captured token. Existing
claimed-state recovery still advances task floors, removes holders and adopts
expired leases without replaying them (ADR-0002).

Ordinary reconstruction retains SQLite quarantine. Deleting those markers,
resetting a live coordinator or restoring an old D1 under its namespace does
not fence an unknown original request. Reuse would require ADR-0017's explicit
quiescence/drain/reconciliation protocol; the managed restore helper instead
refuses used resources. `docs/operations/backup-recovery.md` records this boundary.
The Node serializer and real Wrangler drill fixtures now carry parent and
dependency graphs and a manual reason, while the fresh-coordinator Worker test
checks their live readiness and fresh fences. No backup workflow redesign or
published migration change is included.

### Amendment, 2026-10-24: one typed relation list and a searched picker

The console's relation component is one list of every relation, each row its
type, the to-do and a remove, and one row that adds a relation: a type, then
the to-do. The four types are `TODO_RELATION_TYPES` in
`app/concepts/todo-relations.ts`, read from the open to-do: blocked by,
blocks, parent, child. Blocks and child are written on the other to-do,
because the stored edge starts there; `relationEdit` names which to-do the
coordinator edits. A form still posts one relation. The native datalist of
loaded IDs is replaced by `TodoPicker`, which searches `/todos/suggest` by
title or id across every owned to-do; a pasted `todo:` id still works with
scripting off. The prose under each section is cut to one line per type, and
the child count and the note that unfinished children do not prevent
completion remain.

## Consequences

Relations and scheduling share one per-owner coordinator without a second queue
or bulk blocked-state updates. Graph edits and reopens pause that owner's new
shared operations while admitted readers drain. A slow D1 write therefore
delays claims during a graph edit; independent normal ticket operations retain
their concurrency. Bounded traversal can refuse a large valid graph. These
limits are deliberate refusals, not claims of unlimited scale.

`test/mcp/todo-relations.worker.test.ts` covers ownership, independent hierarchy,
manual reasons, multiple prerequisites, cycles/limits, serialized opposing
edges, delayed real D1 responses around edge/claim/completion/reopen, stale
fences and unknown-outcome reconstruction. Late-write cases deliberately reject
before executing the real batch, then execute it after reconstruction, recovery
and a successful claim; they assert that a delayed add/reparent/remove or related
creation cannot bypass its fence. Other cases commit first and lose the response,
retain quarantine on a lost recovery response, and recheck an active dependent
on a fresh retry. `test/ui/todo-relations.spec.ts`
exercises native forms with scripting on and off at 390px.

## Verification evidence, 2026-10-24

Targeted runtime selection passed 63/63 relation, transition-race, tenancy and
fresh-recovery tests. `node --test test/backup.test.mjs` passed 3/3, including
the actual Wrangler fresh-install drill over 20 authoritative tables and R2
original bytes. Logs are under `.context/evidence/todo-relations/` as
`targeted-runtime-1.log` and `restore-drill-1.log`.

The first complete foreground `npm run verify` at `ac5a3cc` passed D1 209/209,
MCP 472/472, client Vitest 110/110, Node self-host/backup 20/20 and UI-server
6/6, then failed three UI checks (152/155 passed). The eval matrix needed its
new-case index; the checklist Add selector also matched Add dependency; the
recovery notice overlapped Saving while the fetcher revalidated. The index is
regenerated, the selector is exact and recovery notices render only while idle
(P11). These fixes require a new full exact-head receipt before push; the
initial log is `full-verify-ac5a3cc.log`, not a successful gate.

Committed eval run `2026-10-24T12-50-25` uses eight synthetic cases, two cheap
models and one repeat on isolated local state: Haiku 8/8, Mini 7/8, zero provider
errors, $0.0224995 combined. Manual argument review confirms both models used
the requested parent/dependency IDs, relation-only edits without a token and
recovery-only `reconcile: true` without replay. Checklist controls retain
Markdown steps. Mini's blocked-list miss (`get_brief`, with an unjustified
historical window) is retained. Its passing ready call had an extra unexecuted
brief sibling; primitive scoring does not assess that quality detail. No
model-selected writes ran, no production/private content was used and no
full real-client E2E resumption is claimed. The initial local-health launcher
failure made no model calls; the successful supervisor stopped its server and
removed the isolated state. No further model calls chase a green result.
