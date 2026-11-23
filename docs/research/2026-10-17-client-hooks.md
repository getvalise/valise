# Client hooks: capture nudges from the harness, configured by the user

Date: 2026-10-17
Status: accepted, built as V1-21.

## What this ships

The memory-capture redesign (`docs/research/2026-10-17-memory-capture-redesign.md`) left
auto-capture design-only and named three tiers. This
slice builds tier 1: hook configs that a harness runs at session lifecycle
points, so the capture decision reaches the model that holds the context
without the user asking. The shape the owner confirmed in conversation
(2026-10-17): one static plugin whose hook scripts read user config at
runtime, so turning a nudge off is a config edit, never a reinstall, and the
on/off switch lives on the client, where the behaviour lives. This design was
pressure-tested by a three-reviewer adversarial panel (two Claude models plus
codex) before implementation; the panel's findings shaped the config
contract, the cadence, and the Codex delivery path below.

## One contract, two harnesses

Codex copied Claude Code's hook contract nearly verbatim, on purpose.

| Shared across both | Detail |
|---|---|
| Event names | `SessionStart`, `Stop`, `SessionEnd`, and nine more, identical strings |
| `hooks.json` shape | top-level `hooks` key → event → matcher groups → `{type: "command", command}` |
| stdin payload | JSON with `session_id`, `transcript_path`, `cwd`, `hook_event_name`; `Stop` adds `stop_hook_active` in both |
| Output | `decision: "block"` + `reason` on `Stop`; `hookSpecificOutput.additionalContext` on `SessionStart` |

Sources: code.claude.com/docs/en/hooks, code.claude.com/docs/en/plugins/manifest-reference,
developers.openai.com/codex/hooks, developers.openai.com/codex/plugins/build.

One script serves both harnesses, staying inside that shared subset and
touching none of the fields the harnesses define differently (`turn_number`
vs `turn_id`, Codex's `continue`/`systemMessage`, matchers on
`SessionStart`).

Delivery differs per harness, and only delivery:

- Claude Code installs a plugin: `clients/valise-hooks/` with
  `.claude-plugin/plugin.json`, `hooks/hooks.json` referencing the script via
  `${CLAUDE_PLUGIN_ROOT}`, and a root `.claude-plugin/marketplace.json` so
  the repo is its own marketplace.
- Codex gets a documented block for `~/.codex/hooks.json` whose command names
  the absolute path of a checkout. There is no Codex manifest in this slice:
  hook-bearing plugins are excluded from Codex's public plugin directory,
  subdirectory marketplace sources are undocumented, and `CLAUDE_PLUGIN_ROOT`
  is only set for plugin-installed hooks, so a portable manifest would
  describe an install path that does not exist. One manifest for an
  unreachable path is drift waiting to happen; it returns when Codex
  documents one.
- Codex trusts hooks by hash. A new or changed hook is skipped until the
  user reviews it with `/hooks`, and every update to the script re-triggers
  that review. The README carries both the onboarding step and the
  re-trust-after-update cost; nothing in code can shortcut either.

## The event choice, and when the nudge fires

`Stop` is the only event that can put the capture question to the model.
`SessionEnd` fires after the session is over, its output never reaches the
model, both harnesses ignore its blocking exit code, and Codex gives it one
second. It stays reserved for the transcript tier (spec v1.5), where
fire-and-forget is exactly right and the payload already carries
`transcript_path`.

`Stop` fires at the end of every assistant turn, not at session end. That
rules out the obvious "nudge once per session" guard: it would fire after
the first answer, when there is nothing to capture, and stay silent for the
rest of the session by construction. The nudge instead runs on a turn
cadence. The script keeps a per-session counter in the OS temp dir,
increments it on every `Stop`, and nudges when the count reaches a multiple
of `every_turns` (default 10). A long working session gets a capture moment
roughly every ten turns; a two-question session never sees one. The counter
is the user's `turn-count threshold` knob from the original ask.

The nudge itself is the `Stop` block contract both harnesses share: the
script answers `{"decision": "block", "reason": "<the nudge>"}`, the harness
gives the model one more pass with the nudge in front of it, and the model
saves a memory or simply stops again. `reason` carries the text because it
is the one field both harnesses deliver to the model on a block;
`additionalContext` on `Stop` is the field the two vendors document
differently, so the script never uses it there. Two guards prevent loops:
the harness's own `stop_hook_active` flag always exits silently, and the
cadence counter fires at exact multiples only.

State rules, in order of what they protect:

- Emit first, count second. A crash between the two costs one extra nudge
  later; the reverse ordering costs a silently swallowed one.
- Counter updates are atomic (write to a temp name, rename over). A
  concurrent double-fire can at worst miscount by one turn, which shifts a
  nudge, never repeats it in the same pass.
- A counter that cannot be read or written means no nudge and one stderr
  line. Fail toward silence, never toward a nag loop.
- The filename is a hash of `session_id`, so the id never meets the
  filesystem raw. The OS temp cleaner owns expiry.

`SessionStart` needs no blocking: plain `additionalContext` output lands in
context before the first turn. The script reads the payload's `source` and
injects only for `startup` and `clear` (or when `source` is absent, as under
Codex). `resume`, `compact`, and `fork` keep their context; re-injecting a
recall reminder right after a compaction would tell the model to re-search
what the harness just summarized away.

## Config: two shipped entries, plus explicit custom entries

The panel's strongest consensus finding: an open "merge by id" registry
makes a typo indistinguishable from an intentional new entry, so
`capture_nudge` misspelled, or the right id under the wrong event, silently
leaves the shipped nudge running while the user believes it is off. The fix
is separation, not removal. Overrides address exactly the two shipped ids
and reject anything else; user-defined injections live under a distinct
`custom` key where `event` and `text` are required. A typo in either place
is a loud validation error, never a silent new entry.

Custom entries are the point of the feature, not an extra: "if the session
mentions lemons, call my_lemon_tool" is a one-line entry in the config, no
fork, no reinstall. The panel flagged that this text is not covered by
Codex's hook trust hash, and that is true, but it is also the baseline of
every harness today: any process that can write one file under `$HOME` can
already inject context through `CLAUDE.md`, `AGENTS.md`, or the harness's
own settings, none of which are hashed either. The config file adds no new
class of attack; it is exactly as trusted as those files, and the README
says so plainly. The one real mitigation kept: the closed field set and
required `text` mean nothing fires that the user did not spell out.

`~/.valise/config.json` (every field optional unless marked; the file
itself optional):

```json
{
  "capture-nudge": { "enabled": true, "every_turns": 10, "text": "..." },
  "recall-reminder": { "enabled": false, "text": "..." },
  "custom": [
    { "event": "Stop", "every_turns": 1, "text": "If this session mentioned lemons, call my_lemon_tool before stopping." }
  ]
}
```

| Key | Field | Type | Default |
|---|---|---|---|
| `capture-nudge` (`Stop`) | `enabled` | boolean | `true` |
| | `every_turns` | integer ≥ 1 | `10` |
| | `text` | non-empty string ≤ 2000 chars | the shipped nudge |
| `recall-reminder` (`SessionStart`) | `enabled` | boolean | `true` |
| | `text` | non-empty string ≤ 2000 chars | the shipped reminder |
| `custom[]` | `event` | required, `"Stop"` or `"SessionStart"` | |
| | `text` | required, non-empty string ≤ 2000 chars | |
| | `enabled` | boolean | `true` |
| | `every_turns` | integer ≥ 1, `Stop` entries only | `1` |

All due texts for an event emit together: `SessionStart` joins them into one
`additionalContext`, `Stop` joins them into one block `reason`, and the
combined enabled text per event is capped at 8000 characters at parse time,
loud, which keeps the rendered output under Codex's ~2,500-token spill
threshold. A `Stop` custom entry at the default `every_turns: 1` costs one
extra model pass per turn; that cost is the user's to spend, and `--print`
shows what will fire.

Shipped defaults:

- `capture-nudge`: "If this session produced a decision, insight, or dead
  end another session would pay to rediscover, and Valise's save_memory
  tool is available, save it following the capture-this skill. Otherwise
  stop."
- `recall-reminder`: "Valise is connected. Before re-deriving prior work,
  search it for decisions and skills, and check list_ready for open
  tickets."

Boundary rules. The file is parsed and validated once, at the top of the
script, against the table above. A missing file means defaults. A file that
fails to parse, an unknown key, a wrong type, or an over-length `text`
means no injection, exit 1, and one stderr line, which both harnesses
surface as a non-blocking hook error; a config mistake stays visible without
ever blocking a session. The 2000-character ceiling keeps the rendered
output far below Codex's ~2,500-token `additionalContext` spill threshold.
`VALISE_CONFIG` overrides the config path, which is also the test seam.
Running the script with `--print` writes the merged effective config and
each entry's final text to stdout, so "what will my next session inject"
is one command, not a source read.

The defaults live in the script, not in seeded config. Moving them to data
would dodge Codex's re-trust on wording tweaks, but it would also move the
injected text outside the one artifact Codex hashes, which is the trust
model working as intended. Wording changes are code changes here.

## Alternatives rejected

- *A toggle on the MCP server as the only switch.* The server cannot see
  whether a hook fired. Config living where the behaviour does not is the
  drift machine the memory-capture doc already named. Server-stored config
  the client fetches and enacts is a different shape, and it is planned, not
  rejected; see the next section.
- *A blocking network call in the hook.* A nudge that waits on a Worker
  round-trip adds a failure mode to every offline session and latency to
  every turn end. The hook's cost today is a local Node start, tens of
  milliseconds. Server sync therefore has to be cache-first; see below.
- *An open merge-by-id registry.* The typo problem above. Overrides and
  custom entries are separate namespaces instead.
- *A generated per-user plugin.* A build pipeline to do what one config
  read does, and every wording tweak becomes a version bump.
- *POSIX sh for the script.* The script parses JSON three times (stdin, the
  config, its own output). Shell needs jq, which neither harness
  guarantees. Node is this repo's runtime everywhere; the README names
  Node 18+ as an explicit prerequisite, and the script is useless without
  it by design, not by accident.
- *Nudging via `SessionEnd`.* Cannot reach the model. See above.
- *A second, portable manifest for Codex.* No install path reads it today.
  See delivery above.

## Licensing

The spec splits licenses: FSL-1.1-ALv2 for the server, Apache-2.0 for
clients. This slice makes that real for the first time, so the split gets
written down where tools and readers look: `clients/valise-hooks/LICENSE`
carries Apache-2.0, and root `LICENSE.md` gains one sentence scoping itself
to everything outside `clients/`. The root `.claude-plugin/marketplace.json`
is a pointer file outside the Apache tree; it carries no licensable
expression and the README says so. ADR-0021 later replaced FSL with
AGPL-3.0-only and `LICENSE.md` with `LICENSE` and `NOTICE`.

## Where each client scenario lands

Every nudge design has to answer for four scenarios, not one:

| Scenario | What reaches it |
|---|---|
| Chat, no hooks or CLI (Claude Chat web/mobile, ChatGPT) | Tier 2: tool descriptions, the capture-this skill over MCP, server response nudges, and the MCP `instructions` field, which carries the hook text as standing rules (ADR-0004, amendment of 2026-11-02). |
| Hook-capable harness (Claude Code, Cowork, Codex) | This slice. Install and trust differ per harness; the script and config are shared. |
| Fresh machine, no config or cache yet | Shipped defaults carry the whole experience; the config file is optional by design. |
| Per-harness wording differences | One shared text today. If a harness needs different instructions (tool naming, how a block renders), that becomes a per-entry variant, measured first (see the evals to-do). |

The chat-only row is the reason tier 2 (response nudges on `complete_todo`)
stays on the roadmap independently of hooks, and the eval suite is where
wording claims get tested across models before any per-harness fork.

## Next slice: server-stored config, cache-first

The owner wants config edits to flow from one place to every machine, including
from the Valise console. The shape that preserves this slice's guarantees:
the server stores the config document and the client enacts it, with
`~/.valise/config.json` demoted to a cache. The hook reads the cache
synchronously (today's behaviour, unchanged latency), and when the cache is
older than a TTL (minutes, not seconds) it spawns a detached refresh that
fetches the document, validates it with the same parser, and rewrites the
cache atomically for the next invocation. Offline or failing fetches keep
serving the cache forever; a hook never waits on the network and never goes
silent because the server was unreachable. A fresh machine with no cache runs
on shipped defaults until the first detached refresh lands, so day one needs
no setup beyond the install. The open problem is credentials:
the hook does not share the harness's OAuth session, so the client needs a
token with a config-read scope in a local file, which is its own small
design. That is its own follow-up slice, tracked as a Valise to-do, not part
of this one.

## Open questions

- Whether `recall-reminder` earns default-on. If session starts feel noisy
  in the first dogfood week, flip the shipped default to off; one constant.
- The right `every_turns` default. 10 is a guess at "often enough to catch
  a working session, rare enough not to nag"; dogfooding will move it.
- Codex marketplace install, once subdirectory sources or hook-plugin
  directory rules are documented.
- Per-harness text variants on config entries, only if the evals show one
  shared wording degrading on a specific harness.
