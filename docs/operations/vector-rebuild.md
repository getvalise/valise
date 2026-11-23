# Rebuild vector candidates

The index is optional. Keep `VALISE_RERANK` unset, `jev` or `off` during restore;
lexical publication does not depend on vector delivery. Never enable `hybrid`
solely because an outbox is empty.

Production selects `hybrid`: Jev reranks the lexical/current-vector union.
Restore or rollback selects `jev` through a reviewed config PR, without
deleting the index, changing secrets or trusting restored delivery acknowledgements.

## Prerequisites

The rollout provisions the 1024-dimensional cosine `valise-memories-v1` index.
`VALISE_VECTOR_NAMESPACE=valise-prod-v1` is the production deployment identity,
not the queried partition. Binding and identity changes take effect only through
reviewed merges and Workers Builds. Do not reuse the identity for another
database, restore or workspace. `AI` supplies bge-m3.

Each tenant uses `t:<base64url SHA-256(JSON.stringify(["tenant-v1", deployment,
userId]))>` for live heads and `h:t:<digest>` for history (45 and 47 ASCII bytes).
The tenant comes from the authenticated principal on search and from the
authoritative memory owner on delivery, including old snapshots without userId.
Namespace selection happens before ANN top50 and before project/tag filtering;
D1 still checks publication, ownership, filters and the current generation stamp.
No tenant query reads or falls back to the legacy shared partitions.

Real model input/output, same-id namespace moves and mutation visibility were
verified on a disposable synthetic index on 2026-10-20, below. Scoped ANN recall
and delivery capacity still need rollout evidence. No local test should point at
a production index.

Seed retrieval fixtures only into a fresh isolated database, before backfill.
The loopback seed levers replace fixture rows without revisioning; they are not
supported edits of an already snapshotted vector store. Use application
save/edit/archive for revisioned content changes.

## Enqueue

Apply migrations and restore authoritative rows first. Backups include memories,
memory revisions and memory links, along with the other authoritative tables.
Optionally include `vector_snapshots` to preserve exact historical routing and
stamps. Do not restore `vector_pending` acknowledgements, `vector_backfills`
checkpoints or `vector_drain_state` leases/cursors to a new index.

Against a running loopback Worker using the intended isolated database:

```sh
VALISE_DEV_ORIGIN=http://localhost:4385 node scripts/reindex.mjs --all --vectors
```

This rebuilds FTS and enqueues history and current heads without inference.
This command's vector backfill covers memories; `--all` includes asset FTS but
does not mean asset vectors were enqueued. Restored asset processing outputs and
user decisions are authoritative, not an extraction cache. Use the asset path
below without rerunning conversion or metadata inference.
Pages contain at most 50 source generations plus the current heads needed to
capture publication safely. The cursor is a JSON pair of memory id and
generation; restarting from the beginning is safe. Progress output distinguishes
enqueue completion (`done`) from outstanding deliveries (`pending`, `failed`).
No append-only revision is edited. Historical project is read from the revision;
unknown legacy project remains null. Missing original update times use revision
snapshot time only for history. Current heads use their exact current projection.

### Asset outputs after recovery

Keep the new recovery config in lexical/off mode, with an empty vector base
identity and no attached index. A search-mode change alone does not stop cron
delivery when vector bindings/identity remain enabled.

```sh
node scripts/backup.mjs enqueue-assets /secure/valise-backups/snapshot-… \
  --config wrangler.recovery.jsonc --remote --fresh my-recovered-valise \
  --namespace recovered-assets-unique-base
```

This uses the actual application backfill/stamp/outbox code in 50-output pages,
requires a different base from the snapshot's source, checks exact migrations and
refuses source resources, hybrid or an attached index. It changes only the
existing `asset_vector_pending` ledger, never original bytes, processing output,
attempts, suggestions or apply/dismiss decisions. It makes no provider calls;
its report explicitly says not delivered and visibility unverified. A partial
failure is rerun safely from the start.

Then explicitly provision/select a fresh 1024/cosine index with the `docKey`
string metadata index and attach it with AI and the same new base through the
reviewed configuration/Workers Builds path. Retain lexical/off search while the
normal four-chunk-per-minute asset ledger embeds **retained extracted text** in
`a:<tenant namespace>`. It does not re-extract files or regenerate metadata.
The fresh index/base is shared with memories; enabling bindings also enables
their existing 20-attempt minute delivery/backfill, not just the four asset chunks.
Historical outputs remain stored but only current published owned outputs are
queued. Original and decision history remain recoverable before embedding.

The old index is never attached as a recovery fallback. No restored mutation ID,
enqueue `done`, or zero pending establishes ANN visibility. Obtain bounded fresh
query/current-head, two-user and public hybrid/reranker proof before selecting
hybrid; lexical extracted retrieval remains the recovery floor. The full
[table policies and recovery exercise](asset-processing.md#recovery-table-contract)
cover the distinction between authoritative history and operational delivery.

The same command then pages `backfillSourceVectors()` from
`app/search/source-vectors.ts`, which queues each live bookmark's current
enrichment into `source_vector_pending` with no provider call. Its report adds
`sources`, and `queuedChunks` counts both kinds.

## Drain and validate

The dedicated minute cron attempts at most 20 deliveries, four concurrently.
Selection is tenant round-robin, not a deployment-wide due-order prefix.
It resumes initial backfill in 50-source pages using `vector_backfills`, keyed
by `tenant-v1:<deployment identity>`. Completed scans do not repeat; application writes enqueue new
generations. Nightly trim, skill sync and upstream checks keep their schedule.
An authorized explicit local
drain uses:

```sh
VALISE_DEV_ORIGIN=http://localhost:4385 node scripts/reindex.mjs --vectors --drain
```

That command rechecks enqueue state and attempts one batch, not a paid full-store
loop. Failed jobs back off from 60 seconds to one day; they are never silently
dropped. A crashed claim retries after its 120-second lease. Completed rows keep
the accepted mutation id and deletion target. Cron output includes pending and
failed counts without memory text.

The minute handler samples full backlog counters once every five minutes;
`statusSampled: false` means counters were omitted, not zero. Accepted/failed
attempt counts are logged each minute. At 5,000 generations, sampling reads
1.44 million ledger rows/day rather than 7.2 million for minute-by-minute counts.
Initial backfill pages and explicit operator status/drains also return counters.

Embedding and index-mutation waits have five-second deadlines. A stalled job
backs off without preventing the remaining jobs from running. A timeout does
not prove cancellation of a remote mutation; reconciliation still applies.

Accepted rows are eligible for bounded reconciliation again after one day,
including head/history re-embedding and repeated tombstone deletion. This catches
late remote mutations a crashed worker could not report. Reconciliation shares
the 20-job limit. The scheduled ceiling is 28,800 attempts/day, including daily reconciliation,
not measured sustained capacity:
5,000 settled generations consume 17.4% before writes/retries. A healthy empty
5,000-generation index needs at least 250 minute ticks to accept its backfill;
50-source enqueue pages keep ahead of delivery. The 2026-10-21 production census
was 76 live memories and three revisions, not 5,000. At 300 tokens/generation,
5,000 daily re-embeddings cost about $0.018 at $0.012/million tokens.
28,800 attempts with 16KiB bodies cost about $1.42/day plus titles using four
bytes/token. These are estimates, not token-metered bills or spending ceilings.

Pending and failed counts describe the latest delivery or reconciliation
attempt. Claiming a previously accepted row marks it pending again. A failed
reconciliation can therefore count as failed while its existing vector is still
usable. These counters do not measure index visibility. `oldestPendingSeconds`
measures enqueue-to-acceptance backlog age; `lastAcceptedAt` records acceptance,
never visibility. Investigate a healthy-store backlog older than five minutes,
or growing `failed`/`due` across ticks. Provider outages have no finite delivery
SLA; retries back off to one day and lexical search remains available.

Inspect a partition without inference:

```sql
SELECT namespace, COUNT(*) AS total,
       SUM(completed_epoch < epoch) AS pending,
       SUM(completed_epoch < epoch AND attempts > 0) AS failed
FROM vector_pending GROUP BY namespace;
```

Zero pending means mutation acceptance, not visibility. Verify live current-head
queries, historical partition exclusion, archived deletion, supersession,
cross-workspace rejection and restore completeness. Run retrieval floors and the
authorized `retrieval-* --repeat 3` cases before enabling hybrid.
Retiring an old index/namespace is a separate authorized operator
action; this rebuild never deletes an unrelated partition.

## Fair bounded tenant scheduling

Additive migration `0036_vector_tenant_scheduling.sql` adds a nullable indexed
`vector_pending.user_id` scheduling hint and a deployment-keyed
`vector_drain_state` cursor/lease. It rewrites no existing row. New application
enqueue statements stamp the hint in the authoritative/projection/outbox batch.
Each drain fills at most 50 missing hints from `memories`, without resetting
epochs, acceptance or retry times and without inference. Old-version writes
during rollout are caught by the same pass. Delivery and search still resolve
the authoritative owner; a hint is never authorization or a namespace source.

A drain reserves its deployment for 120 seconds. Another invocation reports
`drainLeased: true` and starts no provider work. The holder visits at most 20
tenant ids after its durable keyset cursor, wrapping once. Repeated indexed
`MIN(user_id)` seeks skip bulk-import generations; discovery does not sort or
scan every due row with a window function or `DISTINCT`. Each visited tenant
has an indexed, at-most-20-reference due query; at most 400 references are
returned, and round-robin selection admits at most 20 total delivery attempts.
Unused tenant turns are redistributed within that visited page. When only one
tenant has due work in the page, it can still use all 20 attempts.

The cursor advances before network work, including visits with no due jobs.
After owner bootstrap, with a stable set of N indexed ledger tenants, every
tenant has a service opportunity
within `ceil(N / 20)` successful passes, independent of another tenant's import
size. Settled, leased and backed-off tenants count toward visits but not calls;
sparse populations can therefore spend passes on inactive tenants. This is a
bounded fairness tradeoff, not an active-tenant directory or a delivery SLA.
Growth in tenant count still increases latency; monitor actual age rather than
claiming that fair selection raises throughput. Continuous arrivals, retries,
crashes and provider outages can delay acceptance further.

Existing per-generation epochs, 120-second claims, same-ID upserts, tombstones,
retry backoff and uncertain-mutation repair remain authoritative. Losing the
deployment reservation stops new provider waves; its `finally` release is
token-conditional and cannot clear a replacement's lease. Already admitted or
timed-out remote effects are not proven cancelled by lease expiry. The same
reconciliation rules apply. A crashed pass resumes after its lease expires;
unattempted references remain due in the ledger. Invocation limits remain 20
attempts, four awaited concurrent jobs, and five seconds per embedding/mutation
wait. Explicit operator drains are extra invocations, not part of a daily spend
ceiling. There is no new global token/dollar quota or inference-rate increase.

A rejected claim or retry/acknowledgement persistence write stops later waves,
but the pass waits for every already-admitted sibling to settle before releasing
its reservation. It then rejects with an `AggregateError` retaining the write
failures, rather than returning a healthy report. A failed claim stays due;
a failed retry write can leave its job claim leased until expiry. Recovery must
not clear the deployment reservation while sibling embeddings are still running.

Minute reports add `tenantsVisited` and `ownerHintsBackfilled`; sampled status
adds `ownerHintsPending`. These describe selection and bootstrap, not ANN
visibility. Existing pending/failed counts, oldest enqueue age and acceptance
timestamps retain their meanings. For a tenant-attributed backlog inspection:

```sql
SELECT m.user_id, COUNT(*) AS generations,
       SUM(p.completed_epoch < p.epoch) AS pending,
       SUM(p.completed_epoch < p.epoch AND p.attempts > 0) AS failed,
       MAX(CASE WHEN p.completed_epoch < p.epoch AND p.queued_at > 0
           THEN MAX(0, unixepoch() - p.queued_at) ELSE 0 END) AS oldest_pending_seconds
FROM vector_pending p JOIN memories m USING (memory_id)
WHERE p.namespace = 'valise-prod-v1'
GROUP BY m.user_id;
```

No new Cloudflare resource, secret, binding, metadata index or scheduler setting
is required. After the authorized release, confirm migration/Workers Build and
deployment, that missing hints reach zero and the cursor moves, and that
existing retries/deletions settle. Observe real tenant skew and acceptance age;
keep query-visible head/history/archive checks separate. Rolling back code can
leave the additive state/index in place; old code ignores them. Do not erase
the outbox or backfill checkpoints to recover a scheduler lease.

### Per-owner backlog cap

Additive migration `0053_vector_deferred.sql` adds `vector_deferred` and the
partial index `vector_pending_outstanding`. An owner's backlog is the number of
distinct memories with a `vector_pending` row in the deployment namespace where
`completed_epoch < epoch AND target != 'delete'`. Claimed and failing jobs
count; completed history does not. The cap is `VALISE_VECTOR_BACKLOG_CAP`, a
positive integer, defaulting to 200 when unset or invalid.

A memory write (save, edit, link, review merge, subject summary) runs three
statements in its authoritative batch. While the owner is under the cap, or the
memory already has outstanding work, or the memory is archived, its rows are
enqueued as before. Otherwise its content, revision and FTS row still commit and
one `vector_deferred` row records the memory; later edits reuse that row and
keep its place. D1 executes batches serially, so concurrent writers each count
what the previous batch left; one statement can enqueue a memory's predecessors
with it, which is the only overshoot. Backfill, relocation and the restore
rebuild call the ungated enqueue and are always admitted.

Each minute, before delivery, `promoteDeferredVectors` visits up to 20 owners
with deferred rows after a cursor kept in `vector_drain_state` under
`defer:<namespace>`, takes each owner's oldest rows up to its headroom, and
promotes at most 20 memories round-robin through the same gate. The minute
report adds `promotion: { promoted, tenantsVisited }`; sampled status adds
`deferred`. `save_memory` and `edit_memory` return
`metadata.vector_indexing: { state: "deferred", outstanding, cap }` for a
deferred memory; the client has nothing to retry. To inspect:

```sql
SELECT user_id, COUNT(*) AS deferred, MIN(deferred_at) AS oldest
FROM vector_deferred WHERE namespace = 'valise-prod-v1' GROUP BY user_id;
```

A deferred memory is found by lexical search immediately. Its earlier head
vector, if any, no longer matches the current generation and is dropped at
hydration until promotion delivers the new one. Raising the cap takes effect on
the next write and the next pass; lowering it defers new work and never evicts
queued rows. Rolling back code leaves deferred rows unread until the code
returns; the rebuild under Enqueue above also enqueues their memories.

### Per-owner daily embedding budget

Additive migration `0058_embedding_usage_daily.sql` meters every provider
embedding call per owner per UTC day (`date('now')`), by kind: `memory`,
`asset` and `source` (bookmark passage) deliveries in the minute drains, and
`query` embeddings at search time. Each call reserves its UTF-8 input bytes before it is made; retries and
failed attempts count, with `failures` incremented when the call throws.
Deletes and errors before the provider call cost nothing. Rows older than 90
days are trimmed by the nightly cron.

`VALISE_EMBEDDING_DAILY_BYTES` sets the budget; unset or invalid, every call is
metered and none is refused. It is unset in production until metered data
supports a value (`todo:tdo_5986108d-2f2b-47bb-9156-5a2961708e35`). Set, a
reservation is refused once the owner's total for the day has reached it, so
one call overshoots by at most its own input. A refused delivery job keeps its
attempts, gets `error_code = 'daily_budget'` and `next_attempt_at` at the next
00:00 UTC, so it takes no drain slot from other owners until then. Minute
reports add `budgetDeferred`; sampled memory status adds `budgetDeferred`. A
refused search query embedding raises `VectorSearchFailure("daily embedding
budget reached")`, which search reports as its rerank `fallback` while
returning lexical order. Raising or unsetting the budget does not move parked
jobs forward; they run at the next UTC day. To inspect:

```sql
SELECT user_id, day, kind, calls, failures, input_bytes
FROM embedding_usage_daily WHERE day >= date('now', '-7 days')
ORDER BY day DESC, input_bytes DESC;
```

### Cron versus Queues

The owner reported 101 settled ledger rows, zero errors/pending and a completed
tenant backfill after PR169; five transient embedding failures recovered via
existing retries. This is recovery evidence, not an arrival-rate measurement,
multi-tenant load test or inference headroom estimate. It does not justify
introducing Queues or raising the paid budget now. Retain bounded minute cron.

Revisit dispatch infrastructure when measured new generations plus daily repair
and retry demand sustain backlog growth or violate the healthy-store age
investigation threshold despite fair selection and indexed queries. Record
arrival/acceptance rates, skew, provider latency/error rates and token cost over
a representative interval first. Queues provides at-least-once delivery and
autoscaling consumers, not tenant fairness or an inference spending cap. A
future design must retain this outbox as authority, bridge enqueue-to-notification
durably, deduplicate by generation/epoch and retain lease/deletion repair; cap
consumer concurrency and total admitted work explicitly. Unbounded autoscaling
or a FIFO batch of one tenant's import is not the fairness fix.

## Tenant namespace migration

No SQL migration, metadata index or environment change is needed for this move.
Keep the deployment identity unchanged: vector IDs/stamps deliberately still
hash that identity, not the tenant partition. Upserting the same ID moves it out
of the old shared head or `h:<deployment>` history partition without duplicates.
Deletion by unchanged ID removes either layout. Existing outbox epochs, lease
tokens, retry backoff and daily reconciliation remain authoritative.

The first new-code minute tick ignores the old deployment-only backfill
checkpoint. The versioned checkpoint re-enqueues every source generation,
including previously accepted deliveries and tombstones, for tenant routing.
Each page invalidates its selected epochs without stealing an active lease;
an in-flight acknowledgement cannot settle a newer epoch. A crash can repeat a
page safely. Old immutable snapshots and memory revisions are not rewritten.
The old checkpoint is retained; `done=1` on the new checkpoint means enqueued,
not accepted or query-visible. Search can temporarily have fewer semantic
candidates while vectors move; lexical results remain available.

After an authorized release, confirm Workers Build/deployment, the
`tenant-v1:valise-prod-v1` checkpoint, pending/failed/oldest age and actual query
visibility for two tenants. Check bare/project/all-tag retrieval under foreign
crowding, historical exclusion and archived deletion. Existing project/docKey
metadata indexes remain required. Never validate against the shared namespace
as a substitute for a tenant query. No live provider/production proof is implied
by the local contract-double tests.

Rolling back to the old vector code makes it query now-empty shared partitions;
use lexical/`jev` mode for rollback rather than restoring shared-namespace search.
Old workers can move the same IDs back until they drain; new-code daily
reconciliation repairs routing. Inspect visibility after old versions stop.
Do not delete the index, outbox or checkpoints as a rollback shortcut.

Vectorize's current limits page permits 50,000 namespaces/index on Workers Paid
and 1,000 on Free; the older namespace guide still says 1,000. Two per tenant
plus the two legacy production partitions bound this layout to at most 24,999
tenants on Paid or 499 on Free (fewer if it hosts other deployments). Verify the
account plan and track namespace use before opening signup; pooled indexes or
an indexed tenant metadata design need separate capacity/rollout work. The
20 attempts/minute remains a deployment-wide bound: daily history re-embedding,
retries and new writes compete for it. Tenant fairness is now bounded as above;
provider batching, automated backlog-age alerts and a measured capacity/spend
budget remain follow-up work, not claims of the namespace migration.

## Scoped queries and isolated proof

Create string metadata indexes `project` and `docKey` before the first upsert.
Projects use SHA-256 keys: Vectorize indexes only 64 UTF-8 bytes, while Valise
allows 100-character project names. D1 still rechecks the original project.
All-tag queries first select eligible published D1 keys, then query indexed
32-key `$in` partitions and merge by cosine score before taking 50. They do not
post-filter a global top 50. At most 256 eligible heads (eight queries) are
allowed under the shared 2.5-second deadline; broader tag scopes explicitly
fall back to FTS rather than claiming truncated vector recall. Tag strings,
including 100-character Unicode tags, never depend on truncated metadata.

Use a fresh local database and the disposable eval index, never production:

```sh
npx wrangler d1 migrations apply DB --local --persist-to .wrangler/vector-rollout-eval
VALISE_STATE=.wrangler/vector-rollout-eval VALISE_RERANK=hybrid \
  VALISE_VECTOR_EVAL_INDEX=valise-rollout-eval-20261021 \
  VALISE_VECTOR_EVAL_NAMESPACE=rollout-eval-v1 npm run dev -- --port 4474 --strictPort
VALISE_DEV_ORIGIN=http://localhost:4474 node scripts/vector-rollout-probe.mjs --seed --size 50
```

Vite generates `.wrangler/vector-eval-<resource-hash>.jsonc` before remote-binding
discovery. Distinct eval namespaces use distinct config files as well as stores.
Put the local eval Jev key in `.wrangler/.dev.vars` (an ignored symlink to the
root `.dev.vars` is sufficient); secrets resolve beside the generated config.
Only `valise-rollout-eval-*` indexes and `rollout-eval-*` namespaces are accepted,
with an explicit isolated `VALISE_STATE`. Normal local dev does not enable the
remote production Vectorize binding. The proof script bounds source pages,
paid drain batches and visibility polling, requires at least 95% genuine hybrid
responses at 50 (at most three timeout fallbacks in 75 queries),
applies the existing 50-store floors, and checks project/all-tag ANN inclusion
for all 25 targets. It deletes nothing. Remove only the disposable eval index
after retaining evidence.

The recorded disposable index was deleted. Reproduction requires a newly
created `valise-rollout-eval-*` 1024/cosine index with the two metadata indexes,
a fresh local state path and a fresh `rollout-eval-*` namespace. Never reuse
completed delivery acknowledgements after deleting or replacing an index.

Explicit probe drains pause ten seconds between batches to avoid saturating the
local remote-binding proxy/control-plane rate limits. `--batch-delay-ms` accepts
0..60000; lowering it is a deliberate load test, not the production schedule.
The script stops on a wholly failed page and retains partial JSON on failure.

## Production merge sequence

1. Merge binding/capacity only after exact-head local `npm run verify`. Confirm
   Workers Build, migration 0021 and deployment success. No laptop deploy.
   New cron schedules can take up to 15 minutes to propagate; measure backlog
   after the minute trigger is running, not from the merge timestamp.
2. Observe minute `vector_drain` reports and the namespace's `vector_backfills`
   checkpoint. Wait for `done=1`, `pending=0`, no failed jobs, and live query
   visibility. Confirm current heads, history exclusion and scoped queries.
3. After live floors pass and repeated retrieval episodes are reviewed against
   ADR-0013's recorded acceptance criteria, merge a separate
   `VALISE_RERANK=hybrid` config change through the same gate. Confirm
   the deployed setting and real search call metadata. Roll back mode through
   a PR if it regresses; do not delete the index or ledger.

## Provider references

- [D1 atomic batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [Vectorize binding operations](https://developers.cloudflare.com/vectorize/reference/client-api/)
- [Namespaces and asynchronous writes](https://developers.cloudflare.com/vectorize/best-practices/insert-vectors/)
- [Vectorize limits](https://developers.cloudflare.com/vectorize/platform/limits/)
- [bge-m3 usage and schemas](https://developers.cloudflare.com/workers-ai/models/bge-m3/)
- [Cron propagation and local invocation](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Scheduled duration/CPU limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Queues at-least-once delivery](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Queues consumer concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/)

## Live contract proof, 2026-10-20

The authenticated operator ran bge-m3 with `text: [syntheticText]`. It returned
HTTP 200, `shape: [1, 1024]`, and one finite 1024-dimensional `data` vector.
The actual service accepts the input used by `queryVector` and the outbox,
despite the model page's conflicting `contexts`/`query` schema.

The probe created `valise-contract-20261020`, a 1024-dimensional cosine index,
with one synthetic vector and only `docKey`/`stamp` metadata. No production
memory was sent. Query returned both namespace and metadata. A query in an
unrelated namespace returned no matches. Upserting the same 64-character ID
into `h:head` removed it from `head`; upserting it back removed it from history.
Deletion became visible in both namespaces. Mutation acceptance was not treated
as visibility: the probe waited for actual query results at each step.

| Operation | Accepted mutation | Observed visibility delay |
| --- | --- | --- |
| Insert into head | `40780ad7-8bcf-40eb-b272-a997233c67a4` | 68.3 s |
| Move to history | `37d7ae35-a311-440a-a07c-403e6adadca3` | 43.5 s |
| Restore head | `6e520bfb-bb9b-4d3a-995b-e4cad307f536` | 27.7 s |
| Delete | `bdcf732c-b834-4caf-80f4-dd686da983d0` | 51.5 s |

These are single-operation observations through the HTTP API, not latency
percentiles, binding integration, production freshness or recall evidence.
The synthetic index was deleted after the passing probe. No production index,
namespace, binding or hybrid mode was enabled.

The old live-schema/namespace uncertainty is resolved. Remaining work on
`todo:tdo_786aa360-6fcb-42e1-990c-c2935bbf33d7` is engineering, not a GitHub
Actions billing dependency: provision the deployment index, add enough drain
capacity for new generations plus daily reconciliation, backfill it, and run
scoped retrieval floors and repeated model-in-the-loop cases before activation.
