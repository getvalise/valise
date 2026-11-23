# Valise v1 implementation plan

Valise v1 is one Cloudflare Worker that serves skills, memories, and to-dos to any MCP client. This plan turns `docs/specs/2026-10-12-valise-v1-spec.md` and the ADRs into pull requests. The rule the program enforces is that no slice merges on a passing test suite alone, because every v1 acceptance check in the spec is a real client talking to a real endpoint. V1-1 through V1-6 build the endpoint and the console in order. V1-7 through V1-10 are the second pass, opened after the first six ran against real clients and the gaps showed: a consent screen that granted one scope at a time, skills reachable only behind a listing tool, no way to tell whether a model reads a tool description correctly, and a console whose stylesheet never loaded.

**Frozen 2026-10-17 by ADR-0010.** This was the program's checklist for twenty-six slices — V1-26 landed on trunk while this freeze was in flight, so its boxes are the last ones this file ever takes. Every box keeps the state it had when the decision landed — 617 ticked, 71 not — because the boxes are the evidence trail for what each slice touched and what proved it. Do not tick one, and do not add one. Open work lives in the Valise instance: `list_ready` over MCP, or `/todos`. The open boxes that still named real work became to-dos in the same change that froze this file; the rest were per-PR rituals nobody was ever going to tick once.

## How to read this

One box was one unit of work, and every box names the evidence that checked it. A nested box is a sub-step of the box above it. A box was ticked only when its evidence existed: a file, a log line, an artifact, a test run, or a SHA. The body is a how-to. The appendices explain and record.

Tests alone were not sufficient verification. A PR counted as verified only when its unit and live boxes were both checked.

## Program checklist

### Arm the program

- [x] State the plan to the user, then stop. Start execution only on an explicit go.
- [x] Read these from trunk at program start, and again whenever the run resumes.
  - [x] `git show origin/main:docs/specs/2026-10-12-valise-v1-spec.md`
  - [x] `git show origin/main:docs/adr/0001-data-model.md`
  - [x] `git show origin/main:docs/adr/0002-claiming-semantics.md`
  - [x] `git show origin/main:docs/adr/0003-mcp-tool-surface.md`
  - [x] `git show origin/main:docs/adr/0004-auth-and-scopes.md`
  - [ ] `git show origin/main:skills/dstack/dstack-mode/playbooks/opening-a-pr.md` from the owner's private tools repo
- [ ] Name the wake mechanism for unattended stretches, per `playbooks/autonomous-run.md`. Never leave the cadence to memory.
- [ ] Keep a decision trail per the **show-me-your-work** skill when the user reviews this after stepping away.

### Order the work

- [ ] Follow this dependency graph. Start dependent work only after its parent merges, or base it on the parent branch when stacking.
  - [x] V1-1 is first and branches from `main`. Nothing else can start, because every later PR reads the schema.
  - [ ] V1-2 after V1-1.
  - [ ] V1-3 and V1-4 both after V1-2. They are independent of each other in logic but both register tools in `app/mcp/tools.ts`, so whichever lands second rebases onto the first.
  - [ ] V1-5 after V1-4, because the scope map can only be enforced once all eleven tools exist.
  - [ ] V1-6 after V1-5, because the console reuses the session cookie that V1-5 introduces.
- [ ] Hold the file boundaries. V1-1 alone writes `drizzle/` and `app/db/schema.ts`. Later PRs add migrations, never edit `0000_init.sql`.
- [ ] Hold the review gate. V1-5 and V1-6 change behavior a person sees and touch auth. They wait for the user's review before merge.
- [ ] Treat any direct `UPDATE todos SET state` outside the coordinator as a bug, per ADR-0002.

### PR mechanics, for every PR

- [ ] Open the PR ready, never draft, with `gh pr create`.
- [ ] Run the repo's lint, typecheck, and tests once before the PR-facing push. The owner's earlier Cloudflare app, whose pieces this plan copies, ships no lint script, so V1-1 adds `biome` and the `lint` script rather than inheriting the gap.
- [ ] Run `/simplify` before each commit and `/no-comments` before review.
- [ ] Triage every review comment on its merits per `../references/review-triage.md`.
- [ ] Rebase onto current trunk before the merge-ready report.

### Verdict and merge, for every PR

- [ ] At the merge-ready head SHA, verify per the PR's **Verify, unit** and **Verify, live** blocks. Add an audit pass that reads the diff and the receipts and distrusts the PR body.
- [ ] Clean only when every check passes. Findings go back to the owner. A new head gets a fresh verdict.
- [ ] The owner merges. No auto-merge on any PR, because this repo has no CI gate on day one.

## Land the schema and the rebuildable search projection (V1-1)

**Depends on.** None.

**Files.**

- [x] Create `package.json`.
- [x] Create `wrangler.jsonc`.
- [x] Create `drizzle.config.ts`.
- [x] Create `app/db/schema.ts`.
- [x] Create `drizzle/0000_init.sql`.
- [x] Create `app/search/project.ts`.
- [x] Create `app/search/reindex.ts`.
- [x] Create `app/search/query.ts`, `app/search/write.ts`, `app/search/seed.ts`.
- [x] Create `workers/app.ts` with the loopback-only dev levers. V1-2 mounts the MCP handler on the same file.
- [x] Create `scripts/dev-lever.mjs` and `scripts/restore.sh`.
- [x] Create `biome.jsonc` and `test/d1/env.d.ts`.
- [x] Create `scripts/reindex.mjs`.
- [x] Create `scripts/dev-seed.mjs`.
- [x] Create `vitest.d1.config.ts`.
- [x] Create `tsconfig.json`.
- [x] Create `test/d1/apply-migrations.ts`.
- [x] Create `test/d1/schema.worker.test.ts`.

**Build.**

- [x] Declare bindings in `wrangler.jsonc`, copying the shape from the earlier app's `wrangler.jsonc`. `DB` as D1 with `migrations_dir` set to `drizzle`, `BUNDLES` as R2, `OAUTH_KV` as KV, `TODO_COORDINATOR` as the Durable Object namespace V1-3 fills in.
- [x] Write the seven authoritative tables in `app/db/schema.ts` per ADR-0001. `skills`, `skill_versions`, `memories`, `memory_revisions`, `todos`, `todo_updates`, `search_index`.
- [x] Land the two amendments ADR-0001 records from the judge. A `project` column and a `tags` column on both `todos` and `skills`, and the `memory_revisions` table.
- [x] Hand-write the FTS5 half of `drizzle/0000_init.sql`. drizzle-kit generates ordinary tables only, so `CREATE VIRTUAL TABLE search_fts USING fts5(title, body, tags, content='search_index', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2')` and the three sync triggers are written by hand under the generated output.
- [x] Export one `project(row)` per concept from `app/search/project.ts`, each returning the frozen five columns or null to unpublish. Skills project the head version only. Bodies truncate at 16KB.
- [x] Write `reindex(env, concepts?)` in `app/search/reindex.ts`. It clears the projection rows for the named concepts, re-runs every `project()`, then issues `INSERT INTO search_fts(search_fts) VALUES('rebuild')`. This is the restore path and the weekly drift reconciliation in one function. `scripts/reindex.mjs` is its CLI entry, taking `--all` or `--concept`.
- [x] Write `scripts/dev-seed.mjs` to insert one skill, one memory, and one to-do sharing a term, so ranking across concepts is observable from the first commit.

**You see.**

- [x] `npm run db:migrate` lists `0000_init.sql` with an ok status and reports every statement executed, including the virtual table and the three triggers, with no statement skipped.
- [x] After `node scripts/dev-seed.mjs`, the ADR-0001 search query returns three rows, one per concept, with `bm25()` values negative and ascending order putting the strongest match first.
- [x] `node scripts/reindex.mjs --all` run against a projection emptied by hand restores the same three rows and the same ranking.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] `test/d1/schema.worker.test.ts` gains four cases against a real D1 through `@cloudflare/vitest-pool-workers`, following the earlier app's `test/d1/migration.worker.test.ts` and its `readD1Migrations` setup. Migrations apply from empty. An upsert on an existing `doc_key` removes the stale tokens from `search_fts`. A `project()` returning null unpublishes the row. `reindex` reproduces the index byte for byte after a manual truncate. Run `npm run test:d1`.
- [x] `INSERT INTO search_fts(search_fts) VALUES('integrity-check')` passes at the end of each case. Run `npm run test:d1`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked. Drive the real surface through the wrangler CLI against the local D1 engine, which is workerd's SQLite rather than the system one.

- [x] Lane 1. Apply migrations into an empty database with `wrangler d1 migrations apply DB --local`. Save `.context/evidence/v1-1-migrate.txt`. Pass when the migration reports ok and no statement errors.
- [x] Lane 2. Seed, then run the ADR-0001 search query with a type filter through `wrangler d1 execute DB --local`. Save `.context/evidence/v1-1-search.json`. Pass when three concepts rank in one result set and the filter drops to two.
- [x] Lane 3. Prove the backup story. Run `wrangler d1 export DB --local` with no table flags, then again naming only the authoritative tables. Save `.context/evidence/v1-1-export.txt` and `.context/evidence/v1-1-export-filtered.sql`. Pass when the unfiltered export fails on the virtual table and the filtered export contains every authoritative table and neither `search_fts` nor `search_index`.
- [x] Lane 4. Restore from the filtered dump into a fresh local database, then run `reindex --all`. Save `.context/evidence/v1-1-restore.json`. Pass when the Lane 2 query returns identical rows and identical ranking.

**Lane results, 2026-10-14.** Artifacts are under `.context/evidence/`, which git ignores, so the numbers are here too. Lane 1: `0000_init.sql` applied into an empty local D1, 25 commands, no statement errors. Lane 2: `duckdb` ranked memory, to-do, skill in one result set at -1.952e-6, -1.666e-6, -1.531e-6; a `concept` filter dropped it to two, a tag filter to one, and an unmatched project filter to none. Lane 3: the unfiltered export failed with `cannot export databases with Virtual Tables (fts5)`; the export naming the six authoritative tables produced a dump with four rows and zero FTS artifacts. Lane 4: `scripts/restore.sh` loaded that dump into a fresh database and `reindex --all` reproduced Lane 2's rows, order, and scores byte for byte. The magnitudes are near zero because every seeded document contains the query term, which is the calibration caveat Appendix C names, not a defect.

**Review gate.** None. V1-1 is not review-gated.

**Merge.**

- [x] Clean verdict at the exact head SHA.
- [x] Review-comment triage done.
- [x] Rebased onto current trunk after the verdict.
- [x] The owner merges.

## Serve search, fetch, and save_memory over MCP (V1-2)

**Depends on.** V1-1.

**Files.**

- [x] Create `workers/app.ts`.
- [x] Create `workers/mcp.ts`.
- [x] Create `app/mcp/contracts.ts`.
- [x] Create `app/mcp/tools.ts`.
- [x] Create `app/concepts/memories.ts`.
- [x] Create `scripts/mcp-probe.mjs`.
- [x] Create `vitest.mcp.config.ts`.
- [x] Create `test/mcp/fixture-worker.ts`.
- [x] Create `test/mcp/search.worker.test.ts`.

**Build.**

- [x] Mount `createMcpHandler` from `agents/mcp` at the MCP route in `workers/app.ts`. The package is `agents`, confirmed at 0.28.0, above the 0.20 floor the spec names.
- [x] Write the zod input and output schemas for `search`, `fetch`, and `save_memory` in `app/mcp/contracts.ts`, mirroring the earlier app's `app/lib/mcp/contracts.ts` layout so V1-5 can bolt the scope map onto the same object.
- [x] Register the three tools in `app/mcp/tools.ts`. Write each description for the model, stating when to call it, because description text is the only discovery mechanism in clients without SEP-2640.
- [x] Implement `search` as the single ADR-0001 query with optional `type`, `project`, and `tag` filters. Implement `fetch` as a prefix dispatch on `doc_key` to the authoritative table, never to the projection.
- [x] Implement `save_memory` in `app/concepts/memories.ts` as one `db.batch` holding the `memories` insert and the `search_index` upsert, so row and projection commit together.
- [x] Take provenance from the request context rather than caller-supplied strings, per ADR-0003. Until V1-5 lands OAuth, a dev-only header supplies it and the handler refuses to start when `wrangler dev` is not local.
- [x] Write `scripts/mcp-probe.mjs`, a scripted Streamable HTTP MCP client that runs `initialize`, `tools/list`, and any `tools/call` named on the command line, printing raw JSON-RPC. The earlier app has no such script, so this is new and every later PR reuses it.

**You see.**

- [x] `node scripts/mcp-probe.mjs tools/list` prints exactly three tools with their descriptions.
- [x] `node scripts/mcp-probe.mjs search '{"query":"duckdb"}'` returns ranked snippets carrying `doc_key` ids, and passing the same id to `fetch` returns the full authoritative record.
- [x] A `save_memory` call followed immediately by the same `search` query returns the new memory in the ranking, proving the projection upsert committed in the same batch.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] `test/mcp/search.worker.test.ts` gains cases driving real JSON-RPC against the real handler through `test/mcp/fixture-worker.ts`, after the earlier app's `test/mcp/fixture-worker.ts` pattern. Ranked cross-concept results, type filtering, `fetch` on each prefix, and a `save_memory` round trip. Run `npm run test:mcp`.
- [x] A rejected `save_memory` missing `type` or `tags` returns a tool error naming the field, not a thrown exception. Run `npm run test:mcp`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked. Drive the real surface through `scripts/mcp-probe.mjs` against a running `wrangler dev`.

- [x] Lane 1. Discovery. Run `tools/list` against `wrangler dev`. Save `.context/evidence/v1-2-tools.json`. Pass when three tools appear with non-empty descriptions and valid JSON Schema.
- [x] Lane 2. Cross-concept ranking. Search a term seeded into all three concepts, then repeat with a type filter. Save `.context/evidence/v1-2-search.json`. Pass when the unfiltered call ranks all three and the filtered call returns only the named type.
- [x] Lane 3. Write then read. Call `save_memory`, then `search`, then `fetch` on the returned id. Save `.context/evidence/v1-2-roundtrip.json`. Pass when the memory is searchable in the next request and `fetch` returns the body as written.
- [x] Lane 4. ChatGPT contract shape. Assert the `search` and `fetch` payloads against the Deep Research contract the spec names. Save `.context/evidence/v1-2-deepresearch.json`. Pass when `search` returns id, title, and snippet per result and `fetch` returns id, title, text, and metadata.

**Review gate.** None. V1-2 is not review-gated.

**Merge.**

- [x] Clean verdict at the exact head SHA.
- [x] Review-comment triage done.
- [x] Rebased onto current trunk after the verdict.
- [x] The owner merges.

## Claim to-dos through the coordinator Durable Object (V1-3)

**Depends on.** V1-2.

**Files.**

- [x] Create `app/do/todo-coordinator.ts`.
- [x] Create `app/concepts/todos.ts`.
- [x] Edit `app/mcp/tools.ts`.
- [x] Edit `app/mcp/contracts.ts`.
- [x] Edit `wrangler.jsonc`.
- [x] Create `scripts/claim-race.mjs`.
- [x] Create `test/mcp/claiming.worker.test.ts`.

**Build.**

- [x] Write `TodoCoordinator` with SQLite storage, addressed by `idFromName('todos:' + userId)` per ADR-0002. One instance per user, not one per ticket.
- [x] Implement `claim`, `renew`, `complete`, `block`, and `release` as single-threaded methods. A claim is granted only when state is `pending`, or `claimed` with an expired lease.
- [x] Put the fence floor on the synchronous path. A transition returns success only after the guarded `UPDATE todos SET fencing_token = :token WHERE todo_id = :id AND fencing_token < :token` commits in the same request. This is the graft ADR-0001 records from candidate A and the correctness fix the cross-vendor judge demanded.
- [x] Reseed lazily from D1 when the coordinator has no row for a ticket, resuming tokens at the stored floor plus one. Never use a fixed offset.
- [x] Schedule the alarm at the earliest `lease_expires_at`. On fire, flip expired claims to `pending`, append a release entry to `todo_updates`, and write through. The progress log survives expiry so the next claimant inherits the findings.
- [x] Mirror `state`, `lease_holder`, and `lease_expires_at` to D1 asynchronously with an unmirrored flag and alarm retry. Only the fence floor is synchronous.
- [x] Register `create_todo`, `list_ready`, `claim_todo`, `update_todo`, and `complete_todo`. A stale fencing token returns a tool error naming the current holder, the graft from candidate B.

**You see.**

- [x] `node scripts/claim-race.mjs 8` fires eight concurrent `claim_todo` calls at one ticket and prints exactly one success and seven errors, each naming the winner.
- [x] A `claim_todo` with a 5 second TTL, left alone, shows the ticket back in `list_ready` after the alarm fires, with its progress entries intact.
- [x] An `update_todo` carrying the previous token after a re-claim returns a tool error naming the new holder, not a silent write.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] `test/mcp/claiming.worker.test.ts` gains cases for concurrent claims resolving to one winner, lease renewal extending expiry, a stale token rejected on both `update_todo` and `complete_todo`, and alarm expiry returning the ticket to `pending`. Run `npm run test:mcp`.
- [x] A coordinator whose storage is deleted mid-test reseeds from D1 and issues a token strictly above every token it previously handed out. Run `npm run test:mcp`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked. Drive the real surface through `scripts/claim-race.mjs` and `scripts/mcp-probe.mjs` against a running `wrangler dev`.

- [x] Lane 1. The race. Eight concurrent `claim_todo` calls at one ticket. Save `.context/evidence/v1-3-race.json`. Pass when exactly one call succeeds and every loser names the winner.
- [x] Lane 2. Expiry without cooperation. Claim with a 5 second TTL and never call back. Save `.context/evidence/v1-3-expiry.json`. Pass when `list_ready` shows the ticket again and `fetch` still shows the progress log.
- [x] Lane 3. Fencing across a coordinator reset. Claim, delete the Durable Object storage, claim again, then replay the first token. Save `.context/evidence/v1-3-fence.json`. Pass when the replayed token is rejected and the new token exceeds the old one.
- [ ] Lane 4. Two real agents. Open two Claude Code sessions against the dev endpoint and have both run `claim_todo` on the same ticket. Save `.context/evidence/v1-3-two-agents.txt`. Pass when one session reports the claim and the other reports the holder, which is spec acceptance check 1.

**Review gate.** None. V1-3 is not review-gated.

**Merge.**

- [x] Clean verdict at the exact head SHA.
- [x] Review-comment triage done.
- [x] Rebased onto current trunk after the verdict.
- [x] The owner merges.

## Publish and serve skills with R2 bundles (V1-4)

**Depends on.** V1-2.

**Files.**

- [x] Create `app/concepts/skills.ts`.
- [x] Create `app/r2/bundles.ts`.
- [x] Create `app/mcp/resources.ts`.
- [x] Edit `app/mcp/tools.ts`.
- [x] Edit `app/mcp/contracts.ts`.
- [x] Edit `app/search/project.ts`.
- [x] Create `skills/capture-this/SKILL.md`.
- [x] Create `test/mcp/skills.worker.test.ts`.

**Build.**

- [x] Implement `publish_skill` as an append-only `skill_versions` insert plus a `skills.head_version_id` move plus a projection upsert, all in one `db.batch`. Versions are never updated.
- [x] Write bundle files to R2 under `u/{user}/skills/{skill_id}/{version}/{path}` before the batch, so a crash leaves orphan objects rather than a dangling manifest. Record path, sha256, and size in `files_json`.
- [x] Copy the earlier app's write-once R2 pattern from `app/lib/artifacts/object-store.server.ts`, the `onlyIf` etag guard and the re-head checksum confirmation, and its path sanitizer.
- [x] Return `publish_skill` validation failures as `is_error` tool results listing every specific violation, so the model repairs and retries. This is the vibe garden repair loop ADR-0003 names.
- [x] Project only the head version into `search_index`, so superseded SKILL.md bodies never enter the ranking.
- [x] Serve the same data through SEP-2640 `skill://` resources with `skills/list` and `skills/get`, registered alongside the tools.
- [x] Author `skills/capture-this/SKILL.md` and publish it through `publish_skill`, so Valise ships its first skill through itself.

**You see.**

- [x] Publishing the same body twice is a no-op on content hash and does not create a second version.
- [x] `get_skill` with no version returns the head, and with a pinned version returns the older body, both after three publishes.
- [x] A search for a term that appears only in version 1 returns nothing once version 2 is head.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] `test/mcp/skills.worker.test.ts` gains cases for publish creating an immutable version and moving the head, pinned `get_skill` retrieval, idempotent republish on matching hash, and head-only indexing. Run `npm run test:mcp`.
- [x] A `publish_skill` with malformed frontmatter returns an `is_error` result naming each violation, and writes no row and no R2 object. Run `npm run test:mcp`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked. Drive the real surface through `scripts/mcp-probe.mjs` against a running `wrangler dev`, then through the Claude mobile app once V1-5 exposes it publicly.

- [x] Lane 1. Publish and pin. Publish three versions, then `get_skill` at head and at version 1. Save `.context/evidence/v1-4-versions.json`. Pass when both bodies come back correct and `skill_versions` holds three rows.
- [x] Lane 2. Head-only ranking. Search a term unique to version 1 after version 2 is head. Save `.context/evidence/v1-4-headonly.json`. Pass when the result set is empty.
- [x] Lane 3. Bundle round trip. Publish a skill with a `scripts/run.py` file, then read it back. Save `.context/evidence/v1-4-bundle.json`. Pass when the returned sha256 matches the uploaded file and the R2 key carries the version.
- [x] Lane 4. Two doors. Call `list_skills` and `skills/list` for the same corpus. Save `.context/evidence/v1-4-two-doors.json`. Pass when both return the same set of names and descriptions.

**Review gate.** None. V1-4 is not review-gated.

**Merge.**

- [x] Clean verdict at the exact head SHA.
- [x] Review-comment triage done.
- [x] Rebased onto current trunk after the verdict.
- [x] The owner merges.

## Put OAuth and scopes in front of the endpoint (V1-5)

**Depends on.** V1-4.

**Files.**

- [x] Create `workers/oauth.ts`.
- [x] Create `app/lib/auth.server.ts`.
- [x] Edit `workers/mcp.ts`.
- [x] Edit `app/mcp/contracts.ts`.
- [x] Create `app/concepts/tokens.ts`.
- [x] Create `scripts/first-deploy.sh`.
- [x] Create `test/mcp/scopes.worker.test.ts`.

**Build.**

- [x] Install `@cloudflare/workers-oauth-provider` at 1.x, confirmed at 1.2.3 on npm. The earlier app runs 0.8.0, so its wiring is a reference and not a copy, and the upgrade delta is read before the first line.
- [x] Port `createOAuthProvider` and `isOAuthProviderPath` from the earlier app's `workers/oauth.ts`, keeping PKCE required, implicit flow off, and plain PKCE off.
- [x] Seed the dynamic client registration allowlist from the earlier app's `supportedRedirectUri`. The claude.ai callback exactly, the ChatGPT connector callback by prefix, and localhost and loopback for development.
- [x] Add `preflightMcpRequest` to `workers/mcp.ts`, ported from the earlier app. Attach `{ schema, scope }` to every one of the eleven tools and check scope before the MCP SDK sees the call.
- [x] Answer scope failures with `insufficient_scope` and a `WWW-Authenticate` challenge, so capable clients can step up.
- [x] Implement long-lived bearer tokens in `app/concepts/tokens.ts`, each bound to a scope set and a label, with the label feeding provenance. Creation and revocation are UI actions in V1-6, CLI-visible here.
- [x] Port human session auth from the earlier app's `app/lib/auth.server.ts`, the signed opaque session id and the D1-backed `sessions` row, not a stateless token.
- [x] Declare per-tool rate limits keyed on the `Mcp-Method` and `Mcp-Name` headers, so limiting needs no JSON parsing.
- [x] Adapt the earlier app's `scripts/first-deploy.sh` to create the D1 database, apply migrations remotely, generate secrets, and deploy.

**You see.**

- [x] A token holding only `search:read` calling `save_memory` gets HTTP 403, an `insufficient_scope` body, and a `WWW-Authenticate` header.
- [x] A registration attempt from an unlisted redirect URI is refused at `/register`.
- [ ] Adding the deployed endpoint as a connector on claude.ai web completes the PKCE flow and lists eleven tools.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] `test/mcp/scopes.worker.test.ts` drives every tool through the real provider with scoped bearer tokens, asserting refusal without its scope and success with it. Run `npm run test:mcp`.
- [x] Cases for a refused DCR redirect URI, a rejected plain PKCE attempt, and a revoked bearer token failing on the next call. Run `npm run test:mcp`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked. Drive the real surface through the deployed Worker, using real clients rather than the probe script alone.

- [ ] Lane 1. Claude Code over HTTP. Run `claude mcp add --transport http` against the deployed endpoint and call `search`. Save `.context/evidence/v1-5-claude-code.txt`. Pass when the OAuth flow completes and the search returns ranked results.
- [ ] Lane 2. Claude mobile. Add the connector on claude.ai web, then from the phone save a memory through `/capture-this` and retrieve it by search. Save `.context/evidence/v1-5-mobile.png`. Pass when the memory written on the phone comes back in search, which is spec acceptance check 2.
- [ ] Lane 3. ChatGPT developer mode. Connect the endpoint and run a query that exercises `search` and `fetch`. Save `.context/evidence/v1-5-chatgpt.png`. Pass when ranked results span all three concepts, which is spec acceptance check 4.
- [ ] Lane 4. Scope denial on the real endpoint. Mint a `search:read` bearer token and call `save_memory` with it. Save `.context/evidence/v1-5-scope-denied.txt`. Pass when the response is 403 with an `insufficient_scope` body and a challenge header.
- [ ] Lane 5. Skills on the phone. From the Claude mobile app, list skills and pull one body into context. Save `.context/evidence/v1-5-mobile-skills.png`. Pass when the skill body arrives, which is spec acceptance check 3.

**Review gate.** The owner reviews before merge. This PR exposes a public endpoint on a personal Cloudflare account and owns token lifecycle.

- [x] Post the artifacts from the live lanes. Stop at merge-ready and wait.

**Merge.**

- [x] Clean verdict at the exact head SHA.
- [x] Review-comment triage done.
- [x] Rebased onto current trunk after the verdict.
- [x] The owner merges.

## Ship the management console (V1-6)

**Depends on.** V1-5.

**Files.**

- [x] Create `app/routes/`.
- [x] Create `app/root.tsx`.
- [x] Create `react-router.config.ts`.
- [x] Create `playwright.config.ts`.
- [x] Create `test/ui/console.spec.ts`.
- [x] Edit `workers/app.ts`.

**Build.**

- [x] Stand up React Router framework mode with the earlier app's visual language, the sand canvas, the cards, and the 2px borders. No chat surface.
- [x] Build a list view per concept with search, filter, edit, and archive. Deletion lives here only, never in the MCP surface, per ADR-0003.
- [x] Build the skill editor with version history and a publish action that calls the same code path as `publish_skill`.
- [x] Build the to-do board showing status, claim holder, a live lease countdown, and the progress log. Read the mirrored D1 columns and label them as possibly seconds stale, per ADR-0002.
- [x] Build the connections page listing OAuth clients and bearer tokens with their scopes, and a revoke action.
- [x] Guard every route with `requireUser` from the ported `auth.server.ts`.

**You see.**

- [x] Editing a to-do in the console shows the new body from an agent's next `fetch` call.
- [x] Archiving a memory removes it from `search` results on the next request, through a `project()` returning null.
- [x] Publishing a skill version in the editor makes `get_skill` return the new head immediately.
- [x] Revoking a bearer token on the connections page makes the next call with that token fail.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] `test/ui/console.spec.ts` gains Playwright cases for the four flows above, each asserting the agent-visible effect through a direct MCP call in the same test. Run `npm run test:ui`.
- [x] A logged-out visit to every console route redirects to the login page. Run `npm run test:ui`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked. Drive the real surface through the Playwright MCP against the deployed console, with `scripts/mcp-probe.mjs` checking the agent side of each flow.

- [ ] Lane 1. Edit a to-do, then fetch it as an agent. Save `.context/evidence/v1-6-todo-edit.png`. Pass when the agent sees the edit within one request.
- [ ] Lane 2. Archive a memory, then search for it. Save `.context/evidence/v1-6-archive.png`. Pass when the memory is gone from the ranking.
- [ ] Lane 3. Publish a skill version, then call `get_skill`. Save `.context/evidence/v1-6-publish.png`. Pass when the new body is head and the old version is still pinnable.
- [ ] Lane 4. Revoke a token, then call with it. Save `.context/evidence/v1-6-revoke.txt`. Pass when the call fails with 401. Lanes 1 through 4 together are spec acceptance check 5.

**Review gate.** The owner reviews before merge. This is the surface a person looks at every day and the only place deletion exists.

- [x] Post the artifacts from the live lanes. Stop at merge-ready and wait.

**Merge.**

- [x] Clean verdict at the exact head SHA.
- [x] Review-comment triage done.
- [x] Rebased onto current trunk after the verdict.
- [x] The owner merges.

## Grant the whole scope set at first consent (V1-7)

**Depends on.** V1-5.

**Files.**

- [x] Edit `app/lib/auth.server.ts`.
- [x] Edit `test/mcp/oauth.worker.test.ts`.
- [x] Create `scripts/oauth-roundtrip.mjs`.

**Build.**

- [x] Pass the full `MCP_SCOPES` vocabulary to `approveConsent`, so the grant holds every capability the client may ever need rather than the `search:read` baseline the client happened to ask for. The provider allows an approval wider than the request; `completeAuthorization` stores it verbatim.
- [x] Show the granted set on the consent page, grouped by concept, and say plainly that approving grants all of it. A consent screen that lists one scope and grants seven is a lie.
- [x] Keep the per-tool scope preflight and the `insufficient_scope` challenge. They are what a narrow bearer token still hits, and what a future per-client scope choice would use.
- [x] Keep bearer tokens granular. A token minted in the console carries only the scopes its checkbox set names, which is the one surface where narrow scope is the point.

**You see.**

- [x] One consent screen, then `list_skills`, `save_memory`, and `create_todo` all answer without a second authorization round trip.
- [x] A `search:read` bearer token still gets 403 and a challenge on `save_memory`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] `test/mcp/oauth.worker.test.ts` asserts that a client requesting only `search:read` receives a grant covering all seven scopes and that `save_memory` succeeds on the first token. Run `npm run test:mcp`.
- [x] The bearer-token case still asserts 403 plus `insufficient_scope` for an ungranted scope. Run `npm run test:mcp`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] Lane 1. `scripts/oauth-roundtrip.mjs` registers a client, drives the real consent page in a browser, exchanges the S256 code, then calls one tool per scope family on that single token. Save `.context/evidence/v1-7-single-consent.txt`. Pass when no call answers with an `insufficient_scope` challenge.
- [x] Lane 2. Screenshot the consent screen itself. Save `.context/evidence/v1-7-consent.png`. Pass when the page lists all seven scopes and says plainly that approving grants them.

**Review gate.** The owner reviews before merge. This changes what a consent screen gives away.

- [x] Post the artifacts from the live lanes. Stop at merge-ready and wait.

**Merge.**

- [x] Clean verdict at the exact head SHA.
- [x] Review-comment triage done.
- [x] Rebased onto current trunk after the verdict.
- [x] The owner merges.

## Serve each skill as its own tool and fix the SEP-2640 URIs (V1-8)

**Depends on.** V1-4.

**Files.**

- [x] Create `docs/adr/0005-skills-first-surface.md`.
- [x] Edit `app/mcp/resources.ts`.
- [x] Edit `app/mcp/tools.ts`.
- [x] Edit `workers/mcp.ts`.
- [x] Edit `app/concepts/skills.ts`.
- [x] Edit `app/mcp/contracts.ts`.
- [x] Edit `scripts/mcp-probe.mjs`.
- [x] Edit `test/mcp/skills.worker.test.ts`.

**Build.**

- [x] Move the resource URIs onto the scheme SEP-2640 actually defines: `skill://{name}/SKILL.md` for the instructions, `skill://{name}/{path}` for each bundled file, and `skill://index.json` for the enumerable index. The shipped `skill://skills/{name}` was invented and no host resolves relative references against it.
- [x] Declare `io.modelcontextprotocol/skills` alongside `resources` in the server capabilities, which is what tells a host it may call the skills methods at all.
- [x] Implement `skills/list` and `skills/get` as low-level request handlers, each entry carrying full frontmatter and a manifest of `{uri, digest, size}` over `SKILL.md` and every bundled file. The SDK has no skills vocabulary yet, so these ride `Server.setRequestHandler`.
- [x] Register one tool per published skill, `skill_{name}`, whose description is the skill's frontmatter description. The body arrives on call, not in `tools/list`, which keeps the progressive disclosure the extension is for.
- [x] Teach the scope preflight the `skill_` prefix so a per-skill tool needs `skills:read` like the rest of the skills family.
- [x] Record the amendment in ADR-0003 and the reasoning in ADR-0005. The eleven tools were frozen; a dynamic twelfth family is a contract change.

**You see.**

- [x] `tools/list` names one tool per published skill, each carrying its own description, with no `list_skills` round trip in between.
- [x] `resources/read` on `skill://capture-this/SKILL.md` returns the body, and the digest matches the one `skills/list` published.
- [x] Publishing a new skill makes its tool appear on the next `tools/list`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] `test/mcp/skills.worker.test.ts` asserts the per-skill tool exists, returns the head body, and needs `skills:read`. Run `npm run test:mcp`.
- [x] A case asserts `skills/list` manifest digests equal the sha256 of the bytes `resources/read` returns, for `SKILL.md` and for a bundled file. Run `npm run test:mcp`.
- [x] A case asserts `skills/get` answers for a skill, and `-32602` for an unknown URI. Run `npm run test:mcp`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] Lane 1. `scripts/mcp-probe.mjs tools/list` against a running dev server. Save `.context/evidence/v1-8-skill-tools.json`. Pass when every published skill has a tool and its frontmatter description.
- [x] Lane 2. `scripts/mcp-probe.mjs skills/list` then `resources/read` on the returned URI. Save `.context/evidence/v1-8-sep2640.json`. Pass when the digest and size match the bytes.

**Review gate.** None. V1-8 is not review-gated.

**Merge.**

- [x] Clean verdict at the exact head SHA.
- [x] Review-comment triage done.
- [x] Rebased onto current trunk after the verdict.
- [x] The owner merges.

## Measure whether models pick the right tool (V1-9)

**Depends on.** V1-8.

**Files.**

- [x] Create `evals/cases.json`.
- [x] Create `evals/run.mjs`.
- [x] Create `evals/README.md`.
- [x] Edit `package.json`.
- [x] Edit `app/mcp/tools.ts`, once the first run says which descriptions are confusable.

**Build.**

- [x] Read the tool surface from a live `tools/list` rather than a hand-kept copy, so an eval can never score a surface the server does not serve. ADR-0003 says the description text is the only discovery mechanism in fallback clients; this is the harness that tells us whether the text works.
- [x] Define each case as a user turn plus the tool that should answer it, including negative cases where the right answer is no tool call at all.
- [x] Send every case to every model through OpenRouter with the real tool definitions, one request per case per model, and record the tool the model chose and the arguments it built.
- [x] Score tool choice and argument validity separately. A model that picks `create_todo` and omits `project` is a schema problem, not a description problem, and the report must say which.
- [x] Write both a JSON run file and a markdown table, so a regression is a diff rather than a memory.

**You see.**

- [x] The report names, per model and per case, the tool chosen and whether it matched.
- [x] Rewording a tool description and rerunning moves a number.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] `node evals/run.mjs --list` prints the cases and the tools they target without calling a model. Run it.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] Lane 1. Run the suite across at least three model families against a local dev server. Save `evals/runs/` and `.context/evidence/v1-9-eval-report.md`. Pass when every case resolves to a scored row rather than a transport error.

**Review gate.** None. V1-9 is not review-gated.

**Merge.**

- [x] Clean verdict at the exact head SHA.
- [x] Review-comment triage done.
- [x] Rebased onto current trunk after the verdict.
- [x] The owner merges.

## Dress the console and open the workbench (V1-10)

**Depends on.** V1-6.

**Files.**

- [x] Edit `app/root.tsx`.
- [x] Create `public/valise.css`, and delete `app/styles/console.css`.
- [x] Create `app/components/ui.tsx`.
- [x] Create `app/routes/workbench.tsx`.
- [x] Edit `app/routes.ts` and every route under it.
- [x] Edit `scripts/roadmap.mjs`.
- [x] Create `scripts/console-shots.mjs`.
- [x] Edit `playwright.config.ts` and `test/ui/console.spec.ts`.

**Build.**

- [x] Render `<Links />` in the root layout. The stylesheet has never reached the browser, which is why the console renders as unstyled HTML; every visual complaint about the console traces to this one missing element.
- [x] Write the design tokens as CSS custom properties on one line of ownership: a bone ground, paper surfaces, three inks, and the trunk — the Globe-Trotter orange, its dark leather, and its brass.
- [x] Set the language as Swiss over luggage. A strict grid, one grotesque, hairlines rather than boxes, no shadow and no ornament, shadcn's control sizing. The orange is structural, not decorative: it is the strap across the top of every page, the focus ring, and the progress bar, and nowhere else. Brass is for labels and the dotted stud line; a didone appears once per page, on the title.
- [x] Build the shared primitives in `app/components/ui.tsx`: page header, card, tag, status pill, field, button, toolbar, empty state. Routes compose them instead of repeating class names.
- [x] Lift the duplicated workspace nav out of the four routes into one component, and give the console a disclosure for each per-item edit form so a list reads as a list rather than as a column of forms.
- [x] Add `/workbench`, a signed-in development page with two tabs: every primitive rendered in every state, and the roadmap. It is how a change to a token is reviewed without clicking through four routes.
- [x] Teach `scripts/roadmap.mjs` to emit `docs/roadmap.json` beside the HTML, from the same parse, and render the workbench roadmap tab from that file. One parse, two renderings, no drift.

**You see.**

- [x] The console renders in the Valise palette rather than browser defaults.
- [x] `/workbench` shows every primitive and the live roadmap, and is behind the session guard like every other route.
- [x] Editing one token changes the whole console.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] `test/ui/console.spec.ts` asserts the stylesheet loads and a known token resolves to its palette value in the browser. Run `npm run test:ui`.
- [x] A logged-out visit to `/workbench` redirects to the login page. Run `npm run test:ui`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] Lane 1. Screenshot every console route and the workbench against a running dev server. Save `.context/evidence/v1-10-console/`. Pass when each page is styled and legible at 1280 and at 390 wide.

**Review gate.** The owner reviews before merge. This is the surface a person looks at every day.

- [x] Post the artifacts from the live lanes. Stop at merge-ready and wait.

**Merge.**

- [x] Clean verdict at the exact head SHA.
- [x] Review-comment triage done.
- [x] Rebased onto current trunk after the verdict.
- [x] The owner merges.

## Watch the endpoint and score the surface (V1-11)

**Depends on.** V1-10.

**Files.**

- [x] Edit `app/db/schema.ts`, and add `drizzle/0003_faulty_fat_cobra.sql`.
- [x] Create `app/concepts/activity.ts`.
- [x] Create `app/mcp/observe.ts`.
- [x] Create `app/console/evals.server.ts`.
- [x] Create `evals/index.mjs`.
- [x] Edit `workers/mcp.ts`, `workers/app.ts`, and `wrangler.jsonc`.
- [x] Edit `app/console/context.server.ts` and `app/lib/auth.server.ts`.
- [x] Edit `app/routes/workbench.tsx` and `public/valise.css`.
- [x] Create `test/mcp/logging.worker.test.ts`, and edit `test/ui/console.spec.ts`.
- [x] Create `docs/adr/0006-call-log-and-eval-surface.md`.

**Build.**

- [x] Write one `mcp_calls` row per MCP request from the wrapper every transport already passes through, so the rate-limit and preflight rejections that return before `dispatch` are in the log rather than missing from it. ADR-0006.
- [x] Store the arguments as sent, capped at 8KB with the original length beside them. A count cannot answer "what did it send", which is the question the tab exists for.
- [x] Read the outcome from the response rather than guessing at the call site. A tool error and a refused input both answer 200 with `isError`, and only the body tells them apart. Parse a clone inside `waitUntil`, so the row costs the caller no latency.
- [x] Give a transport refusal its own outcome, `protocol_error`. A client that sends the wrong `Accept` header never reaches a tool, and filing that under `tool_error` buries the one thing the row is good for.
- [x] Record console sign-in, refused sign-in, sign-out, and both OAuth consent decisions in `auth_events`. `sessions` already implies the successes; the refusal is the row worth having.
- [x] Add the one cron trigger and trim on it: calls to 30 days, auth events to 90, expired sessions with them. The nightly backup export will share this trigger.
- [x] Build the logs tab: four counts, a per-tool table with its error rate and its argument sizes, a per-client table, the recent calls with their payload under a disclosure, and the auth trail. Filter by window, tool, client, and outcome.
- [x] Teach `evals/run.mjs` to write `evals/runs/index.json`, and build the evals tab from it: per-model totals with a delta against the previous run, and the per-case matrix in the same vocabulary the markdown report prints, so a change reads the same in both.
- [x] Count the routes that read a SKILL.md before acting as their own column. ADR-0005 made skills the first surface; `via skill` is the number that says whether it works.
- [x] Read the eval index on the server, not in the route module. The roadmap tab ships `docs/roadmap.json` to the browser; doing that with runs would grow the client bundle with every eval.

**You see.**

- [x] A tool call from any client shows up on the logs tab with the arguments it carried.
- [x] A call the preflight refuses is in the log, labelled `invalid_input`, with its arguments intact.
- [x] A client that cannot negotiate the transport reads as `protocol_error`, not as a tool failure.
- [x] Signing in adds a row to the auth trail; a wrong password adds one too.
- [x] Rewording a tool description, rerunning the evals, and reloading the tab moves a number and prints the delta.
- [x] Neither tab scrolls the page sideways at 390 wide. A dense table scrolls inside its own band instead.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] `test/mcp/logging.worker.test.ts` asserts the recorded method, tool, scope, arguments, and every outcome in the vocabulary, plus the aggregates and the retention trim. Run `npm run test:mcp`.
- [x] `test/ui/console.spec.ts` drives both tabs: a refused call appears with its payload under the disclosure, and the evals tab renders the summary and the matrix from the index. Run `npm run test:ui`.
- [x] The same spec asserts no page-level horizontal overflow at 390 wide on every console route, the regression a dense table causes by default. Run `npm run test:ui`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] Lane 1. Drive five clients' worth of traffic at a running dev server, then screenshot the logs tab at 1280 and at 390. Save `.context/evidence/v1-11-workbench/`. Pass when the per-tool and per-client tables, the outcomes, and the payloads all read.
- [x] Lane 2. Screenshot the evals tab against the indexed run. Save `.context/evidence/v1-11-workbench/09-workbench-evals.png`. Pass when every model has a row and every case has a cell.
- [x] Lane 3. Fire the scheduled handler at a running dev server with a row aged past the window. Save `.context/evidence/v1-11-cron.txt`. Pass when the row is gone and the `trim:` line names it.
- [ ] Lane 4. After deploy, confirm the trigger is registered and fires on its own.

**Review gate.** The owner reviews before merge. The log holds the arguments agents send, which is the most sensitive thing the database carries.

- [x] Post the artifacts from the live lanes. Stop at merge-ready and wait.

**Merge.**

- [x] Clean verdict at the exact head SHA.
- [x] Review-comment triage done.
- [x] Rebased onto current trunk after the verdict.
- [x] The owner merges.

## Give the console a modal, a combobox, and an icon set (V1-12)

**Depends on.** V1-10.

The console has one input primitive, `Field`, and a native `<select>` used twice. Everything past that is a `<details>` disclosure, because nothing else existed. A skill with twelve files does not read as a disclosure, and a model list of four hundred does not read as a `<select>`. This slice adds the three parts the next two slices need, and shows each one on the workbench so a token change is still reviewed in one place.

**Files.**

- [x] Create `app/components/modal.tsx`, `app/components/combobox.tsx`, and `app/components/icon.tsx`.
- [x] Edit `app/components/ui.tsx` and `public/valise.css`.
- [x] Edit `app/routes/workbench.tsx`.
- [x] Edit `package.json` to add `lucide-react`.
- [x] Edit `test/ui/console.spec.ts`.

**Build.**

- [x] Build the modal on the native `<dialog>` element and `showModal()`, so the focus trap, the inert background, and Escape are the platform's rather than ours. A controlled `open` prop, a `close` event that calls back, and a server render that is a closed `<dialog>` with its content present.
- [x] Dress `::backdrop` as a flat ink tint. The design language has no shadow and no gradient, and a blurred backdrop is both.
- [x] Add `Select` next to `Field`, taking the same label-and-name shape, so a form mixes the two without the caller writing a class name.
- [x] Build `Combobox` as the ARIA 1.2 combobox-with-listbox pattern: a text input that filters, a listbox of options, `aria-activedescendant` for the active row, arrow keys, Enter, Escape, and a hidden input carrying the chosen value so it posts with a plain form. No library, because the pattern is one file and a dependency here would own our keyboard behaviour.
- [x] Take `lucide-react` for icons and re-export a closed set through `app/components/icon.tsx`. A curated list typed as a union is what stops an icon sprawl; a free-form `name: string` is how a system ends up with three different ticks.
- [x] Draw icons at 16px with a 1.5 stroke, `currentColor`, and `aria-hidden` unless the caller names one. The system is built on hairlines, and lucide's default 2px stroke at 24px is heavier than every rule on the page.
- [x] Add a specimen per primitive to the components tab, each one operable rather than a screenshot: the modal opens, the combobox filters, every icon in the set is drawn with its name under it.

**You see.**

- [x] The modal opens on the workbench, traps focus, closes on Escape, and closes on the backdrop.
- [x] The combobox filters as you type, moves on arrow keys, selects on Enter, and submits the chosen value in a plain form post.
- [x] Every icon in the closed set is drawn on the components tab at the same weight as the hairlines around it.
- [x] The components tab still fits 390 wide without the page scrolling sideways.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] `test/ui/console.spec.ts` opens the modal, closes it with Escape, and drives the combobox by keyboard to a selection. Run `npm run test:ui`.
- [x] The existing overflow assertion covers the new specimens at 390 wide. Run `npm run test:ui`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] Lane 1. Screenshot the components tab at 1280 and at 390 with the modal open and the combobox filtered. Save `.context/evidence/v1-12-primitives/`. Pass when the modal reads as a card on a tinted ground and the listbox rows align to the input's hairline.

**Merge.**

- [x] Clean verdict at the exact head SHA.
- [x] Review-comment triage done.
- [x] Rebased onto current trunk after the verdict.
- [x] The owner merges.

## Count the turns and the tokens, and show the case behind the cell (V1-13)

**Depends on.** V1-11 for the eval index, V1-12 for the modal.

The evals tab scores whether a model picks the right tool and stops there. Two tools can both be chosen correctly and cost very differently: one is read in a single turn, the other costs a skill round trip and four thousand reasoning tokens. Cheapness is part of whether a description works, and nothing recorded it. The matrix also prints a cell with no way to see the case behind it, so reading a failure meant opening `evals/cases.json` beside the page.

**Files.**

- [x] Edit `evals/run.mjs`, `evals/index.mjs`, and `evals/README.md`.
- [x] Edit `app/console/evals.server.ts` and `app/routes/workbench.tsx`.
- [x] Edit `public/valise.css`.
- [x] Edit `test/ui/console.spec.ts`.
- [x] Commit the run the tab reads.

**Build.**

- [x] Ask OpenRouter for `usage: { include: true }` and keep what comes back: prompt, completion, reasoning, and cost in dollars. Reasoning is its own number because a description that forces a model to think twice is a description that costs, and it hides inside the completion count otherwise.
- [x] Count turns as model calls rather than as tool calls. A route that reads a skill and then acts is two turns and two calls; a route that answers in prose is one turn and no calls, and scoring those the same loses the `no-tool-*` cases.
- [x] Add `anthropic/claude-sonnet-5.5` and `openai/gpt-6-luna` to the default models. Six families rather than four, both slugs checked against `openrouter.ai/api/v1/models` rather than guessed.
- [x] Record the case definitions in the run file, not just their ids. A case edited after a run would otherwise print its new text under an old score, which is the one thing a kept run exists to prevent.
- [x] Total the turns, tokens, and cost per model in the index, and keep the per-cell numbers next to the per-cell outcome.
- [x] Add the three columns to the summary table, with the same delta against the previous run the scores already carry. A token count that moves is the signal a reworded description is paid for in tokens.
- [x] Make a matrix cell open its case in the modal: the prompt as sent, the system prompt, what the case expects, and what this model did with it.
- [x] Hold the index backwards compatible. A run written before this slice has no turns, no tokens, and no case bodies, and it has to keep rendering rather than crash the tab.

**You see.**

- [x] The summary table carries turns, tokens, and dollars per model, each with a delta against the previous run.
- [x] Clicking any cell in the matrix opens the case: its prompt, its `why`, what it expects, and the route this model took.
- [x] Six models have rows, including Sonnet 5.5 and GPT-6 Luna.
- [x] Selecting the run from before this slice still renders, with the new columns reading `—`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] `test/ui/console.spec.ts` asserts the three new columns and opens a case from the matrix. Run `npm run test:ui`.
- [x] The phone-width overflow assertion covers the widened summary table. Run `npm run test:ui`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] Lane 1. `npm run evals` against a running dev server, all six models, every case. Commit the run and its markdown report. Pass when every model has a turn count, a token count, and a cost.
- [x] Lane 2. Screenshot the evals tab with a case modal open. Save `.context/evidence/v1-13-evals/`. Pass when the matrix, the new columns, and the case body all read.

**Merge.**

- [x] Clean verdict at the exact head SHA.
- [x] Review-comment triage done.
- [x] Rebased onto current trunk after the verdict.
- [x] The owner merges.

## Ask why where the arguments cannot say it, and log what a client already says (V1-14)

**Depends on.** V1-11 for the call log.

The logs tab answers what a client sent and never why it sent it. For most tools that gap is imaginary: `search` carries the query, `publish_skill` carries the skill, and the argument is the intent. Two are not like that. `claim_todo`, `update_todo`, and `complete_todo` carry an opaque `todo:` id and a fencing token, and nothing says what the agent thought it was doing; a stranded lease is exactly the row you want to read, and today it is four fields of plumbing. `save_memory` looks answered because the body is right there, but ADR-0003 put classification on the agent, so the body says what was saved and nothing says why it was typed and tagged that way.

ADR-0007 holds the reasoning, including why this is four tools rather than twelve, why it is optional, and why it is never authorization evidence.

**Files.**

- [x] Create `docs/adr/0007-call-intent.md`, and edit `docs/adr/0003-mcp-tool-surface.md` and `docs/adr/0006-call-log-and-eval-surface.md`.
- [x] Edit `app/db/schema.ts`, and add a migration under `drizzle/`.
- [x] Edit `app/mcp/contracts.ts` and `app/concepts/todos.ts`.
- [x] Edit `workers/mcp.ts`, `app/mcp/observe.ts`, and `app/concepts/activity.ts`.
- [x] Edit `app/routes/workbench.tsx` and `public/valise.css`.
- [x] Edit `evals/run.mjs`, `evals/index.mjs`, `app/console/evals.server.ts`, and `evals/README.md`.
- [x] Edit `test/mcp/logging.worker.test.ts` and `test/ui/console.spec.ts`.

**Build.**

- [x] Take the context a client already sends before asking a model for any. `initialize` carries `clientInfo`, and the log throws it away: every row reads `oauth` because the non-tool branch records only a resource uri. Record the whole `params` for a non-tool method instead, which captures `clientInfo` today and anything a later revision adds without a second change.
- [x] Read a SEP-2817 `_meta` invocation reason ahead of any argument. The SEP is draft and no client ships it, so this is three lines that cost nothing now and cost nothing later either.
- [x] Add one optional `why` to `claim_todo`, `update_todo`, `complete_todo`, and `save_memory`. Not to the other eight, where the functional argument already carries the reason. Measured on the real surface: 219 characters a tool, 4.7% on three, 6.3% on four, 18.8% if every tool took one.
- [x] Name it `why` and ask for a short explanation, not for reasoning. A parameter named `reasoning` or `thinking` that asks a model to reproduce its thinking is a documented refusal class, and a refusal is billed.
- [x] Say in the description itself that it is logged for debugging, never shown to the user, and never used for access control. The model reads that line, and so does whoever is later tempted to branch on it.
- [x] Store the resolved string in one `mcp_calls.intent` column whatever its source. Both sources are model-asserted, so a column recording which one it came from would be a distinction without a difference.
- [x] Show it on the logs tab: on the call's summary line where it exists, and as a filter, because a row with an intent is the row worth reading first.
- [x] Keep `why` out of the evals' `requiredArgs` and measure fill rate instead. The argument-validity column has no headroom — the committed run fails zero rows on a missing argument — so adding an advisory field to the gate can only turn volunteered silence into a regression.

**You see.**

- [x] A `claim_todo` or a `save_memory` that carried a `why` shows it on the logs tab without opening the payload.
- [x] Filtering the logs tab to calls that carried an intent returns those rows and no others.
- [x] An `initialize` row records the client's own name and version rather than `oauth`.
- [x] The evals tab reports what fraction of eligible calls volunteered a `why`.
- [x] The eval scores do not move, because four descriptions gained a field and none changed meaning.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] `test/mcp/logging.worker.test.ts` asserts the intent from an argument, the intent from `_meta`, `_meta` winning over the argument, a null when neither is sent, and `clientInfo` reaching the row from `initialize`. Run `npm run test:mcp`.
- [x] The same spec asserts a tool without `why` in its schema still logs a null intent rather than the stray key. Run `npm run test:mcp`.
- [x] `test/ui/console.spec.ts` drives the intent filter on the logs tab. Run `npm run test:ui`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] Lane 1. Drive a claim, an update, and a completion at a running dev server, each with a `why`, then screenshot the logs tab filtered to intents. Save `.context/evidence/v1-14-intent/`. Pass when all three rows read without opening a payload.
- [x] Lane 2. `npm run evals` after the surface change, all seven models. Pass when the scores hold and the run reports a fill rate.
- [x] Lane 3. `npm run db:migrate:prod` before merge, because the column is additive and the deploy does not run migrations.

**Review gate.** The owner reviews before merge. This adds a model-authored string to the most sensitive table in the database.

- [x] Post the artifacts from the live lanes. Stop at merge-ready and wait.

**Merge.**

- [x] Clean verdict at the exact head SHA.
- [x] Review-comment triage done.
- [x] Rebased onto current trunk after the verdict.
- [x] The owner merges.

## Make skills a table with a detail view, and count what reaches them (V1-15)

**Depends on.** V1-12 for the modal, V1-14 for the call log's shape.

The skills page is a stack of cards with the whole SKILL.md of every version under a disclosure. Ten skills with four versions each is forty `<pre>` blocks on one page, and the one question it cannot answer is which of them anything actually reads. A skill is three doors and a bundle — its own tool, `get_skill`, a `skill://` resource, plus the files in R2 — and the page shows one of those.

**Files.**

- [x] Edit `app/concepts/skills.ts` and `app/concepts/activity.ts`.
- [x] Create `app/components/file-tree.tsx`.
- [x] Edit `app/routes/skills.tsx`, `app/components/ui.tsx`, and `public/valise.css`.
- [x] Edit `test/d1/schema.worker.test.ts` or `test/mcp/logging.worker.test.ts` for the usage counts.
- [x] Edit `test/ui/console.spec.ts`.

**Build.**

- [x] Make the list a table: name, version, project, bundle size, what reached it, and when it last changed. One row per skill, nothing expanded.
- [x] Count the three doors separately from `mcp_calls`: the skill's own `skill_{name}` tool, a `get_skill` naming it, and a `skill://` resource read. ADR-0005 made skills the first surface and ADR-0003 gave them three doors; which door gets used is the number that says whether either decision worked.
- [x] Read the resource door through both argument shapes. Before V1-14 a `resources/read` logged its uri as a bare string, and after it the whole `params`; a count that sees only the new shape would read as a cliff on the day of that deploy rather than as a change in the schema.
- [x] Put the detail in a modal: the description, the frontmatter as it parsed, the bundle as a tree, the version history, and the body of whichever version is selected.
- [x] Draw the bundle as a real tree rather than a flat list of paths. A manifest is paths with slashes in them, and `scripts/` with eight files in it reads as one line, not eight.
- [x] Move the publish form behind a button. It is the rarest thing on the page and it currently sits above everything else.

**You see.**

- [x] The skills page is one row per skill and fits without scrolling past the publish control.
- [x] A skill with a bundle shows its files as a tree, with each file's size and digest.
- [x] Calling `skill_capture-this`, then `get_skill`, then reading its `skill://` resource moves three different counters.
- [x] Clicking a version in the history swaps the body without leaving the modal.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] A worker test drives all three doors at one skill and asserts three counts of one, plus a `resources/read` row written in the old bare-uri shape still counting. Run `npm run test:mcp`.
- [x] `test/ui/console.spec.ts` publishes a skill with a bundle, opens its detail, and asserts the tree and the version history. Run `npm run test:ui`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] Lane 1. Publish a skill with a nested bundle at a running dev server, drive all three doors, and screenshot the table and the detail at 1280 and 390. Save `.context/evidence/v1-15-skills/`. Pass when the tree nests, the counts are non-zero, and neither width scrolls sideways.

**Merge.**

- [x] Clean verdict at the exact head SHA.
- [x] Review-comment triage done.
- [x] Rebased onto current trunk after the verdict.
- [x] The owner merges.

## Import a skill from skills.sh without copying its SKILL.md (V1-16)

**Depends on.** V1-15.

Getting a skill into Valise means opening its repository, copying the SKILL.md, pasting it into the publish box, and giving up on the bundle, because the form takes one file. skills.sh indexes about twenty thousand skills across GitHub and the CLI that installs them talks to two endpoints that need no key.

Neither is documented, and `robots.txt` disallows `/api/`. They are used nonetheless because every `npx skills` invocation depends on them, they are pinned in MIT-licensed source that can be watched, and the CLI itself honours a base-URL override. The base URL is a Worker var here for the same reason: a change upstream is then a config edit rather than a deploy.

**Files.**

- [x] Create `app/concepts/skills-registry.ts`.
- [x] Edit `app/db/schema.ts`, and add a migration under `drizzle/`.
- [x] Edit `app/concepts/skills.ts`, `app/routes/skills.tsx`, and `public/valise.css`.
- [x] Edit `wrangler.jsonc` and `.dev.vars.example`.
- [x] Create `test/mcp/registry.worker.test.ts`, and edit `test/ui/console.spec.ts`.
- [x] Edit `docs/adr/0005-skills-first-surface.md`.

**Build.**

- [x] Call `GET {base}/api/search?q=&limit=` and `GET {base}/api/download/{owner}/{repo}/{skill}` from the Worker, never from the browser. skills.sh answers both with no `access-control-*` header at all, so a direct call from the console is blocked before it is sent.
- [x] Leave the documented `/api/v1` alone. It authenticates with a Vercel OIDC token, which only a Vercel runtime can mint, so it is not an option at any price.
- [x] Drop search hits whose `source` is not `owner/repo`. The index carries bare-domain sources like `docs.stripe.com`, and `/api/download` answers 404 for every one of them.
- [x] Validate the source id against `owner/repo/skill` before it reaches a URL. The path is interpolated, and a segment with a slash or a dot-dot in it is a request to somewhere else.
- [x] Validate the download before it is written: a `SKILL.md` at the root, frontmatter that parses with a name and a description, no absolute or escaping paths, a file count and a total size under a cap.
- [x] Record `source` and `source_hash` on the skill. The hash is the upstream's own content digest, which is what makes a later "has this changed" a comparison rather than a re-download.
- [x] Show the licence from the frontmatter, and show "not stated" when there is none rather than nothing. skills.sh returns no licence field, the terms push the question onto the upstream repository, and `anthropics/skills` has no repository licence at all while its `pdf` skill is marked proprietary.
- [x] Preview before writing: the search hit expands into the frontmatter, the licence, and the bundle tree, and one button writes it. One click to import, after one click to see what it is — a one-click import of a stranger's shell scripts, sight unseen, is not a feature.
- [x] Publish through `publishSkill`, not around it. The import is a normal version with a normal bundle, so it gets the projection write, the immutability, and the head move for free.

**You see.**

- [x] Searching the registry from the console returns rows with their source repository and install count.
- [x] Opening a row shows its licence, its frontmatter, and its bundle as a tree before anything is written.
- [x] Importing writes a v1 that `get_skill` serves immediately, with its bundle in R2.
- [x] An importable skill and a bare-domain source are told apart before either is offered.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] `test/mcp/registry.worker.test.ts` stubs the upstream and asserts the search URL, the domain-source filter, the id validation, the path-escape rejection, the size cap, a missing SKILL.md, and a successful import reaching `get_skill`. Run `npm run test:mcp`.
- [x] `test/ui/console.spec.ts` asserts the registry panel renders and costs no upstream call without a query. Run `npm run test:ui`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] Lane 1. Search the real skills.sh from a running dev server, import a real skill with a real bundle, then read it back through `get_skill` and the `skill://` resource. Save `.context/evidence/v1-16-registry/`. Pass when the imported body matches the upstream byte for byte.

**Review gate.** The owner reviews before merge. This writes third-party content into the store from an undocumented endpoint.

- [x] Post the artifacts from the live lane. Stop at merge-ready and wait.

**Merge.**

- [x] Clean verdict at the exact head SHA.
- [x] Review-comment triage done.
- [x] Rebased onto current trunk after the verdict.
- [x] The owner merges.

## Group the log into runs instead of a flat list of calls (V1-17)

**Depends on.** V1-14 for the intent column.

The logs tab lists calls newest first. That answers "what was the last thing sent" and nothing about work: twenty-eight calls from one agent over ninety-six seconds read as twenty-eight rows with no sign they belong together. An agent-framework trace view groups by the unit of work and rolls it up, which is the shape worth copying.

Half of what those views show is out of reach, and saying so is part of the slice. Valise sees `tools/call`, never the conversation, so there is no prompt and no answer to put in a column. Tokens and cost belong to the model on the far side of the client. `duration_ms` is server time and excludes everything the model spent thinking, so a run that took a person two minutes shows as forty milliseconds here. The column is named for what it measures.

The unit is a **run**, not a turn. A turn needs SEP-2817's `turnId` and no client sends one; `mcp_calls.session` holds a bearer token id and is null under OAuth, so it cannot group either. A run is calls from one agent and client with no idle gap longer than ten minutes. It is a heuristic and the page says so.

**Files.**

- [x] Edit `app/concepts/activity.ts`.
- [x] Edit `app/routes/workbench.tsx` and `public/valise.css`.
- [x] Edit `test/mcp/logging.worker.test.ts` and `test/ui/console.spec.ts`.
- [x] Edit `docs/adr/0006-call-log-and-eval-surface.md`.

**Build.**

- [x] Sessionize in SQL with `LAG` over `(agent, client) ORDER BY at`, then a running sum of the gap breaks. D1 runs both; the query is proven in `test/mcp/logging.worker.test.ts` rather than assumed.
- [x] Return the calls of the top runs rather than the top calls. A query that caps on calls and groups afterwards leaves the oldest run cut in half, and a half-run reports a wrong duration and a wrong error count.
- [x] Roll up what the row can honestly carry: calls, distinct tools, wall-clock span, summed server time, errors, and the first `why` any call in the run gave.
- [x] Derive two badges from the calls, not from a model's opinion. A run is `recovered` when a tool fails and the same tool succeeds later in that run. It `repeats itself` when one tool is called twice with byte-identical arguments.
- [x] Sort by newest, longest, or most errors. Not by cost, because there is none to sort by.
- [x] Keep the call list. A run opens into the rows the tab already renders, with their arguments.
- [x] Label the span and the server time apart on the page, so nobody reads forty milliseconds as how long the work took.
- [x] Head each run with the name the caller gives itself. An OAuth client's `agent` is its registration URL, so every production row would otherwise read `https://claude.ai/oauth/claude-code-client-metadata`. The `initialize` call in the run carries `clientInfo`; fall back to the readable end of the URL.
- [x] Put the runs above everything else on the tab, and drop the per-tool and per-client tables. The filter selects already do the narrowing those tables were being read for, and two tables that grow with the corpus push the thing worth looking at off the screen.
- [x] Give each level of nesting its own ground: a run on the page's bone, its calls on paper, one call's payload on paper-2. Indentation alone does not say which of three disclosures you opened.
- [x] Number each call by how far into the run it happened rather than by the clock. Eight absolute timestamps inside one run all read the same.
- [x] Collapse the auth trail. It is mostly repeated sign-ins and it was the longest thing on the page.

**You see.**

- [x] Twenty-eight calls from one Playwright run collapse to one row reading `28 calls · 9 tools`.
- [x] Two scripts running in the same minute stay two rows, because the agent differs.
- [x] A run that carried a `why` shows it without opening anything.
- [x] A run where `create_todo` fails and later succeeds is badged `recovered`.
- [x] Sorting by longest puts the ninety-six-second run above the one-call runs.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] A worker test asserts the gap split, that a different agent starts a different run, the rolled-up counts, and both badges. Run `npm run test:mcp`.
- [x] `test/ui/console.spec.ts` drives the sort and opens a run. Run `npm run test:ui`.
- [x] The phone-width overflow assertion covers the run list. Run `npm run test:ui`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] Lane 1. Drive two agents at a running dev server, one of them failing and retrying, then screenshot the runs list at 1280 and 390 and one run opened. Save `.context/evidence/v1-17-runs/`. Pass when the two agents stay apart, the retry is badged, and neither width scrolls sideways.
## Make memories a table of typed claims, and render their Markdown (V1-18)

**Depends on.** V1-15 for the table-and-modal shape.

Three weeks of captures exposed four problems with one root: nothing in the
system says what a memory is for. Agents save session summaries instead of
claims, `type` is an open string with four undefined ad-hoc values, the
console shows Markdown as source inside a card grid that stops working past a
dozen rows, and the only filters are free-text boxes. The design and the type
vocabulary are argued in `docs/research/2026-10-17-memory-capture-redesign.md`;
this slice ships the console, contract, and skill changes. Hooks and
auto-capture stay design-only in that doc.

**Files.**

- [x] Create `docs/research/2026-10-17-memory-capture-redesign.md` and `app/components/markdown.tsx`.
- [x] Edit `skills/capture-this/SKILL.md`, `app/mcp/contracts.ts`, and `app/mcp/tools.ts`.
- [x] Edit `app/routes/memories.tsx`, `app/components/list-filters.tsx`, `app/concepts/list-filters.ts`, `app/concepts/memories.ts`, `app/search/seed.ts`, and `public/valise.css`.
- [x] Edit `test/mcp/oauth.worker.test.ts`, `test/mcp/logging.worker.test.ts`, `test/mcp/search.worker.test.ts`, `test/ui/console.spec.ts`, and `scripts/oauth-roundtrip.mjs`.

**Build.**

- [x] Settle the memory type vocabulary on the recall question it answers — decision, insight, fact, preference, reference, episode — grounded in the Tulving/CoALA split the concepts already encode (skills procedural, to-dos prospective, memories declarative). The column stays an open string; the vocabulary lives in `MEMORY_TYPES` in `app/mcp/contracts.ts` and steers through descriptions, so a new type is an edit, not a migration.
- [x] Require `title` on `save_memory` and define it as the claim in one sentence. `search` returns titles and the table shows titles, so an untitled memory is invisible at exactly the moment it should be judged.
- [x] Rewrite `capture-this` to state the test (a cold agent must be able to act on the body alone) and the shape that passes it: conclusion first, rejected alternatives, pointers back, one memory per claim.
- [x] Make the list a table: claim over a first-line snippet, type, project, tags, age. One row per memory, the body behind a click, in the V1-15 modal.
- [x] Render memory bodies as Markdown in the modal through react-markdown, which emits React elements and drops raw HTML, so an agent-written body can never become markup.
- [x] Make type, project, and tag cells links that set the matching filter, and feed the filter bar's type select from `SELECT DISTINCT memory_type`, so vocabulary drift is visible rather than rejected.

**You see.**

- [x] The memories page is one row per memory and the body appears only in the modal, rendered, with provenance and timestamps beside it.
- [x] Clicking a tag, a type, or a project filters the table to it, and the type select shows each type with its count.
- [x] `save_memory` without a title is rejected naming the field.
- [x] The seeded memory reads as a claim ("Query the warehouse through its MCP, not ad hoc scripts"), typed `preference`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] `test/mcp/search.worker.test.ts` names `title` among the invalid fields of a bare `save_memory`. Run `npm run test:mcp`.
- [x] `test/ui/console.spec.ts` opens a memory from the table, asserts the Markdown rendered as markup (a bold run is an element, not asterisks), and archives it from the modal. Run `npm run test:ui`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] Lane 1. Save a Markdown-bodied memory through MCP at a running dev server, filter by its type from a cell link, and screenshot the table and the modal at 1280 and 390. Save `.context/evidence/v1-18-memories/`. Pass when the body renders and neither width scrolls sideways.
- [x] Lane 2. Rerun `npm run evals`. Both the `save_memory` description and the capture-this body are eval-gated surfaces and both changed.

**Merge.**

- [x] Clean verdict at the exact head SHA.
- [x] Review-comment triage done.
- [x] Rebased onto current trunk after the verdict.
- [x] The owner merges.

## Give every skill an off switch, and let built-ins update themselves (V1-19)

**Depends on.** V1-18 for the capture-this rewrite this exists to deliver.

The V1-18 rewrite of capture-this exposed a gap: the repo file feeds dev
through the seed, but production serves the DB head, so a merged skill change
waits for someone to remember a manual publish. And a skill, once published,
cannot be taken off the agent surface without deleting it. Two mechanisms,
one upstream model: `source` already distinguishes a skills.sh import from a
skill authored here; built-ins extend it with the repo as upstream
(`builtin:<name>`), and `disabled_at` closes all three doors — the
`skill_{name}` tool, get_skill/list_skills, the SEP-2640 resources — plus the
search projection, without touching the row or its immutable versions.

**Files.**

- [x] Create `app/concepts/builtin-skills.ts` and `drizzle/0006_narrow_wendigo.sql`.
- [x] Edit `app/db/schema.ts`, `app/search/project.ts`, `app/search/reindex.ts`, and `app/search/seed.ts`.
- [x] Edit `app/concepts/skills.ts`, `app/mcp/tools.ts`, `workers/app.ts`, `app/console/forms.server.ts`, and `app/routes/skills.tsx`.
- [x] Create `test/mcp/toggles.worker.test.ts`; edit `test/d1/schema.worker.test.ts` and `test/ui/console.spec.ts`.

**Build.**

- [x] Add `disabled_at` to skills. Off is a fourth state, not a reuse: `visibility` is reserved for sharing and `deleted_at` hides the row from the console, while a disabled skill stays visible there — that is where it comes back.
- [x] Close every door at once. `projectSkill` returns null for a disabled skill, the per-skill tool is not registered, `get_skill`/`list_skills`/`fetch` answer not-found, and the SEP-2640 list and read exclude it. The MCP handler is stateless, so a toggle takes effect on the next request with no deploy.
- [x] Sync built-ins from the Worker bundle, once per isolate plus the nightly cron. A deploy replaces every isolate, so the first request after it publishes any changed built-in through `publishSkill` — the version, head move, and projection come free, and no pipeline step or extra credential exists. The `(skill_id, version)` unique index settles the race between isolates.
- [x] Hold the sync when the head is not what it last wrote. `source_hash` records the last body the sync published; a head that differs was edited here, and the console says so instead of a deploy clobbering it. A name managed by a registry import is never overwritten. An unmanaged skill sharing a built-in's name is adopted — its old head stays one click away in the append-only versions.
- [x] Give the console the switch: a toggle in the skill detail, an `off` pill on the row, and the built-in upstream named where the skills.sh source would be.

**You see.**

- [x] Disabling capture-this removes `skill_capture-this` from tools/list, empties its search hits, and 404s get_skill, within one request, and enabling restores all three.
- [x] Editing `skills/capture-this/SKILL.md` and deploying moves the production head with no manual publish.
- [x] A capture-this head published by hand stops the sync, and the console shows the hold.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] `test/mcp/toggles.worker.test.ts` drives disable and enable across every door, publishes onto a disabled skill without flipping it, and covers the sync's four outcomes: published, current, held, adopted. Run `npm run test:mcp`.
- [x] `test/ui/console.spec.ts` toggles capture-this from the modal and watches get_skill refuse and then serve. Run `npm run test:ui`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] Lane 1. At a running dev server: hit `/__dev/sync-builtins` and read the outcome, disable capture-this in the console, watch an MCP get_skill refuse it, re-enable, and screenshot the row pill and the modal at 1280. Save `.context/evidence/v1-19-toggles/`.

**Merge.**

- [x] Clean verdict at the exact head SHA.
- [x] Review-comment triage done.
- [x] Rebased onto current trunk after the verdict.
- [x] The owner merges.

## Give a to-do the origin and the pointers a memory already carries (V1-20)

**Depends on.** V1-18 for the Markdown renderer and for the provenance shape
this borrows.

A to-do is prospective memory: the same claim, pointed at the future. It
records far less about itself than a memory does. A memory names the agent,
the client, and the session that saved it; a to-do named one `created_by`
string. A memory is told to carry pointers back in its body and the console
renders them; a to-do's body was never rendered anywhere, so the one place a
pointer could live was invisible. What is left is a queue of titles a cold
agent cannot act on — "calibrate the BM25 weights" says nothing about which
repo, which file, or what prompted it.

So: the same provenance triple under the same names, a typed pointer list
beside the tags, and the body on the page.

Pointers are a column rather than prose because they are read by a claimant
deciding whether to pick the work up, and `list_ready` has to carry them. The
kind vocabulary is soft, exactly as `MEMORY_TYPES` is: an open string steered
by the contract description. Memories keep their pointers in the body, where
`docs/research/2026-10-17-memory-capture-redesign.md` put them; a memory is
read whole, a ready to-do is read as a row.

**Files.**

- [x] Create `drizzle/0007_cloudy_sentry.sql`.
- [x] Edit `app/db/schema.ts`, `app/mcp/contracts.ts`, and `app/mcp/tools.ts`.
- [x] Edit `app/concepts/todos.ts`, `app/search/project.ts`, `app/search/reindex.ts`, and `app/search/seed.ts`.
- [x] Edit `app/routes/todos.tsx`, `app/console/forms.server.ts`, and `public/valise.css`.
- [x] Edit `test/d1/schema.worker.test.ts`, `test/mcp/claiming.worker.test.ts`, and `test/ui/console.spec.ts`.

**Build.**

- [x] Rename `todos.created_by` to `source_agent` and add `source_client` and `source_session`. One triple, one set of names across memories and to-dos; a column that means `source_agent` while spelled like `skill_versions.created_by` is drift. Rows written before this migration backfill their client as `unknown`, because no one recorded it.
- [x] Add `refs_json`: `[{kind, value}]`, kinds recommended by `TODO_REF_KINDS` — repo, file, url, issue, doc — and enforced by nothing. The open string is the V1-18 argument again: a new kind is an edit to one constant, not a migration.
- [x] Carry refs through the whole agent path: `create_todo` takes them, `list_ready` returns them so a claimant can judge a row without a fetch, `update_todo` replaces them when the work turns out to live elsewhere, and `fetch` returns them with the origin triple.
- [x] Project the ref values into the searchable body, appended after it so a snippet still opens on the body's own words. A path is a query an agent actually types.
- [x] Render the body as Markdown on the to-do card, through the V1-18 renderer, with the pointers under it: a URL as a link, anything else as code to carry to a shell. The console edit form takes them one per line, inferring the kind when the line is a bare link or path.
- [x] Leave the page a card list. The lease countdown and the claim holder are at-a-glance state, which is what a card is for; the V1-15 table is the right shape for a thousand rows and the wrong shape for a queue of live work.
- [x] Say in `create_todo`'s description that refs are named when already known, not gone looking for. The first wording — "use a concise title, the project, and refs pointing at the repo, files, or page" — read as a prerequisite, and two consecutive eval sweeps caught gemini-3.8-flash searching the store instead of filing the ticket. This is what the lane is for.

**You see.**

- [x] A to-do's body is on the page, rendered, instead of hiding in the edit textarea.
- [x] Each to-do names where its work is, and who opened it through which client.
- [x] `list_ready` hands a claimant the repo and the files with the title.
- [x] Searching a file path finds the ticket about that file.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] `test/d1/schema.worker.test.ts` edits a to-do's pointers and asserts the replaced one leaves the index with the old body, and that an edit does not touch provenance. Run `npm run test:d1`.
- [x] `test/mcp/claiming.worker.test.ts` carries refs from `create_todo` to `list_ready`, `search`, and `fetch`, then repoints them from a claimed `update_todo`. Run `npm run test:mcp`.
- [x] `test/ui/console.spec.ts` asserts the rendered body, the pointer list, and the origin on the card, then edits the pointers and reads them back through MCP. Run `npm run test:ui`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] Lane 1. At a running dev server: create a to-do through MCP with refs, read the card at 1280 and 390, and screenshot both. Save `.context/evidence/v1-20-todo-origins/`. Pass when the body renders, the pointers are there, and neither width scrolls sideways.
- [x] Lane 2. Rerun `npm run evals`. The `create_todo` and `update_todo` descriptions changed, and tool descriptions are the eval-gated surface. Three sweeps: two on the first wording, which caught the regression above, one on the fix. 102/112 primary against a 101/112 baseline, every to-do case green across all seven models, and the remaining misses on memory and skill cases this slice does not touch.

**Merge.**

- [x] Clean verdict at the exact head SHA.
- [x] Review-comment triage done.
- [x] Rebased onto current trunk after the verdict.
- [x] The owner merges.

## Ship client hook configs that nudge capture from the harness (V1-21)

**Depends on.** Nothing in-tree. Tier 1 of the capture redesign
(`docs/research/2026-10-17-memory-capture-redesign.md`);
this slice builds against main and only references that doc.

Capture only happens when asked, because nothing in any harness creates the
moment where the model considers saving. Both Claude Code and Codex run
lifecycle hooks with a near-identical contract, so one shared zero-dependency
Node script can nudge capture on a turn cadence at `Stop` and inject a recall
reminder at `SessionStart`, with the toggle, the wording, and the cadence
user-editable in `~/.valise/config.json`. The design, the adversarial-panel
findings that shaped it, and the rejected alternatives are argued in
`docs/research/2026-10-17-client-hooks.md`. Server code does not change;
`clients/` is Apache-2.0 per the spec's license split.

**Files.**

- [x] Create `docs/research/2026-10-17-client-hooks.md`, `clients/valise-hooks/` (`.claude-plugin/plugin.json`, `hooks/hooks.json`, `scripts/valise-hook.mjs`, `README.md`, `LICENSE`), `.claude-plugin/marketplace.json`, `vitest.clients.config.ts`, and `test/clients/hook-script.test.ts`.
- [x] Edit `package.json` (`test:clients` wired into `verify:ci`), `LICENSE.md` (one sentence scoping FSL to everything outside `clients/`), and `README.md` (install pointer).

**Build.**

- [x] One zero-dependency Node script serving both harnesses: read the stdin payload, dispatch on `hook_event_name`, validate `~/.valise/config.json` (path overridable via `VALISE_CONFIG`) against the research doc's contract: two shipped entries overridable by id, plus explicit `custom` entries with required `event` and `text`, and emit only the shared subset: `{"decision": "block", "reason": <nudge>}` on `Stop`, `hookSpecificOutput.additionalContext` on `SessionStart`. No Codex manifest; `CLAUDE_PLUGIN_ROOT` is unset on the direct-hooks path, so the Codex block in the README names an absolute checkout path.
- [x] Nudge on a turn cadence, not once per session: a per-session counter file in the OS temp dir (hashed `session_id` name, atomic rename updates), nudging at multiples of `every_turns` (default 10). Emit before counting, so a crash costs an extra nudge rather than a swallowed one. `stop_hook_active` always exits silently. A counter that cannot be read or written means no nudge and one stderr line, never a block.
- [x] Validate at the boundary per the research doc's table: missing file means defaults; a parse failure, unknown key, unknown field, wrong type, over-length `text` (2000 chars), a `custom` entry missing `event` or `text`, or combined enabled text past 8000 chars per event means no injection, exit 1, one stderr line. The caps keep output under Codex's ~2,500-token spill threshold.
- [x] `SessionStart` injects only when the payload's `source` is `startup`, `clear`, or absent; `resume`, `compact`, and `fork` stay silent.
- [x] `--print` writes the merged effective config and each entry's final text to stdout, the one-command answer to "what will my next session inject".
- [x] `hooks/hooks.json` with no matchers and an explicit per-hook timeout; `.claude-plugin/plugin.json` plus root `.claude-plugin/marketplace.json` naming `./clients/valise-hooks` so the repo is its own marketplace.
- [x] README documents: install for both harnesses (plugin commands for Claude Code, a literal `~/.codex/hooks.json` block with the absolute-path placeholder called out), Node 18+ as a prerequisite, the Valise MCP connector as what the nudge assumes, the config contract with the defaults enumerated verbatim, and Codex trust-by-hash including the re-trust cost on every script update.

**You see.**

- [x] After `/plugin marketplace add` + `/plugin install` in Claude Code, a new session opens with the recall reminder in context, and a session that reaches ten assistant turns gets the capture nudge.
- [x] Setting `{"capture-nudge": {"enabled": false}}` in `~/.valise/config.json` silences the nudge with no reinstall; a custom `text` replaces the wording; a `custom` entry fires its own line at its own cadence; a typo in a key is a visible hook error, not a silent no-op.
- [x] `node clients/valise-hooks/scripts/valise-hook.mjs --print` shows the merged config.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] `test/clients/hook-script.test.ts` spawns the real script with documented payloads from both harnesses and asserts, as a matrix with one case per row: `SessionStart` emits the reminder for `startup` and stays silent for `compact`; `Stop` is silent before turn 10, nudges in `reason` at turn 10 (the model-visible field, not a proxy), and is silent at turn 11; `stop_hook_active` is silent; `enabled: false` silences; custom `text` and `every_turns` are honored; a `custom` Stop entry fires at its own cadence and a `custom` SessionStart entry joins the reminder; unknown key, non-boolean `enabled`, over-length `text`, a `custom` entry missing `text` or naming a bad `event`, and malformed JSON each exit 1 with one stderr line and no stdout; an unwritable counter path emits no block. Config supplied via `VALISE_CONFIG`, state isolated via `TMPDIR`. Run `npm run test:clients`.
- [x] `verify:ci` includes `test:clients` and stays a strict subset of `verify`; `npm run typecheck` covers the new test file.

**Verify, live.**

- [x] Lane 1, Claude Code. Install from the local marketplace, run a real session past the cadence threshold, and capture evidence that the reminder entered context and the stop nudge fired. Save `.context/evidence/v1-21-hooks/`.
- [x] Lane 2, Codex. Wire the block into `~/.codex/hooks.json`, run `codex exec` (trust reviewed, or bypassed with the documented one-off flag), and capture the injected context. Save alongside lane 1.

**Merge.**

- [x] Clean verdict at the exact head SHA.
- [x] Review-comment triage done.
- [x] Rebased onto current trunk after the verdict.
- [x] The owner merges.

## Carry the schema with the merge, and stop the drop (V1-22)

**Depends on.** V1-20, which is the outage this is written from.

V1-20 merged as `9b58352`, Workers Builds deployed it, and `create_todo`
failed in production for three hours. The code reads four columns that
`drizzle/0007_cloudy_sentry.sql` adds, and the migration was still sitting
unapplied on the remote database. The rule it broke is a sentence in
`AGENTS.md` — a person runs `npm run db:migrate:prod` before the PR merges —
and V1-14 kept it by writing the reminder into its own live lane. V1-20 added
four columns and wrote no lane, and nothing else was looking: `verify` runs
against a local database, Playwright runs against `wrangler dev`, and
`scripts/smoke.sh` asks for health, a stylesheet, and a 401, all of which a
database missing a column answers correctly. The first detector was a person
trying to file a to-do.

The rule was also wrong for the migration in front of it. `0007` renames a
column, so running it before the merge breaks the code then in production and
running it after breaks the code that just landed. No ordering of one
migration and one deploy is correct for a rename, which means "a person runs
it first" only ever worked for additive migrations — the ones that least need
a person.

So the deploy carries the schema, and the classifier decides what the deploy
is allowed to carry. ADR-0008.

**Files.**

- [x] Create `scripts/migrations.mjs`, `scripts/deploy.sh`, and `scripts/probe-migration-gate.sh`.
- [x] Create `docs/adr/0008-migrations-in-the-deploy.md`.
- [x] Edit `package.json`, `AGENTS.md`, and `drizzle/0007_cloudy_sentry.sql`.

**Build.**

- [x] Make the build's deploy command `./scripts/deploy.sh`: migrations, then `wrangler deploy`, then `scripts/smoke.sh`. Schema first, because a column the running Worker does not read costs it nothing, and a deploy that fails after the migration leaves production on old code against a superset of its schema.
- [x] Classify every statement with a default-deny allowlist: the `CREATE` forms, `ALTER TABLE … ADD`, and `INSERT INTO` are additive, and everything else needs a person, including a statement shape the list does not recognise. Split on drizzle's `--> statement-breakpoint`, the only split that survives a trigger body holding `DELETE` and semicolons.
- [x] Let a non-additive migration declare itself with a `-- valise:by-hand` line. `npm run db:audit` fails `verify` without one, so the decision is forced in review, and the deploy refuses a marked migration outright, so the build stops before `wrangler deploy` and production keeps serving the code it has.
- [x] Mark `0007` retroactively with the date it was applied by hand. Wrangler tracks migrations by filename, so a comment added after the fact changes nothing it has already run.
- [x] Refuse to run from any branch but `main`, read from `WORKERS_CI_BRANCH`. Workers Builds runs the preview command on other branches today; this is what keeps a feature branch off the production schema if that is ever wired the other way.
- [x] Delete `npm run deploy`. It built and deployed from a laptop, which `AGENTS.md` already forbade, and it would now be the one path that ships code without its schema.
- [ ] The owner, in the Cloudflare dashboard: set the deploy command to `./scripts/deploy.sh`, and add D1 (edit) to the Workers Builds API token under My Profile > API Tokens. The token it creates for itself carries Workers Scripts, KV, R2, and Routes, and no D1, so the migration step 403s without it.

**You see.**

- [x] A migration that drops or renames without saying so fails `npm run verify` on the pull request, naming the statement.
- [x] The same migration pending on the remote database stops the deploy before it ships anything.
- [ ] A merge that adds a column serves it in production without anyone running a command.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] `./scripts/probe-migration-gate.sh` holds six cases: additive passes, an undeclared `DROP COLUMN` and an undeclared `RENAME COLUMN` fail, the declared drop passes, an unrecognised `PRAGMA` fails closed, and an FTS trigger body stays additive. Run `npm run db:audit`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] Lane 1. Classify the real tree. Save `.context/evidence/v1-22-deploy-migrations/audit.txt`. Pass when eight files read additive and `0007` reads by-hand.
- [x] Lane 2. `node scripts/migrations.mjs apply` against the production database with nothing pending. Save `.context/evidence/v1-22-deploy-migrations/apply-up-to-date.txt`. Pass when it reads the applied set off the remote and exits 0 without calling wrangler.
- [x] Lane 3. Put an unmerged `ALTER TABLE todos DROP COLUMN refs_json` in `drizzle/` and run the same command. Save `.context/evidence/v1-22-deploy-migrations/apply-refuses.txt`. Pass when it exits 2, names the file, and `refs_json` is still on the production table afterwards.
- [ ] Lane 4. The first merge after the dashboard switch. Save the build log as `.context/evidence/v1-22-deploy-migrations/build-log.txt`. Pass when the migration step runs before `wrangler deploy` and smoke passes after it.

**Merge.**

- [x] Clean verdict at the exact head SHA.
- [x] Review-comment triage done.
- [x] Rebased onto current trunk after the verdict.
- [x] The owner merges.

## Tell parallel sessions apart on the logs tab (V1-23)

**Depends on.** V1-17 for runs, V1-21 for the plugin.

Every Claude Code on a machine shares one OAuth grant, so every call carries the same `agent` and `client`, and `session` is null. Three sessions open at once (a terminal, a Conductor workspace, a second laptop) were one run on the logs tab, held together by reconnect chatter: `server/discover`, `tools/list`, and `resources/list` were 85% of a day's rows and kept the ten-minute gap from ever opening. "Newest" sorted by a run's first call, so a call made at 16:59 sat at the bottom of a closed run headed 16:19.

Two things identify a caller without trusting a model. The stateless protocol sends `clientInfo` in `_meta` on every request, and Claude Code's `headersHelper` runs as a direct child of the Claude process, which records its session in `~/.claude/sessions/<pid>.json`. Both are self-reported, so they label rows and authorize nothing.

**Files.**

- [x] Edit `app/concepts/activity.ts`, `app/mcp/observe.ts`, `workers/mcp.ts`, and `app/db/schema.ts`.
- [x] Create `drizzle/0008_first_crusher_hogan.sql`.
- [x] Edit `app/routes/workbench.tsx`.
- [x] Create `clients/valise-hooks/.mcp.json` and `clients/valise-hooks/scripts/valise-headers.mjs`; edit the plugin's `README.md` and `plugin.json`.
- [x] Edit `test/mcp/runs.worker.test.ts`, `test/mcp/logging.worker.test.ts`, `test/mcp/fixture-worker.ts`, and `test/ui/console.spec.ts`; create `test/clients/headers-script.test.ts`.

**Build.**

- [x] Keep successful handshakes out of runs, totals, and the gap calculation unless the Handshakes filter is ticked. A failed handshake stays, and `initialize` stays because it names the caller.
- [x] Sort "Newest" by a run's last call and show that time. Open the newest run on arrival.
- [x] Record `clientInfo` as `name version` on every row, from `_meta` or a legacy `initialize`'s params, plus the user agent.
- [x] Record `X-Valise-Session`, `-Session-Name`, `-Host`, and `-Plugin`. Under OAuth the session header fills `session`, so a session's writes carry it in their provenance too.
- [x] Sessionize per `(agent, client, session)`. A client without the plugin falls back to the gap heuristic.
- [x] Ship the connector in the plugin with a `headersHelper` that reads the parent's session file and falls back to `pid@host`. `VALISE_MCP_URL` points it at a self-hosted deployment.
- [x] Add 0008 as five additive `ALTER TABLE … ADD` statements, so the deploy applies them alone.
- [x] Name the plugin `valise`, in `clients/valise/`. It carries the connector now, and `valise-hooks` read as an add-on to something installed elsewhere. Its header reads `valise/<version>`.

**You see.**

- [x] Two sessions of one agent at the same moment are two runs, each headed by its session name with version and host beneath.
- [x] A run from a client with the plugin carries a `valise-hooks/<version>` badge; one without it reads `claude-code <version>`.
- [x] A call's details show session, client and host, and user agent.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] Worker tests assert handshake exclusion, that a handshake does not bridge a gap, that a failed one stays, the last-call sort, the session split, and that the headers and `_meta` reach the row. Run `npm run test:mcp`.
- [x] Client tests assert the helper names the parent's session, falls back to `pid@host`, and keeps a non-ASCII name a legal header. Run `npm run test:clients`.
- [x] `test/ui/console.spec.ts` drives two sessions of one agent and finds two runs. Run `npm run test:ui`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] Lane 1. Load the plugin with `claude -p --plugin-dir` against a header-logging probe at `VALISE_MCP_URL`. Pass when every request carries all four headers with the real session id. It did; the helper ran once for four requests, so a `/clear` keeps the old session until reconnect.
- [x] Lane 2. Drive three sessions at a running dev server, two with plugin headers and one without, then screenshot the runs list at 1280 and 390 and one call opened. Saved `.context/evidence/v1-23-sessions/`. Pass when the three stay apart and neither width scrolls sideways.
- [ ] Lane 3. After merge, confirm 0008 is applied on production and a Claude Code with the plugin shows its session name on the logs tab.
## Tick a to-do, and edit every field where it sits (V1-24)

**Depends on.** V1-20 for the rendered body this makes interactive, V1-18 for
the Markdown renderer, V1-12 for the modal the memories detail still uses.

The console could read a to-do and it could rewrite one, but it could not
work one. Completing was an MCP call: the coordinator only moved a to-do for
the lease holder holding a live token, and the person reading the page was
neither, so a ticket an agent claimed and then abandoned sat there for the
rest of its thirty-minute TTL. Subtasks existed as `- [ ]` in bodies agents
already write, rendered since V1-20 as the disabled grey boxes remark emits,
which look exactly like something you can click and are not. And every edit
went through one disclosure holding every field at once, so changing a title
meant posting a title, a body, a project, a tag list, and a pointer list, and
any of the four you did not look at could go back out stale.

So: a checkbox on the to-do, live checkboxes in its body, and one pen per
field. Todoist is the reference for the shape — the circle, the checklist,
the count, "add sub-task" — not for the chrome.

Three mechanisms carry it.

A checkbox in a Markdown body is addressed by its **source line**. remark
puts a position on every list item it parses, a rehype plugin copies that
line down onto the checkbox remark synthesised, and the submit button posts
it. The scanner that rewrites the line reads the same lines by the same
rules, and `test/d1/task-list.worker.test.ts` asserts the two agree over
`*` and `+` bullets, ordered items, nesting, a quoted list, two items with
identical text, and a fenced block holding something that looks exactly like
a task. Counting rendered checkboxes — GitHub's approach, which predates
having an AST on the write side — breaks on that last one; matching on text
breaks on the one before it.

Which field is open is **in the URL**, `?edit=<id>.<field>`. The pen is then
an ordinary link rather than a click handler: it works before hydration, it
is in the tab order on its own, the open editor survives a reload, and a
filtered list keeps its filters through an edit because the href carries
them. The memories modal moves to the URL for the same reason, which makes a
memory linkable as a side effect.

The console's state change **goes through the coordinator and bumps the
fencing token**. ADR-0002 is amended rather than bypassed: `override` takes
no lease and no token, writes the D1 fence floor synchronously like every
other transition, and fences the displaced agent out of its next write. A
human closing a ticket is the same event as a re-claim, from the agent's side.

To-do content is not versioned. Memories are, and have been since V1-6;
what was missing was anywhere to read the revisions, which is now a
disclosure in the detail. A to-do's audit trail is its progress log.

**Files.**

- [x] Create `app/concepts/task-list.ts`, `app/components/editable.tsx`, and `test/d1/task-list.worker.test.ts`.
- [x] Edit `app/components/markdown.tsx`, `app/components/modal.tsx`, `app/components/icon.tsx`, and `app/browser.d.ts`.
- [x] Edit `app/do/todo-coordinator.ts`, `app/concepts/todos.ts`, `app/concepts/memories.ts`, and `app/concepts/list-filters.ts`.
- [x] Edit `app/routes/todos.tsx`, `app/routes/memories.tsx`, `app/routes/workbench.tsx`, `app/console/forms.server.ts`, `app/search/seed.ts`, and `public/valise.css`.
- [x] Edit `docs/adr/0002-claiming-semantics.md`; edit `test/mcp/claiming.worker.test.ts` and `test/ui/console.spec.ts`.

**Build.**

- [x] Address a Markdown checkbox by its source line. A rehype plugin copies the `<li>`'s position onto the input remark synthesised, because remark positions what it parsed and not what it generated, and the checkbox is where the click lands.
- [x] Post the state the page rendered alongside the line. A stale card, or a body an agent rewrote underneath, posts a `was` the line no longer agrees with and is refused with a 409 rather than silently reversing someone.
- [x] Keep the item's own bullet and indent when rewriting it, so a body written with `* [ ]` does not grow a stray `-`, and so a nested item stays nested.
- [x] Add `TodoCoordinator.override`, amending ADR-0002. No lease, no token, still single-threaded, still synchronous on the D1 fence floor, and it increments the token so the displaced holder is fenced rather than told. It flushes its own display mirror, because the caller is a browser about to re-read the list.
- [x] Offer `pending`, `blocked`, and `done` from the console and not `claimed`: a person claiming on an agent's behalf means nothing. Blocked takes a reason, because `blocked_on` is a sentence.
- [x] Sort done to the bottom. Completing touches `updated_at`, so recency alone puts the thing you just finished at the top of the queue.
- [x] Replace both "Edit content" disclosures with one `Editable`, which renders the value with a pen and the editor in the value's place. Which field is open is a query parameter, so the pen is a link and needs no client state.
- [x] Render the pen always and hide it with opacity, never remove it — WCAG 2.1 SC 1.4.13 — gated behind `@media (hover: hover) and (pointer: fine)`, so a touch screen with no hover to reveal it with simply shows it. Hit areas are 24px per SC 2.5.8, around marks of 14 and 18, with the checklist rows padded so two adjacent hit areas do not overlap.
- [x] Move the memories modal to `?open=`, which the inline editor needs — a modal in component state closes on the navigation that opens a field — and which makes a memory linkable.
- [x] Read `memory_revisions` into a History disclosure. The rows have been written since V1-6; nothing has ever shown them, and a reworded claim is only trustworthy next to the wording it replaced.
- [x] Seed a checklist into the seeded to-do, so a fresh console shows one that ticks.

**You see.**

- [x] A to-do completes from the circle beside its title, over a live agent claim, and the agent's next write is refused.
- [x] A `- [ ]` in a body is a real checkbox; ticking it rewrites that line of the Markdown and `fetch` returns the change.
- [x] A checkbox inside a fenced block is still text, and two subtasks with identical text tick independently.
- [x] The title, body, tags, project, and pointers each open on their own pen, and nothing you did not open is posted.
- [x] A memory's old text is under History, with who changed it and when.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] `test/d1/task-list.worker.test.ts` asserts the scanner finds exactly the items remark renders a checkbox for, over the nasty corpus, then covers ticking, the stale-state refusal, and appending. Run `npm run test:d1`.
- [x] `test/mcp/claiming.worker.test.ts` overrides a live claim from the console, reads the mirrored row without waiting for an alarm, watches the displaced agent fail on its token, and reopens idempotently. Run `npm run test:mcp`.
- [x] `test/ui/console.spec.ts` edits a body from its pen and reads it back through `fetch`, ticks the second of two identical subtasks and asserts the exact Markdown, completes a claimed to-do and watches `complete_todo` refuse the agent, and edits a memory then opens the revision holding its old text. Run `npm run test:ui`.
- [x] `test/ui/console.spec.ts` measures the pen's opacity in a fine-pointer context and a coarse one, and every hit area in both, so the SC 1.4.13 and SC 2.5.8 claims are a test rather than a screenshot. Run `npm run test:ui`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] Lane 1. At a running dev server: tick a subtask and read the count change, open the body editor, and edit a memory then open the history it wrote. Screenshot at 1280 and at a touch viewport, saved under `.context/evidence/todo-ui-redesign/`. Pass when the count moves, the Markdown round-trips, and neither width scrolls sideways. The accessibility numbers the lane used to eyeball are in the suite instead, which is where a reviewer can rerun them.
- [ ] Lane 2. No eval sweep. No tool description changed in this slice; the surface it touches is the console.

**Merge.**

- [ ] Clean verdict at the exact head SHA.
- [ ] Review-comment triage done.
- [ ] Rebased onto current trunk after the verdict.
- [ ] The owner merges.

## Write the design down, then stop the list moving under you (V1-25)

**Depends on.** V1-24 for the parts this governs, V1-12 for the combobox it
finally uses.

V1-24 shipped a to-do you can work and gave every field a pen. Reading the
result back, the parts are right and the rules behind them were never written
anywhere a reviewer could cite. Four reports came back from one sitting:
completing a to-do made it vanish, completing a sub-task threw its card to the
top, every editor shoved the page down, and the only way to add a tag was a pen
and a comma-separated string.

Three of those are one bug. The list sorts by `updated_at DESC` with done
pushed last, and every mutation is a full-document POST-redirect-GET, so a
write re-sorts the list and throws away the scroll offset. Measured on the dev
server at 1280x900 on 2026-10-17: ticking a sub-task on the eighth card moved
it to first and the window from 1268px to 0; completing a to-do moved its card
from fourth to thirty-seventh of thirty-eight, 7296px into a 7924px document;
opening the title editor grew the first card 65px and pushed everything below
it down 64px.

The fourth is a different fault. A set is being edited as prose. The same is
true of a memory's `type`, which is a six-value vocabulary with a `Pill`
rendering and a free-text editor, and of a to-do's pointers, whose `kind` is a
five-value vocabulary. `MEMORY_TYPES` and `TODO_REF_KINDS` already steer agents
through the tool descriptions; the person typing gets nothing. `Combobox` has
existed since V1-12 and is used in exactly one place, a demo on the workbench.

So: the principles first, as a document the workbench renders and a review can
cite by number, and then the six debts it records. `docs/design/principles.md`
is the source; `app/concepts/principles.ts` parses it; the Components tab shows
each rule above the parts that keep it. A principle whose status line says
**Owed** names a box below.

**Files.**

- [x] Create `docs/design/principles.md` and `app/concepts/principles.ts`.
- [x] Edit `app/routes/workbench.tsx`, `public/valise.css`, and `AGENTS.md`.
- [ ] Edit `app/concepts/todos.ts` and `app/routes/todos.tsx`.
- [ ] Create `app/components/tag-input.tsx`; edit `app/components/combobox.tsx`, `app/components/list-filters.tsx`, and `app/components/editable.tsx`.
- [ ] Edit `app/routes/memories.tsx` and `app/routes/skills.tsx`; edit `app/concepts/list-filters.ts`.
- [ ] Edit `test/ui/console.spec.ts`; create `test/d1/vocabulary.worker.test.ts`.

**Build.**

- [x] Write the twelve principles with the source that settles each one, and a status line per principle saying whether the console holds it. A rule with no citation is an opinion, and an opinion does not survive the next redesign.
- [x] Render the file itself on the Components tab, and tag every specimen with the rule it keeps. Two copies of a design language disagree within a month; one copy read at build time cannot.
- [ ] Sort the queue by something the reader chose. `created_at DESC` is the floor, matching Todoist's project order and GitHub's default, with done still last. A mutation must not be able to change a to-do's position. P4.
- [ ] Give every mutation form `preventScrollReset`, then move the sub-task toggle and the checkbox onto `useFetcher` so they do not navigate at all. The no-script path stays a form post, which is the test of whether an enhancement is one. P4, P11.
- [ ] Keep a completed to-do in place, struck through, and add a "hide done" filter with the count beside it. Trello and Superlist keep the row; Todoist removes it and names where it went. Doing neither is what reads as the thing vanishing. P5.
- [ ] Reserve the editor's height on the value, so opening a pen does not move what is below it. The Save and Cancel pair stays: NN/g measured no gain from removing it and Atlassian defends it on accessibility grounds. P6.
- [ ] Build `TagInput` over the existing `Combobox`: a chip row with an `x` per tag, a `+` that opens the list, create-on-miss, and `aria-label="Remove {tag}"` rather than a bare "Remove". Use it for to-do tags, memory tags, and skill tags. P7.
- [ ] Make every empty value its own control. "Add a pointer", "Add tags", "Add a description" become buttons, not labels beside a hover-only pen. P8.
- [ ] Offer the vocabularies the endpoint already teaches: `MEMORY_TYPES` on a memory's type, `TODO_REF_KINDS` on a pointer's kind, and the distinct projects and tags out of D1 on both the editors and the filter bar. `listMemoryTypes` is the pattern; it just needs four more callers. P9.
- [ ] Finish the APG combobox contract: Left, Right, Home and End return visual focus to the textbox and move the caret rather than walking the list. P9.

**You see.**

- [ ] Ticking a sub-task halfway down the queue leaves the card where it was and the window where it was.
- [ ] A completed to-do stays in place with its title struck through, and "hide done" removes it with a count that says how many went.
- [ ] Opening any pen moves nothing below the card being edited.
- [ ] A tag is added from a `+` that suggests existing tags and removed from the `x` on the chip, on to-dos, memories, and skills.
- [ ] A memory's type and a pointer's kind are picked from the vocabulary the tool descriptions teach, with a free value still accepted.
- [ ] The filter bar's Project and Tag fields suggest what is actually in the store.
- [ ] `/workbench?tab=components` opens on the principles, and every specimen names the rule it keeps.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] `test/ui/console.spec.ts` asserts the Components tab renders one disclosure per rule in `docs/design/principles.md` and that every specimen's rule id resolves to one of them, so a renamed principle fails the build rather than rendering an empty chip. Run `npm run test:ui`.
- [ ] `test/ui/console.spec.ts` measures card index and `window.scrollY` either side of a sub-task toggle on a mid-list card, and card height either side of opening each pen. The numbers in this slice's prose are the before; the test is the after. Run `npm run test:ui`.
- [ ] `test/d1/vocabulary.worker.test.ts` asserts the distinct project and tag queries return what was written, including a tag used by two records once. Run `npm run test:d1`.
- [ ] `test/ui/console.spec.ts` adds and removes a tag from the chip row on all three routes, and walks the combobox with Home, End, Left and Right per the APG table. Run `npm run test:ui`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [ ] Lane 1. At a running dev server with more than a screenful of to-dos: tick a sub-task mid-list, complete a to-do, open each pen, add and remove a tag, and filter by a suggested project. Screenshot at 1280 and at a touch viewport under `.context/evidence/design-principles/`. Pass when nothing moves that was not touched and neither width scrolls sideways.
- [ ] Lane 2. No eval sweep. No tool description changes; `MEMORY_TYPES` and `TODO_REF_KINDS` are read, not edited.

**Merge.**

- [ ] Clean verdict at the exact head SHA.
- [ ] Review-comment triage done.
- [ ] Rebased onto current trunk after the verdict.
- [ ] The owner merges.

## Show where to connect and who connected, on the connections page (V1-26)

**Depends on.** V1-23 for the caller columns.

The connections page listed OAuth clients and bearer tokens by scope. It did not say where to point a client, and it could not say what had used a connection: the same OAuth client is a terminal, a Conductor workspace, and a second laptop. V1-23 records the session, host, client version, and plugin on every call, so the page can show them.

**Files.**

- [x] Edit `app/routes/connections.tsx` and `app/concepts/activity.ts`.
- [x] Edit `public/valise.css`.
- [x] Edit `test/mcp/runs.worker.test.ts` and `test/ui/console.spec.ts`.

**Build.**

- [x] Head the page with this deployment's MCP URL, the plugin install commands, `VALISE_MCP_URL` for the plugin, and the `claude mcp add` and `codex mcp add` lines.
- [x] List each session that called in the last 7 days, newest first: session name, client version, host, plugin, connection, last seen, tool calls. A client without the plugin groups by client version and user agent, so two versions stay apart.
- [x] Name the connection from the log: an OAuth call's principal is its client id, a bearer call's session is its token id. Loopback reads as local dev, and a client no longer granted reads as revoked.
- [x] One full-width table, not one per card. Six columns in a card a third of the page wide read as a column of wrapped words.

**You see.**

- [x] The endpoint and the commands to connect, before anything else.
- [x] Two sessions of one OAuth client as two rows, with the plugin version or `none`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] Worker tests assert one row per session described by its latest call, two versions apart without a session, and the 7-day window. Run `npm run test:mcp`.
- [x] `test/ui/console.spec.ts` finds the endpoint, the install command, and a session row with its host, plugin, and connection; the phone-width check covers the page. Run `npm run test:ui`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are both checked.

- [x] Lane 1. Screenshot the page at 1280 and 390 against a dev server with three simulated sessions. Saved `.context/evidence/v1-26-connections/`.
- [ ] Lane 2. After merge, the production page lists this machine's Claude Code sessions under the Claude Code OAuth client.

**Merge.**

- [ ] Clean verdict at the exact head SHA.
- [ ] Review-comment triage done.
- [ ] Rebased onto current trunk after the verdict.
- [ ] The owner merges.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] The five spec acceptance checks each point at a saved artifact from a live lane.
- [ ] Reply with the report, naming what shipped and what stayed open.

## Appendix A. Prototype evidence

Run `./scripts/probe-ddl.sh` to reproduce every finding below. It applies the ADR-0001 projection DDL through `wrangler d1 migrations apply --local`, which is workerd's SQLite rather than the system one, prints one pass or fail line per claim, and exits non-zero on any failure. It creates nothing on the Cloudflare account. All eleven checks passed on 2026-10-12.

- *Does ADR-0001's DDL run on D1?* Yes. The concept tables, `search_index`, the external-content `search_fts`, and all three triggers applied through `wrangler d1 execute DB --local --file`. The search query with a `json_each` type filter, `snippet()`, and weighted `bm25()` returned ranked rows. `'rebuild'` and `'integrity-check'` both succeeded.
- *Does `wrangler d1 migrations apply` survive a migration containing a virtual table and triggers?* Yes. The same DDL as `migrations/0001_init.sql` reported 18 commands executed successfully. This is why V1-1 Lane 1 exists as a box rather than an assumption.
- *Does an upsert on an existing `doc_key` actually drop stale tokens?* Yes. After upserting a changed body over the same key, the superseded term returned zero rows. The `AFTER UPDATE` trigger carries its weight.
- *Does the backup story hold?* Yes. `wrangler d1 export DB --local` with no flags fails on the virtual table. The same export naming only authoritative tables succeeds and contains no FTS artifacts. The `--table` flag takes a list, so the ADR-0001 backup path is real.
- *Does a projection delete unpublish cleanly?* Yes. Deleting the `search_index` row removes its terms from the index, which is the soft-delete path a `project()` returning null takes.
- *Is candidate B's fusion query executable?* No, and the arena judge missed this. `snippet()` and `RANK() OVER (ORDER BY bm25(...))` cannot appear in the same select over an FTS5 table. Both the system SQLite and the D1 engine return `unable to use function snippet in the requested context`. Each works alone. The defect is fixable by wrapping the ranked select in a subquery, and it does not change the verdict, since B lost on criteria 1, 3, and 5 independently. Recorded here because the judge report at `docs/research/arena-2026-10-12/judge.md` calls that SQL "a valid RRF merge", which is wrong.
- *Are the named dependency versions real?* `agents` is at 0.28.0 and exports `createMcpHandler` from `agents/mcp`, above the 0.20 floor in the spec. `@cloudflare/workers-oauth-provider` is at 1.2.3, matching ADR-0004.

Unproven and deliberately left to V1-1. Whether `porter` stemming is the right tokenizer for a corpus mixing SKILL.md prose with three-line to-dos. It stems correctly, confirmed on a `memories` to `memory` match, but the retrieval quality question needs real content.

## Appendix B. Alternatives rejected

- *Build the UI first.* Rejected. Four of the five spec acceptance checks run from an MCP client, so the UI proves nothing the probe script cannot prove earlier and cheaper.
- *Fork the earlier app.* Rejected, and already settled in the research doc. The recon in this session found the pieces worth copying are five files and a test-harness shape, while the chat runtime, the MDX content pipeline, the renderer worker, and the club multi-tenancy are all dead weight.
- *One PR for all eleven tools.* Rejected. Claiming and skills have genuinely different failure modes, a race and an immutability invariant, and each needs its own live lane.
- *Copy the earlier app's `@cloudflare/workers-oauth-provider` at 0.8.0 to avoid an upgrade.* Rejected. ADR-0004 names v1 for the MCP 2026-07-28 auth support and `insufficientScope()` step-up, and starting one major version behind on the piece that faces the internet is the wrong debt to take.
- *Drive the live lanes by hand.* Rejected per the **build-the-lever** principle. `scripts/mcp-probe.mjs` and `scripts/claim-race.mjs` are the artifacts a reviewer reruns, and V1-2 pays for both once.

## Appendix C. Risks

- *The OAuth provider upgrade from 0.8.0 to 1.2.3 is not a copy-paste.* Lands in V1-5. The owner reads the changelog before writing, and Lane 1 through Lane 3 are three independent real clients, so a protocol regression shows up as a failed connection rather than a silent one.
- *Projection drift is a convention, not a database constraint.* ADR-0001 accepts this. The owner watches the weekly `reindex` reconciliation counts, and any write path added later that bypasses the repository layer is a review blocker.
- *The claim-write boundary is unenforceable in the schema.* Lands in V1-3. ADR-0002 states the rule. The owner greps for `UPDATE todos SET state` outside `app/do/` at each verdict.
- *The Playwright MCP failed to connect in this session.* Affects V1-6. The lanes fall back to `playwright test` run from the CLI with saved screenshots, which is the same harness without the MCP wrapper.
- *Mobile lanes depend on a public deployment.* Lands in V1-5. The connector must be added on claude.ai web, since the mobile app cannot add one, and ChatGPT mobile is a documented dead end.
- *Cross-concept BM25 weights are taste, not calibration.* ADR-0001 names this. Expect a per-concept query-time boost after real content lands. The owner reads Lane 2 of V1-2 with that in mind rather than treating the first ranking as correct.

## Appendix D. Links and reading list

Read before editing. `docs/specs/2026-10-12-valise-v1-spec.md` for the acceptance checks and the tool table. `docs/adr/0001-data-model.md` for the projection contract. `docs/adr/0002-claiming-semantics.md` for the fencing rules, which V1-3 must not reinterpret. `docs/adr/0003-mcp-tool-surface.md` for the frozen eleven. `docs/adr/0004-auth-and-scopes.md` for the scope map. `docs/research/arena-2026-10-12/judge.md` for what the arena rejected, read with Appendix A's correction in hand.

Skill routing. V1-1 and V1-3 get the **interrogate** skill before merge, because the schema is expensive to change and the fencing argument is the one place a subtle bug is invisible until two agents collide. V1-5 gets **interrogate** too, since it faces the internet. V1-2, V1-4, and V1-6 get the **how** skill only if the owner is unsure of an existing pattern from the earlier app. Every PR description and every doc change runs **technical-writing** then **unslop**.

Trail. Keep the decision trail per the **show-me-your-work** skill under `.context/trail/`, one file per PR, when the user reviews a stretch after stepping away.
