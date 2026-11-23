# Landscape, prior art, and settled decisions (2026-10-12)

Research behind Valise: a personal, portable MCP endpoint for skills + memories + to-dos (+ documents and transcripts later), Cloudflare stack, BM25 search. Nine research agents: prior art in the owner's repos (a local retrieval tool, an earlier Cloudflare app, the skills plugin) and five landscape slices (memory, to-dos, skills portability, transcripts, MCP hosting/pricing), plus follow-ups on skills-over-MCP client support, mobile transcript capture, and Cloudflare's 2026 releases.

## The gap, confirmed five ways

Nobody bundles skills + memories + to-dos + transcripts + documents behind one authenticated, portable MCP endpoint with a UI. Every neighbor covers one slice:

- **Memory**: mem0 ($19/mo, killed its local prosumer OpenMemory entry in 2026 — hosted-dev-API-first now), Zep ($125/mo, teams), supermemory ($19/mo — nearest threat: cross-app MCP memory with UI, funded, built on Cloudflare), basic-memory ($15/mo cloud, Markdown+FTS+MCP but AGPL and notes-only), memU/MemOS (dev infra). Nobody ships to-dos or skills as primitives.
- **To-dos**: beads (repo-scoped, documented claim race conditions: claims visible only locally until pushed), Claude Code Tasks (`~/.claude/tasks`, single machine, single vendor; Boris Cherny credits beads), Linear/GitHub agent queues (work SaaS, repo/org-shaped). Archon was closest to a shared hub and pivoted away. vibe-kanban: 28k stars, thousands of daily users, shut down April 2026 — no business model.
- **Skills**: SKILL.md is an open standard (agentskills.io, Dec 2025) consumed by ~45 clients incl. ChatGPT/Codex, Gemini CLI + app, Cursor, Copilot. SEP-2640 "Skills over MCP" is a ratified MCP extension (final 2026-09-13): `skill://` resources, `skills/list`/`skills/get`. The only hosted implementation (skillsovermcp.com) is free, public-repos-only, skills-only. No private, authenticated skill storage with versioning exists.
- **Transcripts**: the most unoccupied slice. All tools with traction are local + single-ecosystem (ccusage 19k stars = usage analytics; claude-self-reflect/episodic-memory = Claude-only local). Codex CLI history has no credible search tool. The one cross-tool attempt (ChatVault): 1 star, no MCP.
- **MCP hosts**: Smithery/Composio/Glama/Zapier all aggregate third-party tools; none stores personal data.

## Client reachability (one endpoint, all ecosystems)

- Claude: remote MCP connectors on all tiers incl. free; Claude Code via `claude mcp add --transport http`.
- ChatGPT: full MCP via developer mode (Plus/Pro); Deep Research requires a literal `search` + `fetch` tool pair — BM25 maps directly. Consumer ChatGPT cannot install skills (Business+ only).
- Gemini: CLI full support; consumer-app custom MCP is US-only.
- Anthropic's memory tool (`memory_20250818`) is client-side file ops against a `/memories` prefix with a user-supplied backend — Valise can BE the backend. Claude.ai memory has import/export; ChatGPT/Gemini memories are walled gardens (the portability argument writes itself).

## Skills-over-MCP client support (late 2026)

SEP-2640 is Final but almost no client ships it — the official matrix lists only ChatGPT's app-submission importer (static snapshot at submission, max 5 skills), fast-agent, MCP Inspector, Apify mcpc. Claude Code has a dark `FEATURE_MCP_SKILLS` flag (off by default, unofficial source); the public feature request was closed "not planned". Codex request open; SDK PRs landing. **The tool-wrapper shim (`list_skills`/`get_skill` as plain tools) is the real product**; SEP-2640 resources are the forward-compatibility layer. Fallback confirmed working: Claude Code, Claude Desktop, Cursor; reported working: Gemini CLI (calls wrappers unprompted); expected: claude.ai web. **Mobile**: claude.ai mobile works via connectors added on claude.ai web (sync automatically; cannot add from the app). **ChatGPT mobile is a dead end** — dev-mode connectors are web-only.

## Transcript capture reality

Gold tier = local JSONL + SessionEnd hooks (Claude Code, Codex): lossless, real-time, ToS-clean. Claude Code cloud/mobile sessions: a `claude --teleport` sweep materializes them as local JSONL (first-party, clunky; the Compliance API that would do it properly is Enterprise-only). claude.ai/ChatGPT/Gemini incl. mobile: official export ZIPs only (snapshot, user-triggered; Google Takeout schedulable every 2 months). Continuous web capture = extensions/sessionKey scripts, ToS-violating on paper (enforcement against personal backup looks nil, but Anthropic demonstrated in Feb 2026 it enforces when it wants to). MCP-side "log this turn" cannot see the conversation — valid as user-triggered memory capture (and the only self-serve hook reaching claude.ai mobile), dishonest as transcripts. The existing `search-conversations` skill already parses Claude Desktop + ChatGPT export formats.

## Build facts from prior art

- **An earlier Cloudflare app by the owner** (Workers app): working remote MCP endpoint + workers-oauth-provider (PKCE, Claude/ChatGPT callbacks whitelisted), per-tool scope+zod preflight (`workers/mcp.ts:preflightMcpRequest`), D1/drizzle, R2 versioned artifacts, KV, rate limiters, Google OAuth + email OTP, SSE chat with provider-neutral `ToolSpec` (same tool definition serves in-app chat and MCP), React Router + Tailwind management UI. Most of v1's infrastructure — copy selectively.
- **A local retrieval tool by the owner**: port `retrieval/chunking.py` (~130 pure lines, deterministic chunk IDs), the `sources`/`chunks`/FTS5 schema (D1 is SQLite — ports near-verbatim incl. `bm25()` + triggers), the lease-based job queue (content-hash dedupe, lease token+expiry, attempt counter), and the "files authoritative in R2, D1 index rebuildable" split. Skip embeddings and the PDF cleanup chain. Replace its naive FTS query builder.
- **An earlier CSS-generation agent**: constraints live in tool surface area, not prompts ("the model has no way to express a markup change, so the rule never has to be obeyed, only made impossible"). Validation failures return as `is_error` tool results with specifics so the model self-repairs. Constraints a parser can't check need a measurement instrument in the loop.
- **Skills plugin drift** (the pain this product solves, observed live): three copies of the same skills at three versions on one machine, versions hand-duplicated across four files and inconsistent, an orphaned silently-broken plugin, committed byte-for-byte Codex copies because its importer ignores symlinks, recurring machine-specific leakage bugs. A hosted service must do per-skill visibility, one version of record, server-side per-agent packaging.
- **Claiming must be server-side and atomic**: Durable Object compare-and-set + lease TTL + fencing token eliminates the beads failure class. Steal Linear's "delegate acknowledges within 10s" liveness rule and Claude Code Tasks' blocked/unblocked dependency propagation.

## Cloudflare, April–October 2026

The default stack (D1+FTS5, R2 blobs, DO locking, stateless `createMcpHandler`, workers-oauth-provider) survives the year intact. Deltas:

- **workers-oauth-provider v1** (Oct 1): split AS/RS over service bindings, MCP 2026-07-28 auth, `insufficientScope()` step-up. Plan this version; single-Worker layout still fine at personal scale.
- **Clef / Clef-flash** (Oct 1, Workers AI): open-weight decision models returning typed answers + per-option probabilities (27B ~209ms, 9B multimodal ~39ms) — the later classification layer becomes "call decision model, get probabilities".
- **DO SQLite mandatory** for new namespaces since July; 30-day point-in-time recovery on by default.
- **D1 free-tier limits hard-enforced** since Sept 1 (5M reads/day; FTS5 queries count row reads): budget the $5 Workers Paid plan from day one.
- **AI Search GA** (billing Nov 1): managed hybrid vector+BM25 over R2 — only relevant if semantic-over-documents is wanted later; it keeps a separate copy of the data.
- **Sandboxes/Containers GA** (April): the future "run a script" feature is a GA primitive on the same plan.

The concrete case for the later compute stage: consumer chat sandboxes (web and especially mobile) block ordinary network probes. Observed 2026-10-12: claude.ai could not answer "which of these domains is available?" because its sandbox blocks WHOIS/RDAP, while a local agent settled it in two curl calls. A Valise tool like `probe(url)` or `run_check(script)` — light, allowlisted, server-side — would make the phone as capable as the desktop for exactly these blocked-on-sandbox lookups. Same mechanism later serves scheduled checks (Workflows + cron).
- D1 export still cannot handle FTS5 virtual tables — the rebuildable-index design is the backup story.
- `Mcp-Method`/`Mcp-Name` headers enable per-tool rate limits at the edge without JSON parsing.

## Pricing

Single-feature utilities sit at €4–8/mo; personal-infrastructure tools cluster at €9–19 (supermemory $19, mem0 $19, basic-memory $15, Readwise $9.99, Smithery $10); €19–29 is where buyers expect team features. Defensible point: ~€10–15/mo. COGS ≈ $5/mo on Workers Paid. No billing until dogfooding proves it.

## Risks

1. Platform absorption of memory (Claude/ChatGPT/Gemini native; Limitless→Meta). Durable value = cross-assistant + hosted + agent-queryable, never memory itself.
2. supermemory expanding sideways into to-dos/skills (funded, on Cloudflare, Cloudflare's CTO is an angel).
3. Distribution beats features: ccusage/screenpipe won on `npx`-frictionless install; Jean Memory had the "personal memory hub over MCP" idea and sits at 172 stars. Install friction is the whole game.
4. Business-model caution: vibe-kanban (28k stars, thousands of daily users, shut down April 2026).

## Settled decisions (grilling, 2026-10-12)

- **First user**: the owner; both ChatGPT + Claude surfaces, mobile + desktop, multi-agent. Dogfood only, all personal (repo under the owner's personal GitHub account, personal Cloudflare account), no billing yet.
- **v1 scope**: copy the earlier app's infra selectively (re-evaluated against the Oct 2026 Cloudflare releases), keep its visual language, no chat UI — management console only. Pillars: to-dos + memories + skills, one BM25 search, `search`+`fetch` pair, typed tools, skills via tool wrapper + SEP-2640 resources, OAuth from day one. `/capture-this` skill + capture tool in v1 as the flagship loop (a skill served by Valise that writes memories to Valise, from any client including the phone). Documents and transcripts out of v1.
- **To-dos**: complement native task systems, never replace. High-level tickets; agents keep sub-steps internal. Requirements: reliable completion, claim expiry (lease TTL), agents update tickets with progress/insights. Do not trust session-end hooks to fire.
- **Transcripts (v1.5)**: tiered honesty — local JSONL+hooks real-time, teleport sweep for Claude cloud sessions, official-export snapshot ingestion for consumer apps. No ToS-gray scraping in the product.
- **License**: FSL-1.1-ALv2 for the server; Apache-2.0 for CLI/SDK/skills. Superseded for the server by ADR-0021 (AGPL-3.0-only, 2026-11-03).
- **Mobile**: key validation criterion — capture a to-do and pull a skill from the Claude mobile app. ChatGPT mobile documented as a platform dead end.
- **Classification**: v2, via Clef decision models, as UI suggestions only — never silent writes.
- **Data model** (one catalog vs per-concept stores): deliberately open, to be settled by adversarial design review. Frozen constraint: search spans all concepts; each concept's schema evolves independently.
- **Name**: Valise. workbench/jack/tally rejected on discoverability. valise.tools / valise.run available at check time; valise.dev/.app/.com taken, valise.io parked for resale.
- **Light compute (stage 2) rationale**: give chat and mobile clients the lookups their sandboxes block (see the RDAP example above), plus scheduled checks. Allowlisted and bounded; not a general code-execution service.
