# 0022. Transcripts as a concept, written by a Valise CLI holding its own grant

Date: 2026-11-05
Status: accepted

## Context

The owner wants the conversations from Claude Code, Codex and OpenCode on
every machine inside Valise, so Valise can work out what should improve, and
wants the same data readable from DuckDB. The v1 spec sketched
transcripts for v1.5 as local JSONL plus SessionEnd hooks, a `--teleport`
sweep for cloud sessions and export ZIPs for consumer apps. Two of those are
closed off: the plugin has held no credential since PR #317 (one sign-in, the
plugin reaches Valise only through Claude Code's own MCP session, and an
`mcp_tool` hook cannot read `transcript_path`), and `claude --teleport` is
interactive, one-way and has no listing.

What the spike settled (`docs/research/2026-11-05-local-proxy-spike.md`): a
local pass-through proxy set as `ANTHROPIC_BASE_URL` adds under a millisecond
per request, keeps tool search and the one-hour prompt cache, and sees the
session id and a device id in `metadata.user_id` of every request. One Claude
Code transcript is 15 MB raw and 33 KB once reduced to human turns, assistant
text and tool names; the raw file is a delta-encoded trace already, so the
proxy's own value is the clients that keep no such file, the wire timing and
the rate-limit headers.

What was still owed, and what the owner decided on 2026-11-05:

- The credential a machine holds to write. A scoped bearer minted on
  Connections, as the iPhone capture URL is, or an OAuth grant. Decision: an
  additional OAuth sign-in, and the program that holds it is the start of a
  Valise CLI.
- Transcripts as a source kind or a concept of their own. Decision: a concept.
  `save_source` dedupes on URL and the library's notes cap at 64 KiB; a
  session is written many times and has no URL.
- Raw traces now or later. Decision: the distilled conversation, as long as
  errors can still be debugged from it. Raw request and response bodies stay
  out.

The OAuth server today (`app/lib/auth.server.ts`) grants every scope to any
client approved at the consent screen, except a Chrome extension, which gets
the capture base scopes plus what it asked for. A machine running a writer for
one concept would otherwise hold the whole case in its refresh token.

## Decision

1. **Transcripts are a concept.** One `transcripts` row per session, keyed by
   client, device and the client's session id, carrying cwd, git branch,
   project, model, first and last activity, and turn counts. One row per turn
   in `transcript_turns`: a human message, an assistant text, a tool call with
   its name and a one-line argument summary, or a tool error with the tool
   name and the bounded error text. API errors the writer sees (status,
   error type, message, request id) are turns of their own. No tool results
   that succeeded, no thinking, no system prompts. Writes are idempotent: a
   turn is identified by its position and content hash, and a writer sends
   the turns after the longest common prefix the server already holds.
   Transcript text enters `search_docs` through `projectionStatement()` like
   every other concept (ADR-0001). The distilled session is also written to
   R2 as one JSON line per turn under `transcripts/<user>/<client>/<session
   id>.jsonl`, which is what DuckDB reads. Both tables go into
   `scripts/recovery-policy.mjs` and the prefix into the backup Workflow.
2. **A Valise CLI is the writer.** `clients/valise-cli/`, Apache-2.0
   (ADR-0021), dependency-free Node like the spike. Three commands to start:
   `valise login`, which registers an OAuth client with a loopback redirect,
   opens the browser, exchanges the code with PKCE and stores the refresh
   token per machine (the OS keychain where there is one, else a mode 0600
   file under the user's config directory); `valise proxy`, the spike's
   pass-through plus the distilled writer, buffering turns on disk while
   Valise is unreachable and sending them on the next request; and `valise
   import`, the one-time backfill from `~/.claude/projects`, Codex's
   `~/.codex/sessions` and OpenCode's SQLite file. Which projects the proxy
   writes is an allowlist in the CLI's config, empty by default, so nothing is
   sent until a project is named.
3. **Consent grants what the client asked for.** A client that names scopes
   in its authorize request gets that subset, shown on the consent page; a
   client that names none keeps today's grant of every scope, so claude.ai,
   ChatGPT and Codex connect as before. Two scopes are added,
   `transcripts:read` and `transcripts:write`. The CLI asks for
   `transcripts:write` alone for `proxy` and `import`; a later command asks
   for what it needs when it is added. The grant appears on Connections under
   the CLI's client name and the machine's hostname, and revoking it there
   ends that machine's writes.

This replaces the v1.5 transcript line in the spec: no SessionEnd hook, no
teleport sweep. Export ZIPs for claude.ai and ChatGPT remain a possible
`valise import` input and are not decided here.

## Consequences

- Each machine runs one more program, chosen per machine. Remote Control is
  off while Claude Code points at a non-Anthropic base URL, and cloud sessions
  ignore the variable; those sessions reach Valise only through `import`.
- The "one sign-in" rule of PR #317 stands for the plugin and bends for the
  CLI: a machine that writes transcripts holds a second, narrow credential,
  and it is the only credential outside the MCP session on that machine.
- Codex and OpenCode behind the proxy are untested; the spike measured Claude
  Code 2.1.318 only. `import` covers them from their local stores regardless.
- Raw traces are out. Per-request timing, cache numbers and rate-limit
  headers stay in the proxy's local log until a decision says otherwise; the
  distilled turns keep what explains an error, not what reproduces a request.
- A transcript page in the console is a user-facing feature and needs its
  interaction contract (user job, default view, primary action, failure
  states) recorded before it is built. This record decides the data and the
  writer, not the screen.
- Narrowing consent by requested scope is a change to every client's
  authorization path; the roundtrip script (`npm run oauth:roundtrip`) and
  the consent tests have to cover both the named-scope and the no-scope
  request.

## Amendments

- 2026-11-05, what counts as naming scopes. Decision 3 as written would have
  undone ADR-0004's V1-7: claude.ai asks for `search:read`, the required
  scope the resource metadata advertises, and then calls every tool, so
  granting "the subset it named" sends it round the consent screen once per
  capability again. The rule implemented in `consentGrant()`
  (`app/auth/scopes.ts`): a request that names nothing from the vocabulary
  beyond `search:read` gets the whole case, as before; a request that names
  any other scope gets exactly the scopes it named, and the consent page says
  so. The Valise CLI asks for `search:read transcripts:write`. A connector
  that one day names a partial list would get that list; the fix on its side
  is to name none, `search:read` alone, or all.

- 2026-11-05, the concept as built. `transcripts` and `transcript_turns`
  (migration 0063) with the columns decision 1 names, plus `source_agent`
  and `source_client` like every concept. `POST /mcp/transcripts` appends: the
  body names the session (`client`, `device`, `session_id`, optional `cwd`,
  `git_branch`, `project`, `model`), `from`, the position of the first turn
  sent, and `turns` (`kind`, `text`, `tool_name`, `at`). The server hashes
  each turn from its kind, tool and text, checks the overlap between `from`
  and what it holds hash for hash, appends the rest, and answers `409` with
  its own hash list when the histories disagree, so a resend after a lost
  answer adds nothing and a diverged writer resends from the longest common
  prefix. `GET /mcp/transcripts?client=&device=&session=` returns that state.
  Both sit behind the OAuth provider beside `/mcp`, so the CLI's grant and a
  console-minted bearer token both open them; `transcripts:write` appends,
  `transcripts:read` looks. The R2 mirror key gained the device,
  `transcripts/<user>/<client>/<device>/<session id>.jsonl`, because the
  device is part of the session's identity; a header line precedes the
  turns. The mirror is derived from D1 and rewritten whole on every append,
  so backups cover the two tables (`scripts/recovery-policy.mjs`) and not the
  prefix. Search finds a transcript only with `type: transcript`; neither a
  broad search nor `include_library` returns one, and `fetch` of a
  `transcript:` id returns the turns one per line. No console page yet.

- 2026-11-05, the CLI as built. `clients/valise-cli/` with `login`,
  `logout`, `project add|remove|list`, `proxy`, `import` and `status`.
  `login` asks for `search:read transcripts:write transcripts:read`; the
  sign-in lives in `~/.config/valise/cli.json` at mode 0600, and the OS
  keychain is deferred: putting a secret on a child process's argument list
  to reach it would show it in the process table. The proxy covers Claude
  Code only; Codex and OpenCode speak other wire formats and reach Valise
  through `import`, whose Codex reader follows that client's documented
  format and has not run against a real file. A request carries no cwd of its
  own: an interactive session's system prompt has a "Primary working
  directory" line, a headless `claude -p` run's does not, so the proxy falls
  back to the session's own transcript file under `~/.claude/projects`,
  which it can read because it runs on the same machine. It sends a session
  only when that directory is under a `project add` path; `import --all` sends sessions
  outside the allowlist with no project. Turns the proxy cannot deliver wait
  in `proxy-queue.jsonl` beside the config and go out on the next request.
  Claude Code writes a tool result's record twice when a hook fires on it,
  so adjacent identical turns are folded once.

- 2026-11-06, a watcher replaces the proxy, and the project allowlist is
  gone. Claude Code cannot reach the API through a base URL that is not
  listening: with `ANTHROPIC_BASE_URL` pointing at a closed port, `claude -p`
  printed nothing and retried for 180 s. A writer on the request path made
  every session depend on one more process, and the proxy added nothing for
  Claude Code that its own JSONL file lacks (see Context). `valise watch`
  reads the clients' local stores instead: a change to a Claude Code or
  Codex session file sends that session once the file is quiet for 3 s, a
  change to OpenCode's SQLite file sends OpenCode's sessions, and a full pass
  runs at start and every 10 minutes. When it is down, sessions wait in
  their own files and no client notices. `valise install` sends every
  existing session with a progress line, then writes a launchd agent,
  `run.valise.watch`, with `RunAtLoad` and `KeepAlive`, and reports it
  started only when the agent writes a fresh heartbeat (`watch.json` beside
  the config); `valise uninstall` removes it. macOS only. `sent.json` beside
  the config records each session's sent turn count and last turn hash, so an
  unchanged file costs a `stat` and a grown one resends from where Valise
  stopped without a `GET`. Transcripts describe work, not one project, so
  every session on the machine is sent; `project` is now a label, the name of
  the git repository the session's cwd is in (a worktree reports its main
  repository), and null outside one. `project add|remove|list`, `proxy`,
  `import --all`, `proxy-queue.jsonl` and the response distillers went with
  the proxy. Remote Control and cloud sessions are unaffected by the CLI;
  cloud sessions still never reach Valise. Wire timing and rate-limit
  headers are no longer captured anywhere; `scripts/local-proxy-spike.mjs`
  remains for measuring them.

- 2026-11-08, thinking is sent. The owner decided on 2026-11-06 that
  thinking goes to Valise; decision 1's "no thinking" came from the proxy
  spike's privacy default alone. Thinking is the part that explains why an
  agent took a wrong turn. Measured on the owner's Mac over the 200 newest
  Claude Code transcripts: 2,376 thinking blocks, 1,549 (65 %) empty, the
  other 827 holding 474K characters against 772K of visible assistant text.
  `thinking` is a turn kind. The CLI sends a non-empty block as one turn:
  Claude Code's `thinking` content blocks (a block with only a signature is
  skipped), OpenCode's `reasoning` content items, and the summary of a Codex
  `reasoning` item (untested on real Codex data). Thinking is left out of
  `search_docs`, so a search never finds a session by a guess the agent
  discarded; it is in the R2 mirror and in `fetch`. The console folds it
  under "Thinking" with its opening words and hides it with the tool calls.
  A session already sent picks it up when the updated CLI resends: the
  longer history no longer matches the held hashes, so the `409` handshake
  resends from the longest common prefix.
- 2026-11-08, system text is sent. The owner decided that system prompts are
  as crucial as thinking: they explain what the agent was told before it
  acted. Decision 1's "no system prompts" assumed the files did not hold
  one; Claude Code 2.1.316 and later write the full system prompt as a
  `prompt_snapshot` attachment (about 8.5K characters, in sections) and the
  rest of the injected context as attachments: `instructions` (CLAUDE.md and
  AGENTS.md by path), `hook_additional_context`, `skill_listing`,
  `invoked_skills`, `mcp_instructions_delta`, `agent_listing_delta`,
  `session_context`, `environment`, `model`, `date` and reminders. Older
  sessions inline the same as `<system-reminder>` blocks, and `isMeta`
  records carry skill bodies and messages from other sessions. `system` is
  a turn kind, and its `tool_name` names the source. The CLI reads an
  allowlist of attachment types; tool definitions (`prompt_snapshot.tools`,
  about 125K characters, and `deferred_tools_*`) and bookkeeping
  (credentials, mode flags, token counts, edited files) stay out. A text
  goes once per session, so a CLAUDE.md the client repeats on every request
  is one turn. Measured over the owner's 27 newest top-level Claude Code
  sessions: 416 system turns of 4,679 (9 %), 2.1M characters, the largest
  30K, under `MAX_TURN_BYTES`. Codex's `session_meta` instructions,
  `developer` messages and the `<user_instructions>` and
  `<environment_context>` user messages become system turns (untested on
  real Codex data); OpenCode does not store its system prompt. System text
  is left out of `search_docs`, because the same CLAUDE.md in every session
  would match every session. `fetch` gives each system turn's source and
  first 300 characters, so reading one session is not 80K characters of the
  same prompt; the console and the R2 mirror keep the whole text. The
  importer's `sent.json` records `DISTILL_VERSION`, and an entry from an
  older version no longer counts as unchanged, so `valise import` re-sends
  every session through the handshake. Without it the mtime check would
  have kept every already-sent session, thinking included, as it was.
- 2026-11-08, a writer may replace a diverged tail. The two amendments above
  said the `409` handshake resends a session from the longest common
  prefix. It could not: the server only appended, and a resend from a
  prefix shorter than what it held still overlapped turns that differed, so
  it was refused again, and the CLI logged "Valise refused the session
  twice". Every session sent before thinking and system text diverges that
  way, because the new turns sit between old ones. A `POST /mcp/transcripts`
  with `replace: true` now drops the held turns from `from` on and appends
  the writer's, in one batch with the projection; the delete is guarded on
  the turn count the server read, so a raced writer's turns are never
  dropped, and the chain hash, title and times are recomputed from the kept
  prefix. A replace whose overlap agrees is an ordinary resend. The CLI asks
  for it only when the server's hashes stop matching before their end, never
  to append. Decision 1's idempotence holds for a writer that does not ask;
  what a writer that asks gives up is the held tail it replaced, which only
  its own machine sent.

- 2026-11-08, fetch reads a page, not the session. `fetch` on a transcript
  returned every turn, up to 20,000 of them at up to 60,000 characters each,
  so an agent handed one message paid for the whole session. It now takes
  `transcript:<id>`, `transcript:<id>#t-<position>`, or the console link the
  pane copies (`/activity/transcripts?open=transcript:<id>&turns=<page>#t-<n>`),
  and returns one line per turn, `[t-<n> HH:MM] Human: …`, with the named
  message marked `→`. A named message comes with five turns either side, a
  bare id with its first 40; `limit` sets the page and `prev_cursor` /
  `next_cursor` (`t-<n>`) read on. A turn a client wrote as a user message
  (a task notification, a slash command, hook feedback) reads `Event: …`.
  The result's `url` opens the pane at that message. Two tool-choice cases,
  `transcript-message-link` and `transcript-message-ref`, cover the
  description (ADR-0003).

- 2026-11-09, archives and chat exports are an `import` input. The owner
  asked for the conversations kept on SeaweedFS
  (`scrapers/conversations/`) to be in Valise: copies of
  `~/.claude/projects` and `~/.codex/sessions` that outlived Claude Code's
  retention, dated folders of Claude Code sessions, a claude.ai account
  export with one `conversation.json` per chat beside it, and a ChatGPT
  `conversations.json`. That settles the export question left open above.
  `valise import --from DIR` reads such a directory in any layout, picking a
  reader per file by name and, for JSON, by shape. Two clients are added,
  `claude-ai` (claude.ai and Claude Desktop chats) and `chatgpt`. Their
  device is the service, `claude.ai` or `chatgpt.com`, not the machine, so a
  later export from any machine lands on the same sessions. Only the branch the
  person last saw is kept; edits and regenerations fork the export's message
  tree. A pasted file goes as a `system` turn named for the file, so it is
  readable in fetch and kept out of search. An archive copy can be older than
  what Valise holds, so `--from` sends only sessions Valise does not hold at
  all and never replaces a tail. Reading 1,874 real Codex rollouts showed
  the Codex reader dropped `custom_tool_call` items (exec, apply_patch), never
  read the model (`turn_context`) or branch (`session_meta.git`), and sent
  harness parts of a user message (`<recommended_plugins>`, the AGENTS.md
  preamble) as prompts. `DISTILL_VERSION` is 3 for those fixes.
  The first import from that archive surfaced two more problems. A Codex
  subagent's rollout opens with its own `session_meta` and then repeats its
  parent's. Letting the last record win filed 97 subagents under 36 parents'
  ids, so the first record now names the session (`DISTILL_VERSION` 4). An
  import of 4,758 sessions also outlasted its access token. Each request now
  asks for a live token, and concurrent requests share one refresh because
  the server rotates the refresh token.

## Console interaction contract

The job is to find a conversation captured on this account, check whether its
turns arrived, and read what the human, assistant and failed tools said. Activity
links to Transcripts; the default view is the newest saved sessions, with title,
client, device, project, last turn time and turn count. The primary action is
opening a session's conversation in a right-hand pane; the URL names the open
session. The list and turn history are bounded to 30 sessions and 100 turns per
page, with page links for the rest. Metadata (session id, cwd, branch, model)
is disclosed in the pane rather than repeated on every row. Empty means no
sessions were captured, and points to the CLI's `login` and `install`
commands; an unknown or other account's id gets a 404 rather than
an empty conversation. Failed reads fail the page, never masquerade as empty.
The list reads only the signed-in account's D1 rows; this is evidence of what
Valise received, not proof that every local or cloud session was captured.
At 320px the pane becomes a bottom sheet, and links still work without scripts
(P3, P4, P10, P11, P13).

## Amendments (console)

- 2026-11-06, the console contract moves to `docs/design/transcripts.md`.
  The list orders by last activity rather than last write, groups by day, and
  filters by project, client, device, errors, and a tag or subject. The pane
  pages 400 turns rather than 100, folds runs of tool calls, keeps failed
  calls open, and shows tags and subjects read off the to-dos, memories and
  subjects the turns name. Nothing new is stored; the links are inferred at
  read time.
