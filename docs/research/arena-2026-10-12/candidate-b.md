# Valise data model — candidate B: per-concept tables

Premise: todos, memories, and skills differ enough in lifecycle (lease
semantics, append-only logs, immutable versions) that one shared row shape
buys nothing and costs independence. Each concept owns its table(s), its FTS
table, its migrations, its own sync mechanism for that FTS table. Cross-
concept search is a query-time fusion problem, not a shared-schema problem.

## 1. DDL

### Todos

```sql
CREATE TABLE todos (
    todo_id         TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    body            TEXT NOT NULL DEFAULT '',
    state           TEXT NOT NULL DEFAULT 'pending'
                        CHECK (state IN ('pending','claimed','done','blocked')),
    priority        INTEGER NOT NULL DEFAULT 0,
    due_at          TEXT,
    blocked_on      TEXT REFERENCES todos(todo_id),
    claimed_by      TEXT,              -- agent id, mirrored from DO
    lease_expires_at TEXT,             -- mirrored from DO, informational only
    fencing_token   INTEGER NOT NULL DEFAULT 0,  -- mirrored, audit-only
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX todos_claimable ON todos(state, priority DESC, due_at);

CREATE TABLE todo_updates (          -- append-only progress log, owned by todos
    update_id   TEXT PRIMARY KEY,
    todo_id     TEXT NOT NULL REFERENCES todos(todo_id) ON DELETE CASCADE,
    author      TEXT NOT NULL,       -- agent id
    body        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX todo_updates_todo_id ON todo_updates(todo_id, created_at);

CREATE VIRTUAL TABLE todo_fts USING fts5(
    title, body, content='todos', content_rowid='rowid'
);
CREATE TRIGGER todos_ai AFTER INSERT ON todos BEGIN
    INSERT INTO todo_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER todos_ad AFTER DELETE ON todos BEGIN
    INSERT INTO todo_fts(todo_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER todos_au AFTER UPDATE OF title, body ON todos BEGIN
    INSERT INTO todo_fts(todo_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
    INSERT INTO todo_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
```

### Memories

```sql
CREATE TABLE memories (
    memory_id       TEXT PRIMARY KEY,
    type            TEXT NOT NULL,     -- 'preference'|'fact'|'decision'|'episodic'|... open vocabulary
    body            TEXT NOT NULL,
    source_agent    TEXT NOT NULL,     -- provenance
    source_session  TEXT,
    source_client   TEXT NOT NULL,     -- 'claude-code'|'claude.ai'|'chatgpt'|...
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX memories_type ON memories(type, created_at DESC);

CREATE TABLE memory_tags (            -- owned by memories, not a shared concept
    memory_id TEXT NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
    tag       TEXT NOT NULL,
    PRIMARY KEY (memory_id, tag)
);
CREATE INDEX memory_tags_tag ON memory_tags(tag);

CREATE VIRTUAL TABLE memory_fts USING fts5(
    body, content='memories', content_rowid='rowid'
);
-- ai/ad/au triggers mirror todo_fts exactly, on (body)
```

### Skills

```sql
CREATE TABLE skills (
    skill_id        TEXT PRIMARY KEY,   -- stable slug, e.g. 'capture-this'
    visibility      TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
    head_version_id TEXT,               -- CAS pointer, flipped on publish
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE skill_versions (          -- immutable rows, never updated
    version_id      TEXT PRIMARY KEY,
    skill_id        TEXT NOT NULL REFERENCES skills(skill_id) ON DELETE CASCADE,
    version_number  INTEGER NOT NULL,
    description     TEXT NOT NULL,
    body            TEXT NOT NULL,      -- SKILL.md content
    content_sha256  TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (skill_id, version_number)
);

CREATE TABLE skill_files (             -- bundled scripts/references, blobs in R2
    file_id          TEXT PRIMARY KEY,
    skill_version_id TEXT NOT NULL REFERENCES skill_versions(version_id) ON DELETE CASCADE,
    path             TEXT NOT NULL,     -- 'scripts/run.py'
    r2_key           TEXT NOT NULL,
    size_bytes       INTEGER NOT NULL,
    content_type     TEXT NOT NULL
);
CREATE INDEX skill_files_version ON skill_files(skill_version_id);

-- NOT external-content, NOT trigger-synced: indexes only the current head,
-- maintained explicitly by publish_skill (see §4, §6 point 5).
CREATE VIRTUAL TABLE skill_fts USING fts5(skill_id UNINDEXED, description, body);
```

v1 has no `owner_id` columns anywhere (single user). Multi-tenancy later is
the same `ALTER TABLE <concept> ADD COLUMN owner_id ...` move as any other
field addition — per concept, isolated, deferred rather than blocked.

## 2. Cross-concept search: fusion, not a shared index

Raw `bm25()` values from `todo_fts`, `memory_fts`, `skill_fts` aren't
comparable (different corpora, different average document lengths — the
frozen constraint's warning, taken literally). Fix: rank, don't score. Each
branch orders by its own `bm25()` for a within-type rank, then **reciprocal
rank fusion** (RRF, `1/(k+rank)`, k=60) combines them using rank only, never
score magnitude:

```sql
WITH todo_hits AS (
  SELECT 'todo' AS kind, t.todo_id AS id, t.title AS title,
         snippet(todo_fts, 1, '<b>','</b>','…',10) AS snippet,
         RANK() OVER (ORDER BY bm25(todo_fts)) AS rnk
  FROM todo_fts JOIN todos t ON t.rowid = todo_fts.rowid
  WHERE todo_fts MATCH :q
), memory_hits AS (
  SELECT 'memory', m.memory_id, m.type, snippet(memory_fts, 0, '<b>','</b>','…',10),
         RANK() OVER (ORDER BY bm25(memory_fts))
  FROM memory_fts JOIN memories m ON m.rowid = memory_fts.rowid
  WHERE memory_fts MATCH :q
), skill_hits AS (
  SELECT 'skill', s.skill_id, s.description, snippet(skill_fts, 2, '<b>','</b>','…',10),
         RANK() OVER (ORDER BY bm25(skill_fts))
  FROM skill_fts s WHERE skill_fts MATCH :q
)
SELECT kind, id, title, snippet, SUM(1.0/(60+rnk)) AS rrf_score
FROM (SELECT * FROM todo_hits UNION ALL SELECT * FROM memory_hits UNION ALL SELECT * FROM skill_hits)
GROUP BY kind, id            -- a hit can appear once per branch only, GROUP BY is defensive
ORDER BY rrf_score DESC
LIMIT :n;
```

A `type` filter drops branches instead of fusing — single-type search is
plain `bm25()` ordering, and the score stays directly meaningful.

## 3. Todo claiming: DO vs D1

One Durable Object instance per todo (`idFromName(todo_id)`), DO-SQLite backed.
State shape:

```
TodoLeaseDO {
  todo_id: string
  state: 'pending' | 'claimed' | 'done' | 'blocked'
  claimed_by: string | null
  lease_token: number        // monotonic, bumped every successful claim
  lease_expires_at: number   // epoch ms
  alarm: scheduled at lease_expires_at
}
```

- `claim(agent_id, lease_seconds)`: single-threaded CAS — succeeds if
  `state='pending'` or (`state='claimed'` and `lease_expires_at < now`). Bumps
  `lease_token`, sets `claimed_by`/`lease_expires_at`, schedules an alarm.
  Returns `{ok, lease_token, lease_expires_at}` or `{ok:false, current_holder}`.
- Alarm at `lease_expires_at`: if still claimed under the same token, reverts
  to `pending` in the DO and writes that through to D1 — "reliable expiry"
  even if no agent ever calls back.
- `complete(agent_id, lease_token)` / `progress(agent_id, lease_token, note)`:
  both require the token to match the DO's current one and not be expired,
  else `409`.

**Consistency story**: the DO is sole authority on "who holds the lease right
now" — CAS lives there because DOs are single-threaded, D1 isn't. D1's
`claimed_by`/`lease_expires_at`/`fencing_token` are a write-through mirror,
kept only so `list_todos`/`search` can filter without a DO round trip per
row. The mirror can lag by one write (crash between DO success and the D1
`UPDATE`) — self-heals via a cron sweep: `UPDATE todos SET state='pending',
claimed_by=NULL WHERE state='claimed' AND lease_expires_at < now()`,
independent of the DO. `fencing_token` in D1 is audit-only, never consulted
to grant or deny a claim.

## 4. Tool → query mapping

- `search(query, type?, limit)` → §2 fusion query, or single-branch `bm25()`
  query when `type` is given.
- `fetch(kind, id)` → `kind` dispatches to the owning table by PK
  (`todo:<id>` / `memory:<id>` / `skill:<id>`); no cross-table join needed.
- `create_todo(title, body?, priority?, due_at?)` → `INSERT INTO todos`;
  `todo_fts` updates via trigger.
- `claim_todo(todo_id, agent_id, lease_seconds)` → DO `.claim()`, then
  `UPDATE todos SET state='claimed', claimed_by=?, lease_expires_at=?,
  fencing_token=? WHERE todo_id=?`.
- `complete_todo(todo_id, agent_id, lease_token)` → DO `.complete()`, then
  `UPDATE todos SET state='done', claimed_by=NULL WHERE todo_id=?`.
- `update_todo(todo_id, agent_id, lease_token, note)` → DO `.checkLease()`
  (read-only), then `INSERT INTO todo_updates`.
- `save_memory(type, body, tags[], source_agent, source_session,
  source_client)` → `INSERT INTO memories` + one `INSERT INTO memory_tags`
  per tag; `memory_fts` updates via trigger.
- `list_skills(visibility?)` → `SELECT ... FROM skills JOIN skill_versions ON
  head_version_id = version_id WHERE visibility = ?`.
- `get_skill(slug)` → head `skill_versions` row + its `skill_files` rows;
  Worker proxies/signs the R2 reads for bundled files on demand.
- `publish_skill(slug, body, description, files[])` → `INSERT INTO
  skill_versions` (new `version_number`), upload files to R2 under a
  versioned prefix, `INSERT INTO skill_files`, `UPDATE skills SET
  head_version_id=?`, then `DELETE FROM skill_fts WHERE skill_id=?; INSERT
  INTO skill_fts ...` — the one FTS table maintained by application code
  instead of a trigger (see §6.5).

## 5. Migration/evolution story

No table is shared across concepts, so no migration crosses a concept
boundary. Adding a to-do field: `ALTER TABLE todos ADD COLUMN ...` — memories
and skills, their FTS tables, their triggers, untouched, no reindex. A whole
new concept (documents, transcripts): new table(s), new FTS table, new sync
mechanism, one new CTE branch in the §2 union, one new `fetch` dispatch arm —
zero rewrite of existing rows. Migrations are one-per-concept-change
(`0005_todos_add_recurrence.sql`); D1's migration ledger is global
infrastructure worth naming as the one shared surface, but it tracks *that*
migrations ran, not concept data.

## 6. Backup story

D1 export cannot dump FTS5 virtual tables. Backup covers ordinary tables only
— `todos`, `todo_updates`, `memories`, `memory_tags`, `skills`,
`skill_versions`, `skill_files` — via scheduled `wrangler d1 export`
(Workflows/cron) to R2. Restore order: load base tables, rebuild each
concept's FTS independently:
- `todo_fts`, `memory_fts` (trigger-synced, external-content): `INSERT INTO
  todo_fts(todo_fts) VALUES ('rebuild');`, same for `memory_fts` — one
  statement, no app code.
- `skill_fts` (app-maintained): replay the publish projection — for every row
  in `skills`, read its head `skill_versions` row and re-run the
  `publish_skill` FTS-write step.

Concepts share no tables, so restoring todos never touches memories or
skills — partial restore is real, not theoretical. R2-held skill files are
backed up by R2's own versioning, a separate mechanism from the D1 export,
stated explicitly rather than assumed. DO lease state is never backed up —
operational, not authoritative; the §3 cron sweep is the recovery path if a
DO is lost.

## 7. Rationale

**Alternatives considered, and rejected, inside the per-concept premise:**

1. *Single `items(id, type, data JSON)` catalog, one shared FTS* — the
   competing premise this design argues against. Rejected on its own merits
   too: a JSON blob loses "real columns, own lifecycle" — adding a to-do
   field becomes a blob-shape negotiation shared by every type, or a
   sparse-column table, neither of which constraint 2 asks for.

2. *One shared FTS5 table fed by triggers from every concept table*
   (`global_fts(kind, ref_id, text)`), for directly-comparable `bm25()`
   scores from one corpus. Rejected: a shared corpus means a hot path in one
   concept (frequent `todo_updates` appends, say) perturbs the average
   document length and term statistics `bm25()` uses for memories and skills
   too — "schema evolves independently" has to mean index behavior, not just
   column migrations, or it's a constraint in name only. It also breaks §6:
   you can't rebuild "just the todos slice" of a table everyone shares.

3. *Raw-score fusion (min-max/z-score normalization)* instead of RRF.
   Rejected: z-score normalization needs a stable variance estimate, and a
   query matching 2 memories and 40 todos gives a variance estimate from a
   sample of 2 — unstable by construction. RRF needs only within-list rank
   and degrades gracefully with tiny per-type counts.

4. *One registry DO holding all active leases* vs. one DO per todo. Rejected
   the registry: at thousands of todos with likely single-digit concurrent
   claims, a shared registry serializes unrelated claims behind one object
   for no benefit. Per-todo DOs shard for free; the cost (more objects to
   reason about) is real but small since DOs are idle-billed and isolated.

5. *Trigger-synced external-content FTS for skills too*, matching todos and
   memories. Rejected: a skill's searchable document is "current head," not
   "every version ever published" — trigger-sync indexes every inserted row,
   keeping superseded SKILL.md bodies permanently searchable. Skills get an
   app-maintained FTS table instead — the one concept whose sync mechanism
   genuinely differs, itself evidence that one FTS strategy doesn't fit all
   three lifecycles.

**Honest weak points:**

- Fusion read-amplifies: an unfiltered search issues up to three `MATCH`
  queries instead of one query plan — fine at personal scale, but three
  round trips of row reads against D1's free-tier counters, not one.
- RRF gives a defensible *ordering*, not a comparable *magnitude* — a caller
  wanting a confidence threshold for auto-filtering doesn't get one that
  means the same thing across types without later per-type calibration.
- The D1 lease mirror is a second, laggy source of truth for "is this
  claimed." Never used to grant/deny a claim, but a reader hitting
  `list_todos` milliseconds after a claim can see stale state until the
  write-through lands or the sweep runs.
- `skill_fts` has no DB-level enforcement — a write to `skill_versions` that
  bypasses `publish_skill` leaves the index stale with no trigger to catch
  it. The guarantee is an application-layer rule, not a database constraint,
  unlike the other two concepts.
- A new concept is zero-touch for existing *data* but not for the search
  tool's own source — someone still hand-writes one more CTE branch and one
  more `fetch` dispatch arm. "Evolves independently" holds for schema and
  storage, not for the search implementation's line count.
