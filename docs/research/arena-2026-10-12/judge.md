## Verdict

Choose **Candidate C** as the base. It keeps concept-owned data models while providing the one global FTS5 corpus that the spec requires for a real cross-concept BM25 ranking. Its projection is small, disposable, and mechanically kept in sync with FTS. Fix its fencing recovery before implementation.

| Criterion | A. Unified catalog | B. Per-concept tables | C. Hybrid projection |
|---|---:|---:|---:|
| 1. Cross-concept search | **5**. One external-content FTS5 table makes `bm25()` genuinely comparable across all concepts, with a valid join back to the catalog. | **2**. The SQL is a valid RRF merge, but it is three BM25 searches with rank fusion rather than one cross-concept BM25 corpus, and it omits the required project and tag filtering. | **5**. `search_fts` is one valid external-content FTS5 corpus, and the query ranks it once before joining to the type-filterable projection. |
| 2. Independent evolution | **3**. JSON payloads avoid row rewrites, but every concept still shares the catalog shape, search document contract, and corpus statistics. | **5**. A field or concept can be added without changing existing concept tables or their FTS rows. | **5**. Concept tables own their data, while a new field only requires updating that concept's projector and its own derived entries. |
| 3. Claiming | **4**. The coordinator has a clear authority split, guarded monotonic D1 write-through, alarms, and a plausible rebuild path, although it serializes all of one user's claims. | **2**. Per-todo DO CAS is sound in isolation, but unguarded delayed D1 mirrors can overwrite newer state and the stated repair SQL does not run. | **3**. The DO owns transitions and has a useful mirror/retry design, but the arbitrary `+1000` token bump does not guarantee stale tokens remain fenced after a prolonged D1 outage. |
| 4. Rebuildability and backup | **4**. Authoritative tables can restore without the virtual table and rebuild FTS, although the proposed scheduled backup conflicts with the v1 no-cron constraint. | **3**. The ordinary-table backup and trigger rebuild are sound, but skill-index restoration is underspecified and DO loss has no real reseed procedure. | **4**. The projection and FTS are correctly disposable and a reindex command is the right recovery mechanism, but export must explicitly exclude virtual tables rather than imply a generic dump works. |
| 5. Simplicity | **5**. Four tables plus one FTS index is the smallest credible implementation for thousands of personal items. | **2**. Three FTS systems, three synchronization paths, fusion logic, and many per-item DOs are too much machinery for v1. | **4**. It adds one shared derived projection, but removes rank fusion and keeps authoritative schemas clear. |
| 6. Skill versioning | **4**. Head rows plus immutable snapshots can work, but versioning is entangled with generic catalog revision fields. | **5**. Immutable `skill_versions`, a head pointer, and separate file manifests are direct and isolated. | **5**. `skill_versions` are immutable and `skills.head_version_id` is a clean, narrow pointer. |

## Technical errors and blockers

### Candidate A

- It conflicts with the v1 infrastructure constraint by proposing a nightly cron Workflow.
- It has no `project` field despite search and every concept requiring project or scope filtering.
- Its DO rebuild query only reads `id`, `state`, and `rev`; it cannot reconstruct a valid claimed lease and must explicitly reset all reconstructed claimed items to pending.
- `stub.register(id)` is an undeclared lifecycle step. A claim can race creation unless the DO lazily initializes from D1 or creation and registration have a defined failure path.
- The schema cannot enforce the claim-write boundary. A future direct update to a todo can bypass the DO and violate its fencing convention.

### Candidate B

- `now()` is not a SQLite or D1 function. `lease_expires_at < now()` fails with `no such function: now`; use epoch timestamps or `datetime('now')` consistently.
- The D1 mirror writes after `claim_todo` and `complete_todo` have no fencing predicate. A delayed write from an older transition can overwrite a newer mirror state.
- Its crash repair only resets expired D1 rows. It does not describe how a lost or reset per-todo DO recovers its state or invalidates outstanding lease tokens.
- The memory FTS triggers are described in prose rather than supplied in DDL, so the stated schema does not actually keep memory search current.
- It lacks memory revisions, todo and skill tags, project fields, and archive semantics required by the spec.

### Candidate C

- `fencing_token + 1000` is not a correctness proof. If more than 999 transitions occur after the last successful D1 mirror, a rebuilt DO can issue a token below an outstanding lost token.
- Fix that by refusing further lease transitions until the authoritative durable token floor is acknowledged in D1, or persist every issued fence in an append-only D1 event before returning success. Rebuild from the recorded maximum, not an arbitrary offset.
- The backup text must name an export that excludes `search_fts`; D1 cannot export virtual FTS tables as part of a generic SQL dump.
- It also omits required project fields, memory revisions, and tags on todos and skills. Those are specification gaps, not reasons to abandon the shape.

## Recommendation

Use **Candidate C**, with these two changes before adoption:

1. Add per-concept revision tables where the contract requires history, starting with `memory_revisions`.
2. Make fencing recovery mathematical. Persist a durable maximum issued token before returning a claim or transition, then rebuild a DO from that maximum.

C best satisfies the frozen constraint. It does not pretend separate FTS indexes can produce a single BM25 corpus, and it does not force skills, memories, and todos into one sparse row model.

## Best grafts

- From **A**, graft its guarded monotonic D1 mirror write pattern. A stale or retried transition must only write when its fencing value exceeds the stored floor.
- From **B**, graft one DO instance per todo if claim traffic becomes materially concurrent. It removes unrelated-ticket serialization while keeping D1 responsible for listing candidates.

The decisive principles were **Model the Domain**, which favors separate authoritative models for genuinely different lifecycles, **Separate Before Serializing Shared State**, which rejects D1 mirrors as claim authority, and **Prove It Works**, which treated the `now()` SQL and FTS rebuild paths as executable claims rather than prose.

Deviations from the ask: none.