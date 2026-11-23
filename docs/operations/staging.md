# Staging

Staging is a second Valise installation, restored from a production backup. It
exists so deployed acceptance runs, memory review (J2) and sharing under load
(J6), can write, enable reviews and spend inference without touching
production. It is also the first remote proof of the J7 fresh-deployment
restore.

Origin: <https://staging.valise.run>

## It holds real data

Staging holds a copy of every tenant's production records and originals: memories,
to-dos, sources, attachments, users and password hashes. Treat it as private as
production.

- Sign-in is the staging admin password, which signs in as the owner and
  shows the owner's restored data. A restored member's production password
  hash would also work here, but on 2026-10-29 no staging account had one: the
  only member, member A (a synthetic test account), joined with Google and had no password at
  capture. So no member can sign in to staging today.
- Google sign-in is off (`GOOGLE_CLIENT_ID=none`). Its callback is registered
  for production only.
- `EMAIL_API_KEY` is not set, so staging sends no verification or invite email.
  `/join` refuses signups without it.
- Per-version preview URLs are off (`preview_urls: false`), so the data is
  served on one hostname only.
- Sessions, bearer tokens, OAuth grants, invites and to-do leases are not
  restored. Every client signs in and consents again.

Cloudflare Access is not in front of staging yet. See
[owner steps](#owner-steps).

## Resources

All on account `cf073c8346e14a9226d271688bb10ee5`. None is shared with
production or with the `previews` block in `wrangler.jsonc`.

| Binding | Staging | Production |
| --- | --- | --- |
| Worker | `valise-staging` | `valise` |
| `DB` (D1) | `valise-staging`, `f36b4047-88bc-4504-879d-484a50e7d1f7` | `valise` |
| `BUNDLES` (R2) | `valise-staging-bundles` | `valise-bundles` |
| `OAUTH_KV` | `valise-staging-oauth`, `7643d9f18aed496a9308ad2bfbe23edd` | `valise-oauth` |
| `TODO_COORDINATOR` | the `valise-staging` Worker's own namespace | `valise`'s |
| `MCP_LIMITER` | namespace `26101503` | `26101501` |
| `VECTOR_INDEX` | none | `valise-memories-v1` |
| `VALISE_RERANK` | `lexical` | `hybrid` |

The config is `wrangler.staging.jsonc`, a whole file rather than an `env`
block in `wrangler.jsonc`. `scripts/backup.mjs restore` reads top-level
bindings only and refuses `--env`. The build selects it with
`VALISE_CONFIG=wrangler.staging.jsonc`, the same mechanism
[self-hosting](self-hosting.md) uses. `wrangler.jsonc` is unchanged.

Search is lexical because restore refuses a vector namespace and inference
reranking. For hybrid search, create a new index, set a staging-only
`VALISE_VECTOR_NAMESPACE`, and follow [vector rebuild](vector-rebuild.md).
Never reuse `valise-prod-v1` or `valise-memories-v1`.

Secrets on the staging Worker: `VALISE_ADMIN_PASSWORD`, `SESSION_SECRET` and
`TOKEN_PEPPER`, each generated fresh for staging. None is copied from
production. `OPENROUTER_API_KEY` was added on 2026-10-25 at 20:12Z (owner
step 2); reviews stay off until someone enables them in the staging console.

## What staging can host

Checked read-only on 2026-10-29 against the staging D1 and Worker. Staging
runs the code deployed from a laptop on 2026-10-25, with migrations through
`0040`; `main` is at `0046`. No build has deployed since. It holds the owner
(`local`) with every restored record, and one member, member A (a synthetic test account),
verified, created 2026-10-23 19:32Z, with no password and no to-dos or
memories of its own. An earlier note that member A was missing from staging
was wrong. Zero invites, zero bearer tokens, one browser session.

Three facts decide the rest. Staging serves a copy of the owner's real data to
anyone holding the staging admin password. Its rate limiter, D1, R2, KV and
coordinator are its own, so load there does not touch production. And it has
no way to admit a new member: Google is off and `/join` refuses without
`EMAIL_API_KEY`.

| Check | On staging | What it takes |
| --- | --- | --- |
| J6 bounded load step | Yes | Two member tenants, then `JOURNEY_ORIGIN=https://staging.valise.run JOURNEY_LOAD=1`. The 160 noisy and 20 quiet calls hit staging's own limiter namespace `26101503` and its own D1. |
| Tenant A, member A | Yes, after a deploy or a refresh | Either ship the reset link to staging and have the staging admin issue one on `/people` for a staging-only password, or refresh, which brings production's password hash. Production is untouched either way. |
| A second synthetic tenant, B | Not today | Needs a way in: `EMAIL_API_KEY` on staging plus an invite and a synthetic mailbox, or Google sign-in on staging. Both are owner decisions. |
| Guessed-id and permission checks, member against member | Yes | Same as J6 steps 2 and 3. Neither tenant is the owner, so a pass reads nothing of the owner's. |
| A member probing the owner's ids | Yes, with care | The owner's restored rows are real. A pass proves isolation; a failure leaks real data to a synthetic tenant, though only on staging and only to whoever holds its credentials. Record failures without bodies. |
| Failure checks: revoked token, rate limit, wrong password, spent reset link | Yes | No real credential is involved. |
| Anything signed in as the staging admin | No, for agents | That session is the owner's real data. Journeys use member credentials only, and the staging admin password stays with the owner. |

What would expose the owner's real data:

- Handing an agent the staging admin password, or consenting an MCP client as
  the owner on staging.
- A local capture under `~/valise-backups`. It holds every tenant's rows and
  password hashes. The one from 2026-10-25 is still there.
- Deploying current `main` to staging as it is. Bookmark enrichment
  (ADR-0015) runs each minute on the `AI` binding, so it would fetch the
  owner's restored bookmark URLs from staging and spend up to the daily budget
  of $0.25 on Workers AI. Set `VALISE_SOURCE_DAILY_USD` to `0` in
  `wrangler.staging.jsonc` before that deploy.
- Turning on reviews in the staging console, now that `OPENROUTER_API_KEY` is
  set. That sends the owner's memories to OpenRouter and spends money.

A refresh from the latest backup is not needed for J6: member A is already on
staging. If the owner wants current data, the [refresh](#refresh-data-from-production)
below still applies, with one cheaper start. `node scripts/backup.mjs pull`
takes the newest scheduled snapshot from the `valise-backups` bucket, so step
1 reads no production D1 or R2. On 2026-10-25, capture at 15:21Z to the first
staging deploy at 15:48Z took under half an hour, including two restore
retries after R2 500s. The bucket delete waits a day for its lifecycle rule
unless the new bucket takes a different name. A refresh also carries
production's password hashes, so member A's current production password
would then work on staging too, and tenant A would need no reset there.

A custom domain `staging.app.valise.run` adds nothing J6 needs. MCP, OAuth,
tokens and password sign-in already work on the `workers.dev` origin. The
domain would be the cleaner way to turn on Google sign-in for staging, because
its callback would sit under `valise.run`, beside production's. But Google
on staging lets the owner's allowlisted Google account sign in to the real
data copy. The name would also appear in certificate transparency logs, and
it is same-site with `app.valise.run`, so `SameSite=Lax` no longer separates
the two; the same-origin check on every form still does. Add it only when
Google sign-in on staging is wanted.

## Deploy

The first deploys on 2026-10-25 ran from a laptop:

```sh
VALISE_CONFIG=wrangler.staging.jsonc npm run build
npx wrangler deploy        # follows the build's redirect to build/server/wrangler.json
./scripts/smoke.sh https://staging.valise.run
```

That is acceptable for staging only. Never deploy production this way.

The intended path is Workers Builds on the `valise-staging` Worker, watching a
`staging` branch. `scripts/deploy.sh` deploys `wrangler.staging.jsonc` only
from `staging`, and `wrangler.jsonc` only from `main`. Any other pairing exits
before touching D1. To ship a branch to staging:

```sh
git push --force-with-lease origin <commit>:refs/heads/staging
```

A staging build applies pending additive migrations to the staging D1, the same
gate production uses (ADR-0008).

## Refresh data from production

A restore needs an uninitialized D1, and the restored Worker must never have
hosted coordinator state. A refresh is therefore a teardown and a fresh
restore, not an import over the old data.

1. Capture production. This only reads production D1 and R2.

   ```sh
   node scripts/backup.mjs capture ~/valise-backups --config wrangler.jsonc --remote --keep 14
   node scripts/backup.mjs verify ~/valise-backups/snapshot-…
   ```

2. Run the [teardown](#teardown), then recreate the D1, bucket and KV namespace
   with the names above. Put the new D1 and KV IDs in `wrangler.staging.jsonc`.
3. Restore into the new resources, from a checkout at the snapshot's
   `codeRevision`:

   ```sh
   node scripts/backup.mjs restore ~/valise-backups/snapshot-… \
     --config wrangler.staging.jsonc --remote --fresh valise-staging
   ```

   This applies migrations, copies and checksums every original, imports the
   rows and rebuilds `search_docs`. `scripts/reindex.mjs` is not needed and
   does not apply: it calls a local dev server, not a remote D1.
4. Set the three secrets again with fresh values, deploy and smoke.
5. Compare row counts per table against the snapshot's `database.sql`, and
   confirm `memory_review_settings` has `enabled = 0` and `overnight = 0`.

Each R2 object put and get in step 3 is tried up to four times, 0.5 s, 1 s
and 2 s apart, because R2 answers an occasional 500 (code 10001). On
2026-10-25, before that retry existed, two restores failed this way before a
clean run. An error that survives four attempts, or any D1 failure, still
fails the restore, and a partial restore is not resumable: delete the migrated
D1, create a new one and run step 3 again.

## Restore of 2026-10-25

Captured from production at 2026-10-25T15:21Z, code `ed86fe0`, 39 migrations.
All 30 authoritative tables match the capture's row counts. Examples: users 2,
skills 35, skill_versions 39, memories 116, todos 260, todo_updates 1264,
todo_comments 244, todo_relations 41, sources 895, source_revisions 895, objects
17, assets 14. 96 of 96 originals (32,455,614 bytes) were put and read back
with matching size and SHA-256. `search_docs` was rebuilt to 1320 rows. Sessions,
bearer tokens, grants, invites and leased to-dos are all 0. Reviews and
overnight are off.

## Teardown

```sh
npx wrangler delete --config wrangler.staging.jsonc
npx wrangler d1 delete valise-staging
npx wrangler kv namespace delete --namespace-id 7643d9f18aed496a9308ad2bfbe23edd
npx wrangler r2 bucket lifecycle add valise-staging-bundles expire-all "" --expire-days 1
# a day later, once the bucket is empty:
npx wrangler r2 bucket delete valise-staging-bundles
```

Deleting the Worker deletes its Durable Object storage. Delete the local
snapshot under `~/valise-backups` too if staging was its only use: it holds
every tenant's data and password hashes.

## Owner steps

1. Connect Workers Builds. Workers & Pages, `valise-staging`, Settings, Build,
   Connect to `getvalise/valise`. Set the production branch to `staging` and
   turn off builds for other branches. Build command:
   `npm run verify:ci && VALISE_CONFIG=wrangler.staging.jsonc npm run build`.
   Deploy command:
   `VALISE_CONFIG=wrangler.staging.jsonc VALISE_ORIGIN=https://staging.valise.run ./scripts/deploy.sh`.
   The build token needs D1 Edit, as production's does.
   The staging Worker is served on the custom domain `staging.valise.run`,
   declared as a custom domain route in `wrangler.staging.jsonc`.
2. For J2, set `OPENROUTER_API_KEY` on staging:
   `npx wrangler secret put OPENROUTER_API_KEY --config wrangler.staging.jsonc`.
   Then enable reviews in the staging console; restore leaves them off.
3. Optionally, put staging behind Cloudflare Access: Workers & Pages,
   `valise-staging`, Settings, Domains & Routes, `workers.dev`, Enable
   Cloudflare Access. Access also intercepts `/mcp` and the OAuth endpoints, so
   MCP clients then need an Access service token, and `scripts/smoke.sh` fails
   its 401 check. The admin password and the absent email key already keep
   strangers out; Access adds a second gate in front of the restored member
   password.
