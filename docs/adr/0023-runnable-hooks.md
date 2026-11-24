# 0023. Runnable hooks: agents propose, the owner approves with a passkey

Date: 2026-11-24
Status: accepted
Amends: ADR-0003 (`propose_hook`), ADR-0004 (`hooks:exec`, approval, the
2026-11-04 line "`Stop` is unchanged and local"), ADR-0015 (hook files as
assets).

## Context

Valise hooks inject text and nothing else. `clients/valise/scripts/valise-hook.mjs`
prints the SessionStart line and the `capture-nudge` Stop text; every entry in
the hook config document (`app/concepts/hook-config.ts`) is a string. Anything
that has to run lives outside Valise, on the machine that runs it. The handoff
hook that prompted this record is `plugins/claude/tools/hooks/handoff-on-stop.sh`
in `dumkydewilde/tools` (PR #107): on Stop, past 120,000 tokens of context and
when `HANDOFF.md` is older than the last commit, it spawns a detached
`claude -p --model haiku` that writes `HANDOFF.md` from a condensed transcript,
and exits 0 at once. It reaches a machine only through the `tools` plugin.

A machine with nothing set up, a cloud VM above all, has none of that. The
owner wants such a machine to get its hooks and their scripts from Valise:
the handoff, custom scripts, a transcript upload at session end.

Valise holding code that runs on the owner's machines changes what a write to
Valise can do. Today `config:write`, which consent grants every OAuth client
(ADR-0004, 2026-10-18), can change text injected into future sessions. If the
same scope could change a script, any connected agent, or anyone holding its
token, could run code on every machine the owner signs in from. Agents also
drive the owner's browser (Claude in Chrome, Playwright attached to the
owner's profile), so a console session cookie is not proof that a person
looked at a change.

Two constraints come from the session itself. A hook that prints, blocks, or
takes seconds is noise in every turn, and `capture-nudge` is already the one
blocking Stop text the owner accepts. And the Stop hook runs at the end of
every turn, so anything it does on the network is paid per turn.

Decided with the owner in the design session of 2026-11-24. The owner
reviewed the draft the same day and settled what it added beyond that
session: hook cost in `hook_runs` rather than `spend_daily`, a cloud handoff as
the run report's result rather than a to-do comment, no waiting period for a
new passkey, the transcript upload on `Stop` every 10 turns because
`SessionEnd` is unreliable, and the git gates in the detached child because
`git status` is a spawn and slow on a large repository.

## Decision

### Entries, versions and what an approval binds

A runnable entry is a named hook (`handoff`, unique per user) that runs a
command. Its content is a version: event, argv, gates, declared outputs,
timeout, caps, and its files, each a `path` and the SHA-256 of its bytes. The
version hash is the SHA-256 of the canonical JSON of all of those, files
sorted by path. Versions are append-only, like `skill_versions`.

An approval is an append-only event naming one version hash. An entry runs its
latest approved version that has not been revoked. A new proposal never
replaces what runs: the previous approved version keeps running until the new
one is approved, and a rejected or expired proposal leaves it running.

Tables: `hook_runnables` (user, name, created_at, disabled_at),
`hook_runnable_versions` (version hash, runnable, the content above,
provenance as every concept records it, proposed_at, expires_at), and
`hook_runnable_decisions` (version hash, `approved` | `rejected` | `revoked` |
`suspended`, credential id, at, reason). The text entries stay in the
`hook_configs` document; runnable entries are not in it, because the document
is edited field by field by agents under `config:write`, and a runnable entry
must never be.

### Agents propose

`propose_hook` (MCP, `config:write`) stores a pending version. It takes the
entry name, the content, and the files inline as UTF-8 text: at most 20 files,
64 KiB each, 256 KiB in all. Scripts are text, and inline content keeps one
call where `upload_asset` needs a call and a PUT (ADR-0003: steps of one
protocol stay behind one tool). Binary files are refused. The result names the
version hash and says that nothing runs until the owner approves it in the
console, with the approval page's URL.

A pending version never runs and is never in the manifest. It expires after 7
days: reads treat `expires_at < now` as expired, and the existing scheduled
maintenance deletes its unreferenced files.

`edit_hook` refuses runnable entries, and `list_hooks` lists them with their
state (approved hash, pending hash, last run). Turning an entry off or revoking
an approval happens in the console under the session alone: removing what can
run never needs proof that a person asked.

### The owner approves, with a passkey

The console's approval page for a version shows every file in full and a diff
against the last approved version, with argv, gates and outputs, never the
proposing agent's description of them. It flags, without blocking: network
calls (`curl`, `wget`, `fetch(`, `nc`, `ssh`), a download piped to a shell,
reads of `~/.ssh`, `~/.aws`, `~/.config/*/`, `.env`, keychain and token files,
writes outside the declared outputs, and `sudo`.

Approve needs the console session and a WebAuthn assertion with user
verification (`uv` set), made at that moment. The challenge is
`SHA-256(server nonce ‖ version hash)`, single use, valid for 5 minutes, so
the assertion is bound to exactly the content on the page; a version changed
between page load and approval fails the check. No bearer token and no OAuth
grant reaches the approve route. The decision row records the credential id.

Passkeys are registered on the account page. The first needs a console sign-in
younger than 5 minutes. Each later one needs a user-verified assertion from an
existing passkey. A new passkey can approve at once; holding it back for 24 hours
was rejected by the owner, because it slows the owner's own second device as
much as an agent's. Every passkey shows on the account page with its creation
time and last use, and the startup brief names one added in the last 7 days.
A virtual authenticator added over the Chrome DevTools Protocol can satisfy
`uv` with no person present, so user verification proves a person only when
the browser is not under CDP control. The bootstrap rule and the brief line
are what keep a passkey an agent added from going unnoticed; signed manifests
(below) are the fuller answer.

### Delivery: `hooks:exec` and the manifest

A new scope, `hooks:exec`, reads the manifest and posts run reports. It is
stored in `bearer_token_grants` like every scope after the first seven, so no
migration. It is never part of the whole-vocabulary grant `consentGrant()`
gives a client that names nothing beyond `search:read`; a client gets it only
by naming it, and the consent page says it lets the client run the owner's
approved hooks. `valise login` names it. A console-minted bearer holds it when
minted with it. A `hooks:exec` token cannot propose or approve, and a token
that can propose (`config:write`) cannot read the manifest, so neither leak
alone gets unapproved code onto a machine.

`GET /hooks/manifest` answers the approved, enabled entries: name, version
hash, event, argv, gates, outputs, timeout, caps, today's reported cost and
run count across machines, and per file `path`, `sha256`, size and a download
URL. The URL is the ADR-0015 asset download capability, an HMAC under
`TOKEN_PEPPER` scoped to one asset, valid for 10 minutes. `POST /hooks/runs`
takes a run report. Both sit behind the OAuth provider beside `/mcp`, like
`/mcp/transcripts` (ADR-0022), and record their calls.

### The runner

`valise-hook.mjs` stays the plugin's command hook. For runnable entries:

SessionStart prints what it prints today and spawns a detached sync. The sync
fetches the manifest once, downloads only files missing from
`~/.cache/valise/hooks/<sha256>/`, verifies each hash, and writes the resolved
manifest to `~/.cache/valise/hooks/manifest.json` with a rename. A file whose
hash does not match is deleted and its entry left out. The session never waits
on the network; on a fresh VM the first Stop may find no cache yet, and that
entry runs from the next one.

Stop reads the cached manifest and nothing else: no network, no downloads, no
spawn for gates. It evaluates the gates that need only files the runner
already reads: `min_context_tokens` (the latest model call's input plus cache
tokens, from the transcript's last 400 lines, as the handoff script does),
`every_turns` (the existing per-session counter), `cooldown_minutes` (a state
file per entry and repo), and the daily caps. It spawns each due entry
detached, with `SIGHUP` ignored, and exits. Target: under 50 ms with a warm
cache.

The detached child does what needs a spawn. It evaluates `git_repo_only` and
`changed_since_last_run` (HEAD, or the set of dirty files, against what it
recorded at the entry's last run in this repo), takes the lock for the entry
and repo (a directory under `~/.cache/valise/hooks/locks/`, stale after the
entry's timeout), and runs argv with the hook's stdin payload on its stdin,
the repo root as cwd, and `VALISE_HOOK_RUN=1`, `VALISE_HOOK_ENTRY` and
`VALISE_HOOK_REPORT` (a file path) in the environment. An argv element
`./<path>` naming one of the entry's files is rewritten to the cached path.
The runner exits at once when it sees `VALISE_HOOK_RUN=1`, so a hook's own
`claude -p` cannot recurse into it. It kills the run at its timeout (default
600 s, at most 1,800 s).

Runnable entries never make noise. The runner prints nothing for them, exits
0, and never answers `decision: block`; `capture-nudge` stays the only
blocking Stop text. A failure goes to `~/.cache/valise/hooks/runs.log` and to
`POST /hooks/runs`, and the next session's brief names it.

Events in this release: `SessionStart`, `Stop` and `SessionEnd`. `SessionEnd`
fires only when a session exits cleanly; a closed terminal, a crash or a VM
torn down skips it. So nothing depends on it alone: an entry that must run
before the session is lost runs on `Stop` with `every_turns`, and may also run
on `SessionEnd` as a last pass when that fires. `PostToolUseFailure` stays text
only: a runnable entry there would spawn a process per failed command, and no
entry needs it yet.

### Outputs and tracked files

An entry declares the paths it writes, relative to the repo root. Before the
run the child refuses one that is neither under `.git/` nor ignored
(`git check-ignore`). After the run it compares `git status --porcelain` for
tracked files with the state before; a tracked file that changed is a
violation. The child reports it, and the server records a `suspended` decision
on that version, so it stops running on every machine until the owner approves
it again. The child does not undo the change. A hook never changes a tracked
file, and a hook that does stops being a hook.

### Cost and caps

An entry reports its own cost by writing JSON to `$VALISE_HOOK_REPORT`:
`{ "cost_usd": 0.0042, "result": "HANDOFF.md written" }`. A `claude -p
--output-format json` run's `total_cost_usd` is the figure. A run that reports
nothing is unpriced and still counts against the run cap.

Each version declares `daily_cap_usd` (default 0.50) and `max_runs_per_day`
(default 20). The runner enforces both from its own ledger plus the manifest's
cross-machine figures as of the last sync; two machines can each start one run
past the cap before either syncs again, and that overshoot is accepted.

Reports go to a `hook_runs` table (user, runnable, version hash, machine,
session, repo, started_at, duration, outcome, cost, result up to 2 KiB), on the
tenant's database, kept 90 days. They do not go into `spend_daily`:
`docs/design/spend.md` estimates what Valise spends at list price, and a
hook's model call is paid by the owner's own Anthropic account. Mixing the two
would make the admin's total wrong in both directions. The entry's console page
shows its runs, cost per day and the caps.

### Results in the brief

The startup brief gains three lines when they apply: versions awaiting
approval ("1 hook awaiting approval"), the latest result of each entry for this
project since the last brief ("HANDOFF.md written 09:12 from session X"), and
failures and suspensions since then.

### Credentials on each kind of machine

On a Mac, the Valise CLI's sign-in in `~/.config/valise/cli.json` gains
`hooks:exec`, and `valise hooks run <event>` does the sync and the detached
run. `valise-hook.mjs` delegates to it when `valise` is on PATH, so OAuth
refresh lives in one program. On a cloud VM, a `VALISE_TOKEN` environment
secret is a console-minted bearer with `hooks:exec`, plus `transcripts:write`
when the transcript entry is enabled.

The plugin reaches a cloud session through the repository's
`.claude/settings.json` (the marketplace and the enabled plugin). Nobody has
run that; the cloud setup is documented only after a cloud session has been
seen loading the plugin and running its SessionStart hook.

A cloud VM is discarded, so its handoff goes up as the run report's `result`
and the brief shows it; locally the handoff stays `HANDOFF.md` for the Herdr
`handoff-md` pane. The `valise watch` LaunchAgent is macOS and login-scoped,
so a VM instead runs an entry that uploads the session,
`valise import --session <transcript_path>`, on `Stop` with `every_turns: 10`
and again on `SessionEnd`. Repeating it is safe: `/mcp/transcripts` checks the
turns it already holds hash by hash and appends only the rest (ADR-0022), so
each upload sends what is new since the last one. A VM discarded mid-session
loses at most the last nine turns.

### Hook files as assets

A hook file is an ADR-0015 asset with a new nullable `purpose` column set to
`hook`. Such an asset has no search projection, is not listed in Library, is
not reachable through `fetch` or `get_asset_download` by an agent, and is not
subject to expiry while a version references it. It inherits what makes assets
the right store: an immutable object, a verified SHA-256, owner scoping, and
the download capability the manifest hands out. Assets with `purpose` null are
unchanged.

### Later: signed manifests

Against a compromised server, the owner signs each approval with a key the
server never holds, and the runner refuses any entry whose signature does not
verify against a public key pinned on the machine (`VALISE_HOOKS_PUBKEY`, or a
file beside `cli.json`). Not built in this release.
`todo:tdo_8b2b151a-369f-49cc-9cd5-18bec4589437`.

## Consequences

Gained: a fresh machine gets the owner's hooks from one sign-in; agents can
write hooks without being able to run them; what runs is exactly what the owner
saw, by hash; Stop stays silent and makes no network call.

Given up: a hook script is no longer changed by editing a file on the machine;
it goes through a proposal and an approval. The owner needs a passkey before
the first approval. A cross-machine cap can be overshot by one run per machine.

Harder: the console gains its first WebAuthn ceremony and its first approval
flow, with its own interaction contract. Codex runs plugin command hooks only
when it trusts the plugin, so runnable entries reach Claude Code first. The
approval page's risk flags are pattern matches, a reading aid and not a
sandbox; the owner's reading is the control.
