# Prior art for hooks, reminders, and capture: beads, memex, Todoist MCP

Date: 2026-10-17
Status: research notes feeding the client-hooks follow-ups. Investigated at
the owner's request after V1-21 shipped the first hook tier.

Three projects, three postures toward "remind the model": beads injects a
primer at session start and otherwise expects discipline, memex pre-renders
the answers into context, Todoist does nothing at all.

## Steve Yegge's beads (github.com/steveyegge/beads)

A Dolt-backed issue tracker built for coding agents, CLI-first.

- Work items carry typed dependencies, and only the blocking types
  (`blocks`, `parent-child`, `conditional-blocks`, `waits-for`) gate the
  `bd ready` queue; annotation types (`related`, `discovered-from`,
  `supersedes`) never do (docs/core-concepts/dependencies.md).
- A `SessionStart` hook runs `bd prime`, injecting 1 to 2k tokens of
  workflow context; the same hook re-fires after compaction. The docs argue
  CLI-plus-hook over MCP on token cost, 10 to 50x less than tool schemas
  (docs/integrations/claude-code.md).
- `bd gc` deletes old closed issues; `bd admin compact` summarizes them
  instead. The docs are explicit that hooks do not make an agent use the
  tracker: "Beads provides the memory. You provide the discipline."
- Valise already beats it on claiming: beads' claim is a status write with
  no concurrency token, Valise has leases and fencing tokens.

Worth stealing: `blocked_on` as a typed, multi-entry dependency list so
`list_ready` gates transitively, and a `discovered-from` style link for
work found mid-task.

## Jasper's memex (github.com/JasperHG90/memex)

Postgres-backed agent memory with a Claude Code plugin, and the closest
prior art to the V1-21 hooks.

- Its `SessionStart` hook injects a pre-rendered, token-budgeted briefing
  (vault summary, KV facts, pinned procedure cards, top mental models) with
  a defined overflow ladder, so a cold agent starts with the facts instead
  of burning rounds re-fetching them
  (docs/explanation/session-briefings.md).
- Capture nudges are event-triggered, not cadence-triggered: `PostToolUse`
  on `Bash` nudges after a git commit, repeated edits to one file trip an
  edit-spiral nudge, and a per-session capture counter feeds a safety-net
  check at `PreCompact`/`SessionEnd`
  (docs/how-to/integrations/claude-code.md).
- Memory feedback is split on purpose: `record_outcome`
  (helpful/not_helpful) is an append-only ranking signal, deprioritize is a
  separate reversible visibility flag, so curation never destroys the
  original claim (docs/explanation/design-principles.md).
- Valise's config validation and `--print` are stricter and cheaper than
  memex's env-var toggles and two-step briefing inspection.

Worth stealing, in order:

1. Turn `recall-reminder` into a briefing: fetch top-N `list_ready` tickets
   and recent memories at hook time and inject the data, not a sentence
   telling the model to go fetch it. Needs the client credential story, so
   it lands with the cache-first server-config slice
   (`docs/research/2026-10-17-client-hooks.md`, next-slice section).
2. Add an event trigger for the capture nudge alongside the turn cadence:
   `PostToolUse` matching `git commit` is a far stronger "something worth
   saving happened" signal than turn count.
3. An append-only outcome stamp on memories (helpful/not_helpful), separate
   from archive, once retrieval ranking starts to matter.

## Todoist MCP (github.com/Doist/todoist-ai)

Doist's official MCP server, workflow-centric tools, batch-first.

- Nice tool-surface patterns: batch writes with per-item failure reporting,
  one universal `delete-object`, every write returning next-step
  suggestions alongside data, and a `deadlineDate` (hard constraint)
  distinct from `dueString` (soft, natural language).
- It has no reminding mechanism at all. No hooks, no briefing, no nudge;
  reminders are human notifications. A pure MCP tool surface leaves "the
  model forgets the list exists" unsolved, which is the negative result
  validating the hook tier.

Worth stealing only if the to-do surface grows: batch operations with
per-item errors, and the hard-deadline vs soft-due split.
