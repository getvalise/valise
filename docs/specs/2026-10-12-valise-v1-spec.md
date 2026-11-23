# Valise v1 spec

Date: 2026-10-12
Status: accepted. ADRs 0001 to 0004 settled; amendments recorded in the ADRs themselves. ADR-0015 adds managed assets and knowledge sources, accepted 2026-10-20 and implemented 2026-10-21; its amendments record what shipped.

One MCP endpoint that carries skills, memories, and to-dos between models and agents. This spec covers v1, the dogfood release. One user, the owner, on their own Cloudflare account, with no billing. Product decisions and the research behind them live in `docs/research/2026-10-12-landscape-and-prior-art.md`. This document turns them into buildable requirements.

Design decisions already made, not revisited here. Complement native task systems rather than replace them. Skills served as tools first, SEP-2640 resources second. BM25 only, no embeddings. OAuth from day one. No chat UI. FSL-1.1-ALv2 server, Apache-2.0 clients; ADR-0021 replaced FSL with AGPL-3.0-only on 2026-11-03.

## Who it is for and what changes for them

A person running several models at once. Claude on the phone, ChatGPT on the web, multiple coding agents on the desktop. Today each client keeps its own skills, memory, and task list on its own machine. With Valise connected, any client can search one store, claim work another agent left, pull the current version of a skill, and save a memory that every other client sees.

The maintainer inherits a single Worker, one D1 database, one R2 bucket, one Durable Object class, and a React management UI. No queues and no embeddings pipeline in v1. Exactly one cron trigger, for the nightly backup export to R2.

## v1 acceptance

A month of real use, and these checks pass from the real surfaces.

1. From Claude Code: `claim_todo` wins exactly once when two sessions race for the same ticket.
2. From the Claude mobile app (connector added on claude.ai web): save a memory via `/capture-this` and retrieve it by search.
3. From the Claude mobile app: list skills and pull one skill body into context.
4. From ChatGPT web (developer mode): `search` and `fetch` return ranked results across skills, memories, to-dos, assets, and sources.
5. From the management UI: edit a to-do, archive a memory, publish a new skill version, and see each change from an agent within one request.
6. Upload a screenshot on one machine and retrieve its original bytes from another authenticated agent/client through a stable asset ID.
7. Save a bookmark with notes and a PDF-backed source; find both by metadata/notes from another client and download the unchanged PDF. Responses make clear that file contents are not indexed.
8. Export and restore the library with original bytes, source revisions, and relationships intact.

## Concepts

### To-dos

High-level tickets, not micro-steps. An agent claims a ticket, works it with its own internal task system, posts progress, and closes it.

- Fields: title, body, status (`pending`, `claimed`, `done`, `blocked`), project/scope, tags, provenance (who created it), claim holder, lease expiry, fencing token, created/updated timestamps.
- Progress updates are append-only entries on the ticket (author, timestamp, text). Agents are expected to write findings and partial results here, since session-end hooks cannot be trusted to fire.
- Claiming is atomic. Compare-and-set in a Durable Object with a lease TTL (default 30 minutes, renewable) and a monotonic fencing token. A write that presents a stale token is rejected. Expired leases return the ticket to `pending` with the progress log intact.
- Blocked tickets name their blockers. Completing a blocker surfaces the unblocked ticket in `list_ready`.

### Memories

Explicit, typed observations. Not transcripts, not auto-captured profiles.

- Fields: type (`user`, `feedback`, `project`, `reference`, extensible), body (Markdown), tags, project/scope, provenance (client, agent, session id when offered), created/updated.
- Append-biased. Edits create a new revision; the UI shows current state, revisions retrievable.
- The `/capture-this` skill is the main write path from chat clients. The tool schema demands a classification (type, tags, project) at write time so quality lives in the writing agent, not a server-side classifier.

### Skills

One version of record per skill, served to every client.

- A skill is a SKILL.md (frontmatter `name`, `description`, Markdown body) plus optional bundled files. Bodies index for search; bundled files live in R2 under the version.
- Versions are immutable. `publish_skill` creates a new version and moves the head pointer. Old versions remain fetchable.
- Visibility field per skill (`private` now, `public` reserved) so the later sharing story is a flag, not a migration.
- Valise ships its own starter skills through itself, `/capture-this` first.

### Assets and knowledge sources

ADR-0015 defines the storage extension on ADR-0011's existing owned objects and attachment resources. Assets hold immutable original files in the deployment's R2 bucket with authoritative metadata in D1, stable `asset:` IDs, and durable-by-default retention. Explicit expiry supports temporary handoffs. Sources (`source:` IDs) hold durable bookmarks, document references, images, or notes and can link multiple assets. Source edits create revisions; referenced assets cannot expire or be deleted implicitly.

Uploads use begin/HTTP transfer/finalize, with verification before search publication and retryable cleanup for interrupted transfers. Retrieval resolves stable IDs to authorized, short-lived download URLs. Search indexes metadata and supplied notes only. Derived content is a future concept linked to immutable inputs; no extraction pipeline is required initially.

### Search

One ranked BM25 query across all concepts, filterable by type, project, and tags. SQLite FTS5 on D1.

Shape per ADR-0001 (arena-settled, Claude and codex judges agreeing). Each concept owns its own tables with real columns. Concepts meet only at a frozen projection, `search_index(doc_key, concept, concept_id, project, title, body, tags)`, with one external-content FTS5 table synced by triggers from the projection alone. Concept modules each export one `project(row)` mapping; authoritative write and projection upsert commit in one atomic batch. One corpus means BM25 scores compare honestly across concepts. The projection and FTS are derived and disposable, excluded from backups, rebuilt by a `reindex` tool that doubles as weekly drift reconciliation, which is what survives D1's inability to export virtual tables. Skills project head versions only, so superseded bodies never pollute ranking.

## MCP surface

Transport: Streamable HTTP via stateless `createMcpHandler` (Agents SDK v0.20+). Auth: `workers-oauth-provider` v1, PKCE, dynamic client registration with an allowlist seeded from an earlier Cloudflare app by the owner (claude.ai, ChatGPT callbacks, localhost). Bearer token fallback for CLIs that cannot OAuth.

Scopes: `search:read`, `todos:read`, `todos:write`, `memories:read`, `memories:write`, `skills:read`, `skills:write`. Every tool call passes a preflight that zod-validates input and checks scope before the MCP SDK sees it (the `preflightMcpRequest` pattern). Scope failures return `insufficient_scope` with a `WWW-Authenticate` challenge.

ADR-0015 adds `assets:read`, `assets:write`, `sources:read`, and `sources:write`. `search:read` covers cross-concept text/metadata; asset downloads require `assets:read`, as does linking existing assets into sources in addition to `sources:write`. Existing concept-scoped attachment resource reads remain supported per ADR-0011.

Tools. Descriptions are the discovery mechanism for clients without native skills support, so each is written for the model, stating when to call it.

| Tool | Scope | Notes |
|---|---|---|
| `search` | search:read | Query + optional type/project/tag filters. Returns ranked snippets with ids. ChatGPT Deep Research compatible. |
| `fetch` | search:read | Full item by id. ChatGPT Deep Research compatible. |
| `create_todo` | todos:write | Requires title, project; body and tags optional. |
| `list_ready` | todos:read | Unclaimed, unblocked tickets, optionally by project. |
| `claim_todo` | todos:write | Atomic claim, returns lease + fencing token, first caller wins. |
| `update_todo` | todos:write | Append progress, renew lease, set blocked. Requires fencing token while claimed. |
| `complete_todo` | todos:write | Close with a result summary. Requires fencing token. |
| `save_memory` | memories:write | Requires type, tags, body. Returns the stored item for confirmation. |
| `list_skills` | skills:read | Names + descriptions only, cheap to call. |
| `get_skill` | skills:read | Full body of the head version, or a named version. |
| `publish_skill` | skills:write | New immutable version. Validation failures return as tool errors with specifics so the model can repair and retry. |
| `upload_asset` | assets:write | Pending asset and bounded HTTP upload instructions; the PUT verifies the bytes and publishes. |
| `update_asset` | assets:write | Descriptive metadata and retention only; original bytes immutable. |
| `get_asset_download` | assets:read | Short-lived download URL for a ready, unexpired asset. |
| `save_source` | sources:write; assets:read when linking assets | Create or revision a knowledge entry; expected revision guards edits. |

Resources: each skill also served as a SEP-2640 `skill://` resource with `skills/list` and `skills/get` for clients that adopt the extension. Same data, second door.

Constraint style follows the vibe garden rule. Hard rules live in the tool surface. There is no generic write tool, no delete tool in the MCP surface (deletion is UI-only in v1), and memory edits go through revisions rather than overwrites.

## Management UI

The earlier app's visual language (sand canvas, cards, 2px borders) on React Router framework mode. No chat.

- Lists per concept with search, filter, edit, archive.
- Skill editor with version history and a publish action.
- To-do board showing status, claim holder, lease countdown, progress log.
- Connections page. Connected OAuth clients, scopes, revoke.
- Asset upload, image preview/download, metadata editing, and retention controls; source editor for bookmarks, notes, and linked originals. Search coverage is labeled metadata/notes only. Library export includes originals and a manifest.
- Human auth: Google OAuth plus email OTP, HMAC-signed session cookie (the earlier app's `auth.server.ts`).

## Infrastructure

- One Worker (Workers Paid, $5/mo). Hono or plain router, React Router for the UI, `createMcpHandler` for MCP.
- D1 for rows and FTS5. Budgeted against the enforced 5M reads/day free ceiling, paid plan removes the worry.
- One Durable Object class for to-do claiming (SQLite backend, PITR on by default).
- R2 for skill bundles and original assets; D1 for asset/source metadata and source revisions. Scheduled maintenance also reconciles abandoned uploads and expired unreferenced assets (ADR-0015).
- KV for OAuth state (`OAUTH_KV` as in the earlier app).
- Per-tool rate limits at the edge using the `Mcp-Method`/`Mcp-Name` headers.
- drizzle-orm migrations, wrangler deploys, no CI beyond lint + typecheck + migration test at first.
- Domains, registered 2026-10-14. `valise.run` serves the endpoints people connect their clients to, and nothing else. `getvalise.dev` is the marketing site, a separate deploy that this Worker never touches. `valise.work` is unassigned; it redirects to `getvalise.dev` until it has a job.
- The v1 endpoint moved to `https://app.valise.run/mcp` on 2026-10-23. One Worker serves both MCP and the management console on `app.valise.run`; `APP_ORIGIN` and `MCP_RESOURCE_URL` name that same canonical origin in deployment configuration and OAuth discovery. How per-user endpoints are addressed once there is more than one user is an open question with an ADR owed, listed in `docs/adr/README.md`. Until it is answered, V1-5 keeps every origin a var the handler reads and never a literal, so both a path and a subdomain per user stay available.

## Out of scope for v1, named so they stay out

- Document processing (later). Original files and knowledge sources are in scope under ADR-0015; PDF extraction, OCR, chunking, semantic enrichment, and embeddings for these new concepts are deferred. Mia's chunking is potential prior art.
- BYO storage, watched buckets, external source connectors, automatic webpage capture, public file sharing, and cross-user collaboration.
- Transcripts (v1.5). Tiered: local JSONL + SessionEnd hooks in real time, `claude --teleport` sweep for cloud sessions, official-export ZIP ingestion for consumer apps. No scraping.
- Classification (v2). Clef decision models, surfaced as suggestions in the UI, never silent writes.
- Light compute (stage 2). Allowlisted lookups for sandbox-blocked clients (the RDAP case), then scheduled checks. Sandboxes are GA when needed.
- Multi-tenancy, billing, hosted signup. After dogfooding proves the thing.

## ADRs this spec depends on

- ADR-0001 data model: one catalog vs per-concept stores vs hybrid. Arena-settled. The frozen constraint is that search spans all concepts while each concept's schema evolves independently.
- ADR-0002 claiming semantics: DO state shape, lease/fencing rules, D1 consistency.
- ADR-0003 MCP tool surface: the table above, frozen as the v1 contract.
- ADR-0004 auth and scopes: OAuth flows, scope map, bearer fallback.
- ADR-0015 managed assets and knowledge sources: storage lifecycle, metadata-only retrieval, tool/scope additions, and implementation acceptance.
