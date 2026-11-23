# 0019. Scheduled backups run inside Cloudflare and write to a locked R2 bucket

Date: 2026-10-25
Status: accepted

## Context

PR173 shipped `scripts/backup.mjs`: an operator runs `capture` on a host with
Node, Wrangler and an account API token, and gets a snapshot directory that
`restore` loads into fresh resources. It shipped no schedule. The activation
to-do stayed blocked on the owner choosing a host, credentials and an alert
channel, and `docs/operations/backup-recovery.md` said "There is no Worker
backup cron or second bucket".

On 2026-10-25 the owner decided: "this should go out as source available for
people to self-host so cron on cloudflare". A NAS, a laptop or GitHub Actions
would give the hosted instance a schedule and give every self-hoster nothing.
The schedule has to come with the deploy.

`backup.mjs` cannot be that schedule. It needs Wrangler, `node:sqlite` and
esbuild, and it reads D1 with `d1 export`, which a Worker cannot call without an
account API token.

## Decision

A daily cron trigger starts a Cloudflare Workflow, `BackupWorkflow`, that writes
a snapshot to a dedicated R2 bucket through bindings. No API token is involved
and no data leaves the account.

### Schedule

`VALISE_BACKUP_CRON` names one of the Worker's crons. Production
uses `23 3 * * *`, off the hour and away from the 04:00 maintenance cron.
`scripts/self-host.mjs` derives the minute from the installation suffix, so
self-hosted installations do not all start at once. The Workflow instance id is
`backup-<UTC date>`, so a cron that fires twice starts one run.

### Steps

Every step is idempotent and its result is cached by the Workflow
engine, so a retried or resumed run continues where it stopped:

1. `plan` refuses unclassified tables and a D1 whose applied migrations differ
   from the bundled `drizzle/`, then records each table's `CREATE TABLE`,
   primary key and foreign keys.
2. `rows` reads each authoritative table in keyset pages of 500 by `rowid`,
   one step per page, into staging objects. Tables are read children first.
3. `assemble` writes `database.sql` by multipart upload, hashing as it goes. It
   refuses a duplicate primary key or a child row whose parent was not
   captured.
4. `originals` copies every R2 key named by `objects` or
   `skill_versions.files_json` into `originals/<sha256>`. The put carries the
   D1 checksum, so R2 refuses bytes that changed. An original already stored
   under that hash is not copied again.
5. `verify` rehashes `database.sql` and checks every original's stored size and
   SHA-256.
6. `publish` writes `manifest.json`. Its presence is what makes a snapshot
   complete; nothing writes it before verification passes.
7. `retention` keeps the newest `VALISE_BACKUP_KEEP` complete snapshots (30 by
   default), never deletes the newest complete one, and removes originals that
   no kept snapshot names.

The coverage list is `scripts/recovery-policy.mjs`. `backup.mjs`, its restore
rehearsal and the Workflow import the same `TABLES`, `OMITTED`, `checkTables`
and original-file inventory, so a new table fails both paths until it is
classified once.

### Consistency

`d1 export` is one database snapshot. Paged reads through a
binding are not, and production takes about 45,000 writes a day, so waiting for
a quiet moment is not a plan. Reading children before parents means a row
inserted mid-capture can be missing, but never a parent its captured children
need. A hard delete or a replace that moves a row can still tear a snapshot.
`assemble` detects both, and the run starts a fresh attempt after ten minutes,
three attempts in all. Invariants that are not foreign keys, such as an asset
admission's attempt count matching its processing row, are not checked in the
Worker. `backup.mjs pull` runs the full restore rehearsal on the operator's
machine, and the local drill runs it on every `verify`.

### Format

`snapshots/<name>/` holds `database.sql`, `wrangler-source.jsonc`
and `manifest.json` in the `valise-recovery` v1 format that `backup.mjs`
writes, with `target: "worker"`. Originals are stored once per content hash
under `originals/`, not once per snapshot: thirty daily copies of every
original would make backup storage thirty times the library. `backup.mjs pull`
downloads one snapshot into the exact directory layout `capture` produces,
`files/<sha256 of key>` included, verifies it and rehearses the restore. The
existing `restore` command then reads it unchanged. The source identity and
config are fixed into the bundle at build time from the config the build
deploys, so `restore` still refuses the source Worker, database, bucket and KV.

### Bucket and lock

The bucket is `valise-backups` for production and
`<app>-<suffix>-backups` for self-hosts. Two Bucket Lock rules, on `snapshots/`
and `originals/`, retain every object for 30 days. A Worker bug, an agent
holding a broad token or a compromised deploy cannot delete a snapshot younger
than that. Retention treats a refused delete as locked and leaves the object
for a later run. Staging objects are unlocked and deleted after publish.

### Alerts

`backup_runs` records each run; `backup_alerts` records the last
incident alerted. An incident is everything since the last complete snapshot:
a failed run, or no complete snapshot for 36 hours. The first failure or
staleness in an incident emails `VALISE_ADMIN_EMAILS` through the existing
Resend sender. Later failures in the same incident do not email again. A new
complete snapshot ends the incident. The check runs when a run fails, at 30
minutes past every hour on the minute cron, and on the nightly and backup
crons. The admin workbench shows the last complete snapshot and the latest
run's state on every tab. Both tables are operational state and are not
restored.

## Consequences

Every installation deployed from `main` backs itself up daily with no host,
token or scheduler to set up. A self-hoster gets the bucket, lock rules and cron
from `scripts/first-deploy.sh`.

The owner accepted on 2026-10-25 that snapshot and source share a Cloudflare
account. Account suspension, compromise of the account itself or a billing stop
takes both. If every cron trigger stops, the staleness alert stops with it,
because the check runs on those crons. `backup.mjs capture` to an off-account
host remains the answer to both and is unchanged.

A snapshot is complete when its checksums verify and its foreign keys close, not
when a restore has been rehearsed. The rehearsal happens on `pull`.

Workflows and long cron runs need the Workers Paid plan. On the free plan's
10 ms CPU limit the first page that does real work fails, and the failure alert
says so.

The bucket and its lock rules must exist before the deploy that binds them, or
the deploy fails. Production's were created by hand on 2026-10-25; self-hosts
get theirs from the setup script.

`backup_runs` and `backup_alerts` are omitted tables. D1 Time Travel still
covers 30 days of point-in-time database restore; this adds originals and a
copy outside D1.
