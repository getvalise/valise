# Backup and recovery

`scripts/library.mjs` remains the per-user portable library export/import.
It includes ready, unexpired assets and source histories, not an installation.
Its scopes cannot read another tenant. See [library export](library-export.md).

Every deployment backs itself up once a day inside Cloudflare: a cron starts
the `BackupWorkflow`, which writes a snapshot to a separate, locked R2 bucket.
See [scheduled backups](#scheduled-backups-in-cloudflare) and ADR-0019.

`scripts/backup.mjs` is the operator's recovery tool. It pulls a scheduled
snapshot out of R2, captures one by hand to another host, and restores either
into fresh resources. It uses Wrangler's account permissions, not an MCP bearer
or a new HTTP endpoint. Run it from the release checkout with `npm ci` and a
supported Node release meeting the locked toolchain's engines
(`^22.18.0 || >=24.11.0`). Capture and pull read D1 and R2; neither changes
application records or the source bucket.

Include development dependencies on the backup host. `esbuild` is a direct,
exact-pinned development dependency (`0.28.1`), used to bundle the application's
actual TypeScript reindex code for scratch SQLite, not a Worker runtime binding.
The recovery scripts also use Node's built-in `node:sqlite`; the recorded local
drill ran on Node 26.5.0. Older supported Node releases have not been exercised
by that drill.

## Coverage

| Included | Recovery behavior |
| --- | --- |
| Skills and every immutable version | Stable IDs, tenant names, bodies, metadata, disabled/deleted state and every supporting bundle file, historical versions included. |
| Memories, revisions and links | Stable IDs, owners, complete text, provenance and confirmed/removed relationship history. |
| Memory review history and preferences | Model proposals, full source evidence/fingerprints, human edits/events, accepted/dismissed/no-op coverage, exact queued progress, chosen models/limits and spent budget reservations. Review/overnight opt-ins reset off; live locks are cleared and interrupted running attempts become failed. |
| To-dos, updates, comments and refs | Full history and the D1 state snapshot. Live leases are invalidated, not replayed. |
| To-do parent/dependency relations and operation fences | Edge owners, kinds, timestamps and endpoints are retained exactly; manual `blocked_on` remains on its task. Captured graph-operation tokens are invalidated, not replayed. |
| Objects and both attachment tables | Original bytes, checksums and links, including attachments never registered as assets. |
| Assets, sources, all revisions and ordered links | Archived/expired records too. Expiry timestamps are not extended. Pending transfers become failed and must be uploaded again. |
| Asset attempts, immutable outputs, selected heads and apply/dismiss decisions | Preserve original checksums, processor/model provenance, complete historical outputs and individual user decisions. Settled states remain; queued/running attempts become `restored_interrupted` failures without automatic inference. |
| Asset admission receipts | Preserve usage windows and spent attempts, including deleted-original receipts; invalidate live leases without refunding usage. |
| Users | IDs, roles, plans, emails, verification status and password hashes. Content never changes owner or collapses into `local`. |
| Hook configuration | Each tenant's stored document. |
| Vector snapshots | Historical generation stamps, not delivery acknowledgements. |
| Deployment configuration | Source Wrangler config, resource identities, migration filenames/hashes and Git revision when available. Secrets are not exported. |

Not restored: sessions, bearer tokens/grants, invites, verification links,
the scheduled backup's run log and alert state,
OAuth KV registrations/grants, coordinator SQLite/alarms, activity/auth logs,
builtin-sync leases/cursors, vector deliveries/backfill/cursors, or search
indexes. These are credentials, operational state or derived data, not content.
An old password still works because its hash is retained; session/token/OAuth
credentials do not. Rotate compromised passwords separately.
Asset drain cursors and vector acknowledgements are omitted, not the immutable
outputs or accepted/dismissed decisions. Processing and receipt lease tokens are
cleared and deadlines set to zero. See the exact [asset recovery table contract](asset-processing.md#recovery-table-contract).

`memory_review_settings`, `memory_review_groups`, `memory_review_events`,
`memory_review_budgets` and `memory_review_pending` are explicitly classified
recovery tables. Pending eligibility is derived but preserved exactly as review
progress: recovery clears only the fresh destination's trigger-generated queue
before loading the captured one. Reviewed memories are not queued again merely
because restoring their rows fired insertion triggers. Dismissed and no-op
fingerprints and immutable model drafts/human events are not reset.

Recovery sets both review execution flags off, clears review lock tokens/expiry
and resets the operational next-run time. An incomplete `running` group becomes
`failed`, keeps its evidence, attempt count, prior error and budget reservation,
and records that no provider request was resumed. A remaining retry is eligible
only after new explicit user authorization. Existing failed/terminal decisions
are retained unchanged. The source snapshot and source installation are not
mutated by these destination-only transformations.

The Haiku default does not rewrite saved model preferences during recovery.
Restored Haiku settings and legacy Workers AI/Gemini choices retain their exact
model ids with both execution flags off. A restored interrupted Haiku attempt
keeps its original model, attempt count and spent reservation, not a fresh
default-model request. New settings use Haiku explicitly; old choices never
inherit OpenRouter transmission permission from that application default.

Migration 0037 adds `todo_relations` and `todo_relation_fences`; both are explicit
authoritative entries in `scripts/recovery.mjs`. Relations are not reconstructed
from refs, prose or checklist steps. The fence serializer preserves `user_id`
and replaces its token with `recovery:` plus the SHA-256 of owner, NUL separator
and captured token. This deterministic invalidation lets capture's rehearsal and
restore produce identical rows. The fresh coordinator's next graph mutation
reserves its own new UUID before any guarded mutation; a captured admission token
cannot authorize it. These tokens are operation fences, not client credentials.

All R2 keys named by `objects` or any `skill_versions.files_json` are copied.
Unreferenced orphans and staged uploads are not copied. Files use hash-derived
local paths, not user filenames. The manifest is checked against the captured
D1 inventory; every original's size and SHA-256 is checked on capture, before
restore, and after destination upload. Missing or changed bytes fail capture.
Unknown database tables fail closed until their recovery policy is classified
in `scripts/recovery-policy.mjs`, the one list both capture paths read.
Capture also rehearses the row transformation, foreign keys and application
projection rebuild before publishing a complete snapshot.

## Scheduled backups in Cloudflare

`VALISE_BACKUP_CRON` names the cron that starts the run: `23 3 * * *` UTC in
production, and a minute derived from the installation suffix for a self-host.
The Workflow instance id is `backup-<UTC date>`, so a double fire is one run.
Each step retries three times with backoff and resumes where it stopped.

| Step | What it does |
| --- | --- |
| `plan` | Refuses unclassified tables and migrations that differ from the deployed code; records each table's `CREATE TABLE`, primary key and foreign keys. |
| `rows` | Reads each authoritative table in `rowid` pages of 500, children before parents, into `staging/`. |
| `assemble` | Writes `database.sql` and hashes it. A duplicate key or a child without its captured parent means a write tore the read: the run waits ten minutes and starts a fresh attempt, three in all. |
| `originals` | Copies each original named by `objects` or `skill_versions.files_json` to `originals/<sha256>`. R2 refuses bytes that do not match the D1 checksum. A missing or resized source fails the run. |
| `store`, `verify` | Copies the SQL and source config under `snapshots/<name>/`, then rehashes the SQL and checks every original's stored size and SHA-256. |
| `publish` | Writes `manifest.json`, the mark of a complete snapshot, and records the run complete in `backup_runs`. |
| `retention` | Keeps the newest `VALISE_BACKUP_KEEP` complete snapshots (default 30) and always the newest one, drops originals no kept snapshot names, and clears staging. |

The bucket is `valise-backups` in production and `<app>-<suffix>-backups` for a
self-host. Two Bucket Lock rules retain `snapshots/` and `originals/` for 30
days, so nothing, the Worker included, can delete a snapshot younger than that.
Retention leaves a locked object for a later run. An original is stored once per
content hash: an unchanged library adds only its SQL to each night's snapshot.

The snapshot is not one database transaction, as `d1 export` is. Reading
children first and checking keys catches inserts and deletes that land during
the read. It does not check invariants that are not foreign keys, such as an
asset admission's attempt count matching its processing row. `pull` runs the
full restore rehearsal before you rely on a snapshot.

Production needs the bucket and its rules before the deploy that binds them:

```sh
npx wrangler r2 bucket create valise-backups
npx wrangler r2 bucket lock add valise-backups valise-snapshots-30d snapshots/ --retention-days 30 --force
npx wrangler r2 bucket lock add valise-backups valise-originals-30d originals/ --retention-days 30 --force
npx wrangler r2 bucket lock list valise-backups
```

`scripts/first-deploy.sh` does the same for a self-host. Workflows and runs of
this length need the Workers Paid plan.

### Status and alerts

The admin workbench shows, on every tab, when the last complete snapshot
finished and how the latest run went. Every run is a row in `backup_runs`.

A failed run, or no complete snapshot for 36 hours, emails every address in
`VALISE_ADMIN_EMAILS` through the Resend sender (`EMAIL_API_KEY`). It sends one
email per incident. An incident lasts until the next complete snapshot, so a
week of failures sends one email. The check runs when a run fails, at minute 30
of every hour on the minute cron, and on the nightly and backup crons. Without
`EMAIL_API_KEY` or an admin address, the check logs `backup_alert_unsent` each
time and the workbench line is the only signal.

The snapshot shares the Cloudflare account with what it protects, a risk the
owner accepted on 2026-10-25. Losing the account loses both. If every cron
stops, so does the staleness check. For an off-account copy, run
[capture on an independent host](#capture-on-an-independent-host) as well.

### Restore from a scheduled snapshot

Take the snapshot name from the workbench or the alert. Pull it with any config
that binds the backups bucket as `BACKUPS` in the same account:

```sh
node scripts/backup.mjs pull snapshot-2026-10-26T03-23-00.000Z-… \
  /secure/restore/snapshot-… --config wrangler.jsonc --remote
```

`pull` downloads `manifest.json`, `database.sql`, `wrangler-source.jsonc` and
every original into the directory layout `capture` writes, then runs `verify`.
When this checkout's migrations match the manifest it also rehearses the
restore: row transformations, foreign keys and the search projection rebuild.
Otherwise it names the `codeRevision` to check out first. Then follow
[recover into a new installation](#recover-into-a-new-installation) with the
pulled directory.

## Capture on an independent host

Choose an encrypted, access-controlled backup filesystem outside the Worker,
D1 and source R2 bucket. A different directory in the source bucket is not an
independent backup. Keep a second offline/off-account copy under separate
credentials for account loss. Retention on this host is not object locking or
protection against compromised backup-host credentials.

```sh
node scripts/backup.mjs capture /secure/valise-backups \
  --config wrangler.jsonc --remote --keep 14
node scripts/backup.mjs status /secure/valise-backups --max-age-hours 26
node scripts/backup.mjs verify /secure/valise-backups/snapshot-…
```

Use Wrangler login or an account-scoped `CLOUDFLARE_API_TOKEN` with D1 Read and
Workers R2 Storage Read. Keep credentials in the scheduler's private environment,
never the crontab, arguments or backup manifest. Verify access on the selected
account before scheduling; capture fails rather than falling back to local data.
Recovery needs D1 Write and R2 Write on the new resources. These account-wide
credentials can read all tenants: only an installation operator may hold them.

The config explicitly selects top-level `DB`, `BUNDLES` and `OAUTH_KV`; `--env`
and previews are not supported. Use a separate reviewed config for another
installation. The config's migrations directory must resolve to this checkout's
`drizzle/`, and applied D1 migration names must match it exactly. `--local`
uses Wrangler's config-relative `.wrangler/state`, not a custom `VALISE_STATE`.
Capture does not promise a live runtime custom persistence directory.

A snapshot contains `database.sql`, `wrangler-source.jsonc`, `manifest.json`
and `files/<SHA-256 of R2 key>`. The source config is an audit record, never a
restore target. Do not put secret values in Wrangler vars: config is copied.
Files are private under a `077` CLI umask; protect an existing root yourself.
The SQL contains all tenants' private data and password hashes. Checksums detect
corruption, not a maliciously replaced manifest; accept only trusted artifacts.

Snapshots become visible by directory rename after validation. A failed run
never prunes completed backups. `--keep` retains 1–365 completed snapshots,
default 14; it counts successful captures, not calendar days. A root is bound to
one installation and local/remote target. A second process cannot take its lock.

## Schedule and monitor

Install [the cron example](../../scripts/backup.cron.example) on the chosen
independent host after replacing its paths and configuring private credentials.
It runs capture nightly and health checks hourly; route cron mail/nonzero exits
to the operator's existing alert channel. No GitHub Actions billing is needed.
The repository does not install cron, choose a storage provider or grant a new
host access to production. Installing the schedule and testing an alert are
operator activation steps, not evidence supplied by merging this change.

`status.json` records the latest attempt, last successful completion and complete
snapshot directory without content or credentials. `status` exits nonzero on a
failed/running attempt, held lock, missing snapshot or success older than the
configured maximum. Check it from an independent monitor too: a dead scheduler
cannot mail its own failure. `verify` performs the separate full checksum scan.
Wrangler diagnostics are deliberately not copied into status or cron output:
they can contain signed export URLs or SQL. Reproduce a failed command privately.

A killed process can leave `.backup-lock/owner.json` and a hidden partial
directory. Confirm its PID is no longer running before removing only that lock
and its named partial directory. Never remove a live process's lock. A backup
disk or provider failure leaves the last successful snapshot available.

D1's export is one database snapshot and can block requests while running.
R2 downloads follow that snapshot's immutable keys; concurrent deletion can
make the run fail, but cannot publish a complete backup with missing originals.
Coordinator display fields can lag their synchronous fence/log by seconds.
Recovery uses that D1 display snapshot; it does not reconstruct live DO state.
Nightly capture targets a 24-hour recovery point only while observed healthy;
it is not a guaranteed SLA. There is no measured production recovery-time SLA.
The runner buffers SQL and each original in host memory; this is a personal-
scale workflow, not a multi-terabyte streaming exporter.

## Recover into a new installation

1. Preserve the damaged installation and evidence. Do not import over it. Check
   the manifest's Git revision, use that release checkout and `npm ci`, and run
   `verify` on the chosen snapshot. Migration filenames and hashes must match
   exactly. Restore the matching release first; upgrade afterwards.
2. Provision a new Worker name, empty D1, empty R2 bucket and fresh OAuth KV
   using [independent setup](self-hosting.md). Do **not** initialize migrations
   or deploy/attach clients yet. Keep its config in a separate release checkout
   or use an absolute `migrations_dir` pointing to this release's `drizzle/`.
   The Worker must never have hosted coordinator state. The helper checks an
   uninitialized D1 and different source resource IDs; the operator must confirm
   the new R2 bucket and Worker/DO/KV namespaces have never been used. It cannot
   prove bucket emptiness or that an unused Worker name has no prior history.
3. Select `lexical` or `off` for recovery, leave `VALISE_VECTOR_NAMESPACE` empty
   and do not attach a vector index. A lexical search mode alone does not stop
   background delivery of configured vectors. Create a new admin password,
   `SESSION_SECRET` and `TOKEN_PEPPER` in the new Worker's runtime configuration.
   Restore other secrets from the password manager, not from this artifact.
   Reconfigure Google callback/allowlist for the new origin, preserving which
   email maps to `local`; changing the allowlist can grant owner access to a
   different account. Member password hashes, roles and verified identity remain.
4. Confirm the literal new Worker name, then restore the unpublished resources:

   ```sh
   node scripts/backup.mjs restore /secure/valise-backups/snapshot-… \
     --config wrangler.self-host.jsonc --remote --fresh my-recovered-valise
   ```

   The helper refuses the source Worker, D1, bucket or KV and the old vector
   namespace. It refuses an initialized D1, even an empty migrated one. It
   applies the matching migrations, copies/read-checks originals, inserts
   authoritative records and rebuilds `search_docs`/FTS using the application's
   actual projection code in a scratch SQLite database. It checks foreign keys
    before and after import. No deployed dev endpoint or inference is needed.
    Memory review execution remains disabled even if provider bindings or keys
    are configured; restoring a saved model choice is not provider consent.
5. On failure leave these resources unpublished. Each R2 object put and get
   is already tried four times with backoff; D1 statements are never retried,
   because the import is not idempotent. A partial restore is not
   resumable; investigate privately, then use a fresh set of resources. Do not
   delete records or rerun with safety checks removed to make the import pass.
6. Deploy the reviewed recovery config from the fork's `main` through Workers
   Builds, following the setup guide. Never hand-run a laptop deployment. Confirm
   Build/deployment success and smoke the new origin before routing clients.
   Sign in afresh and issue new bearer tokens/OAuth consents. Check one record
   and file per tenant, histories/links, tenant-isolated search and a new claim.
   Fence floors are advanced and restored claims have no holder and expiry zero;
    the fresh coordinator performs subsequent transitions above that floor.
    Inspect the recovered Memory inbox before enabling reviews. Every user must
    explicitly enable review transmission again and separately opt in to overnight
    drafts if wanted. Until then, restored private memories are not sent and no
    inference budget is spent by the inbox. Restoring provider secrets is an
    independent operator task, not proof that a provider is available or enabled.
7. Keep old clients disconnected. A historical snapshot cannot know tokens
   issued **after** it. Fresh credentials, KV and coordinator namespaces are
   mandatory isolation, not an assertion that snapshot counters exceed all
   tokens ever issued on the old deployment. Never reuse an old DO namespace.
8. Upgrade code/schema through the normal migration gate after the baseline
   restore is checked. For semantic search use a fresh vector deployment identity
   and index, then follow [vector rebuild](vector-rebuild.md). Empty delivery
   state does not establish ANN visibility; keep lexical mode until validated.

Asset semantic recovery has a separate, provider-free enqueue step:

```sh
node scripts/backup.mjs enqueue-assets /secure/valise-backups/snapshot-… \
  --config wrangler.self-host.jsonc --remote --fresh my-recovered-valise \
  --namespace recovered-assets-unique-base
```

Use the snapshot's exact release and the paused, index-free recovery config.
The command refuses the old deployment identity and source resources, checks
target migrations and fills the existing asset delivery ledger from restored
current immutable outputs. It does not run file extraction, metadata generation,
embeddings or index queries, and cannot select hybrid. Repeating enqueue is safe.
Afterwards explicitly attach a fresh index and enable the new identity through
reviewed config/Workers Builds, keep search lexical during bounded delivery, and
obtain fresh query/tenant/public-reranker proof before hybrid. See
[asset enqueue and delivery](asset-processing.md#provider-free-recovery-enqueue).

The D1 snapshot captures each graph transaction before or after its atomic batch;
it does not capture coordinator SQLite uncertainty markers. This is safe only in
the documented fresh destination: an old in-flight batch still targets the old
D1 binding, not the restored database. Token invalidation is additional fencing,
not permission to point old coordinators at a restored D1 or to clear their local
markers. Disconnect old clients before publishing the destination; retain the
old installation and evidence rather than treating a snapshot as current work.

Deleting an old coordinator's SQLite, clearing `uncertain_graph_write` or
`uncertain_reopens`, or rolling D1 back under that namespace is not recovery.
Any future in-place recovery or tenant move must first quiesce all writers,
drain/reconcile admitted and unknown-outcome requests and establish the fencing
boundary in ADR-0017. A primary read that sees no relation is not proof that an
earlier request cannot still commit. The restore helper deliberately offers no
override for this boundary. Ordinary object reconstruction retains SQLite and
the uncertainty markers; it is different from deleting durable storage.

For an entirely local drill, use the same command with `--local` and a config
in a new directory. Its `.wrangler/state` must not exist; reuse of even an empty
old local namespace is refused. No source or production resource is written.

## Executable restore exercise

```sh
node --test test/backup.test.mjs
npx vitest run --config vitest.mcp.config.ts test/mcp/recovery-coordinator.worker.test.ts test/mcp/backup-workflow.worker.test.ts
```

The Workflow drill seeds the same two-tenant fixture into a local source, runs
the scheduled backup's steps against that installation's local D1 and R2
through `getPlatformProxy`, and reruns them to check that a published run is a
no-op. It then pulls the snapshot with Wrangler, rehearses it, restores it into
a fresh local D1/R2 and makes the same row, FTS and checksum comparisons as the
export drill. The Worker test runs the real Workflows engine: a run publishes a
verified snapshot, a changed original fails the next run without touching the
earlier snapshot, and the alert goes out once per incident.

The Node drill creates separate config-relative local source and destination
installations. It runs real Wrangler migrations, filtered D1 export, R2 get/put,
capture and fresh restore; compares every classified authoritative table under the
documented transformations, full histories/links/attachments, original and
historical bundle checksums, and tenant-filtered FTS. The processing extension
adds two-owner output/decision history, spent admissions, safe interrupted-state
reset, lexical extracted retrieval, and idempotent fresh-namespace enqueue with
no inference and no restored acknowledgement. These extended checks must run at
the release head; their source does not establish a successful drill. Review fixtures include
human-edited proposals, accepted/dismissed/no-op decisions and fingerprints,
events, exact pending progress, budgets, opted-in settings and interrupted
attempts. Regression assertions require opt-ins off, old locks cleared, choices
and history retained, no source mutation and no inference/network call during
the in-process rebuild. It also calls the actual manual/nightly review entry
points against recovered settings with synthetic provider bindings present and
requires both paths to remain off without a provider call. Its separate fault tests
cover failed capture retaining the previous snapshot, retention after success,
staleness, held locks, source-resource refusal and checksum corruption. The
Worker test verifies the fresh coordinator rejects an old token, issues above
the restored floor and cannot adopt another tenant's ticket. The relation fixture
adds two children under a completed parent, multiple prerequisites across
projects, an unfinished restored claim and a separate manual blocker. Both the
scratch serializer test and real Wrangler drill assert all edge rows/timestamps,
manual reason and operation-token invalidation. The fresh-coordinator test checks
live prerequisite gating, no hierarchy cascades, retained update history and
manual reasons surviving prerequisite completion; only an explicit later claim
resolves the manual reason. Before asset integration, on 2026-10-24 the
relation-specific runtime selection passed 63/63 and
`node --test test/backup.test.mjs` passed 3/3, including the 20-table actual
Wrangler drill; ADR-0018 records those historical logs and full-gate boundary.
Those results do not cover the expanded asset recovery/enqueue drill. The tests
run inside `npm run verify`; local results are not a production restore or
evidence that an off-instance schedule is installed.

## Release-gate timing and cancellation

Workers Build `c08555f5-77fd-4a1b-aaca-3b13221cc16f` for PR186 failed because
the real Wrangler drill exceeded its 180-second Node test budget. The supplied
log records cancellation at 180,001.97ms, then the successful drill message
about 32 seconds later. The client-test stage finished with 28 passes and one
cancellation in 214,017.97ms. A late success message does not undo cancellation;
the build command correctly failed and production stayed on PR185.

The drill now batches read-only D1 assertions into SQL files with one JSON
result set per statement. It rejects missing or failed result sets, including
an empty result being lost. It still compares every classified table, the
parent/dependency graph and invalidated fences, both tenants' FTS, histories,
consent and budgets, plus table invariance after vector enqueue. Actual Wrangler D1 export,
fresh migrations/import, R2 copies/readbacks and original checksums remain.
This does not replace the real D1/R2 exercise with scratch SQLite.

One local baseline and one batched run on 2026-10-24 measured:

| Measurement | Serial baseline `32149aa` | Batched `646aad2` |
| --- | --- | --- |
| Real drill | 66.25s | 36.64s |
| Wrangler commands | 91 | 43 |
| D1 execute commands | 68 | 20 |
| Restored-state assertion commands | 46 | 3 |
| Restored-state assertion wall time | 26.15s | 1.73s |

The measured local drill improvement is 44.7%, not a remote build-time promise.
Both runs used the unchanged finite 180-second test budget. The test-only runner
propagates cancellation to its Wrangler process group, sends SIGTERM, escalates
to SIGKILL after two seconds if needed and awaits child exit before deleting its
owned local state. A regression uses a TERM-resistant parent and descendant to
check that neither continues writing after abort. No later command starts after
cancellation, so the timed-out body cannot keep executing and print a late pass.

`Recovery timing:` lines record stage wall time and actual Wrangler command
counts without SQL, content or credentials. `Build timing:` lines record every
sequential `verify:ci` stage and CSS/bundling stage, including failures; no stage
is removed or parallelized. `verify` remains `verify:ci` followed by the full UI
suite. The supplied failed-build excerpt establishes the 214-second client
stage, not an entire seven-minute breakdown. Local `npm ci` took 13 seconds in
this checkout; remote install time and the remaining remote stage costs require
their own log measurements. CSS compilation remains in its existing gates;
the local measured CSS compilations took tens of milliseconds, not the dominant delay.

Provider references: [D1 export/import](https://developers.cloudflare.com/d1/best-practices/import-export-data/),
[R2 Wrangler commands](https://developers.cloudflare.com/r2/reference/wrangler-commands/).
