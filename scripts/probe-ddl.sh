#!/usr/bin/env bash
# Reruns the design-phase DDL probe behind docs/plans/2026-10-12-valise-v1-implementation.md
# Appendix A. Needs wrangler and sqlite3 on PATH. Touches nothing on the Cloudflare account.
set -uo pipefail

WORK="${TMPDIR:-/tmp}/valise-ddl-probe"
rm -rf "$WORK" && mkdir -p "$WORK/migrations"
cd "$WORK"

fail=0
check() {
  if [ "$1" = "$2" ]; then printf 'pass  %s\n' "$3"; else printf 'FAIL  %s\n        want %s, got %s\n' "$3" "$2" "$1"; fail=1; fi
}

cat > wrangler.jsonc <<'EOF'
{
  "name": "valise-ddl-probe",
  "main": "worker.js",
  "compatibility_date": "2026-10-01",
  "migrations_dir": "migrations",
  "d1_databases": [{ "binding": "DB", "database_name": "valise-probe", "database_id": "local-probe" }]
}
EOF
echo 'export default { fetch: () => new Response("ok") };' > worker.js

cat > migrations/0001_init.sql <<'EOF'
CREATE TABLE search_index (
  id INTEGER PRIMARY KEY, doc_key TEXT NOT NULL UNIQUE, concept TEXT NOT NULL, concept_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL
);
CREATE INDEX search_index_concept ON search_index(concept);
CREATE VIRTUAL TABLE search_fts USING fts5(
  title, body, tags, content='search_index', content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER search_index_ai AFTER INSERT ON search_index BEGIN
  INSERT INTO search_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
END;
CREATE TRIGGER search_index_ad AFTER DELETE ON search_index BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
END;
CREATE TRIGGER search_index_au AFTER UPDATE ON search_index BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
  INSERT INTO search_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
END;
EOF

q() { wrangler d1 execute DB --local --json --command "$1" 2>/dev/null | tr -d ' \n'; }

wrangler d1 migrations apply DB --local > apply.log 2>&1
check "$(grep -c '✅' apply.log)" "1" "wrangler d1 migrations apply accepts the FTS5 virtual table and its triggers"

upsert() {
  q "INSERT INTO search_index (doc_key,concept,concept_id,title,body,tags,updated_at) VALUES ('$1','$2','$3','$4','$5','$6',1)
     ON CONFLICT(doc_key) DO UPDATE SET title=excluded.title, body=excluded.body, tags=excluded.tags, updated_at=excluded.updated_at;" > /dev/null
}
upsert 'todo:1'   todo   1 'fix the flaky duckdb test' 'the bm25 index drifts under load' 'duckdb d1'
upsert 'memory:1' memory 1 'tooling note'              'prefer uv over pip, duckdb for local analysis' 'python'
upsert 'skill:1'  skill  1 'capture-this'              'save a memory to valise from any client' 'meta'

hits() {
  q "SELECT count(*) AS n FROM search_fts JOIN search_index si ON si.id=search_fts.rowid WHERE search_fts MATCH '$1'${2:+ AND si.concept IN (SELECT value FROM json_each('$2'))};" \
    | grep -o '"n":[0-9]*' | head -1 | cut -d: -f2
}

check "$(hits duckdb)" "2" "one external-content FTS5 corpus ranks across concepts"
check "$(hits duckdb '["todo"]')" "1" "type filtering works as a column predicate via json_each"

q "SELECT snippet(search_fts,1,'[',']','...',16) AS s, bm25(search_fts,4.0,1.0,2.0) AS r
   FROM search_fts JOIN search_index si ON si.id=search_fts.rowid WHERE search_fts MATCH 'duckdb' ORDER BY r;" > snippet.json
check "$(grep -c '"s":' snippet.json)" "1" "snippet() and weighted bm25() run together in the ADR-0001 query"

check "$(hits memories)" "1" "porter stemming matches memories to memory"

upsert 'todo:1' todo 1 'fix the flaky postgres test' 'no longer about that engine' 'pg'
check "$(hits duckdb)" "1" "an upsert on an existing doc_key drops the superseded tokens from the index"

q "DELETE FROM search_index WHERE doc_key='skill:1';" > /dev/null
check "$(hits client)" "0" "a projection delete unpublishes the row, which is the soft-delete path"

q "INSERT INTO search_fts(search_fts) VALUES('rebuild');" > /dev/null
q "INSERT INTO search_fts(search_fts) VALUES('integrity-check');" > /dev/null
check "$(hits duckdb)" "1" "rebuild and integrity-check both succeed on the derived index"

wrangler d1 export DB --local --output=export-all.sql -y > export-all.log 2>&1
check "$?" "1" "an unfiltered d1 export fails, because it cannot dump an FTS5 virtual table"

wrangler d1 export DB --local --table search_index --output=export-filtered.sql -y > /dev/null 2>&1
check "$(grep -c 'search_fts' export-filtered.sql)" "0" "naming tables explicitly produces a dump with no FTS artifacts, the ADR-0001 backup path"

cat > b_fusion.sql <<'EOF'
CREATE TABLE todos (todo_id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '');
CREATE VIRTUAL TABLE todo_fts USING fts5(title, body, content='todos', content_rowid='rowid');
INSERT INTO todos VALUES ('t1','flaky duckdb test','bm25 drift'),('t2','duckdb again','more duckdb');
INSERT INTO todo_fts(rowid,title,body) SELECT rowid,title,body FROM todos;
SELECT t.todo_id, snippet(todo_fts,1,'<','>','...',10), RANK() OVER (ORDER BY bm25(todo_fts))
FROM todo_fts JOIN todos t ON t.rowid=todo_fts.rowid WHERE todo_fts MATCH 'duckdb';
EOF
sqlite3 :memory: < b_fusion.sql > /dev/null 2>&1
check "$?" "1" "arena candidate B's fusion query does not run, snippet() and a bm25 window function cannot share a select"

printf '\nartifacts in %s\n' "$WORK"
exit $fail
