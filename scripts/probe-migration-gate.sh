#!/usr/bin/env bash
# Prove that `scripts/migrations.mjs audit` lets an additive migration through
# and stops everything else. The gate decides what a deploy runs against the
# production database unasked, so it is worth more than a reading of the
# regular expressions. Runs offline, touches nothing on the Cloudflare account,
# and is part of `npm run db:audit`.
set -uo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/valise-migration-gate.XXXXXX")"
trap 'rm -rf "$work"' EXIT

fail=0
check() {
  if [ "$1" = "$2" ]; then printf 'pass  %s\n' "$3"; else printf 'FAIL  %s\n        want exit %s, got %s\n' "$3" "$2" "$1"; fail=1; fi
}

# One case per directory, because the audit reports on a whole directory.
case_dir() {
  local name="$1"
  mkdir -p "$work/$name"
  cat > "$work/$name/0001_case.sql"
  node "$here/scripts/migrations.mjs" audit "$work/$name" > "$work/$name.log" 2>&1
  echo $?
}

exit_code=$(case_dir additive <<'SQL'
ALTER TABLE `todos` ADD `refs_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE INDEX `todos_project` ON `todos` (`project`);--> statement-breakpoint
CREATE TABLE `sessions` (`session_id` text PRIMARY KEY NOT NULL);
SQL
)
check "$exit_code" 0 "a migration that only adds passes"

exit_code=$(case_dir dropped <<'SQL'
ALTER TABLE `skills` DROP COLUMN `legacy_slug`;
SQL
)
check "$exit_code" 1 "an undeclared DROP COLUMN fails"

exit_code=$(case_dir renamed <<'SQL'
ALTER TABLE `todos` RENAME COLUMN `created_by` TO `source_agent`;
SQL
)
check "$exit_code" 1 "an undeclared RENAME COLUMN fails"

exit_code=$(case_dir declared <<'SQL'
-- valise:by-hand drops a column nothing reads since V1-19
ALTER TABLE `skills` DROP COLUMN `legacy_slug`;
SQL
)
check "$exit_code" 0 "the same DROP passes once the file declares it"

exit_code=$(case_dir unknown <<'SQL'
PRAGMA writable_schema = ON;
SQL
)
check "$exit_code" 1 "a statement the classifier does not recognise fails closed"

# The FTS triggers in 0000_init.sql carry DELETE in their bodies and semicolons
# between their statements. A classifier that split on either would read this
# as a destructive migration and stop every deploy from here on.
exit_code=$(case_dir trigger <<'SQL'
CREATE TRIGGER `search_index_ad` AFTER DELETE ON `search_index` BEGIN
	INSERT INTO search_fts(search_fts, rowid, title, body, tags)
	VALUES ('delete', old.id, old.title, old.body, old.tags);
END;
SQL
)
check "$exit_code" 0 "a trigger body holding DELETE and semicolons stays additive"

[ "$fail" = 0 ] && echo "migration gate: all cases hold"
exit "$fail"
