# 0017. Tenant-scoped access now, measured pooled D1 shards when needed

Date: 2026-10-23
Status: accepted

## Context

ADR-0016 adds accounts and owned rows to one D1 database. The multi-tenancy
review asked whether each user should instead receive a database. The owner
chose to retain D1, strengthen the tenant boundary, and scale by measured pools
of tenants. This record defines that direction and the conditions for a later
physical split. It implements no shard allocator, router or move service.

The review baseline is `origin/main` at `3cab9ab`. These are code findings,
not a production load test or a census of the deployed database:

| Boundary | Evidence at the review baseline | Consequence |
| --- | --- | --- |
| Skill names | `app/db/schema.ts` retains global `skills_name_unique` beside nonunique `(user_id, name)` | Two tenants cannot independently publish the same name. ADR-0016's owner-authorized, verification-gated by-hand replacement remains a rollout dependency. |
| Vector candidates | `app/search/vectors.ts` queries the deployment namespace's top 50 before owner-scoped hydration | Hydration prevents another tenant's content being returned, but cannot recover candidates crowded out before it. |
| Built-in publication | `workers/app.ts` starts `syncBuiltinSkills(env)` once per isolate; `app/concepts/builtin-skills.ts` scans all users when no user is supplied | Cold isolates repeat work proportional to the account population. |
| Vector delivery | `app/search/vector-outbox.ts` attempts 20 jobs per minute tick, including reconciliation | Nominal capacity is 28,800 attempts/day across the deployment, not per tenant; retries and daily repair consume it. |
| Activity queries | `mcp_calls` and `auth_events` indexes in `app/db/schema.ts` do not lead with `user_id` | Tenant filtering alone does not establish bounded row reads for a growing shared log. |
| List pagination | `app/concepts/pagination.ts` sets load-more offset to zero and limit to `page * 30` | Later pages reread a growing prefix. A tenant can outgrow this inside any database layout. |
| Read consistency | No `withSession` call in `app/` or `workers/` | Current D1 calls use the primary. Enabling replicas in a dashboard does not change that. |

The parallel vector-scoping, bounded built-in synchronization and coordinator
fail-closed repairs address present correctness or work bounds. Their commits
and deployment evidence establish what shipped; this baseline does not assert
that they, the skill-index replacement, or physical sharding are deployed.

## Decision

### Tenant is an access boundary before it is a database

Keep the existing D1 database. A request resolves its authenticated principal
before selecting tenant data. Concept access takes that resolved tenant scope;
it does not accept an arbitrary caller-supplied database, owner id, or fallback
to `local`. Missing or inconsistent tenant context fails closed. Scoped access
must cover reads, writes, child lookups, search, counts, facets, vocabularies,
logs, exports, background jobs and resource delivery, not only list pages.

Today the tenant scope is the authenticated `user_id`. A user is the actor;
a future workspace would be a membership and ownership boundary. They are not
interchangeable names for the same future entity. The schema continues to use
`user_id`; a workspace schema, membership model and identity migration remain
an explicit open question. Neither a `project` tag nor an invite group creates
a shared workspace.

The intended repository boundary passes tenant scope and its selected data
store together. Concept operations retain owner predicates even when a shard
contains only one tenant. Child rows are reached through owned parents; a link
validates ownership at both ends. User-facing uniqueness belongs inside the
tenant, including `(user_id, name)` for skills. Global identifiers can remain
globally unique without making human-readable names global. This is the
boundary to consolidate incrementally, not a claim that a new repository API
or database-enforced row security already exists.

### Keep each tenant's concepts and projection together

When capacity evidence forces a split, use a bounded pool of D1 data shards.
Each shard holds multiple tenants. A tenant's skills, memories, to-dos, assets,
sources, versions, revisions, links, object metadata, tenant configuration,
tenant activity and delivery outbox live with its `search_docs` projection and
FTS index. Do not shard by concept: authoritative writes, projection updates
and outbox enqueueing must still share one `db.batch` (ADR-0001).

One ordinary tenant query addresses one data shard. It does not scatter over
all databases. Cross-tenant administration uses explicit bounded control-plane
operations or derived aggregates. FTS remains a shared corpus within each
shard, with tenant filtering before results are returned. BM25 statistics are
corpus-relative: a tenant move can change ranking without changing its content.
Recheck retrieval floors after moves; do not compare BM25 magnitudes across
shards or claim that a pooled corpus has tenant-local ranking statistics.

### Separate control responsibilities from tenant data

Identity, credential/session validation, account admission, future memberships,
plan entitlement and the tenant-to-shard directory are control-plane concerns.
Concept records and their publication are data-plane concerns. They remain in
the same physical D1 today; the separation is a routing and ownership contract
for a future split. Keep unauthenticated/global security events in the control
plane; tenant-scoped activity belongs with the tenant's data.

Once separated, account admission and tenant provisioning cannot share a D1
transaction. Provisioning needs durable, idempotent states and retries; an
account must not receive another tenant's store when its own is unready.
Credential validation and admission must remain available without querying
every data shard. Existing cross-boundary joins and foreign keys must be
inventoried before the split rather than assumed to work across databases.

Use an authoritative directory mapping stable tenant id to shard id, routing
epoch, lifecycle state and compatible schema version. An allocator can use a
hash to choose an initial destination, but `hash(tenant) % shardCount` is not
the routing authority: changing the pool must not relocate existing tenants.
Do not infer a route from a public item id. Route caches require epoch checks
at the write boundary; a stale cache cannot authorize a write to an old shard.
The routing directory and source/destination write gates are durable state,
not an eventually consistent cache alone. A data mutation checks the local
tenant write gate and epoch atomically with its batch; a directory lookup
earlier in the request cannot close a race with a freeze or cutover.

The current `env.DB` binding cannot resolve arbitrary database ids. A bounded
binding pool is the first routing option to evaluate; a larger fleet needs an
explicit dispatch/binding or API design with measured cost and consistency.
No runtime database-creation or arbitrary-id binding API is assumed here.

### Primary consistency for authority

Authentication and revocation checks, routing changes, to-do leases and fence
floors use primary-consistent reads and conditional writes. The coordinator
continues to serialize transitions and persists the D1 fence floor before
success (ADR-0002). A missing tenant or a rejected mirror/fence write cannot
be treated as a successful transition.

D1 Sessions provide sequential consistency and read-your-writes within a
session, not a cross-database transaction or an always-fresh replica. Current
non-session binding calls use the primary. If replica reads are later added,
keep authority paths on that primary path; do not pass them through a generic
`withSession()` default, which is `first-unconstrained`. `first-primary`
constrains only the first query, not every subsequent read. Content reads may
use explicit sessions/bookmarks once the required freshness is defined. A
bookmark belongs to one database and cannot carry causality across a tenant
move; after cutover, begin against the destination primary.

### Tenant moves are a fenced operation

The first move implementation must support a bounded write freeze. Online
dual-write replication is not selected. A move follows this protocol:

1. Freeze: record a move id, source, destination and new routing epoch in the
   control plane. Close admission to new source-tenant writes, including queued
   jobs, imports, upload finalization, cleanup and coordinator writes. Destination
   remains unservable. Refuse or retry writes explicitly while the tenant moves.
2. Drain: wait for already admitted writes and background claims to settle.
   Quiesce the existing tenant coordinator's transitions and alarms; finish
   admitted writes and flush pending mirrors, durable fence floors and lease
   state under the move's drain authority before copying. A disconnected
   client or an expired job lease alone does not prove a remote side effect
   has stopped. Preserve durable retry/reconciliation targets for ambiguity.
3. Copy: transfer all authoritative tenant rows and owned child rows into a
   compatible destination schema in bounded, restartable batches. Preserve
   stable ids, revisions, provenance and fencing-token floors. Include live
   lease state, tombstones and outstanding work. Rebuild the projection and
   FTS from those rows. R2 bytes need not move when the tenant prefix is stable.
4. Verify: compare table counts and content digests, parent/link ownership,
   revision histories, object manifests/checksums, projection membership and
   fence floors. Prove cross-tenant refusal and representative search/fetch/
   claim behavior against the destination. Keep serving reads from the frozen
   source or pause them explicitly until verification finishes.
5. Cut over: conditionally switch the authoritative route to the verified
   destination and epoch. Rebind the same tenant coordinator to that route
   before resuming transitions and alarms. If an implementation replaces the
   coordinator, it must fence the old instance and restore at least the
   persisted floor before issuing a token. Two active coordinators are not a
   migration strategy. Enable destination writes only under the new epoch;
   stale source requests stay fenced. Resume durable jobs against the route.

There is no atomic commit across the directory, two D1 databases and a DO.
Each phase must be durably recorded and idempotent; a crash leaves a closed
write gate until the recorded phase is reconciled. A failed copy can be
discarded while the frozen source is authoritative. After destination writes
resume, rollback is another freeze/drain/copy/verify/cutover, not a directory
flip back to stale data. Retire the source copy only after verification and
the chosen recovery window. This protocol is a prerequisite, not tooling
supplied by this ADR.

### Migration fleet and recovery boundaries

Before a second shard serves traffic, migration tooling must enumerate the
fleet and record schema version, migration result and readiness per shard.
Use additive expand-and-contract migrations with a canary and bounded batches;
resume failures by shard. Code must tolerate the declared mixed-version
window, or refuse routing to an incompatible shard. A new shard receives the
complete current schema before allocation. ADR-0008's by-hand gate still
applies to every non-additive migration; applying it to one shard does not
authorize or prove completion across the fleet. Today's deploy script targets
one `DB` and is not fleet migration tooling.

D1 Time Travel restores a database, so restoring a pooled shard in place rolls
back every tenant in that pool. A tenant-only recovery instead restores into
an isolated recovery database, extracts the tenant's complete owned graph,
then uses the move protocol. Backups must identify authoritative tables,
schema version, shard and tenant manifest, with the directory/control-plane
backup recorded separately. Restore must not resurrect revoked credentials
or discard a newer routing epoch by blindly restoring control state.

FTS and vectors are rebuilt; external delivery acknowledgements are not proof
that a restored index exists. R2 originals need their own recoverable copy and
checksum manifest; a D1 snapshot does not restore bytes. Preserve or advance
coordinator fencing floors beyond every token already issued, even if the
content backup is older. Pause/reconcile live leases before reopening a
recovered tenant. If surviving durable state cannot establish that floor,
reopening requires a protocol that invalidates all prior lease tokens; an old
backup's counter is insufficient. Existing `scripts/restore.sh` is
single-database tooling, not a tenant-selective restore command.

### R2 and vector isolation survive database moves

R2 keys remain under the stable owner prefix from ADR-0011. D1 ownership and
current authorization/state are checked before issuing or serving access;
the prefix is organization, not an authorization mechanism. Uploads,
capabilities, exports and cleanup must resolve the same tenant route. A move
must account for outstanding upload credentials and download capabilities,
not strand them by removing the only id-to-owner lookup. The exact routed
capability format is part of move implementation, not chosen here.

Vector queries must scope to the tenant before top-K selection, using an
owner-specific namespace or an indexed exact tenant filter. D1 hydration must
still recheck ownership, publication, generation and content stamps. Partition
head/history data and restore generations consistently across query, enqueue,
delivery, deletion and backfill. An absent or mismatched tenant partition
falls back to lexical search; it never widens to the deployment's candidates.
Tenant namespace identity is independent of mutable D1 shard placement.
Fresh restore partitions invalidate old acknowledgements; their visibility
must be verified separately from mutation acceptance (ADR-0013).

### Capacity evidence precedes allocation

Measure per-shard bytes and growth, SQL duration, rows read/written per
operation, p95/p99 request and claim latency, overload errors, tenant load
skew, outbox age/retry rate and maintenance duration. Include immutable history,
FTS, logs, vector snapshots and daily repair, not only live concept counts.
Record the workload, tenant distribution and database size alongside every
load test. There is no measured production tenant-capacity number in this
review; a provider limit is not one.

Fix unbounded work and query plans before treating another shard as the cure:
bounded resumable built-in sync, tenant-leading activity indexes where query
plans justify them, bounded/keyset pagination and fair delivery scheduling.
The 20-job minute drain's 28,800 daily attempts include repair and retry; adding
D1 databases does not multiply that scheduler or the inference budget.
ADR-0013's healthy-store backlog age above five minutes remains an investigation
trigger, not evidence by itself for D1 sharding.

Open the sharding implementation decision when growth forecasts reach the
database ceiling inside the measured provisioning/move/recovery lead time,
or sustained primary contention/overload violates the measured latency budget
after query and maintenance fixes. A repeatable noisy-neighbor test or a
tenant-specific restore requirement can force earlier isolation. Pick pool
size and headroom from those measurements and a rehearsed move, not a users-
per-database guess. A single hot or oversized tenant may need a dedicated
shard or another store; moving it between identical pools cannot remove its
own write or size ceiling. No automatic split, rebalance or per-signup
database provisioning is approved by this record.

## Alternatives

| Choice | What it buys | Why it is not the default now |
| --- | --- | --- |
| Dedicated D1 per tenant | Independent storage/primary capacity, clearer tenant restore boundary, reduced noisy-neighbor impact | Database lifecycle, binding/routing, fleet migrations and backup management grow with tenants. The 10 GB ceiling remains. Keep as an exception when measurements or recovery needs justify it. |
| SQLite-backed DO per tenant | Colocated data and serialized coordination, direct transactional SQLite access, natural per-tenant object routing | Requires moving all concept/repository, search, migration and recovery paths into objects. Each object remains single-threaded and Paid storage still caps at 10 GB. Current coordination already uses a DO without requiring that rewrite. |
| PostgreSQL | Larger relational storage, richer indexing/transaction and row-security options, established database operations | A new managed service and a D1/SQLite/FTS migration; Workers connectivity through Hyperdrive does not itself migrate the data model or replace lease alarms. Revisit for requirements or hot-tenant load D1 cannot meet, not account count alone. |
| One shared D1 indefinitely | Smallest current operational surface | Preserves a common contention and restore boundary and cannot grow past the database ceiling. Retain now, with the measured exit above. |

## Consequences

Tenant safety is reviewed at every access path while deployment remains one
Worker and one D1. A later pool preserves atomic concept/projection writes
and bounds migration work by shard rather than by account. It adds routing
authority, mixed-version deployment, tenant moves and tenant-selective recovery
as real engineering obligations before the first split. Shared FTS statistics,
primary contention and shard-wide recovery remain properties of a pool.

## Amendments

### 2026-10-23: first tenant-store boundary

`app/store/routing.server.ts` separates control database selection from tenant
data selection. Both still return the existing `DB` primary binding. This is
a single-binding routing seam, not the directory, shard allocator, epoch gate
or move service described above. It takes the authenticated user, never an
item id, query parameter, project or request-selected database.

`app/store/tenant.server.ts` constructs request-local bound operations after
browser-session validation or admitted provider-context validation. The public
store exposes no raw database, owner override or provenance argument. Its memory
operations, search, facets and vocabulary retain the existing SQL owner guards
and atomic content/projection/outbox batches. The authenticated console actor
provides this store; `/memories` delegates to `app/console/memories.server.ts`,
which uses it for every read and mutation, including history, usage, links and
attachments. The route retains the extracted feature views and P11 fetcher and
document-form behavior; no orchestration moves back into the route.
Browser-only person-link assertions are
absent from the MCP store. Transport scope preflight is still required: a store
binds tenant access, not MCP permissions.

Cross-tenant account/invite administration is a separate owner-session factory
in `app/store/admin.server.ts`; `/people` uses it. A normal tenant store cannot
enumerate accounts or mint invitations. Attachment access checks both the
object owner and parent owner, and memory-link access checks both endpoints,
including when a malformed historical child/link row exists.

This is incremental adoption, not database row security or a completed physical
control/data split. Other console routes, MCP registrations, resource delivery
and background jobs still use their existing owner-scoped concept APIs. Keep
their predicates and admission checks until their adapters adopt bound store
operations. The MCP factory is available for that adaptation; no transport
contracts, coordinator routing, scope requirements or development impersonation
behavior change in this slice.

Remaining adapter adoption is tracked by
`todo:tdo_122440ac-1cc0-4073-8ae8-bf543435943c`, with concrete console, MCP,
resource/capability and background-job refs. Domain contract extraction remains
the separate `todo:tdo_41933c10-9c9f-4291-9b71-a498a958d4f1`; neither that
extraction nor completion of this first store slice closes the adoption work.

No `withSession` call is added. Authentication, owner-role checks and all current
content reads continue on the primary. Before replica content reads can be
enabled, define which reads can be stale and propagate a database-bound bookmark
from each successful content write through the browser or MCP response to the
next read. Keep each request's session local; never share it across requests or
tenants. Bind any client-carried bookmark to the authenticated tenant and selected
database/route rather than treating it as authorization. Define missing, invalid
and stale-route bookmark handling and test read-after-write across requests,
revocation and route cutover. Authority paths must keep using the primary binding:
`first-primary` constrains the first session query only. A future tenant move
invalidates the source bookmark; start on the destination primary. These are
prerequisites, not a bookmark protocol implemented by this change.

### 2026-11-01: adoption by domain slice

`todo:tdo_122440ac-1cc0-4073-8ae8-bf543435943c` converts the remaining adapters
one domain at a time, one pull request each, every slice with cross-tenant
negative tests. A slice adds a bound namespace to the store in its own
`app/store/<domain>.server.ts`, built from the route the store already
selected, and moves its adapters onto it. The namespace takes no owner, no
database and no provenance; ids are the concepts' bare ids. Coordinator
transitions and relation edits stay coordinator calls (ADR-0002) and content
writes keep their projection in one batch (ADR-0001).

The inventory below is the state of adoption. A slice updates its row.

| Adapter | Uses | State |
|---|---|---|
| `/memories`, memory links, `/people` | `store.memories`, admin store | converted 2026-10-23 |
| `/todos`, `/todos/suggest` | `store.todos` (`app/store/todos.server.ts`) | converted 2026-11-01 |
| `/skills` (`app/console/skills.server.ts`) | `store.skills` (`app/store/skills.server.ts`); registry and GitHub listing fetches stay on the env because they read no tenant row | converted 2026-11-01 |
| `/library/:assetId/process`, `/library/documents`, `/library/authors`, `/library/authors/:slug` | `store.library` (`app/store/library.server.ts`) | converted 2026-11-01 |
| `/library` (loader and every action), `/library/read/:sourceId`, `/library/read-file/:assetId`, `/library/archive/:assetId`, `/save` | `store.library`, `store.sources`; the route's inline folder SQL became `folderFill`, and `linkedImportBackups` moved from `app/features` to `app/concepts/library.ts` | converted 2026-11-01 |
| Memory review tab, `/memories/subjects`, `/memories/subjects/:id` | `store.review`, `store.subjects` (`app/store/review.server.ts`); provider bindings are captured when the store is built | converted 2026-11-01 |
| `/hooks`, `/workbench` logs, `/activity`, `/files/:objectId`, `/connections` sessions | `store.hooks`, `store.activity`, `store.files` (`app/store/activity.server.ts`) | converted 2026-11-01 |
| `/connections` OAuth grants and bearer tokens, `/account` and its password change | `requireCredentialStore` (`app/store/credentials.server.ts`): a browser-only factory on the control database, apart from the tenant store, so no MCP or bearer store can mint or revoke credentials; `changeConsolePassword` reads the person from the session | converted 2026-11-01 |
| MCP request binding (`workers/mcp.ts`) | `mcpTenantStore(env, ctx, sessionHeaders)` after provider authentication, which also performs admission and returns the request's provenance; the loopback surface uses the separately named `loopbackTenantStore` | converted 2026-11-01 |
| MCP `save_memory`, `edit_memory`, `fetch` of a memory | `store.memories` | converted 2026-11-01 |
| MCP `create_todo`, `list_ready`, `get_brief`, `list_todos`, `claim_todo`, `update_todo`, `complete_todo`, `edit_todo_tags`, `comment_todo`, `fetch` of a to-do, search freshness | `store.todos` | converted 2026-11-01 |
| MCP `list_skills`, `get_skill`, `publish_skill`, `read_skill_file`, per-skill `skill_*` tools, `fetch` of a skill, skill resources, `skills/list`, `skills/get`, prompts, `list_hooks`, `edit_hook` | `store.skills`, `store.hooks` | converted 2026-11-01 |
| MCP `search` (rerank, owned hydration, use ordering, passage citations), `fetch`'s use recording, the completion nudge's call-log read | `store.rankedSearch` (`app/store/search.server.ts`), `store.library`, `store.activity` | converted 2026-11-01 |
| MCP `upload_asset`, `update_asset`, `get_asset_download`, the asset resource, attachment resources, `fetch` of an asset | `store.library` (upload, update, folder join, download credential and object read re-check ownership), `store.files.attached` | converted 2026-11-01 |
| MCP `save_source` (including its URL check and image capture), `fetch` of a source, `save_memory`/`edit_memory` vector deferral | `store.sources` (`app/store/sources.server.ts`), `store.library.deleteAsset`, `store.memories.vectorDeferral`; `app/mcp` now passes no owner id outside the call log | converted 2026-11-01 |
| `/config/hooks`, `/config/brief`, `/library/export*`, `/library/import*`, `/capture` | `bearerTenantStore` (token, admission and scopes resolve to a store in one step; `authorizeBearer` keeps its shape by delegating to it), `store.hooks`, `store.startupBrief`, `store.library`, `store.sources.captureBookmark` | converted 2026-11-01 |
| `/uploads/{id}`, `/downloads/{id}`, `/archives/*` in `workers/app.ts` | concept APIs that resolve the owner from the asset row the capability names (upload token digest, download or archive signature); the request names no user | exception: with one shared-primary route there is nothing to resolve. Forced by the first database move or shard: the capability must then carry its tenant's route inside the signed or hashed value, or a control-plane index must map asset ids to routes |
| `scheduled()` jobs: builtin sweep, upstream skills, asset processing, source enrichment, vector, asset-vector and source-vector delivery, library cleanup, overnight review, activity trim | concept APIs that read each row's own `user_id` and act for that owner, with no request in the path | exception: ownership comes from the authoritative row, not a caller, which is what this follow-up asks of background access. Forced by the first shard: each job must enumerate routes (or tenants per route) from the control plane and run per route, and cross-tenant scans (activity trim, library cleanup) become per-route operations. A permissive store constructor that takes an arbitrary owner is not added for them |

Exceptions that stay outside the tenant store by design: account
authentication and sessions (`/join`, `/verify-email`, `/reset-password`, the
console session itself) read the control database; cross-tenant
administration stays in `app/store/admin.server.ts`; and the owner-only
`/workbench` backup status reads operator state, not tenant rows.

### 2026-10-23: bounded tenant round-robin vector delivery

Retain the minute cron, 20 total attempts per pass, four concurrent jobs and
five-second embedding/mutation waits. The owner reports PR169's 101 ledger rows
settled after five transient embedding failures retried successfully. That
observation establishes recovery, not arrival rates, inference headroom or
evidence for Queue infrastructure. No paid production load test is authorized
or needed for the fairness change.

Additive migration 0036 adds an indexed nullable owner hint to `vector_pending`
and a deployment cursor/lease in `vector_drain_state`. Enqueue stamps new hints
atomically with the authoritative batch; runtime bootstrap fills at most 50
legacy hints per pass without invalidating accepted epochs. The authoritative
memory owner, not the hint, still determines delivery namespace and hydration.

A 120-second deployment reservation serializes ordinary drains. Each pass seeks
at most 20 distinct ledger tenants by keyset, wraps once, fetches at most 20 due
references per tenant through the tenant-leading index, then admits at most 20
jobs in tenant round-robin order. Persist the cursor before network work so a
failed tenant or crashed pass cannot pin every next turn. Per-job epochs,
fencing leases, deletion targets and uncertain-mutation repair are unchanged.
Token-conditional reservation release cannot clear a replacement; a lost holder
starts no later provider wave. Already admitted remote effects still require
the existing reconciliation, not a cancellation claim.

On a rejected claim or delivery-persistence write, settle every admitted sibling
before releasing the deployment reservation. Stop later waves and propagate the
write failures; a fail-fast aggregate must not admit a second drain while the
first wave's other embeddings are still running.

Settled tenants also consume bounded visits, so increasing tenant count can
increase service latency even with little due work. Fairness does not increase
the scheduled 28,800-attempt/day ceiling or establish sustained throughput.
`docs/operations/vector-rebuild.md` names bounds, metrics, bootstrap, rollback
and the evidence that would force a further dispatch decision. A later Queue
design must preserve outbox authority and fair admission and explicitly cap
concurrency/spend; at-least-once delivery and default autoscaling do not supply
those properties. No shard router, queue resource or new binding is introduced.

### 2026-11-01: per-owner embedding backlog cap

An owner may have at most `VALISE_VECTOR_BACKLOG_CAP` (default 200) distinct
memories with unfinished, non-delete embedding work in the deployment
namespace. The owner chose the publication policy: at the cap, a memory write
still commits its authoritative rows and FTS projection in the same batch; only
its embedding waits, recorded once per memory in `vector_deferred`. The MCP
receipt says so in `metadata.vector_indexing`. Refusing the write was rejected
because vectors are optional candidates over lexical search (ADR-0013) and a
refused write would push the retry onto every client.

Admission is evaluated inside the writer's batch, so D1's serial batches make
it race-free without a lock; a memory already waiting coalesces repeat edits,
and archives, backfill, relocation and restore are always admitted. The cron
promotes deferred memories through the same gate, round-robin over at most 20
owners and 20 memories per pass, ahead of the unchanged fair drain. Epochs,
leases, deletion targets and the 20-attempt pass are unchanged; the cap bounds
one owner's share of the queue, not the deployment's inference spend.

The default came from read-only production counts on 2026-11-01: 164 memories
across two owners, at most 12 created in any hour, the largest owner holding
154, and an empty backlog. 200 is ten minutes of the whole drain and admits that
owner's entire corpus at once. Revisit it with the per-user daily budget
(`todo:tdo_2ee6be3b-937c-409f-befb-a941a707d0e9`) and the mixed-agent load
measurement. The console shows no deferral notice; its owner sees the count in
vector status. Asset passages keep their own four-per-minute drain and their
existing missing-output reconciler and are not capped by this change.
`docs/operations/vector-rebuild.md` has the mechanism and inspection query.

### 2026-11-01: per-owner daily embedding metering and budget

Every provider embedding call (memory, book-passage and bookmark-passage
deliveries, search query embeddings) reserves its input bytes in `embedding_usage_daily` under the
owner and UTC day before it is made, in one conditional upsert, so concurrent
callers cannot pass a configured budget. Retries and failed attempts count
because the provider charges for them; deletes need no allowance. Over budget,
background jobs wait for the next 00:00 UTC without consuming retries or drain
slots, and search falls back to lexical order with a stated reason.

The owner chose metering without a default budget. Production kept no daily
history to measure from: `vector_pending` keeps only the last completion and
resets attempts on success, and asset and query embeddings were unrecorded. On
2026-11-01 it held 179 memory and 166 asset-passage ledger rows, no retries,
and bge-m3 costs about $0.012 per million tokens. Search now makes one D1 write
per query embedding for this metering. `VALISE_EMBEDDING_DAILY_BYTES` stays
unset until `todo:tdo_5986108d-2f2b-47bb-9156-5a2961708e35` picks a value from
at least a week of metered usage. Mechanism and query:
`docs/operations/vector-rebuild.md`.

## Open questions

- User-owned case or workspace-owned tenant: forced by shared ownership,
  membership changes or billing across users. Kept open by invite-gated,
  independently owned cases; projects and group invites confer no sharing.
- Initial shard count, allocation policy and latency/headroom budgets: forced
  by the capacity or recovery triggers above. Kept open by the absence of a
  representative multi-tenant load baseline and a rehearsed move duration.
- Fleet routing transport and capability lookup: forced before the first
  physical split. Kept open by the single `DB` binding and current id-based
  resource routes. Resolve both before moving data, including control-plane
  availability and route-cache fencing tests.

## Provider constraints checked 2026-10-23

These are documented limits, not a measurement of this account's plan or usage.

| Source | Constraint used in this decision |
| --- | --- |
| [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) | Paid: 10 GB/database, 50,000 databases/account, 1 TB account storage; Free: 500 MB/database, 10 databases, 5 GB account storage. The 10 GB ceiling cannot be increased; account limits can be requested higher. Each database processes queries serially, with overload after its queue fills. |
| [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) | 100 bound parameters/query, 30-second query duration; the duration also bounds a whole batch call. Approximately 5,000 bindings per Worker depend on its 1 MB metadata budget, not just the account database quota. |
| [D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/) | Sessions API is required to use replicas; writes still go to the primary. Sessions are sequentially consistent; unconstrained first reads can be stale. |
| [D1 limits and Time Travel](https://developers.cloudflare.com/d1/platform/limits/) | Recovery window is 30 days Paid / 7 days Free; 10 restores per 10 minutes per database. This is database recovery, not tenant-selective rollback. |
| [SQLite DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) | Paid SQLite storage is 10 GB/object, with unlimited objects and account storage. Each object is single-threaded; the documented 1,000 requests/second is a soft limit, not a Valise throughput promise. |
| [Vectorize limits](https://developers.cloudflare.com/vectorize/platform/limits/) | 20 million vectors/index; 50,000 namespaces/index Paid / 1,000 Free; namespace names are at most 64 bytes. Top-K is at most 50 with values or metadata, 100 without; ten metadata indexes, 64 indexed bytes per metadata field. Head/history and restore partitions consume the namespace budget too. |
