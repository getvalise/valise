# Transcripts in the console

`/activity/transcripts` lists the sessions the Valise CLI sent and opens one in
the right-hand pane. ADR-0022 decides the data and the writer; this file
decides the screen. It replaces the interaction contract at the end of
ADR-0022 (amendment of 2026-11-06 there).

## What the data looks like

Measured on 2026-11-06 over the 21 newest Claude Code sessions in this repo's
own `~/.claude/projects` directory, distilled by `clients/valise-cli/distill.mjs`:

| | |
|---|---|
| Turns per session | P50 17, P90 214, max 535 |
| Turn kinds | 1,243 tool calls, 369 assistant, 126 human, 41 tool errors |
| Consecutive tool calls | P50 2, P90 8, max 28 |
| Idle stretches over 10 minutes | 45 |
| Sessions whose turns name a `todo:`, `memory:` or `subject:` id | 9 of 21 |
| Most used tools | Bash 907, ToolSearch 46, Valise `claim_todo` 41, `fetch` 38, `complete_todo` 34 |

Seventy per cent of the turns are tool calls. The first version listed every
turn as an equal row, 100 to a page, so the eleven prompts a person wrote sat
among two hundred one-line `Bash` summaries.

## Research

Sixteen sources, gathered on 2026-11-06. What they agree on:

- Collapse runs of tool calls, never human or assistant text. Claude Sessions
  (Obsidian plugin) folds runs of more than four calls behind a one-line
  preview; GOV.UK's accordion guidance says not to hide content everyone
  needs. [Claude Sessions](https://www.obsidianstats.com/plugins/claude-sessions),
  [GOV.UK accordion](https://unpkg.com/govuk-frontend@5.8.0/dist/govuk/components/accordion/README.md)
- Make the human turn the landmark, with a list of prompts that jumps to each.
  Langfuse Sessions has a sidebar of user messages; LangSmith switches between
  Messages, Turns and Details views. [Langfuse sessions](https://langfuse.com/docs/observability/features/sessions.md),
  [LangSmith threads](https://docs.langchain.com/langsmith/threads)
- An error never folds away. Braintrust highlights the failed span in its
  trace view. [Braintrust](https://www.braintrust.dev/articles/best-llm-tracing-tools-2026)
- A session header of numbers: turns, duration, calls per tool, and the
  project, branch, model and directory. Claude Sessions and Arize Phoenix
  both lead with it. [Phoenix sessions](https://arize.com/docs/phoenix/learn/sessions.md)
- An index grouped by day or project with per-session counts, and filters by
  message type with live counts. [claude-code-log](https://pypi.org/project/claude-code-log/),
  [claude-code-transcripts](https://simonwillison.net/2025/Dec/25/claude-code-transcripts/)
- Show idle time. Claude Sessions places one dot per turn by its real
  timestamp; Cloudscape puts the absolute time in a `<time title>` beside a
  short one. [Cloudscape timestamps](https://cloudscape.design/patterns/general/timestamps/)
- Topics and chapters (Otter, Fathom) are generated, and regenerating them
  overwrote hand edits in Otter, so generated labels and a person's labels
  are kept apart. [Otter review](https://www.spinach.ai/blog/otter-ai-review)
- Hundreds of turns need no virtualisation; `content-visibility: auto` keeps
  the DOM, so find-in-page and anchors still work.
  [Nolan Lawson](https://nolanlawson.com/2024/09/18/improving-rendering-performance-with-css-content-visibility/)
  A `role="feed"` is for incremental loading and must not sit on an empty
  container ([BotFramework-WebChat #4420](https://github.com/microsoft/BotFramework-WebChat/pull/4420));
  a server-rendered page uses plain articles.

## Interaction contract

The job is to find a conversation, see what it was about and what it touched
in Valise, and read what the person asked and what failed.

- Place: Activity has two sections in its SubNav, Changes (`/activity`) and
  Transcripts (`/activity/transcripts`). No link in the page body leads
  between them.
- Default view: the account's sessions, the most recently started first
  (`first_at`, falling back to `updated_at`), under day headings in UTC.
  "Last active" in the sort menu (`?sort=last`) orders by `last_at` instead,
  and the day headings and the time on each row follow the order chosen. An
  import writes every session at once, so ordering by the write would put a
  month of work under Today. Each row: title; client, device, prompts, tool
  calls and span; project, error count, up to four tags (found in the same
  turns the pane reads, of any kind), and "Started 14:02"
  or "Last active 16:30". A row with an error has the destructive left rule.
- Filters: title search, project, tag, client, device, date and "With
  errors", plus `?subject=` reached from a chip. The tag menu offers the tags
  on the account's to-dos and live memories, the two kinds a turn names; a
  session matches when it named an item under every chosen tag (AND, as on
  the other lists, at most five). The date filter takes UTC days,
  `?from=YYYY-MM-DD&to=YYYY-MM-DD`, both inclusive, with Today, Yesterday,
  Last 7 days and Last 30 days as presets; a session matches when it was
  active in the range, its first turn before the range ends and its last
  turn after it starts. All are GET parameters (P3) and work without scripts
  (P11); without scripts the date filter is two fields and a button.
- Primary action: open a session in the pane (`?open=transcript:<id>`). The
  pane leads with the tags and subjects directly under the title, then the
  facts line and four numbers (prompts, tool calls, errors, active time of
  span). Then section tabs, one
  panel at a time: To-dos with state, Memories with type, Files with edit
  counts, Tools (the histogram and skills), Prompts (each a link to its
  anchor) and Details. A section with nothing in it is left out, and the
  first remaining one is open. The open section is `?section=`; the tabs are
  links that replace the history entry, and the route skips its loader for
  the change, so a flip draws data already on the page. Then the
  conversation.
- The conversation is one `<article>` per prompt, read like a call
  transcript: every line has its time, `14:02`, in a narrow column on the
  left, aligned on the line's first baseline, and its speaker in bold at the
  start of the text, "Prompt 3:" or "Assistant:". A prompt is a card on the
  cream surface whose heading link is its anchor `#t-<position>`; a reply is
  prose on the pane's ground. Neither has a rule, so neither reads as a
  quotation. A folded run and an event take the time of their first turn.
  Prompts and replies are set at the body's 15px. The last reply in an
  exchange is its answer, in full ink; a reply before it narrates the work
  ("Let me read the route") and steps back to 14px in muted ink. When a Stop
  hook sent the agent back to work, the answer is the last reply before the
  hook; what the agent did for the hook reads as notes. A background task's
  notification starts a stretch of its own whose last reply is an answer
  too, so the prompt's long answer stays in full ink above the task's short
  report. This is position,
  not thinking: thinking is its own block (below). Every prompt card but
  the last carries "Next prompt ↓", a link to the next prompt's anchor, on
  another page when it is there. A line's time links to that message alone,
  `/activity/transcripts?open=transcript:<id>&turns=<page>#t-<position>`,
  without the list's filters, and a link icon beside it copies the full URL;
  `fetch` takes that link or `transcript:<id>#t-<n>` and returns the
  message with five turns either side (ADR-0022, amendment of 2026-11-08). Prompts and
  replies render as Markdown (GFM tables, lists, headings at the body's
  scale), with raw HTML dropped; a fence that names its language is
  highlighted from the role colours (`app/components/code-highlight.js`), and
  nothing is guessed. An API error is a destructive hairline box. A run of
  tool calls is one `<details>`, "9 tool calls · Bash ×5, valise ·
  claim_todo ×2, Read, Write · 2m", closed; a run holding a failed call is
  open and says how many failed. An idle stretch over ten minutes is a
  divider, "45m later". Codex writes its `<environment_context>` and
  `<user_instructions>` as user messages; they are events too. "Hide tool calls" (`?tools=hide`) leaves the prompts
  and replies only: every run without a failure goes, a failed run stays,
  and the type does not change.
- Events are not prompts. A client writes some things into the conversation
  as user messages that the person did not type: a background task
  finishing (`<task-notification>`), a slash command and its output, a `!`
  shell command and its output, the summary that opens a compacted session,
  an interruption, and a Stop hook's message when it blocks (the CLI sends
  Claude Code's `hook_blocking_error` attachment as "Stop hook feedback: …",
  the wording the model saw). Measured on the owner's sessions on
  2026-11-08: 55, 14, 6, 6, 6 and 1 of the first six against 165 prompts. A human turn that starts with
  one of the markers in `HARNESS_PREFIXES` (`app/concepts/transcript-view.ts`)
  gets no number, no place in the prompt list, no count in the numbers and
  is never a session's title. It is one muted line inside the exchange it
  interrupted, "Background task: Background command "Run verify" completed
  (exit code 0)" or "Ran `/simplify app/a.ts`", with its ids, output or
  summary folded under it. A failed one is destructive; "Hide tool calls"
  hides the rest. The "Caveat: The messages below…" note only instructs the
  model and is not drawn.
- Thinking is its own turn kind (ADR-0022, amendment of 2026-11-08): one
  italic line, "Thinking · " and its opening words, folded, opening to its
  text in muted ink on a hairline. It is never an answer, it sits in the
  time column like any line, and "Hide tool calls" hides it.
- System text is its own turn kind (ADR-0022, second amendment of
  2026-11-08). Consecutive system turns fold into one muted line, "System · "
  and the names of their sources ("System prompt, AGENTS.md, Hook context, 4
  more"), set like a tool run. Open, each source is its own folded line with
  its size, opening to the text verbatim (`pre`, wrapped, at most 32 rem
  tall). A system turn never splits a tool run: one that arrives mid-run
  folds in after it. It is never an answer, and "Hide tool calls" hides it.
- Loading budget: the list loads 30 sessions at a time as it scrolls, the
  shared `InfiniteList` of /todos: `?page=N` reveals the first N × 30, so a
  reload keeps the rows, the day headings run across loads, and "Load more"
  is the link without scripts. The pane sits beside the list, so the list
  keeps loading while a session is open, and the next page keeps the pane
  and its place (`open`, `turns`, `tools`, `section`). Each load is a count, the rows, and two batched reads for their
  counts and tags (at most 3,000 turns that name an id across the loaded
  rows), one read for the tag menu, and one turn scan per chosen tag; 400
  turns a page in the pane, which holds 90 % of measured sessions whole. The
  pane's context is five bounded reads: counts by kind and tool, timing, up
  to 300 prompts, up to 1,000 turns that name an id, and up to 3,000 file and
  skill calls. A prompt on another page links to that page with its anchor.
- Failure: an unknown or another account's id is a 404; a failed read fails
  the page. A filter that matches nothing says so and links back to every
  session; an account with no sessions keeps the CLI instructions. A
  malformed date is ignored, and a range given backwards is swapped.
- Evidence boundary: what Valise received, not what happened on the device.
  The tags and subjects are inferred from ids the turns name; they are not a
  person's classification.
- 320 px: the pane is the bottom sheet, the four numbers take two columns,
  and the section tabs wrap.

`test/ui/transcripts.spec.ts` walks the list, the sort, a tag and a date
filter, the pane, the section tabs, Markdown and the tool-call toggle at
1280 px, and the pane without scripts at 320 px, on eight synthetic sessions
from `test/ui/fixtures/transcripts.ts`. `test/d1/transcript-view.worker.test.ts`
covers grouping, the linked items, the account boundary, both orders, the
date range, several tags and the list filters.

## Where tags and subjects come from

A transcript has no tags of its own. `app/concepts/transcript-context.ts`
reads them off what the session touched:

- Tags: the tags of every to-do and memory whose id a turn names
  (`claim_todo id: todo:tdo_…`, `fetch id: memory:mem_…`), counted.
- Subjects: the subjects of those memories (`via: memory`), any `subject:` id
  a turn names (`via: mention`), and any live subject whose name's words all
  appear in the title or the first twenty prompts, through `matchSubjects`
  (`via: name`, drawn with a "?" because it is a guess).

The tool result is never stored (ADR-0022), so a to-do or memory the session
created is linked only once a later call names its id. Filtering the list by
a tag or subject scans the account's turns with `instr`, capped at 100 ids and
500 sessions. That is fine at today's volume and is the first thing to
replace.

## Open questions

- Store the links. A `transcript_links (transcript_id, item_id, position)`
  table written by `appendTranscript` would make the tag and subject filters an
  index lookup and give to-dos and memories a "mentioned in" back-link. Forced
  by the first account whose tag filter is slow; open because the inferred
  set may not be what the owner wants stored.
- A person's own tags and subjects on a session. `memory_subject_members` is
  memory-only; a session in a subject means either a second members table or a
  generic one. Forced by the owner wanting to file a session by hand; open
  because the inferred links may be enough.
- A generated summary and chapters per session, from the Workers AI summary
  model. Forced by sessions long enough that the prompt list stops being an
  outline; kept apart from a person's labels, so regeneration never
  overwrites them.
- Search inside one session. Today it is the browser's find, which works
  because the turns are in the DOM. Forced by sessions past one 400-turn page.
