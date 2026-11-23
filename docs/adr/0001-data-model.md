# 0001. Data model: authoritative per-concept tables, one derived search projection

Date: 2026-10-12
Status: accepted

## Context

The frozen constraint from the product grilling: search spans all concepts in one ranked list, while each concept's schema evolves independently. Three competing designs were produced in parallel (design arena; candidates and judge report archived at `docs/research/arena-2026-10-12/`): A, a single unified catalog (one `items` table, JSON payloads, one FTS index); B, fully separate per-concept tables with per-concept FTS indexes fused at query time; C, authoritative per-concept tables publishing into one slim derived `search_index` table with one external-content FTS5 index.

The physics that decided it: BM25 scores are corpus-relative. Separate FTS indexes produce incomparable scores, so B needs reciprocal rank fusion across three MATCH queries per search, which triples row reads against D1's enforced daily limits and yields an ordering without comparable magnitudes. A gets one honest corpus but pays with type-specific lifecycle columns leaking into shared DDL and all typed fields collapsing into unvalidated JSON.

## Decision

Candidate C is the base, with grafts.

- Each concept owns real tables with real columns: `skills` + `skill_versions` (immutable rows, head pointer, `files_json` manifest for R2 bundles), `memories` (typed, tagged, three provenance columns), `todos` + `todo_updates` (append-only progress log).
- Concepts meet only at a frozen five-column projection: `search_index(doc_key, concept, concept_id, title, body, tags)` plus `search_fts`, an external-content FTS5 table synced by triggers from `search_index` alone. One BM25 query serves `search`; type filters are a column predicate.
- Each concept module exports one `project(row)` mapping to a projection row (or null to unpublish). Authoritative write and projection upsert run in one atomic `db.batch`. App code owns the semantic mapping (skills project only the head version, bodies cap at 16KB); triggers own only the mechanical index sync where the schema never changes.
- The projection and FTS are derived and disposable: excluded from backups, rebuilt by a `reindex` tool that re-runs every `project()` and issues the FTS `'rebuild'` command. The same tool reconciles drift weekly. This carries Mia's "files authoritative, index rebuildable" split and survives D1's inability to export virtual tables.
- Claiming per ADR-0002: a per-user coordinator DO owns to-do state transitions; D1 mirrors for display.

Grafts and their sources:

- From A: the fence floor persists in D1 (`todos.fencing_token`, write-through guarded `WHERE fencing_token < :token`), replacing C's +1000 token bump heuristic on DO rebuild. Recorded in ADR-0002.
- From A: revision snapshots generalize beyond skills. Memories get an append-only `memory_revisions` table written on edit, satisfying the spec's revisioned-memories requirement that C's base omitted.
- From B: claim conflicts return the current holder in the tool error, so a losing agent knows who to wait for.
- From B, confirming C: only skill head versions are indexed for search; superseded SKILL.md bodies never pollute ranking.

Rejected, with reasons:

- A's unified catalog: zero-DDL evolution was its best card, but `state`/`scope`/`version` as shared columns are type concepts leaking into shared DDL, every typed field lives in JSON validated only by zod, and its own rationale conceded the per-concept side-table escape hatch. The user's stated preference was concept-level flexibility with one searchable catalog, which is C.
- B's query-time fusion: three MATCH queries per search against enforced read limits, RRF orderings without comparable magnitudes, per-todo DOs whose fencing tokens restart on DO loss (unaddressed), and three FTS tables with two different sync mechanisms to maintain.
- Contentless FTS5 without a projection table: cannot delete individual rows or produce snippets. Disqualified in candidate C's own exploration.
- Triggers from authoritative tables straight into the projection: the mapping is semantic (head version, truncation), which triggers cannot express.

## Consequences

Gained: one ranked BM25 corpus, typed per-concept schemas, migrations that never cross a concept boundary, a new concept (documents, transcripts) lands as new tables plus one `project()` with zero DDL on search, and a backup story that is just the ordinary tables. Given up: searchable text is stored twice (authoritative row and projection), and publish discipline is a repository-layer convention rather than a database constraint, mitigated by atomic batches, the single write path owning D1 credentials, and weekly reconciliation. Inherited: the projection's five columns are frozen; anything a future concept wants searchable must compose into title, body, or tags at projection time, and a tokenizer change is a full (seconds-long, personal-scale) rebuild.

## Amendments

- 2026-10-14, V1-1. The projection carries a sixth column, `project`, alongside the five. Every concept in the spec has a project or scope, and the spec requires search to filter on it, so without the column a project filter means joining back to each concept's authoritative table, which is the per-concept fan-out this ADR exists to avoid. It stays a column predicate, like the `concept` filter. The frozen rule is unchanged: anything *searchable* still composes into title, body, or tags.
- 2026-10-14, V1-1. `search_fts_vocab`, an `fts5vocab` virtual table, reads the index's terms and counts. It is derived like everything else in the projection, it costs no storage, and it is how the weekly reconciliation and the tests compare index content across a rebuild. Raw shadow-table blocks cannot do that: an incrementally built index and a rebuilt one hold the same postings in different segments.
- 2026-10-14, V1-1. `skills.head_version_id` is nullable. A skill row and its first version are inserted in one batch, and the version references the skill, so the skill must land first.
- 2026-10-19, vector candidates and durable delivery (implemented locally; rollout blocked). Authoritative rows, FTS publication, immutable generation snapshots and the D1 vector outbox commit in one `db.batch`. Vectorize remains eventually consistent: a memory is findable by words immediately and by meaning after delivery becomes visible. Search admits only a vector whose workspace and generation/content stamp match a published, live D1 head; missing, stale or failed vectors never remove lexical results. Each unarchived revision has its own vector; older and superseded generations live in a separate history namespace, not the head candidate pool. Archives leave durable deletion targets. The existing nightly cron retries bounded delivery. Backups retain authoritative rows and revision history (and optionally vector snapshots for exact historical stamps), not the external index or completed delivery ledger. Restore rebuilds FTS and enqueues vectors into a fresh namespace; it never trusts old acknowledgements. ADR-0013 records the delivery mechanism, commands and rollout blockers.

- 2026-10-21, rollout capacity. ADR-0013 replaces nightly-only vector delivery
  with a bounded minute drain and resumable namespace backfill. Authoritative
  publication remains atomic; vector acceptance and visibility remain eventual.

- 2026-10-21, projection table. The projection is now `search_docs` with
  `search_docs_fts`, because `search_index`'s concept CHECK refused the
  concepts ADR-0015 adds and widening it is a table rebuild. "A new concept
  lands with zero DDL on search" held for the columns, not the CHECK; the new
  table has none. ADR-0015's amendment of the same date records the cutover.

## Arena record

Candidates: A (unified catalog, Opus), B (per-concept tables, Sonnet), C (hybrid projection, Fable), identical constraints, divergent premises. All three converged on DO-based claiming with lease and fencing, which ADR-0002 adopts. Parent scored C 29, A 27.5, B 23.5 on the six-criterion rubric (cross-concept search, independent evolution, claiming, rebuildability, simplicity, skill versioning).

Cross-vendor judge (codex, gpt-5.6-terra) scored C 26, A 25, B 19 and recommended C independently, so the pick carries Claude-plus-codex agreement, the strongest signal the panel setup produces. Full report at `docs/research/arena-2026-10-12/judge.md`. Its required fixes, both adopted: per-concept revision tables where the contract requires history (`memory_revisions`, already grafted from A), and mathematical fencing recovery, persist the issued token floor durably before a claim or transition returns rather than by asynchronous write-through (tightened in ADR-0002). Its spec-conformance catches, also adopted as amendments to C's DDL: `project` and `tags` columns on todos and skills so search filters work (C's base omitted them), and the backup export must name tables explicitly since D1 cannot dump FTS virtual tables. Its graft suggestions matched the ones recorded above; its fallback of per-ticket DOs if claim traffic ever becomes materially concurrent is noted and deferred.
