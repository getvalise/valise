# Release tenant-local skill names

Hosted instance only, kept as a record. A database created after 2026-10-23
already has migration 0035 and needs none of this.

`0035_skill_names_per_user.sql` creates `UNIQUE(user_id, name)` before
dropping `skills_name_unique` and the redundant `skills_user_name` index.
It changes no skill IDs, contents, versions or ownership. The owner authorized
the manual production migration on 2026-10-23, after verification.

The proposed 0028/0029 skill-name migrations on earlier branches were not
applied in the production inventory read on 2026-10-23. Do not apply those
files alongside 0035. Applied migration filenames are immutable.

## Before release

Use the release checkout, current with `main`, with a recorded successful
`npm run verify` for its exact commit. Inspect the production binding and
account before any remote command: production is `valise`, database
`de471b00-3d61-4b3e-a91a-6ba60273e430`, in account
`cf073c8346e14a9226d271688bb10ee5`. Preview is a different database.

```sh
npx wrangler whoami
npx wrangler d1 migrations list DB --remote
npx wrangler d1 execute DB --remote --command "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'skills';"
```

Review every pending migration: `db:migrate:prod` applies all pending files,
not only 0035. Stop if the inventory differs from the reviewed release.
Retain the database's pre-migration recovery bookmark before applying.

## Apply and confirm

Merge the verified release PR. The deploy gate refuses pending by-hand
migrations and keeps the existing Worker serving. From the merged release
checkout, apply the authorized migrations:

```sh
npm run db:migrate:prod
npx wrangler d1 execute DB --remote --command "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'skills';"
```

Confirm `skills_user_name_unique` is unique on `(user_id, name)` and both
old indexes are absent. Confirm `d1_migrations` records 0035. Retry the
Workers Build if it stopped at the migration gate; do not deploy locally.
Record the successful build, deployed version and origin smoke result.

Two verified accounts must each publish the same skill name, retrieve their
own body and files, and fail to fetch the other's ID. Updating or deleting one
copy must leave the other copy and its versions unchanged. Check built-in
provisioning for existing members as well as new registrations.

## Recovery

An application rollback must retain tenant-local name lookup. Once two
accounts hold the same name, recreating the global unique index would fail;
do not treat that index as a rollback mechanism. Prefer a forward code fix.
Database recovery affects all tenants and needs a separate coordinated
decision; reconcile to-do fencing and external projections after a restore.
