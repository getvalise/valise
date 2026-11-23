# valise-cli

The Valise command line. It sends the conversations this machine holds from
Claude Code, Codex and OpenCode to Valise: every existing session once, then
each new one as its client writes it. ADR-0022 is the decision behind it.

Dependency-free Node 22 or later. Apache-2.0.

```sh
npm run cli:install     # from a checkout: `valise` on PATH, copied, not linked
valise install          # sign in if needed, send existing sessions, then watch (macOS)
valise                  # where setup stands, and the next command
```

`npm run cli:install` runs `npm install -g --install-links ./clients/valise-cli`.
`--install-links` copies the package into the global prefix, so the command
keeps working after the checkout or worktree is gone. Rerun it, then
`valise install`, to update.

## Sign-in

`valise login` registers an OAuth client with a loopback redirect, opens the
consent page, catches the code on 127.0.0.1 and exchanges it with PKCE. It
asks for `search:read transcripts:write transcripts:read`, and the consent
page grants exactly that, so the refresh token on this machine can send and
read transcripts and nothing else. Revoke it on Connections; the CLI then
asks you to sign in again.

The sign-in is kept in `~/.config/valise/cli.json` (or `$XDG_CONFIG_HOME`,
or `$VALISE_HOME`), mode 0600. The OS keychain is not used yet.

## What is sent

Every session on the machine, in any directory. Per turn: a human message,
an assistant text, the assistant's thinking (Claude Code thinking blocks with
text, OpenCode reasoning, the summary of a Codex reasoning item), a tool call
with its name and a one-line summary of its arguments, a tool error with the
tool's name and its output, an API error, or system text: what the client
put in front of the model that nobody typed. For Claude Code that is the
system prompt from `prompt_snapshot`, instruction files (CLAUDE.md,
AGENTS.md), hook context, the skill, agent and MCP-server lists, skill
bodies, the environment and reminders; for Codex its instructions and
`developer` messages. Each distinct text goes once per session. Successful
tool results and tool definitions stay on the machine. Valise keeps thinking
and system text out of search; `fetch` gives the opening 300 characters of
each system turn. One Claude Code transcript of 15 MB becomes about 33 KB
of conversation and about 80 KB of system text.

`sent.json` records the distiller version (`DISTILL_VERSION` in
`distill.mjs`). After an update that changes it, `valise import` re-sends
every session rather than skipping the files whose mtime is unchanged.

Each session carries its working directory, git branch and a project label:
the name of the git repository the working directory is in, where a worktree
reports its main repository, or none outside a repository.

Sessions are identified by client, device (this machine's hostname, or
`device` in the config) and the client's own session id. A resend adds
nothing: the server compares the turns it holds hash for hash and answers
with its own list when the histories differ, and the CLI resends from the
longest common prefix.

## Install and watch

`valise install` prints each step as it takes it:

1. Checks the sign-in. With none stored, or one Valise refuses, it runs
   `valise login` first (`--origin URL` picks the instance). An unreachable
   Valise stops the install instead.
2. Sends every existing session, with a progress line. On one Mac, 1,123
   sessions from 3.4 GB of local files took about 14 s.
3. Writes `~/Library/LaunchAgents/run.valise.watch.plist`, which runs
   `valise watch` at login and restarts it when it exits (`KeepAlive`, at
   most every 10 s).
4. Waits for the watcher to write a fresh heartbeat before it reports it
   started.

`valise watch` watches `~/.claude/projects`, `~/.codex/sessions` and
OpenCode's SQLite file (`$XDG_DATA_HOME/opencode/opencode.db`, or
`$OPENCODE_DB`). A changed session file is sent once it has been quiet for
3 s; a change to OpenCode's file sends OpenCode's sessions. A full pass runs
at start and every 10 minutes, which catches what the OS did not report and
retries what failed. Six sessions are sent at a time; against a fake with
production's measured latency (140 ms per state read, 400 ms per append),
that took 116 sessions from 65 s to 12 s. `sent.json` beside the config,
saved every 50 sessions, remembers how far each session was sent, so an unchanged file costs one `stat` and a grown one
sends only its new turns.

Nothing depends on the watcher. When it is stopped, sessions wait in their
clients' own files and go out on its next pass. Claude Code deletes old
transcripts after its retention period, so a watcher left off past that
loses them.

`valise uninstall` stops the watcher and removes the agent; what was sent
stays in Valise. Output goes to `~/Library/Logs/valise/watch.log`, and
`watch.json` beside the config says when it last sent. `valise status`
prints the same facts as `valise`, tab-separated on stdout.

macOS only. Elsewhere, run `valise watch` under your own service manager.

## Import

`valise import [--client claude-code|codex|opencode]` sends every session
once, with the same progress line, without installing anything. A session
Valise already holds in full is skipped. On the Mac that took the
1,123-session figure above, the readers distilled 1,006 Claude Code
sessions, 116 OpenCode sessions (594 turns) and one Codex session (21
turns). The Codex reader was then checked against 1,874 rollouts from an
archive (2026-03 to 2026-11).

`valise import --from DIR [--client claude-code|codex|claude-ai|chatgpt]`
sends the sessions in a directory of copies or exports. Any layout works:
a copy of `~/.claude/projects` or `~/.codex/sessions`, dated folders of
session files, a claude.ai account export (`conversations.json`, or one
`conversation.json` per chat), or a ChatGPT `conversations.json`. Files are
read by name and, for JSON, by shape. Compressed files (`.zst`, `.zip`) are
passed over, so unpack them first. A session found twice is read from its
largest copy. Claude Desktop chats are claude.ai chats and go as
`claude-ai`.

An archived copy may be older than what Valise holds, so `--from` sends only
sessions Valise does not hold at all and never replaces one. Claude Code and
Codex sessions go under this machine's device name. claude.ai and ChatGPT
conversations go under `claude.ai` and `chatgpt.com`, so a later export from
any machine adds to the same sessions. Only the branch you last saw is
kept. A pasted file goes as a system turn named after the file.
