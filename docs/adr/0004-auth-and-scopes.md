# 0004. Auth: workers-oauth-provider v1, per-concept scopes, bearer fallback

Date: 2026-10-12
Status: accepted
Amended: 2026-10-20 by ADR-0015, planning asset/source scopes and linked-asset authorization requirements; implementation remains pending. Amended 2026-10-21 by ADR-0016, multi-user accounts and invites. Amended 2026-10-25, Chrome extension OAuth. Amended 2026-11-01, the extension's opt-in `todos:write`. Amended 2026-11-03, recall on a failed command under `search:read`, and the brief for a working directory.

## Context

claude.ai and ChatGPT connectors expect OAuth with PKCE and dynamic client registration. CLIs and scripts want a plain token. An earlier Cloudflare app by the owner already runs `@cloudflare/workers-oauth-provider` with a DCR allowlist and a per-tool scope preflight, and v1.0 of the provider (Oct 2026) added MCP 2026-07-28 auth support and `insufficientScope()` step-up. Single user in v1, but connected clients differ in how much they should be allowed to do.

## Decision

- `workers-oauth-provider` v1 in a single Worker (authorization server and resource server together; the split-Worker layout is available later without a protocol change).
- PKCE required. Dynamic client registration with an allowlist seeded from that earlier app's: claude.ai callbacks, ChatGPT callbacks, localhost for development.
- Scopes: `search:read`, `todos:read`, `todos:write`, `memories:read`, `memories:write`, `skills:read`, `skills:write`. Every tool maps to exactly one scope (table in the spec). The preflight validates input with zod and checks scope before the MCP SDK sees the call, the `preflightMcpRequest` pattern from an earlier Cloudflare app by the owner. Failures answer `insufficient_scope` with a `WWW-Authenticate` challenge so capable clients can step up.
- Long-lived bearer tokens for CLIs that cannot OAuth, created and revoked in the UI, each bound to a scope set and a label (which also feeds provenance).
- Human UI auth is separate from MCP auth: Google OAuth plus email OTP with an HMAC-signed session cookie, reused from the earlier app's `auth.server.ts`.
- Rate limits per tool at the edge using the `Mcp-Method`/`Mcp-Name` headers, so abuse control needs no JSON parsing.

## Amendments

- 2026-10-25, Chrome extension OAuth. The capture extension connects with
  OAuth instead of a pasted console bearer, at the owner's request. Its
  callback is Chrome's `https://<extension-id>.chromiumapp.org/`, which
  `chrome.identity.launchWebAuthFlow` delivers only to the installed extension
  with that id. Registration admits that exact form, 32 letters `a`–`p` and a
  bare `/` path, and only as a client's sole redirect URI. Consent for such a
  redirect is the one exception to V1-7: it grants exactly `assets:read`,
  `assets:write` and `sources:write`, whatever was requested, and the page
  names the extension id and those three scopes. The grant's props carry the
  extension id, and `/mcp` admits `Origin: chrome-extension://<id>` for that
  grant only; other OAuth grants still get no extension Origin. The extension
  registers afresh on each Connect, because a stored client id can outlive the
  90-day registration TTL. Disconnect revokes the refresh token at `/token`
  (RFC 7009), which ends the grant, and Connections lists and revokes it like
  any OAuth client. A pasted console bearer remains as an Advanced fallback.
  Gating on the client name or a fixed extension id was rejected: names are
  caller-supplied, and unpacked builds get a path-derived id.

- 2026-11-01, the extension's opt-in `todos:write`. Owner request: save the
  current page as a to-do with a description. Consent for a
  `chromiumapp.org` redirect now grants the three capture scopes whatever
  was asked, plus `todos:write` when it was asked for, and nothing else
  (`chromeExtensionGrant` in `app/auth/chrome-extension.ts`). The consent
  page lists the scopes it will grant. Extension 0.8.0 asks for all four.
  Granting `todos:write` to every extension grant was rejected: extension
  0.7.0 refuses and revokes any grant that is not exactly its three, so
  every installed copy would have stopped connecting the moment this
  deployed. With the scope opt-in, an old copy keeps getting three and keeps
  saving; the new one stores which scopes it was granted and asks to
  reconnect only when a to-do is added on a grant without `todos:write`.
  `todos:write` is wider than the popup needs: it also claims, updates and
  completes to-dos, so a stolen extension token could release or close
  someone's claim. A create-only scope was rejected for now: every write
  scope in the vocabulary is per concept, and one client is not reason
  enough to split the first. It stays under "Open questions" in
  `docs/adr/README.md`. If a create-only scope is added, the extension asks
  for it instead.
  `todos:read` is not granted: the popup reads nothing back but the
  `create_todo` result.

- 2026-10-23, orientation reads. `get_brief` uses `search:read`: like search
  and fetch it reads compact metadata across memories and to-dos. It does not
  require `config:read`, so hookless clients do not need a hook token to orient.
  `list_todos` uses `todos:read`. `/config/brief` keeps its existing
  `config:read` grant and renders the same bounded read model. Neither tool
  introduces a scope or changes an existing tool's requirement. Input failures,
  scope refusals and successful calls take the existing observed MCP path.

- 2026-10-15, V1-7. Consent grants the whole scope vocabulary rather than the scopes the client asked for. A client that requests `search:read` and then calls `list_skills` was being sent back through authorization once per capability, which is seven consent screens to finish one setup. The per-tool preflight and the `insufficient_scope` challenge stay; they are what a narrow bearer token still hits.

- 2026-10-17, hook config. An eighth scope, `config:read`, lets a hook read the config document the server stores for it at `GET /config/hooks`. The hook script runs outside the harness's OAuth session, so it reads a console-issued bearer token from `$VALISE_TOKEN` or `~/.valise/token`; a token minted with `config:read` alone can read hook text and nothing else. Reusing `skills:read` or `todos:read` was rejected: either every reader token could see hook config, or a hook token could read far more than it needs. The endpoint is plain HTTP rather than an MCP tool, because its only caller is the hook's background refresh. There is no `config:write`; the console writes the document under its session. `bearer_token_scopes` has a CHECK listing the original seven literally, and SQLite widens a CHECK only by rebuilding the table, which ADR-0008 makes a by-hand migration, so scopes added since are stored in `bearer_token_grants` and a token's scope set is the union of the two tables. Consent grants the whole vocabulary, so OAuth clients receive `config:read` as well; no MCP tool maps to it.

- 2026-10-18, startup brief. `config:read` also covers `GET /config/brief`, the bounded startup brief the hook injects at `SessionStart`. It carries to-do titles and memory titles, so a hook token can read those as well as hook text. A separate scope was rejected: the same background refresh fetches both, so a hook token would always hold both, and the brief reads less than `search:read` already exposes.

- 2026-10-18, hook edits over MCP. A ninth scope, `config:write`, lets an agent change the hook config document through `edit_hook`, and `list_hooks` reads it under `config:read`. This replaces "There is no `config:write`" above: the owner asked for agents to add and remove hook text. Reusing `config:read` for writes was rejected for the reason that scope exists: a hook's own token must stay unable to change what it injects. Consent grants the whole vocabulary, so every OAuth client gets `config:write` on its next consent. That lets a connected agent change text injected into every future session, the same trust a write to `~/.valise/config.json` already carries (`clients/valise/README.md`, "Trust"). Each change is in the logs tab as an `edit_hook` call and on `/hooks`. A console-issued bearer token holds `config:write` only when it is minted with it. The scope is stored in `bearer_token_grants`, so no migration.

- 2026-10-19, Google sign-in. The console offers Google sign-in beside the administrator password, at `/auth/google` with the earlier app's code flow. There is no email OTP and no invite table: Valise has one user, so a verified Google email in `VALISE_ADMIN_EMAILS` signs in as `local`, the same user the password reaches. Google is off unless the client id, the client secret and at least one allowlisted email are set, so a deployment can never admit any Google account by omission. The consent page links to the same flow and returns to `/authorize` afterwards. Sign-ins and refusals are `console_login` and `console_login_failed` events with the email as subject and `google` in the detail, so the auth event CHECK needs no migration.

- 2026-10-21, session names. Writes record the caller's session name beside the client id. Every Claude Code on a machine shares one OAuth grant, so every agent comment and memory read `https://claude.ai/oauth/claude-code-client-metadata`, and nothing said which worktree wrote it. The plugin's `headersHelper` already sends `X-Valise-Session-Name` (the name Claude Code derives from the working directory, for example `work-todos-60`) for the call log; `workers/mcp.ts` now also puts it on `Provenance.sessionName`, and migration 0022 stores it in nullable `source_session_name` on `memories`, `todos` and `todo_comments`, and `session_name` on `todo_updates`. The client id stays in `source_agent` and `author`, and leases still key on it, so two sessions of one client can continue each other's claim exactly as before. The console shows `<session name> · <client>`, and the client alone, as a short product name (`Claude Code`, `OpenCode`) from `app/concepts/agent-names.ts`, when no name was sent. The name is caller-supplied, unlike the rest of provenance: it is a label for people, never an identity, and a client that lies about it can mislabel only its own writes. A tool argument was rejected because a model would have to fill it on every write and could not know the name; deriving it from the OAuth grant was rejected because one grant serves every session. Clients without a `headersHelper` can set the header statically, as `clients/valise/README.md` shows for OpenCode.

- 2026-10-21, assets and sources. `assets:read`, `assets:write`, `sources:read` and `sources:write` join the vocabulary, stored in `bearer_token_grants` like every scope after the first seven, so no migration. Consent grants them with the rest. `search:read` still searches and fetches asset metadata; bytes, through `get_asset_download` or the `valise://asset/{id}` resource, need `assets:read`. Upload and download URLs carry their own short-lived capability, an HMAC under `TOKEN_PEPPER` scoped to one asset, so a `curl` with no MCP credential can move the bytes. ADR-0015's amendments hold the details.

- 2026-10-21, multi-user. ADR-0016 ends the single user. The Google
  allowlist still signs in as `local`, now the owner row of a `users` table;
  any other verified Google email signs in as its own account when it holds
  one or when it redeems an invite, and is refused otherwise. Google is
  enabled by its client id and secret alone: the allowlist no longer gates
  the button, because the `users` and `invites` tables gate admission. The
  consent screen is unchanged: a signed-in member approves a client for
  their own case, and the grant's `userId` is theirs, which is how `/mcp`
  knows whose rows to serve. Bearer tokens were per user already.

- 2026-10-23, tenant-scoped disconnect. A connection's client registration is
  shared across users. Disconnect enumerates the caller's grants for that
  client and calls `revokeGrant(grant.id, userId)` for each; it never calls
  `deleteClient`, which the provider implements by revoking every user's
  grants and tokens. Other users' connections and browser sessions survive.
  `test/mcp/oauth-connection-isolation.worker.test.ts` exercises the installed
  provider with two users, access tokens and refresh tokens.

- 2026-11-02, hook text as server instructions. The hook config document
  also feeds the MCP `instructions` field of every `initialize` and
  `server/discover` result, through `serverInstructions` in
  `app/concepts/hook-config.ts`. Every client gets the enabled SessionStart
  entries, shipped and custom. A client without `X-Valise-Plugin` also gets
  the enabled PostToolUseFailure and Stop entries as standing rules, because
  it has no hook runtime. ChatGPT chat on web, desktop and mobile is that
  client: plugin hooks run only in the Codex runtime, and the call log showed
  no hook text reaching ChatGPT at all. SessionStart text stays in the
  instructions when the header is present, because the header proves the
  plugin is installed, not that its hooks ran; Codex skips untrusted plugin
  hooks. The hook script keeps injecting its SessionStart text too, so a
  plugin session reads it twice: Claude Code can answer its first turn before
  the MCP server connects, which a headless `claude -p` run showed on
  production the same day, and the hook is the only channel present then.
  A first version dropped the hook's copy (PR #298); the next PR restored it
  before any install took the plugin that dropped it. ChatGPT reads instructions
  only when its connector is refreshed, so an edit reaches it then, not within
  the ten minutes the hook cache takes. Decided by the owner, 2026-11-02;
  `todo:tdo_3de162a3-791a-4e8b-be13-46b511d197ec`.

- 2026-11-03, recall on a failed command. The hook script searches a
  failed command's normalised error itself, at `GET /config/recall?q=`, and
  injects up to two ids and titles instead of asking the model to search.
  The endpoint requires `search:read`, not `config:read`. It answers a
  caller-chosen query over memory, skill and to-do text, which is search,
  and a hook token minted with `config:read` alone still reads hook text and
  the brief and nothing else, as the 2026-10-17 amendment intends. Covering
  it with `config:read` was rejected for that reason; the 2026-10-18
  argument for the brief, that it reads less than `search:read` exposes,
  does not hold for an arbitrary query. A token without `search:read` gets
  403, and the hook sends its plain line as before, so the feature is off
  until the owner mints a token with both scopes. Files and bookmarks are
  not searched: their visibility needs the owned hydration `rankedSearch`
  does, and a failed command is rarely explained by one.
  `todo:tdo_10c82604-6b86-4266-a523-1ebf6e2f1749`.

- 2026-11-03, the brief for a working directory. `GET /config/brief` takes
  `project`, `cwd` and `only=claimed`, still under `config:read`. With `cwd`
  it adds the claimed to-dos whose `worktree` ref holds that directory, by
  id, title, project and latest status; `only=claimed` answers just those,
  which the hook injects on resume and compaction. That is the same kind of
  to-do metadata the brief already carried, so the 2026-10-18 reasoning
  holds and no scope changes. The fencing token is not in the text; an
  agent fetches the to-do for it under its own grant.
  `todo:tdo_75980b29-0e8b-415f-8d32-038a40133f74`.

- 2026-11-04, one sign-in: the plugin's hooks reach Valise through MCP. The
  Claude Code plugin no longer reads a console-minted bearer from
  `~/.valise/token` or `VALISE_TOKEN`. Its network work moved to `mcp_tool`
  hooks, which Claude Code runs over the plugin server's own OAuth session:
  - `PostToolUseFailure` (Bash) calls `search` with `hook:
    "PostToolUseFailure"` and the raw `${error}`. The server normalises the
    error, runs the same recall as `/config/recall`, and answers in the
    hook's shape, `hookSpecificOutput.additionalContext`, followed by the
    owner's enabled custom `PostToolUseFailure` entries; `recall-on-error`
    off silences the hits. `query` takes up to 100,000 characters for this;
    a model's query is still refused past 500.
  - `SessionStart` after a compaction calls `get_brief` with `hook:
    "SessionStart"` and `cwd`, and the worktree's claims come back the same
    way.
  - `SessionStart` at launch, `resume` included, stays a command hook,
    because Claude Code skips `mcp_tool` hooks before MCP servers connect.
    It makes no network call. It names the project and tells the agent to
    call `get_brief` with it.
  - `Stop` is unchanged and local.

  The tool result's text is read as hook output, and the spike showed
  Claude Code parsing a JSON object, ignoring keys it does not know
  (`Hook JSON output had unrecognized keys (ignored): results.`), and
  applying `hookSpecificOutput`. So the hook mode returns the tool's normal
  structured content plus that key, and `outputSchema` still holds.

  Spike, Claude Code 2.1.318, `VALISE_TOKEN` unset, `~/.valise/token`
  present and untouched: `claude -p --settings <file>` with a
  `PostToolUseFailure` `mcp_tool` hook on `plugin:valise:valise`/`search`,
  and a prompt that ran `ls /nonexistent-valise-spike-dir`. The debug log
  showed the transport with `hasAuthProvider: true`, `Returning tokens` from
  the OAuth store, then `Hooks: mcp_tool calling plugin:valise:valise/search
  with 2 arg(s)` and the search result. No bearer was involved.

  The project comes from a committed `.valise.json` `{ "project": "..." }`
  at the repository root, else the `origin` remote's repository name. The
  mapping lives in the repository, not in Valise or `~/.valise`: it is
  shared by every clone and worktree, reviewed like code, and needs no
  call before the server connects. When `get_brief` gets a project nothing
  is filed under, its `note` says so and its `projects` lists the active
  ones, so the agent asks the user.

  Given up: the background refresh of `~/.valise/config.json` from
  `/config/hooks`, so console and `edit_hook` changes to `Stop` entries no
  longer reach Claude Code's hook; `SessionStart` entries still arrive as
  server instructions, and `PostToolUseFailure` entries through the server.
  The once-a-session dedupe and three-a-session cap on recall went with the
  local state; the coverage bar is what keeps it quiet. A server that does
  not answer leaves the failure without a line, where the plain
  `recall-on-error` text used to go out. `/config/hooks`, `/config/brief`
  and `/config/recall` stay for clients holding a bearer; retiring them is
  a separate decision. Decided by the owner, 2026-11-04;
  `todo:tdo_76a3748e-51c3-480a-b4a4-4121e7147609`.

- 2026-11-04, the recall gate moves to the server. The dedupe and cap given
  up above come back as a deterministic gate in `search`, keyed by session.
  The `PostToolUseFailure` hook also sends `session_id: "${session_id}"`;
  Claude Code substitutes it in an `mcp_tool` hook's `input`. Spike, Claude
  Code 2.1.318: a hook calling `fetch` with `id: "memory:sess-${session_id}"`
  answered `No active item exists for memory:sess-5e96e7c7-…`, the run's own
  session id. With `hook` and `session_id`, the shipped entry's hits pass, in
  order: an empty normalised error injects nothing; an error whose
  fingerprint (SHA-256 of the `normaliseError` output) this session already
  injected injects nothing; a session with three injections injects nothing;
  the coverage bar applies as before; otherwise the hits go out and the
  fingerprint is recorded. Only an injection is recorded, so an error below
  the bar is searched again next time. The record is a conditional insert,
  so two concurrent calls cannot both take the third slot or the same
  fingerprint. Custom `PostToolUseFailure` entries are not gated. A gated
  call is still a `search` call through `observeCall`, so the call log keeps
  its row. Without `session_id`, a plugin older than 0.12.0, there is no
  gate. A model's `search` ignores `session_id` without `hook`.

  The rows live in `hook_recall_injections` (user, session, fingerprint,
  created_at), on the tenant's own database. Each recorded injection
  deletes the caller's rows older than 24 hours in the same batch, and the
  read ignores them, so there is no cron. The table is not searchable
  content and has no projection; backups omit it.
  `todo:tdo_939e07f9-f45b-453f-b5ba-05d17f985322`.

- 2026-11-05, scopes a client names. `transcripts:read` and
  `transcripts:write` join the vocabulary for ADR-0022, stored in
  `bearer_token_grants` like every scope after the first seven. Consent still
  grants the whole vocabulary to a client that names nothing beyond
  `search:read`, which is what V1-7 above protects; a client that names any
  other scope now gets exactly the scopes it named (`consentGrant()` in
  `app/auth/scopes.ts`), so a Valise CLI holding `transcripts:write` cannot
  read the case. ADR-0022 records the rule and why the request, not the
  client, carries it.

## Consequences

Gained: every target client connects today; a leaked read-only token cannot write; provenance comes from auth context rather than caller-supplied strings. Given up: running our own authorization server means owning token lifecycle bugs; the DCR allowlist needs a line added whenever a new client family appears. Inherited: scope granularity is per-concept, not per-item; finer sharing (public skills, per-project tokens) is a future ADR.
