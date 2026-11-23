# Valise data model — candidate A: one catalog

Every concept is a row in `items`. Three shared columns carry the searchable text (`title`,
`body`, `tags`), one JSON column carries everything type-specific, one FTS5 index covers the
lot. Two append-only side tables and one Durable Object for to-do claims. Four tables total.

The argument for this shape is BM25, not tidiness. **BM25 scores are corpus-relative** —
`bm25()` normalises by average document length and inverse document frequency *within one
index*. Two FTS tables produce two incomparable score scales, so cross-concept ranking over
per-concept indexes means `UNION ALL` plus a normalisation fudge that drifts as the corpora
grow at different rates. Constraint 1 asks for one ranked list across all concepts; one index
is the only honest way to get it.

## 1. DDL

```sql
-- 0001_catalog.sql

CREATE TABLE items (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,   -- stable rowid for external-content FTS
  id          TEXT NOT NULL UNIQUE,                -- ULID; the public identifier
  owner       TEXT NOT NULL DEFAULT 'me',          -- multi-tenant seam, unused in v1
  type        TEXT NOT NULL,                       -- 'skill' | 'memory' | 'todo' | later types
  slug        TEXT,                                -- stable handle (skill name); NULL elsewhere
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',            -- indexed prose (SKILL.md, memory text, …)
  tags        TEXT NOT NULL DEFAULT '',            -- normalised, space-delimited: 'duckdb d1 '
  state       TEXT,                                -- lifecycle for types that have one
  scope       TEXT NOT NULL DEFAULT 'private'
                CHECK (scope IN ('private','public')),
  version     INTEGER NOT NULL DEFAULT 1,          -- head revision number
  rev         INTEGER NOT NULL DEFAULT 0,          -- monotonic write counter == fencing token
  payload     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  src_client  TEXT,                                -- provenance: 'claude-code', 'chatgpt', …
  src_agent   TEXT,
  src_session TEXT,
  created_at  INTEGER NOT NULL,                    -- epoch ms
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);

CREATE UNIQUE INDEX items_slug ON items(owner, type, slug)
  WHERE slug IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX items_recent ON items(owner, type, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX items_open_todos ON items(owner, state, created_at)
  WHERE type = 'todo' AND deleted_at IS NULL;

CREATE VIRTUAL TABLE items_fts USING fts5(
  title, body, tags,
  content='items', content_rowid='seq',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, body, tags)
  VALUES (new.seq, new.title, new.body, new.tags);
END;
CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, body, tags)
  VALUES ('delete', old.seq, old.title, old.body, old.tags);
END;
CREATE TRIGGER items_au AFTER UPDATE OF title, body, tags ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, body, tags)
  VALUES ('delete', old.seq, old.title, old.body, old.tags);
  INSERT INTO items_fts(rowid, title, body, tags)
  VALUES (new.seq, new.title, new.body, new.tags);
END;

-- Immutable content snapshots. Skills need these (constraint 4); every other type gets
-- edit history for free. Never indexed, so old versions never pollute search.
CREATE TABLE item_revisions (
  item_id        TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  version        INTEGER NOT NULL,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  tags           TEXT NOT NULL,
  payload        TEXT NOT NULL CHECK (json_valid(payload)),
  content_sha256 TEXT NOT NULL,
  bundle_prefix  TEXT,                              -- R2 prefix, e.g. 'skills/<id>/3/'
  src_client     TEXT, src_agent TEXT, src_session TEXT,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (item_id, version)
) WITHOUT ROWID;

-- Append-only activity: agent progress notes, state transitions, claims, expiries.
CREATE TABLE item_events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                         -- progress|state|claim|release|expire|publish
  rev        INTEGER NOT NULL,                      -- items.rev when written (fencing token)
  note       TEXT NOT NULL DEFAULT '',
  data       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
  src_client TEXT, src_agent TEXT, src_session TEXT,
  at         INTEGER NOT NULL
);
CREATE INDEX item_events_item ON item_events(item_id, seq);
```

`seq INTEGER PRIMARY KEY AUTOINCREMENT` is deliberate: a table whose PK is `TEXT` gets an
implicit rowid that **VACUUM can renumber**, silently desyncing an external-content FTS index.
An explicit autoincrement rowid alias is stable.

Payload shapes are app-level contracts (zod), not DDL:

- `todo` — `{due_at, priority, blocked_by:[id], lease:{agent,session,expires_at}, result}`;
  `state ∈ pending|claimed|done|blocked`
- `memory` — `{kind:'fact'|'preference'|'decision', confidence, subject}`; `state` NULL
- `skill` — `{description, allowed_tools, bundle_prefix, files:[{path,sha256,bytes}]}`;
  `state ∈ draft|published`

R2 holds skill bundles only: `skills/<item_id>/<version>/<path>`, immutable per version.
D1 holds the manifest. `body` for a skill is frontmatter description + full SKILL.md.

## 2. Durable Object state

One `TodoCoordinator` per owner (`idFromName(owner)`). v1 has one; multi-tenant later is one
DO per tenant, no schema change. Inside its SQLite, only **open** to-dos (pending/claimed/
blocked) — rows drop once `done` is confirmed in D1, so it stays at tens of rows:

```
leases(item_id TEXT PRIMARY KEY, state TEXT, holder_agent TEXT, holder_session TEXT,
       fence INTEGER, claimed_at INTEGER, heartbeat_at INTEGER,
       lease_expires_at INTEGER, d1_synced_fence INTEGER)
```

**Authority split.** D1 is authoritative for existence, body, payload, tags, provenance,
revisions, events. The DO is authoritative for the *transition decision* and the lease; D1's
`items.state` and `items.rev` are a write-through replica of that decision. **The DO is the
only writer of `state`, `rev`, and `payload.lease` for `type='todo'`** — body and tag edits on
a to-do go through it too, so `rev` stays DO-issued and monotonic.

**Flow.** The Worker picks candidate ids from D1 (a stale hint, never a decision), calls the
DO, the DO runs CAS single-threaded, then writes through to D1 in one `db.batch()` before
returning. The D1 update is guarded `WHERE id=? AND rev < :fence`, so a retried or reordered
write-through can never regress state. If D1 fails, `d1_synced_fence` lags and the alarm
retries; D1 is stale by seconds, which is safe because nothing reads D1 to decide.

**Expiry.** The alarm is set to the earliest `lease_expires_at`. On fire: bump `fence`, reset
`state='pending'`, append an `expire` event, write through, reschedule. Alarms are durable and
retried — no cron sweep, no reliance on a session-end hook firing. TTL 15 min by default;
`update_todo` heartbeats and extends it.

**Rebuild.** `SELECT id, state, rev FROM items WHERE type='todo' AND state IN
('pending','claimed','blocked')`; fence resumes at `rev`. Because the fence lives in D1 as
`items.rev`, losing DO state never breaks the fencing guarantee. That is why `rev` is a real
column, not DO-only.

## 3. MCP tools → queries

**`search(q, types?, tags?, states?, limit)`** — one query, the whole catalog:

```sql
SELECT i.id, i.type, i.title, i.state,
       snippet(items_fts, 1, '«', '»', '…', 14) AS snip,
       bm25(items_fts, 8.0, 1.0, 4.0) AS score      -- title, body, tags weights
FROM items_fts JOIN items i ON i.seq = items_fts.rowid
WHERE items_fts MATCH :q AND i.owner = :owner AND i.deleted_at IS NULL
  AND (:types IS NULL OR i.type IN (/*…*/))
  AND (:states IS NULL OR i.state IN (/*…*/))
ORDER BY score LIMIT :limit;          -- bm25 is negative; ascending = best first
```

Tag filter is either an FTS clause (`tags:duckdb`, free) or
`instr(' '||i.tags||' ', ' '||:tag||' ') > 0`.

**`fetch(id)`** — the ChatGPT Deep Research half of the pair. `SELECT * FROM items WHERE
id=:id` → `{id, title, text: body, url, metadata: payload + provenance}`, plus the last 20
`item_events` and, for skills, the version list.

**`create_todo`** — insert `type='todo'`, `state='pending'`, then `stub.register(id)`.

**`claim_todo(filter, agent, session, ttl)`** — candidates from `items_open_todos`
(`state='pending'`, ordered by `json_extract(payload,'$.priority') DESC, created_at` — a sort
over tens of rows) → `stub.claim(candidates)` → `{item, fence}`.

**`update_todo(id, fence, note, patch?)`** — DO verifies holder + fence, extends lease,
appends `item_events(kind='progress')`, optionally `payload = json_patch(payload, :patch)`.
A stale fence returns `is_error` naming the current holder, so the agent self-repairs.

**`complete_todo(id, fence, result)`** — DO CAS to `done`, `payload.result`, event, drop lease.

**`save_memory(text, tags, kind, provenance)`** — one insert; `title` is the first line or a
caller-supplied label; the trigger indexes it. This is the `/capture-this` write path.

**`list_skills(tag?)`** — `SELECT id, slug, title, version, scope,
json_extract(payload,'$.description') FROM items WHERE type='skill' AND state='published'
AND deleted_at IS NULL`. No FTS. Also rendered as SEP-2640 `skill://` resources.

**`get_skill(slug, version?)`** — head from `items`, or `SELECT body, payload FROM
item_revisions WHERE item_id=:id AND version=:v`; bundle files from `payload.files`, served
as R2 presigned URLs under `bundle_prefix`.

**`publish_skill(slug, body, files)`** — one `db.batch()`: upsert head (`version=version+1,
rev=rev+1`), insert `item_revisions`, insert `item_events(kind='publish')`. R2 objects are
written first, so a crash leaves orphan objects, never a dangling manifest.

## 4. Migration and evolution

Three classes of change, in increasing cost:

1. **New field on one concept** (to-do gets `estimate`) — zero DDL. Write the key into
   `payload`, update the zod schema, ship. No other type's rows are read, written, or
   reindexed. This is the premise paying off.
2. **Whole new concept** (documents, transcripts) — zero DDL. A new `type` value, a payload
   schema, new tools. It appears in `search` the moment the first row lands.
3. **A payload field needs sorting or range filtering at scale** — one partial expression
   index: `CREATE INDEX items_todo_due ON items(json_extract(payload,'$.due_at')) WHERE
   type='todo' AND deleted_at IS NULL;`. No other type's rows touched, no FTS rebuild.

The one change that costs everything is altering the **FTS column set**: `DROP TABLE
items_fts`, recreate, `INSERT INTO items_fts(items_fts) VALUES('rebuild')`, re-reading every
row. So the FTS columns are frozen at three forever — anything a new concept wants searchable
is composed into `body` at write time. A transcript's speaker labels, a document's headings:
all `body`. That is the discipline the one-index promise buys.

Migrations are numbered SQL under `migrations/`, applied by `wrangler d1 migrations apply`.

## 5. Backup and export

- **Nightly** (cron Workflow): `items`, `item_revisions`, `item_events` dumped to R2 as JSONL
  at `backups/<date>/`. Doubles as the user-facing portability export and is what restore reads.
- **Weekly**: `wrangler d1 export valise --table items --table item_revisions
  --table item_events --output valise.sql`. The `--table` flags are mandatory, not cosmetic:
  D1 export cannot dump FTS5 virtual tables.
- **R2** bundles are immutable per version; bucket versioning plus the `payload.files`
  manifest (path + sha256 + bytes) makes a restored bundle verifiable.
- **Restore**: import SQL or replay JSONL, then `INSERT INTO items_fts(items_fts)
  VALUES('rebuild')`. The index is disposable by construction.
- **DO state** is not in the export and needs not be. It carries 30-day PITR, and §2's rebuild
  regenerates it from `items`. Worst case every in-flight lease is lost and claimed to-dos
  revert to pending — safe, because the fence floor survives in `items.rev`.

## 6. Rationale

**Alternatives considered inside the premise, and rejected.**

- *Type-specific columns promoted onto `items`* (`due_at`, `lease_expires_at`,
  `skill_version`). Rejected: every new concept widens the shared table, exactly the coupling
  constraint 2 forbids, and leaves columns NULL for 90% of rows.
- *`items` plus 1:1 side tables per concept.* Rejected for v1: per-concept DDL plus a join on
  every fetch, for no gain at thousands of rows. It is the honest escape hatch though — if
  to-dos grow ten queryable fields, promote them into a side table and keep the catalog row
  as the search and identity record. Additive, and it touches no other type.
- *EAV attributes table.* Rejected outright; a JSON column gives the same flexibility with
  none of the join pain, and SQLite's JSON functions are first-class.
- *Standalone (non-external-content) FTS with composed documents.* Would let the indexed
  document include a to-do's progress notes. Rejected for v1: duplicates every body's bytes
  and moves index maintenance from triggers into app code, where it gets forgotten. The swap
  is invisible to callers if progress search ever matters.
- *Skill versions as `items` rows with an `is_head` flag.* Rejected: twelve versions of one
  skill in the corpus wrecks BM25's IDF and forces `is_head=1` into every query.
- *Merging `item_revisions` into `item_events`.* Tempting (one append-only log), rejected:
  snapshots and activity have different keys, retention, and read patterns. Merging means
  `WHERE kind='revision' AND seq=:version` everywhere.
- *A `tags` join table.* Rejected at personal scale. A normalised string column is
  filterable, searchable as its own FTS column, and survives export without a join.
- *Per-to-do Durable Object.* Rejected: "claim the next matching to-do" would fan out across
  N DOs. The singleton coordinator serialises in one place and shards by owner later.

**Where this shape honestly strains.**

1. **`state` is a shared column only two types use.** Memories have no state. It is a real
   column rather than a payload key solely because `search` filters on it and `json_extract`
   in a catalog-wide WHERE is slower and uglier. The clearest leak in the unified shape: a
   type-specific concept in shared DDL. `scope` and `version` carry the same smell.
2. **Payload is unvalidated by the database.** `json_valid()` is the only guard; the rest
   lives in app zod schemas. A buggy write path produces structurally fine, semantically
   broken rows and no CHECK will catch it. Mitigation is the boundary-validation pattern: validate at
   the tool boundary, return `is_error` with specifics.
3. **Cross-concept ranking is still hard with one index.** A 4,000-word SKILL.md and a
   20-word memory compete in the same ranking. BM25's length normalisation helps, but skills
   will dominate broad queries. The fix is a per-type score multiplier in SQL — a permanent
   tuning liability. One index makes the comparison possible, not right.
4. **Progress notes are not searchable.** `item_events` sits outside the index, so "what did
   the agent say about the flaky test" returns nothing. Accepted in v1; the fix is the
   standalone-FTS swap above.
5. **Soft-deleted rows stay indexed** until purged, so every search carries
   `deleted_at IS NULL`. Cheap, since the join is needed anyway, but a trap for any future
   query that forgets it. An `items_live` view is the discipline.
6. **To-do rows have two conceptual writers** — the DO for state, the app for body — and the
   fencing guarantee rests on a convention the schema cannot enforce. No CHECK expresses
   "all to-do writes go through the DO". This is the rule most likely to be broken by a
   future tool that edits a to-do's text directly.
