# Independent Cloudflare setup

Use your own fork and Cloudflare account. Node 22+, R2 enabled on the account,
and a registered `workers.dev` subdomain are required. Cloudflare may require
billing details to enable R2. Workers, D1, KV and R2 usage have their own plan
limits and charges; lexical search avoids inference charges, not hosting costs.
The daily backup runs as a Cloudflare Workflow and needs the Workers Paid plan;
on the free plan it fails and the workbench says so.

This setup provisions a new installation. For recovery, follow
[backup and recovery](backup-recovery.md) before initializing migrations or
deploying; do not point fresh setup at an existing database or reuse a production
vector namespace. [Library export/import](library-export.md) is per-user portability.

## Prepare resources

```sh
npm ci
npx wrangler login
npx wrangler whoami
scripts/first-deploy.sh
```

Copy the account ID from `whoami` or the Cloudflare dashboard. The script asks
for that ID, an app name and a search backend. It retrieves the account's actual
Workers subdomain; this is not necessarily the account username. If the account
has none, register one under Workers & Pages in the dashboard, then retry.
Choose an unused Worker app name, 3–40 lowercase letters, digits or hyphens.

For a scoped API token instead of Wrangler OAuth, set `CLOUDFLARE_API_TOKEN`
privately in your shell. Never paste it into chat or commit it. Setup needs
Workers Scripts Read, D1 Write, Workers R2 Storage Write and Workers KV Storage
Write on the selected account. The corresponding write permissions include
resource discovery. It does not need zone/DNS permissions. Wrangler OAuth has
broader scopes; use an account-scoped token when that matters.

Before any create, setup shows the selected account, origin and resource names
and asks for literal `setup` confirmation. It writes `.valise-setup.json` and
creates or reuses exactly four installation-specific resources:

- D1: `<app>-<installation suffix>-data`
- R2: `<app>-<installation suffix>-bundles`
- KV: `<app>-<installation suffix>-oauth`
- R2: `<app>-<installation suffix>-backups`, with Bucket Lock rules that retain
  `snapshots/` and `originals/` for 30 days

Rerunning setup adds the backups bucket and its lock rules to an installation
made before they existed, and keeps any lock rules you added yourself.

The generated `wrangler.self-host.jsonc` sets:

```text
APP_ORIGIN=https://<app>.<actual-workers-subdomain>.workers.dev
MCP_RESOURCE_URL=https://<app>.<actual-workers-subdomain>.workers.dev/mcp
```

The hosted `wrangler.jsonc` is untouched. No preview bindings, custom domains,
Vectorize index or production vector namespace is copied. The compatibility
date stays at the application's tested date, not the setup date.

Setup asks whether to run background jobs every minute, `on` by default. `on`
adds the minute cron (`* * * * *` in `workers/app.ts`) and binds Workers AI,
which file processing and bookmark fetching run on. That inference is billed to
your account; bookmark fetching stays inside `VALISE_SOURCE_DAILY_USD` per
owner per day. The answer is saved as
`background` in `.valise-setup.json`; change it there and rerun setup to
regenerate the config. A state file from before this setting counts as `off`.
With `off`, these jobs do not run:

- "Process" on a Library file never finishes
- bookmarks are not fetched or enriched
- a built-in skill that changes in a deploy does not reach existing accounts;
  a new account still gets the current version
- the backup health check runs twice a day, with the two daily crons, rather
  than every hour

Capture, search, skills, memories and to-dos do not depend on it.

Backups are on by default. The config binds the backups bucket as `BACKUPS`,
declares the `<app>-backup` Workflow, and adds a daily cron at 03:MM UTC, where
MM comes from the installation suffix. `VALISE_BACKUP_CRON` names that cron and
`VALISE_BACKUP_KEEP` (30) how many complete snapshots retention keeps. Failure
emails need `EMAIL_API_KEY` and `VALISE_ADMIN_EMAILS`; without them the
workbench shows the backup status and nothing is sent. See
[scheduled backups](backup-recovery.md#scheduled-backups-in-cloudflare).

Keep `.valise-setup.json` to resume after a failure. Rerun the same command;
even a create whose response was lost is found by its saved name. Do not run
two copies for the same installation. A crash can leave `.valise-setup.json.lock`;
remove that one lock only after confirming its PID is no longer running.
A changed account/subdomain, duplicate resource names, or a missing/replaced
saved resource stops setup. Do not delete the state to work around that check.
Review the existing installation instead. The script never silently replaces
a lost database with an empty one, rotates a secret or overwrites edited output.

## Choose search and configure secrets

| `VALISE_RERANK` | Required inference secret/binding | Where query and candidate titles/bodies go | Inference cost |
| --- | --- | --- | --- |
| `lexical` | None | D1 only; no inference request | None |
| `clef` | Workers AI `AI` binding | Cloudflare Workers AI, at most 50 lexical candidates | Billed by Workers AI usage |
| `jev` | `TYPESAFE_API_KEY` | TypeSafe's `api.typesafe.ai/v1/systemone`, at most 50 lexical candidates | Billed by TypeSafe usage |

The query and current candidate text are sent on each reranked search, not the
whole case and not R2 originals. Clef stays with Cloudflare; standard Workers AI
inference inputs/outputs are not retained or used for training under its
[data usage policy](https://developers.cloudflare.com/workers-ai/platform/data-usage/).
TypeSafe states Jev is not trained on customer requests and describes enterprise
zero retention in its [model policy](https://docs.typesafe.ai/models). Review
current terms before sending private data. Provider failures return lexical
results; reranking cannot retrieve a document absent from the lexical candidates.

ADR-0013's October 2026 corpus measured about $1.86/1,000 searches for Clef
and $0.30/1,000 for Jev. These are measured input sizes at then-listed prices,
not a quote or a budget cap. See current [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
and TypeSafe pricing. Generated config defaults to `lexical`; an existing
TypeSafe secret alone cannot turn it on. `fts` is an old alias for Clef, not
the lexical baseline. Production's `hybrid` mode is a separate, provisioned
configuration and is not enabled by this installer.

In the dashboard, create the new Worker named exactly as your app, without a
Git integration initially, and add its runtime secrets under Settings:

| Secret | Value |
| --- | --- |
| `VALISE_ADMIN_PASSWORD` | A unique password, at least 16 characters |
| `SESSION_SECRET` | A fresh random secret |
| `TOKEN_PEPPER` | A different fresh random secret; preserve it across deploys |
| `TYPESAFE_API_KEY` | Your TypeSafe key, only for `jev` |

Generate each random secret with `openssl rand -base64 32` in a private terminal
and transfer it to the dashboard or your password manager, not a tracked file.
On retry, preserve existing values. Changing the pepper invalidates stored
bearer token hashes; changing the session secret signs browsers out.

Google sign-in is disabled (`GOOGLE_CLIENT_ID=none`). The administrator password
works without Google or an email provider. For Google later, remove that var,
add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `VALISE_ADMIN_EMAILS` as required
secrets in the self-host config, set their runtime values, and use
`<your APP_ORIGIN>/auth/google/callback` in Google's allowed redirects.
`VALISE_ADMIN_EMAILS` names the admins: the first to sign in reaches the owner
account, and each other address gets its own account with the admin pages
(README, "Sign in with Google").
Member email/password signup and backup alerts need email delivery through
Resend: an `EMAIL_API_KEY` secret and an `EMAIL_FROM` var such as
`Valise <noreply@your-domain.example>`, on a domain verified in your Resend
account. Unset, `EMAIL_FROM` falls back to the hosted instance's
`noreply@valise.run`, which your key cannot send from. Owner-only use needs
neither Google nor email.

Members get a 2 MiB file allowance per bookmark and the owner 25 MiB
(`app/concepts/attachment-limits.ts`). Set the `VALISE_MEMBER_ALLOWANCE` var
to `owner` to give every member the owner's allowance. Admins always get the
owner's.

Connections offers the upstream iPhone Capture Shortcut, which works with any
install because the capture URL it asks for names the origin. To offer your
own copy instead, set the `IOS_SHORTCUT_LINK` var to its iCloud link
(`docs/operations/ios-capture.md`); `none` hides the button.

A migration the deploy refuses to apply alone (`-- valise:by-hand`, ADR-0008)
is applied with `VALISE_CONFIG=wrangler.self-host.jsonc npm run
db:migrate:prod`. Without `VALISE_CONFIG` that command targets the hosted
database in `wrangler.jsonc`.

## Initialize and deploy from main

The generated config is initially ignored. In your fork only, review it and
track it explicitly; keep `.valise-setup.json` local. Do not replace the hosted
config in this upstream repository.

```sh
git add -f wrangler.self-host.jsonc
```

`wrangler.jsonc` remains the development/type-generation reference. Set
`VALISE_CONFIG=wrangler.self-host.jsonc` for the application build and remote
migration gate; this selects the isolated bindings before Vite discovers them.
For local console use with this config, its required secrets must also exist in
`.dev.vars`. Do not enable remote bindings for local tests.

Initialize only the newly provisioned, empty D1, after reviewing the migration
files (including declared by-hand historical migrations):

```sh
npx wrangler d1 migrations apply DB --remote --config wrangler.self-host.jsonc
```

This is the operator's explicit fresh-schema step, not an automatic bypass of
the existing-production migration gate. Rerunning applies only pending files;
stop and follow ADR-0008 if the database is already serving a deployed app.

Run `npm run verify` before pushing your fork's setup commit. In Workers & Pages,
connect the new Worker's build to your fork's `main`, disable automatic deploys
from other branches, and configure:

```text
Build:  npm run verify:ci && VALISE_CONFIG=wrangler.self-host.jsonc npm run build
Deploy: VALISE_CONFIG=wrangler.self-host.jsonc VALISE_ORIGIN=https://<app>.<subdomain>.workers.dev ./scripts/deploy.sh
```

The Workers Builds token needs the normal Worker deploy permissions plus D1
Write for the migration gate, and access to the selected account's resources.
Clef additionally needs Workers AI access. Runtime secrets belong to the Worker,
not merely the build environment. The Vite build writes Wrangler's deployment
redirect; deployment uses that built config, not the hosted source bindings.
Before touching D1, the self-host deploy checks that the selected config,
compiled Worker and smoke origin name the same account, app, URLs and storage
bindings. A stale build for another installation stops instead of migrating one
database and deploying another Worker.
The deploy script still refuses a non-`main` production branch and stops on
pending by-hand migrations. Never run `wrangler deploy` from your laptop.

Confirm the Workers Build and deployment succeeded, then check the actual URL:

```sh
scripts/smoke.sh https://<app>.<subdomain>.workers.dev
```

The smoke check validates health, the stylesheet, MCP's 401 challenge and OAuth
resource metadata naming your new origin. Sign in at `/login`, connect a client
to the printed MCP URL, save a test memory and fetch it from another client.
For Clef/Jev, inspect the search call's rerank metadata/log row: the backend must
match and `reranked` must be true, not a silent lexical fallback. Contract tests
do not establish live provider access, paid billing or second-person usability.
