# Valise data model — Candidate C: authoritative concept tables + one derived search projection

Premise: each concept owns its schema and lifecycle in its own tables. Search is a single
derived projection — one slim `search_index` table plus one external-content FTS5 table —
that every concept publishes into, droppable and rebuildable from authoritative rows at any
time. The projection's schema is frozen (doc_key, concept, title, body, tags); concepts
evolve without touching it. This is Mia's "files authoritative, index rebuildable" split
applied across concepts, and the D1 billing-correct shape: one FTS query per search instead
of N, under hard-enforced limits where FTS5 queries count as row reads.

Ids are ULIDs (TEXT), timestamps INTEGER epoch ms. Single user in v1; R2 keys and the DO name
carry a user prefix now (hard to retrofit), D1 user_id columns later via trivial ALTERs.

## 1. DDL (runs on D1)

### Skills (immutable versions, head pointer, visibility)

```sql
CREATE TABLE skills (
  skill_id        TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,          -- slug, SKILL.md frontmatter name
  visibility      TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  head_version_id TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);

CREATE TABLE skill_versions (          -- append-only; rows are never updated or deleted
  version_id   TEXT PRIMARY KEY,
  skill_id     TEXT NOT NULL REFERENCES skills(skill_id),
  version      INTEGER NOT NULL,       -- monotonic per skill
  body_md      TEXT NOT NULL,          -- full SKILL.md, frontmatter included
  body_sha256  TEXT NOT NULL,
  files_json   TEXT NOT NULL DEFAULT '[]',  -- [{path, r2_key, sha256, size}]
  created_at   INTEGER NOT NULL,
  created_by   TEXT NOT NULL,          -- agent/client from MCP auth context
  UNIQUE (skill_id, version)
);
```

Bundled files live in R2 at `u/{user}/skills/{skill_id}/{version}/{path}` (immutable keys,
R2 object versioning on). D1 holds only the manifest. SKILL.md body is in D1 because it is
the searchable artifact and small (tens of KB).

### Memories (typed, tagged, provenance)

```sql
CREATE TABLE memories (
  memory_id      TEXT PRIMARY KEY,
  memory_type    TEXT NOT NULL,        -- open vocab: 'fact','preference','decision',...
  title          TEXT,
  body           TEXT NOT NULL,
  tags_json      TEXT NOT NULL DEFAULT '[]',
  source_agent   TEXT NOT NULL,        -- e.g. 'claude-code'
  source_client  TEXT NOT NULL,        -- OAuth client id that wrote it
  source_session TEXT,                 -- session id if the client supplies one
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER
);
CREATE INDEX memories_type ON memories(memory_type) WHERE deleted_at IS NULL;
```

Provenance is three columns, not a JSON blob, because it is filtered on. Tags stay JSON — a
join table at thousands of rows is ceremony; tag search goes through the FTS tags column,
exact filters via `json_each`.

### To-dos (states, lease fields mirrored from the DO, append-only progress)

```sql
CREATE TABLE todos (
  todo_id          TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  body             TEXT NOT NULL DEFAULT '',
  state            TEXT NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending','claimed','done','blocked')),
  lease_holder     TEXT,               -- mirror of DO truth, may lag seconds
  lease_expires_at INTEGER,            -- mirror
  fencing_token    INTEGER NOT NULL DEFAULT 0,  -- mirror; highest token ever granted
  blocked_on       TEXT,               -- free text or todo_id
  created_by       TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  completed_at     INTEGER
);
CREATE INDEX todos_state ON todos(state, updated_at);

CREATE TABLE todo_updates (            -- append-only agent progress log
  update_id  TEXT PRIMARY KEY,
  todo_id    TEXT NOT NULL REFERENCES todos(todo_id),
  kind       TEXT NOT NULL CHECK (kind IN ('progress','claim','release','complete','blocked')),
  author     TEXT NOT NULL,
  token      INTEGER,                  -- fencing token the author held, for audit
  body       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX todo_updates_todo ON todo_updates(todo_id, created_at);
```

### The search projection (derived, disposable — the only shared schema)

```sql
CREATE TABLE search_index (
  id         INTEGER PRIMARY KEY,      -- rowid, referenced by FTS
  doc_key    TEXT NOT NULL UNIQUE,     -- 'skill:01H…' | 'memory:01H…' | 'todo:01H…'
  concept    TEXT NOT NULL,            -- type filter column
  concept_id TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '', -- capped at 16KB per doc at publish time
  tags       TEXT NOT NULL DEFAULT '', -- space-joined
  updated_at INTEGER NOT NULL
);
CREATE INDEX search_index_concept ON search_index(concept);

CREATE VIRTUAL TABLE search_fts USING fts5(
  title, body, tags,
  content='search_index', content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 2'
);

CREATE TRIGGER search_index_ai AFTER INSERT ON search_index BEGIN
  INSERT INTO search_fts(rowid, title, body, tags)
  VALUES (new.id, new.title, new.body, new.tags);
END;
CREATE TRIGGER search_index_ad AFTER DELETE ON search_index BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, body, tags)
  VALUES ('delete', old.id, old.title, old.body, old.tags);
END;
CREATE TRIGGER search_index_au AFTER UPDATE ON search_index BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, body, tags)
  VALUES ('delete', old.id, old.title, old.body, old.tags);
  INSERT INTO search_fts(rowid, title, body, tags)
  VALUES (new.id, new.title, new.body, new.tags);
END;
```

Publish discipline, split where each mechanism is strong: **application code** maps a concept
row to a projection row (semantic — which fields, which version, truncation; it reads across
rows, e.g. the skill head version); **SQL triggers** keep `search_index` and `search_fts` in
lockstep (mechanical, schema frozen, cannot be forgotten). Each concept module exports one
`project(row) -> {doc_key, title, body, tags} | null` (null = unpublish, for soft-deletes).
Writes run as one `db.batch([authoritative write, search_index upsert])` — D1 batches are
atomic, so row and projection commit or fail together. The upsert:

```sql
INSERT INTO search_index (doc_key, concept, concept_id, title, body, tags, updated_at)
VALUES (?,?,?,?,?,?,?)
ON CONFLICT(doc_key) DO UPDATE SET
  title=excluded.title, body=excluded.body, tags=excluded.tags, updated_at=excluded.updated_at;
```

## 2. Durable Object state for claiming

One DO instance per user: `TodoCoordinator`, `idFromName('todos:' + userId)` — multi-tenant
later is more instances, not a redesign. DO SQLite storage (mandatory for new namespaces,
30-day PITR):

```sql
CREATE TABLE leases (
  todo_id          TEXT PRIMARY KEY,
  state            TEXT NOT NULL,      -- pending|claimed|done|blocked
  lease_holder     TEXT,
  lease_expires_at INTEGER,
  fencing_token    INTEGER NOT NULL DEFAULT 0,
  mirrored         INTEGER NOT NULL DEFAULT 1   -- 0 = D1 write-through still owed
);
```

**Split of authority.** The DO is the sole authority for `{state, lease_holder,
lease_expires_at, fencing_token}` — every transition (claim, release, complete, block, expiry)
is a single-threaded DO method, which is the compare-and-set. D1 is authoritative for
everything else (title, body, updates, timestamps) and holds a *mirror* of the DO fields for
listing and search. All state transitions go through the DO; D1's copies are display data.

**Flows.** `claim(todo_id, agent, ttl)`: lazily seed the lease row from D1 if absent
(self-healing after any DO reset); grant iff `state='pending'` or (`state='claimed'` and
`lease_expires_at < now`); `fencing_token += 1`, set holder and expiry, schedule the alarm at
`min(lease_expires_at)`, return `{token, expires_at}`. `complete(todo_id, token)` and guarded
writes check `token == fencing_token AND holder == caller` — a stale holder whose lease was
re-granted is rejected even if it wakes later. **Expiry is the DO alarm**: flip expired
claims back to `pending`, append a `release` row — reliable expiry without trusting
session-end hooks, which D1 alone cannot do (no timers).

**Consistency DO→D1.** After each transition the DO writes through to D1 (`UPDATE todos …` +
`INSERT INTO todo_updates`), marking `mirrored=1` on success, `0` on failure with
alarm-driven retry. D1 reads can lag one failed write-through window; cosmetic only, since no
claim/complete ever consults D1 state. If DO storage is ever rebuilt from the mirror, resume
tokens at `fencing_token + 1000` to dominate any unmirrored grant.

## 3. MCP tool → query mapping

- **search(query, types?, limit=20)** — the one ranked query, ChatGPT Deep Research `search`:
  ```sql
  SELECT si.doc_key, si.concept, si.title,
         snippet(search_fts, 1, '[', ']', '…', 16) AS snip,
         bm25(search_fts, 4.0, 1.0, 2.0) AS rank
  FROM search_fts JOIN search_index si ON si.id = search_fts.rowid
  WHERE search_fts MATCH :q AND (:types IS NULL OR si.concept IN (SELECT value FROM json_each(:types)))
  ORDER BY rank LIMIT :limit;
  ```
- **fetch(id)** — `id` is the `doc_key`; dispatch on prefix to the authoritative table:
  skill → head version body + files with signed R2 URLs; todo → row + `todo_updates`;
  memory → row. The projection never serves content; it only ranks.
- **create_todo** — `db.batch([INSERT todos, upsert search_index])`; DO learns of it lazily.
- **claim_todo / complete_todo** — DO methods above; complete's write-through batch also
  re-upserts the projection row (done items stay searchable; state shown on fetch).
- **update_todo(id, token, progress)** — DO verifies token (CAS gate), then
  `db.batch([INSERT todo_updates, UPDATE todos.updated_at])`. Progress bodies are not
  projected in v1; title+body are the searchable text.
- **save_memory** — provenance from the authenticated MCP context, never caller-supplied
  free text; `db.batch([INSERT memories, upsert search_index])`. Backs `/capture-this`.
- **list_skills / get_skill** — `SELECT` on skills (+ head version join); also serves the
  SEP-2640 `skills/list` / `skills/get` resource layer. `get_skill(name, version?)` pins or
  takes head.
- **publish_skill(name, body, files)** — no-op if `body_sha256` and file shas match head;
  else upload files to immutable R2 keys, then `db.batch([INSERT skill_versions,
  UPDATE skills.head_version_id, upsert search_index with the new head body])`.

## 4. Migration and evolution

Numbered wrangler migrations, one file per concept; the search migration is frozen after v1.
Adding a field to to-dos = one ALTER on `todos`; if searchable, update the todo `project()`
and run `reindex --concept todo` (re-upsert that concept's rows only). Skills and memories
rows and their FTS entries are untouched — constraint 2 holds because concepts meet only at
the projection's frozen five columns. A new concept (documents, transcripts) = new tables, a
new `project()`, a new fetch case; zero DDL on search. The one genuinely global event is a
tokenizer change: a full rebuild of a disposable index, acknowledged below.

## 5. Backup and restore

Authoritative truth = D1 concept tables + R2 objects. A nightly cron Worker calls the D1
export API and drops the SQL dump in R2; `search_fts` cannot be exported (virtual table) and
`search_index` is deliberately excluded — both derived. R2 skill bundles are versioned
objects at immutable keys; D1 Time Travel and DO PITR (30d each) cover fat-fingers. Restore:
import dump → `reindex --all` (truncate `search_index`, re-run every `project()`, then
`INSERT INTO search_fts(search_fts) VALUES('rebuild')`) → DO reseeds lazily with the +1000
token bump. The same `reindex` tool doubles as weekly reconciliation (per-concept counts and
`max(updated_at)` vs the projection, repair drift).

## 6. RATIONALE

**Alternatives considered inside the premise, and rejections:**
1. *Truly contentless FTS5 (`content=''`), no `search_index` table.* Rejected hard:
   contentless tables cannot delete or update individual rows and cannot `snippet()`. No
   incremental unpublish means no soft-delete story. Disqualifying.
2. *External-content FTS over a UNION view of concept tables.* No stable rowid, no triggers
   on views, and the view couples the index to every concept's DDL — the exact cross-concept
   reindex coupling constraint 2 forbids.
3. *Per-concept triggers on authoritative tables writing into `search_index`.* Tempting (no
   double-write discipline), rejected because the concept→projection mapping is semantic:
   skill text lives in a different row (head version) than the trigger target, bodies need
   truncation, future concepts may project from R2 content triggers can't reach. Triggers
   stay where the mapping is mechanical (index→FTS).
4. *Per-concept FTS tables merged at query time* (the premise's boundary). BM25 scores from
   separate indexes carry different corpus statistics and are not comparable — "one ranked
   list" becomes score splicing — and each search costs N FTS queries against hard D1 limits.
5. *D1-only claiming via conditional UPDATE.* D1 serializes writes, so `UPDATE … WHERE
   state='pending'` is atomic and nearly suffices. Rejected: reliable expiry needs a timer
   (DO alarms) and fencing needs a monotonic counter under single-threaded CAS; without the
   DO, expiry is lazy, which the settled decisions explicitly distrust.

**Honest weak points of this shape:**
- *Publish is a convention, not a constraint.* Any write path that skips the repository layer
  (manual `wrangler d1 execute`, a hotfix script) silently desyncs the index. Mitigations are
  real but janitorial: atomic `db.batch`, one repository module per concept, weekly
  reconciliation. The CSS-vibe-garden lesson says constraints beat conventions; here the
  constraint lives one level up (nothing else has D1 write credentials), which is weaker.
- *Text is stored twice.* A skill body sits in `skill_versions` and (truncated) in
  `search_index`. Megabytes at personal scale, but it is duplication, and the 16KB cap means
  very long documents (a later concept) are only partially searchable.
- *Cross-concept BM25 is hand-tuned.* One corpus means comparable scores, but a 3-line todo
  and a 400-line skill compete under one length normalization; the column weights (title 4,
  tags 2, body 1) are taste, not calibration. Expect to add a per-concept query-time boost.
- *DO→D1 mirror lag.* `list` and `search` can show a todo as claimed for a few seconds after
  expiry (or vice versa). Correctness is unaffected; UIs may flash stale state.
- *One index is shared fate.* A tokenizer change or FTS corruption rebuilds everything. At
  thousands of rows a rebuild is seconds, so this is accepted rather than solved.
