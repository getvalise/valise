#!/usr/bin/env bash
# Restore a Valise database from a filtered D1 dump.
# Legacy SQL-only path: does not restore original bytes or invalidate live
# leases/credentials. For supported fresh-install recovery, use
# scripts/backup.mjs restore and docs/operations/backup-recovery.md instead.
#
# The projection and the FTS index are derived and disposable, so backups name
# the authoritative tables only (D1 cannot export virtual tables at all). That
# makes restore two steps plus a rebuild:
#
#   1. schema from the migrations, which is where the derived objects live
#   2. rows from the dump, INSERTs only
#   3. `node scripts/reindex.mjs --all` against a running `wrangler dev`
#   4. If vectors are configured, use a fresh index/base namespace and enqueue
#      `node scripts/reindex.mjs --all --vectors`. Never reuse restored delivery
#      acknowledgements. See docs/operations/vector-rebuild.md before inference.
#
# Usage: scripts/restore.sh <dump.sql> [--local|--remote]
set -euo pipefail

dump="${1:?usage: scripts/restore.sh <dump.sql> [--local|--remote]}"
target="${2:---local}"
rows="$(mktemp -t valise-restore)"
trap 'rm -f "$rows"' EXIT

echo "==> applying migrations ($target)"
npx wrangler d1 migrations apply DB "$target"

echo "==> loading rows from $dump"
# Each row is one line; the dump encodes newlines as char(10). The dump orders
# tables alphabetically, so skill_versions lands before skills and todo_updates
# before todos. Defer the foreign keys the way the dump's own header does.
echo 'PRAGMA defer_foreign_keys=TRUE;' > "$rows"
# External-index acknowledgements and abandoned scheduler leases are not restored.
awk '/^INSERT INTO/ && $0 !~ /^INSERT INTO ["`]?(vector_pending|vector_backfills|vector_drain_state)["`]?[ (]/' "$dump" >> "$rows"
echo "    $(grep -c '^INSERT INTO' "$rows") rows"
npx wrangler d1 execute DB "$target" --file "$rows"

echo "==> done. Rebuild the search projection with:"
echo "    npm run dev   # in another shell"
echo "    node scripts/reindex.mjs --all"
echo "    # Optional vectors: fresh index/namespace, then --all --vectors (enqueue only)."
echo "    # See docs/operations/vector-rebuild.md; no index is provisioned by restore."
