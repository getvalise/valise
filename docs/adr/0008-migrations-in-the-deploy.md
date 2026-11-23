# 0008. The deploy applies additive migrations; a drop still waits for a person

Date: 2026-10-17
Status: accepted

## Context

V1-20 merged as `9b58352` and Workers Builds deployed it. The code it shipped
reads `todos.refs_json`, `todos.source_agent`, `todos.source_client`, and
`todos.source_session`; the production database was still on `0006`, because
`drizzle/0007_cloudy_sentry.sql` had never been applied. Every `create_todo`
from every client failed on a D1 error for three hours, until the migration was
applied by hand at 15:24 UTC.

The rule that was supposed to prevent this is a sentence in `AGENTS.md`:
`npm run db:migrate:prod` is run by a person before the PR that needs it
merges. V1-14 carried it as a live lane — "Lane 3. `npm run db:migrate:prod`
before merge, because the column is additive and the deploy does not run
migrations". V1-20 added four columns and wrote no such lane. Nothing noticed,
because nothing was looking: `verify` runs against a local database, the
Playwright suite runs against `wrangler dev`, and `scripts/smoke.sh` checks
health, the stylesheet, and that `/mcp` answers 401 — all of which pass
perfectly against a production database missing a column. The first detector in
the chain was a person trying to file a to-do.

A rule that depends on an author remembering to write the checkbox that
reminds them has one failure mode and it is the common one.

The second problem is worse, because it means the old rule was not merely
fragile but wrong for the case in front of it. `0007` renames `created_by` to
`source_agent`. Running it before the merge, as the rule says, breaks the
deployed code immediately — the Worker then in production selects
`created_by`, and the column is gone. Running it after the merge breaks the new
code until it lands. For a rename there is no ordering of one migration and one
deploy that keeps production working, so "a person runs it before merge" is
correct advice only for additive migrations, which are exactly the ones that do
not need a person.

Cloudflare's own token makes the split visible. The API token Workers Builds
creates for itself carries Workers Scripts, KV, R2, and Workers Routes, and no
D1 at all, so until D1 (edit) is added to it under My Profile > API Tokens the
build *cannot* touch the schema. That is a prerequisite, not an argument:
`wrangler d1 migrations apply` skips its confirmation prompt in a
non-interactive environment by design, captures a backup before it runs, and
rolls a failed migration back to the last good one.

## Decision

**The deploy applies what is pending, before it deploys.** Workers Builds'
deploy command is `./scripts/deploy.sh`: migrations, then `wrangler deploy`,
then `scripts/smoke.sh`. Schema first, because that is the order that works —
a column the running Worker does not read costs it nothing, and the code that
reads it arrives seconds later and finds it there. If the deploy then fails,
production is serving old code against a superset of its schema, which is a
state it is already happy in.

**Additive only, by a default-deny classifier.** `scripts/migrations.mjs`
reads every statement in `drizzle/` and allows four heads: `CREATE TABLE`,
`CREATE INDEX`, `CREATE TRIGGER` and the other `CREATE` forms, `ALTER TABLE …
ADD`, and `INSERT INTO`. Everything else needs a person, including statement
shapes the list does not recognise, so the unforeseen case fails closed instead
of running itself against production. Statements are split on drizzle's own
`--> statement-breakpoint` rather than on semicolons, which is the only split
that survives a trigger body.

**A non-additive migration declares itself in the file.**

```sql
-- valise:by-hand drops skills.legacy_slug, superseded by V1-19's disabled_at
```

The marker does two jobs. `npm run db:audit` fails `verify` when a statement
drops, renames, or rewrites without one, so the decision is forced in review
rather than at deploy time; and the deploy refuses to apply a marked migration
at all, failing the build before `wrangler deploy` runs. Production then stays
on the code it already serves — stale rather than broken, the same property
`verify:ci`-in-the-build already buys — until a person runs
`npm run db:migrate:prod`.

**A drop is two merges.** Add the new column in one PR, ship the code that
stops needing the old one, then drop it in a later `by-hand` migration once
nothing reads it. That is the expand-and-contract shape, and it is what the
original "dropping a column stays a decision" rule was reaching for. `0007`
carries the marker retroactively, with the date it was applied by hand; wrangler
tracks migrations by filename, so a comment added after the fact changes
nothing it has already run.

**`npm run deploy` is gone.** It built and deployed from a laptop, which
`AGENTS.md` already forbade, and it would now be the one path that ships code
without its schema.

## Consequences

Gained: a merge carries its schema with it, and the window where production
runs code against a database that cannot serve it closes. The hour it cost
this time was the cheap version; the expensive version is the same mistake on a
Friday.

Given up: the build can now write to the production schema, which it could not
before. The blast radius is bounded by the classifier to statements that add,
and by D1's thirty-day time travel for anything that gets through it.

Given up, smaller: one more place to keep honest. The classifier reads SQL with
regular expressions, and a statement it misreads as additive is applied without
being asked. `npm run db:audit` prints its classification of every file, so the
reading is visible on every PR rather than only at deploy time.

Inherited: a prerequisite that lives in a dashboard. Without D1 (edit) on the
Workers Builds token the deploy fails at the migration step, loudly, before it
ships anything — the failure mode is a red build, not a silent skip.

## Amendment — 2026-10-20: GitHub verification paused

The owner requested disabling GitHub Actions while billing is unavailable.
The `CI` workflow is disabled through GitHub's workflow API; its YAML remains
in the repository for reversal. Existing failed checks are not successful
verification and remain in the history.

Local `npm run verify` on the exact PR head, current with `main`, is the
pre-merge gate, with its result recorded in the PR. Cloudflare Workers Builds
still runs `npm run verify:ci && npm run build`, then `./scripts/deploy.sh`.
The additive-migration classifier, migration-before-code ordering and smoke
check are unchanged. Confirm the build and deployed application after merge;
GitHub Actions is not part of that deployment path.

## Amendment — 2026-11-03: only the branch head deploys

Workers Builds runs one build per push, concurrently, and the last to finish
deploys. On 2026-11-01 build `2089197d` for `cbc05cf` (#277) finished at
17:55:54Z, four minutes after build `e3f1c27d` for `6a4ef19` (#278), and
production served the older commit until the next merge. `smoke.sh` passed
throughout; it checks health, not the commit.

`deploy.sh` now runs `scripts/deploy-head.mjs check` before migrations. The
build commit is `WORKERS_CI_COMMIT_SHA`, a Workers Builds default variable
(developers.cloudflare.com/workers/ci-cd/builds/configuration/). A build
whose commit is not `git ls-remote origin refs/heads/<branch>` skips
migrations and the deploy and exits 0. Skipping migrations costs nothing: the
newer commit carries every migration the older one does, and its build applies
them before its own code.

Every deploy passes `--message <branch>@<sha>`, so the live version names its
commit and `wrangler versions view` answers what production serves.

The owner decided three points on 2026-11-03:

- A build that cannot read the branch head is an error. `deploy-head.mjs`
  exits 1 when `ls-remote` gives no sha or `WORKERS_CI_COMMIT_SHA` is not
  one, and `deploy.sh` stops under `set -e` with nothing migrated or deployed.
  There is no fallback to the live version's commit. If the build clone cannot
  reach the private repository, every production build fails until it can;
  the first build after this amendment merges shows which case holds.
- A superseded build exits 0 and prints `deploy: superseded, nothing
  deployed`. The skip is correct, so the build shows green.
- A build that passes the check and is overtaken by a newer merge's build in
  the seconds before `wrangler deploy` finishes still wins. Builds take
  minutes, so the race is accepted rather than closed.

Outside a Workers Build, with no `WORKERS_CI_COMMIT_SHA`, there is no build
commit to compare, and a self-host or staging deploy run by hand proceeds as
before.
