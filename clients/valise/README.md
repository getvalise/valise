# valise

The Valise connector for Claude Code, plus lifecycle hooks that nudge memory
capture and recall. Valise is the shared MCP memory and to-do endpoint.

- `.mcp.json` registers the `valise` MCP server, with a `headersHelper` that
  tells Valise which session made each request.
- One zero-dependency Node script, shared verbatim between Claude Code and
  Codex, runs at `SessionStart` and `Stop`. It only injects text and never
  calls Valise.
- Two `mcp_tool` hooks call Valise over the connector's own sign-in: `search`
  after a failed Bash command (`PostToolUseFailure`), and `get_brief` after a
  compaction.

Install, sign in once with `/mcp`, done. There is no token to mint or paste.

## Invoking a skill

Enabled skills are available as MCP tools, prompts, and resources. Tools let
the assistant discover instructions automatically. Prompts let you select a
skill explicitly: with the server named `valise`, OpenCode registers
`/valise:conversation-history`; the tested Claude Code command is
`/mcp__valise__conversation-history`. Use the name shown by your client's
command picker. Clients decide command spelling and catalog refresh; reconnect
the MCP server if a newly enabled skill is not listed. Native `@` or `$` skill
pickers are separate and are not populated by these prompts.

A prompt takes no arguments and loads the current SKILL.md instructions. If
the skill has supporting files, it includes their resource URIs for on-demand
reading. It does not install local skills or grant access to tools those
instructions require. Listing or loading prompts requires `skills:read`.

Tool-only clients can read supporting text with `read_skill_file(name, path)`.
Use a path from the loaded skill's files manifest, such as
`references/guide.md`. This tool reads only the active head's published files;
it does not execute scripts or load SKILL.md. Binary files remain available
through `resources/read`. Both routes require `skills:read`.

## Prerequisites

Node 18 or later, on the PATH the harness uses to run hook commands.

## Install: Claude Code

```
/plugin marketplace add getvalise/valise
/plugin install valise@valise
```

The plugin brings its own connector, so remove one you added by hand, or
every tool shows up twice:

```
claude mcp remove valise -s user
```

If you installed this plugin under its earlier name, uninstall that first
with `/plugin uninstall valise-hooks@valise`.

Then run `/mcp` and authenticate `plugin:valise:valise`. Its tools are
named `mcp__plugin_valise_valise__*`; update any permission rules that
name `mcp__valise__*`.

The connector points at the hosted endpoint. Set `VALISE_MCP_URL` to the
`/mcp` URL of your own deployment to use that instead.

## What the connector tells Valise

OAuth gives Valise one identity per grant, and every Claude Code on a machine
shares the grant. Without more to go on, the logs tab cannot tell this
terminal from a Conductor workspace or a second laptop. The `headersHelper`,
`scripts/valise-headers.mjs`, adds four headers to every request:

| Header | Value |
|---|---|
| `X-Valise-Session` | the Claude Code session id, or `pid@host` when there is none |
| `X-Valise-Session-Name` | the session's name, for example `valise-34` |
| `X-Valise-Host` | the machine's hostname |
| `X-Valise-Plugin` | `valise/<version>`, so a missing header means no plugin |

The session comes from `~/.claude/sessions/<pid>.json`, which Claude Code
writes for itself and does not document; if it disappears, sessions still
split on `pid@host`. Claude Code runs the helper once per connection, so a
`/clear` keeps reporting the old session until the connector reconnects.

The session name is also what the console calls the agent. A to-do it
creates, claims, updates, comments on or completes, and a memory it saves,
stores `X-Valise-Session-Name` beside the OAuth client id, and the console
shows `work-todos-60 · Claude Code` instead of
`https://claude.ai/oauth/claude-code-client-metadata`. Claude Code derives
the name from the working directory, so a worktree session is named after its
worktree; `/rename` changes it from the next connection. The lease still
belongs to the client id, not the session name. ADR-0004.

Codex has no `headersHelper`. Its requests carry its client name and
version and `X-Valise-Plugin`, and nothing per session.

Any other client that can set a static MCP header can name its session the
same way. OpenCode substitutes environment variables in `opencode.json`:

```json
{
  "mcp": {
    "valise": {
      "type": "remote",
      "url": "https://app.valise.run/mcp",
      "headers": { "X-Valise-Session-Name": "{env:VALISE_SESSION_NAME}" }
    }
  }
}
```

Start it with `VALISE_SESSION_NAME=$(basename "$PWD") opencode`. Without the
header the console shows the client's short name, `OpenCode`.

## Install: Codex

```
codex plugin marketplace add getvalise/valise
codex plugin add valise@valise
```

Codex reads `.codex-plugin/plugin.json`, which points at `.codex.mcp.json`
instead of the Claude Code `.mcp.json`. Codex expands neither
`${VALISE_MCP_URL:-…}` nor a `headersHelper`, so its connector has the hosted
URL written out and one static header, `X-Valise-Plugin`. To use your own
deployment from Codex, add it with `codex mcp add valise --url <your /mcp URL>`
and leave the plugin for its hooks.

Remove a `[mcp_servers.valise]` entry from `~/.codex/config.toml` if you added
one by hand. It has the same name as the plugin's server, and the
`config.toml` entry wins.

Codex trusts plugin hooks by hash. Open `/hooks` in Codex and approve the
`valise@valise` `SessionStart` and `Stop` hooks, or they never run. Every
update that changes `valise-hook.mjs` changes its hash and asks again.
Codex has no `PostToolUseFailure` event and skips that entry in
`hooks.json`, so `recall-on-error` runs in Claude Code only. The `mcp_tool`
hooks name the server `plugin:valise:valise`, Claude Code's name for it, so
Codex does not find it and runs neither.

## Config

`~/.valise/config.json` is optional; every field in it is optional. The three
shipped ids (`capture-nudge`, `recall-reminder`, `recall-on-error`) take
overrides only on the fields below; a `custom` array adds entirely new
injections. Both namespaces reject anything outside their field set with one
stderr line and a non-zero exit, so a typo surfaces as a visible hook error
rather than a silent no-op or a silently misfiled entry.

| Key | Field | Type | Default |
|---|---|---|---|
| `capture-nudge` (`Stop`) | `enabled` | boolean | `true` |
| | `every_turns` | integer ≥ 1 | `10` |
| | `text` | non-empty string ≤ 2000 chars | the shipped nudge |
| `recall-reminder` (`SessionStart`) | `enabled` | boolean | `true` |
| | `text` | non-empty string ≤ 2000 chars | the shipped reminder |
| `recall-on-error` (`PostToolUseFailure`) | `enabled` | boolean | `true` |
| | `text` | non-empty string ≤ 2000 chars | the shipped line, unused since the hook searches |
| `custom[]` | `event` | required, `"Stop"`, `"SessionStart"` or `"PostToolUseFailure"` | |
| | `text` | required, non-empty string ≤ 2000 chars | |
| | `enabled` | boolean | `true` |
| | `every_turns` | integer ≥ 1, `Stop` entries only | `1` |

`recall-on-error` and `PostToolUseFailure` custom entries in this file are
validated and then unused: that hook runs on the server, which reads the
config stored in Valise (see "Config from Valise").

All due texts for an event emit together: `SessionStart` and
`PostToolUseFailure` each join them into one `additionalContext`, `Stop`
joins them into one block `reason`. The combined enabled text per event (the
shipped entry plus every enabled custom entry for that event) is capped at
8000 characters, checked at parse time with the same loud failure as any
other config error.

Shipped defaults:

- `capture-nudge`: "If this session produced a decision, insight, or dead
  end another session would pay to rediscover, and Valise's save_memory
  tool is available, save it following the capture-this skill. Leave
  unfinished work as a to-do whose next step copies identifiers, paths and
  values exactly as the user or a tool gave them; never invent a command. If
  nothing new came up or it is already saved, saving nothing is fine: stop."
- `recall-reminder`: "Valise is connected. Before re-deriving prior work,
  search it for decisions and skills. When a command fails with an error the
  message itself does not explain how to fix, search Valise for the error
  text before trying something else. When you leave work for another
  session, name its next step with identifiers, file paths and values
  exactly as the user or a tool gave them. Never invent a command nobody
  gave." A line asking for `get_brief` follows it (see below).

A `Stop` entry is due on the session's first turn and then on every
`every_turns`-th turn, so a one-turn headless session still gets one capture
moment. If the turn counter cannot be saved the hook nudges nothing, since
every turn would otherwise look like the first.

`capture-nudge` fires on a due turn only when the stretch since the last due
turn called at least one tool and called no Valise write tool (`save_memory`,
`edit_memory`, `create_todo`, `update_todo`, `complete_todo`,
`comment_todo`). A stretch of conversation has nothing new to save, and a
session that already wrote back does not need asking twice. The hook reads
the tool calls from the hook payload's `transcript_path`, Claude Code's
`tool_use` and Codex's `function_call` records alike, and keeps the byte
offset of the last due turn beside the turn counter. When the transcript
cannot be read, the cadence alone decides, as before. Custom `Stop` entries
keep their plain cadence. The J4 writeback run of 2026-10-25 is why: with the
reminder after every answer, Haiku saved its failed attempts as dead ends
and ran out of rounds (evals run `writeback/2026-10-25-first-paid`; raw runs stay local).
- `recall-on-error`: "This command failed. Unless the error
  is a typo in the command you just ran, search Valise for the error text
  before trying something else; a stored memory may explain it."

`recall-on-error` fires when a Bash command exits non-zero, which Claude
Code reports as `PostToolUseFailure` rather than `PostToolUse`. A command
that succeeds never fires it. The plugin's hook for it is an `mcp_tool`
hook: Claude Code calls `search` on the connector with `hook:
"PostToolUseFailure"` and the command's raw error as `query`, over the same
OAuth session as every other tool call. The server keeps the error's
error-shaped lines (or its last three), drops the `Exit code N` line, URLs,
paths and every word holding a digit, and looks for at most two memories,
skills or to-dos holding at least 60% of the error's informative words, and
never fewer than two of them. A word that a fifth of your notes hold is not
informative. The hook then injects:

```
This command failed. Valise holds notes that share most of this error's words. Fetch the one that fits before trying something else:
- memory:mem_… <title>
```

When nothing clears that bar it says nothing, which is the intent for a
typo, since no note shares its misspelt word. The hook also sends the
session id, and the server injects a given error once a session and at
most three errors a session; a repeat, or a fourth, says nothing. Two runs
of one failure count as the same error when they differ only in numbers,
paths and URLs. The server reads your stored
hook config for this event, not `~/.valise/config.json`: `recall-on-error`
off silences the hits, and enabled custom `PostToolUseFailure` entries
follow them on every failure. A server that does not answer within the
hook's 10 seconds leaves the failure without a line.

The evals below measured the plain `recall-on-error` line the hook used to
inject, not the searched one. In headless Claude Code on the shipped config
(run `2026-10-19T10-28-12`), Sonnet and Haiku searched Valise after a real
failed `gh pr merge` in 6 of 6 sessions, and in none of the 6 sessions where
`npm run tset` failed on a typo. With the hook off, the sentence alone drew
a search after the conflict in 1 of 6. Over seven models (run
`2026-10-18T21-17-54`), the hook took searches after the conflict from 8 to
19 of 21 episodes and after the typo from 4 to 6 of 21, all of the typo
searches gpt-5.4-mini and grok. The full suite on the shipped config is run
`2026-10-19T10-22-13`. `evals/README.md`, under "Which default ships", has
the runs. Turn it off on the console's Hooks page or through `edit_hook`.

Example, widening the nudge cadence, turning the reminder off, and adding a
custom `Stop` entry:

```json
{
  "capture-nudge": { "enabled": true, "every_turns": 20 },
  "recall-reminder": { "enabled": false },
  "custom": [
    {
      "event": "Stop",
      "every_turns": 1,
      "text": "If this session mentioned lemons, call my_lemon_tool before stopping."
    }
  ]
}
```

`VALISE_CONFIG` overrides the config file path, for testing or for a
non-default location.

## Config from Valise

Valise stores a hook config document too. Edit it field by field on the
console's Hooks page (`/hooks`), or ask an agent: the MCP tools `list_hooks`
and `edit_hook` read and change it. It reaches a session three ways:

- Enabled `SessionStart` entries arrive as MCP server instructions, in every
  client.
- `recall-on-error` and custom `PostToolUseFailure` entries are read by the
  server when the failed-command hook calls `search`.
- `Stop` entries reach Claude Code's hook only from `~/.valise/config.json`.
  The plugin no longer syncs that file from Valise, because the sync needed
  a bearer token beside the OAuth sign-in. A file a previous version synced
  stays in use until you edit or delete it.

## Startup brief

The `SessionStart` hook makes no network call, because Claude Code runs it
before the connector is connected. On `startup` and `clear` it adds a line
after `recall-reminder` naming the directory's project and asking the agent
to call `get_brief` with it; the brief comes back over the agent's own
sign-in. Turning `recall-reminder` off drops both.

The project is, in order:

1. `project` in a `.valise.json` at the repository root (or in the directory
   itself outside git), for a repository whose name is not its project:

   ```json
   { "project": "valise" }
   ```

   Commit it, so every clone and worktree agrees.
2. The repository name of the `origin` remote (`git remote get-url origin`,
   given 0.5 seconds), which a worktree shares with its main checkout.
3. Neither: the line asks for `get_brief` without a project, which briefs
   every project.

When `get_brief` gets a project nothing is filed under, its `note` says so
and `projects` lists the active ones, so the agent asks you which one you
meant and can suggest the `.valise.json`.

On `resume` the conversation already holds the reminder, but which to-do
this worktree claimed can be lost. The command hook points at `get_brief`'s
claimed section, since the connector is not up yet at launch. After a
compaction, a second hook, `mcp_tool` this time, calls `get_brief` with
`hook: "SessionStart"` and the working directory, and injects the claimed
to-dos whose `worktree` ref holds that directory, each with its id, title,
project and latest status and a pointer to `fetch` it for the fencing
token. With no such claim it injects nothing. Other sources, such as `fork`,
stay silent.

The server also sends every enabled `SessionStart` entry as MCP server
instructions to every client, so a plugin session reads that text twice. The
hook keeps injecting it anyway: Claude Code can answer its first turn before
the MCP server has connected, and a headless session often does, so the hook
is the only channel present at turn one. A client without the plugin, such as
ChatGPT chat, also gets the `Stop` and `PostToolUseFailure` entries as
standing rules in those instructions.

`GET /config/hooks`, `/config/brief` and `/config/recall` still answer a
console-minted bearer, for a client that holds one. The plugin no longer
calls them.

## Trust

This config file carries the same trust as `CLAUDE.md`, `AGENTS.md`, or any
of the harness's own settings files: anything that can write it can steer
what gets injected into a future session. Codex's hook-trust hash covers
`valise-hook.mjs` itself, not this file, so editing the config does not
trigger a re-trust prompt. That is not a gap specific to this hook; any
process that can write a file under your home directory can already inject
context through those other files. Treat `~/.valise/config.json` with the
same care you'd give them.

## Inspecting the effective config

```
node clients/valise/scripts/valise-hook.mjs --print
```

Prints the merged config (every entry's `enabled`, `every_turns` where it
applies, and the final `text`) plus the config file path used, without
reading stdin.
