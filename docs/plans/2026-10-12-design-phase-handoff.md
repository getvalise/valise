# Design phase handoff

Date: 2026-10-12
Status: active. Pick this up in a fresh session in this repo.

## Where things stand

The design phase is complete.

- Research and product decisions: `docs/research/2026-10-12-landscape-and-prior-art.md`. Read it first.
- v1 spec: `docs/specs/2026-10-12-valise-v1-spec.md`, complete including the data-model section.
- ADRs 0001 through 0004 are accepted in `docs/adr/`: data model (arena-settled, candidate C base with grafts, Claude and codex judges agreeing), claiming semantics (per-user coordinator DO, synchronous fence floor in D1), MCP tool surface (eleven tools, frozen), auth and scopes (workers-oauth-provider v1, seven scopes, bearer fallback).
- The arena's full record (three candidate designs and the cross-vendor judge report) is archived at `docs/research/arena-2026-10-12/`.

## Next step: execution

The implementation plan is written and checked at `docs/plans/2026-10-12-valise-v1-implementation.md`. Six PRs, V1-1 through V1-6, each with its own live verification lanes. Execution starts on the owner's explicit go, per the plan's first box.

Scope update (2026-10-20): ADR-0015 records the planned managed-assets and durable-knowledge extension, building on ADR-0011's shipped storage and attachment resources. Implementation is tracked by `todo:tdo_62f57330-73b3-4722-ab41-375f3d16d364` in Valise; the v1 implementation plan is now a frozen historical record per ADR-0010. Start with the deployment's R2 bucket and metadata/notes search; document processing, semantic enrichment for these sources, BYO storage, and source connectors are deferred.

The first slice is V1-1, the D1 schema and the rebuildable search projection. The two DDL amendments ADR-0001 records from the judge land there, `project` and `tags` columns on todos and skills plus the `memory_revisions` table.

One correction to the arena record, evidenced in the plan's Appendix A. The judge report calls candidate B's fusion SQL "a valid RRF merge". It does not run. `snippet()` and `RANK() OVER (ORDER BY bm25(...))` cannot appear in the same select over an FTS5 table, on either the system SQLite or the D1 engine. B lost on other criteria anyway, so the verdict stands.

## Standing context

- Infra to copy selectively, not fork: an earlier Cloudflare app by the owner (OAuth provider wiring, `workers/mcp.ts:preflightMcpRequest` scope/zod preflight, D1/drizzle setup, R2 artifact versioning, auth.server.ts session cookies, the visual language). No chat UI.
- Prior art to port later: an earlier local retrieval tool's chunking + FTS5 schema (documents, v1.5).
- Working style: dstack mode per task (`/dstack-mode`), ceremony tiers from the user-level `CLAUDE.md`. Design decisions of record go in ADRs here, not in conversation.
- The grilling transcript and research agents ran in a separate scratch workspace; everything durable from it is already in this repo.

## Open items not blocking design

- Register a domain (valise.tools and valise.run were available on 2026-10-12; premium status unverified).
- The `studio/` skill group in the owner's skills repo (incl. the grilling skill) is not synced into the local plugin cache; sync covers only dstack and tools.
- Decide repo visibility flip (currently private) when dogfooding ends.
