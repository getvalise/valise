# What fifteen eval runs say, and what they cannot

Date: 2026-10-18
Status: analysis. Each proposal below is filed as a to-do in Valise, project
`valise`, tag `evals`. Nothing here changes a default on its own; the loop in
`evals/README.md` is how a proposal becomes one.

## Where the numbers come from

`npm run evals:trends` folds every committed run with sixteen rows or more
into a pass rate per case and model. Fifteen runs qualify, from
2026-10-15T12-16-35 to 2026-10-18T10-39-38, seven models from the second run
on. A cell is one sample per run, so a case that has been in the suite since
the start has about 103 samples and one added yesterday has 28. The rates
below are read from that output. Rerun it before trusting them; a new run
moves them.

Last full run, 2026-10-18T10-39-38, 37 cases, 18 tools:

| Model | Primary or accepted | Cost |
| --- | --- | --- |
| claude-sonnet-5.5 | 37/37 | $0.65 |
| kimi-k2.6 | 36/37 | $0.09 |
| gpt-6-luna | 35/37 | $0.007 |
| grok-4.3 | 35/37 | $0.18 |
| gpt-5.4-mini | 34/37 | $0.04 |
| gemini-3.8-flash | 32/37 | $0.12 |
| claude-haiku-5.5 | 31/37 | $0.03 |

A full run costs about $1.12. Sonnet is 58% of it.

## Three kinds of miss

Reading the failing routes, not the scores, sorts the misses into three
groups. They need three different fixes, and only one of them is a Valise
default.

### 1. The runner ends the episode before the model acts

`evals/run.mjs` executes skill tools and the tools a case lists in `live`,
and ends the episode on any other call. A model that searches, fetches, or
lists before it acts is scored on the read, not on what it would have done
next. This is the single largest source of red cells:

| Case | Cell | Route recorded |
| --- | --- | --- |
| procedure-not-memory | haiku 2/15 | `search` 13 times |
| todo-claim | gpt-6-luna 3/14 | `search` 9, `list_ready` 2 |
| todo-update-needs-claim | gpt-6-luna 6/14 | `search` 7 |
| memory-decision | gemini 4/15 | `search` 7, `get_skill` 4 |
| skill-direct | grok 8/15 | `get_skill` 7 |
| complete-nudge-capture | sonnet, gpt-6-luna | `fetch` 2 each |

Haiku's search on procedure-not-memory carries `"diff review checklist"`,
which is a model checking whether the skill already exists before publishing
it. Grok's `get_skill` on skill-direct reads the same `capture-this` body the
`skill_capture-this` tool would have returned, and then the episode ends, so
the `via` check fails on a route that did the right thing by another door.
In a real client every one of these routes continues.

This is a measurement fault. Fixing it changes scores without changing
Valise, and until it is fixed, a description rewrite aimed at these cells is
tuning against noise. The fix is in the runner: treat the read-only tools
(`search`, `fetch`, `list_ready`, `list_skills`, `get_skill`) as live by
default, keep `maxRounds` at three, and score where the route ends. It
needs a seeded, deterministic local database, because a live `search` now
shapes the route; the `fixtures` mechanism from PR #61 already covers the
startup cases and extends to this.

Landed the same day, with one difference: a read the case accepts as its
ending still ends the episode, so `search` on a recall case is scored as the
answer. Runs `2026-10-18T12-52-49` (the old runner) and `2026-10-18T12-54-10`
(the new one) share a fresh eval store with 15 tools. On that store the first
five cells in the table above pass for 7/7 models in both runs, with two
exceptions. Kimi on `skill-direct` ended on `get_skill` under the old runner,
the stop this change removes. Kimi on `todo-claim` went straight to
`comment_todo` under the new one, with no read before it. Most of their red
came with the store rather than the runner: earlier runs saw up to 20 tools
and whatever rows the local database held.

The runner on its own changed these routes. `complete-nudge-capture` went from
4/7 to 6/7: sonnet and gpt-6-luna fetched the to-do and then saved, where the
old runner scored the fetch. Haiku made no read in either run, so its gain is
noise. gpt-6-luna on `todo-claim-blocked` searched twice and then claimed.
Haiku on `procedure-not-memory` now searches and then publishes, a route the
old runner would have failed.

### 2. The nudges, where the real product question is

These cells are the ones worth a default change, because the nudge text is
the product and the model is the user.

**`complete_todo` tier-2 line, 24/42 captured.** Gemini never saved (0/6).
Haiku saved 3/6. The misses are `(none)`: the model closed the to-do,
answered in prose, and treated the line in the tool result as information
rather than a question. The text today:

> If this to-do produced a decision, insight, or dead end another session
> would pay to rediscover, save it with save_memory following the capture-this
> skill. Otherwise carry on.

The paired `complete-nudge-nothing` is 42/42, so the line never over-fires.
There is room to push it harder. Candidates to score side by side: lead
with the question ("Did this to-do settle something another session would
otherwise rediscover? If so, call save_memory now"), name the capture in
the second person, and drop "following the capture-this skill", which sends
some models on a read they then do not return from. The runner reads the
line from `app/mcp/nudges.json`, so variants need a per-case override
before they can be compared without editing the shipped file.

Scored the same day, and the shipped line held. With the override in place,
runs `2026-10-18T13-09-53`, `13-14-00` and `13-17-53` put the shipped line
at 18/21 captured and each of the three candidates at 15/21, with every
line correctly silent on the typo fix 20/21 or better. The 24/42 above
was measured on the old runner, which scored a fetch as the ending. On the
new one gemini saved 2/3 on the shipped line, and 0/3, 1/3 and 1/3 on the
candidates. The table is in
`evals/README.md`, under scenario cases.

**Stop hook, 24/42 captured, 32/42 correctly silent.** Two distinct
patterns. gpt-5.4-mini reads `skill_capture-this` and then stops, in 11 of
12 episodes across both the capture and the nothing case. The skill's own
text ends "If nothing here would be expensive to rediscover, save nothing",
and the hook says "Otherwise stop"; for that model the read is the whole
action. Haiku and gemini do not act at all on the capture case (3 and 3 of
6). The nothing case is clean for five of seven models, and the two that
read the skill before deciding to save nothing are scored as misses because
the read cost a round trip; that scoring is defensible but it is the
runner's opinion, and the `-nothing` cases should probably accept a
skill-only route.

**SessionStart reminder.** Earned its tokens on the implicit cases: 38/42
with the reminder against 29/42 without. The startup brief (PR #64) holds
to-do recall at 28/28 and memory recall by id at 26/28, and causes no call on
an unrelated turn (28/28). Nothing to change. The miss, where the item the
user wants is not in the brief, holds too: 21/21 searched or listed by
project for a missing to-do and a missing memory, and neither a counts line
nor an instruction line moved any cell (runs `2026-10-18T13-54-36`,
`2026-10-18T13-59-43`, `2026-10-18T14-04-44`; `evals/README.md`).

None of those cases end on a failed command, which is where a stored fix is
most often needed and least often searched. `recall-on-error-*` covers it.
With the reminder alone, 1 of 21 episodes searched after a `gh pr merge`
conflict; with a sentence naming errors the message does not explain, 8 of
21, and none on an npm typo. That sentence now ends the shipped reminder.
`evals/README.md`, under recall on error, has the runs and the broader
wording that over-fired.

A `PostToolUseFailure` hook puts a line right after the failed command
instead. Four arms, seven models, three samples per cell (run
`2026-10-18T21-17-54`), and the plugin lane of headless Claude Code with
Sonnet and Haiku (`2026-10-18T21-41-45`):

| Arm | Conflict | Typo | Claude Code conflict | Claude Code typo |
| --- | --- | --- | --- | --- |
| neither | 1/21 | 0/21 | 0/6 | 0/4 |
| SessionStart sentence only | 8/21 | 4/21 | 1/6 | 0/5 |
| hook only | 16/21 | 7/21 | 6/6 | 0/2 |
| both | 19/21 | 6/21 | 6/6 | 1/5 |

Both ship: the sentence and the hook. The rule set before the runs, the most
conflict searches with typo searches at or below the sentence-only arm, picks
the sentence alone, because both hook arms search more on the typo. Every
hook typo search over OpenRouter was gpt-5.4-mini, grok or gpt-6-luna. Claude
Code is the only client that fires the hook, and it mostly runs Sonnet and
Haiku, which searched on the conflict 12 of 12 times under the hook alone
with no typo search. For those users the hook takes the conflict from 1 of 6
to 6 of 6 sessions, and the typo cost is one Haiku search in five.

### 3. Descriptions, with one candidate each

**`claim_todo`.** gpt-6-luna searches first when the user hands it an id
(9/14). The description says to claim before working and nothing about an
id already in hand. `fetch` says "Do not guess ids"; `claim_todo` could say
the inverse: with an id in the turn, claim it directly. Group 1 has to land
first, or the cell cannot show the effect.

Landed after group 1. On the eval store, gpt-6-luna still read before
claiming in 5 of 6 episodes over three runs, and ran out of rounds on
`todo-claim-blocked` all three times. With the clause it read first in 0 of
6 and grok stopped searching first too. ADR-0003's amendment carries the
run stamps.

**`publish_skill`.** Haiku searches for an existing skill before publishing
(13/15). The description does not say that publishing a name that exists
adds a version. One clause would remove the reason to look first. Same
dependency on group 1.

Tried after group 1 and dropped. On the eval store haiku searched first in
3 of 8 episodes with the clause and 3 of 8 without, and the cell passes
either way because the runner now lets the search run. The dead end is
memory `mem_27a8b905-e066-4ec9-a22f-54cd2b6024d1`.

**`create_todo`.** Already says "do not go looking first" and gpt-6-luna
still opens with `list_ready` 5/14. One model, one sentence already in
place; not worth more words until a second model does it.

**`why`.** Fill rates stay above the 60% floor the README sets: sonnet
7/10, kimi 8/10, grok 10/11, gpt-6-luna 10/10 on the last run. Haiku's
dipped to 4/8 once. Keep the field.

**Skills as `skill_*` tools.** `skills-search-both` is 0/28 by design: told
to search two registries, no model searched either. The preloaded control
reads the skill in 15/28. The memory `mem_1a84afbd` records the conclusion;
the eval keeps it honest. Keep the surface.

## What the eval cannot see, and the production log can

`mcp_calls` for the seven days to 2026-10-18, `tools/call` only:

| Tool | Plugin sessions | No plugin |
| --- | --- | --- |
| fetch | 106 | 10 |
| claim_todo | 77 | 9 |
| search | 57 | 2 |
| create_todo | 54 | 33 |
| update_todo | 51 | 3 |
| complete_todo | 48 | 8 |
| save_memory | 21 | 14 |
| list_ready | 15 | 9 |
| skill_capture-this | 2 | 3 |
| get_skill, list_skills | 2 | 2 |

Two things the eval does not show. First, the capture skill was read six
times in a week against 37 real saves, where the eval's `skill-direct` case
has a read before 90 of 103 saves. The eval prompt cues it ("the way this workspace
wants it done, following the house procedure"); real turns do not. The suite
needs an uncued save, and the production ratio is the number the nudge work
should move. Second, the plugin is most of the traffic, and the no-plugin
sessions are mostly `create_todo` and `save_memory`, which is what a chat
client with no hooks does. The two client shapes have different tool mixes,
and the eval scores neither as a client.

Run `2026-10-18T13-24-17` added the uncued case and puts the eval's ratio
in the report header. `save-uncued` is `skill-direct`'s fact as "Save this:",
with no cue and no `via`. All seven models saved, and four read the skill
first: sonnet, haiku, gpt-6-luna, and gemini. `skill-direct` read it 7/7, so
the cue is worth three models. Across every route in the run that ended on
`save_memory`, 33 of 58 read a skill first, 57%. Production is 6 of 37, 16%.

The cue is not what separates the two. `memory-preference` and
`memory-decision` were already uncued saves, and they read the skill 4/7 as
well. Something about the eval's setting still raises the read rate by a
factor of three and a half: 15 tools with one skill among them and a bare
system prompt, where a real session carries its client's prompt, native tools,
and every other MCP server. The harness lane under "Coverage gaps" is how to
find out which; `save-uncued` has not been run through it. Until it has,
`save-uncued` on the OpenRouter lane is the cell to try a capture nudge or
description change on, and the production ratio is the check on whether the
change carried over.

## Coverage gaps

**Harness.** An OpenRouter run sends a bare system prompt and the tool
list to a model. No Claude Code system prompt, no Codex prompt, no native
tools competing for the turn, no hook actually firing, no
`mcp__plugin_valise_valise__` prefix on the names. The description is
measured in a vacuum. `--harness claude` closes this for Claude Code; Codex
and a `--bare` lane remain open. Two probes, `claude -p` version 2.1.302:

- Headless Claude Code loads the plugin as installed. The thirteen Valise
  tools appear under the plugin prefix. With `--output-format stream-json
  --verbose`, the `SessionStart:startup` hook shows up as a `hook_started`
  and `hook_response` pair carrying the recall reminder as
  `additionalContext`, and the Stop hook wrote its turn counter under the OS
  temp dir for that session id. Hooks and plugins are live in `-p` mode, so
  a harness lane needs no mocking.
- One turn with no Valise tools at all cost $0.36, and one with every MCP
  server on this machine cost $0.69, because `-p` loads the whole of
  `~/.claude`: sixteen plugins and their skills in the first case. A
  harness lane has to isolate. `--bare` with `--plugin-dir clients/valise`
  and `--bare` with `--mcp-config` naming only Valise would do it, but bare
  mode needs `ANTHROPIC_API_KEY` and does not use the subscription login.
  The shipped lane isolates with `--setting-sources ""`, `--tools ""` and
  `--strict-mcp-config` instead. Codex is the same shape with `codex exec`
  and `~/.codex/hooks.json`.

Scoring the lane needs no new instrumentation. Every call lands in
`mcp_calls` with the session id, the plugin header, and the arguments, and
the probe's `tools/list` is already in the log under its `-p` session id.
The runner sends a prompt under a session id it chose and scores the calls
that session made against the same `cases.json`. Writes run for real in that
lane, so it points at a seeded local endpoint. The plugin's `.mcp.json`
expects OAuth, so the lane's temp copy adds the `x-valise-agent` and
`x-valise-client` headers the loopback endpoint accepts instead.

**One sample per cell.** The pass rates above have 95% intervals of plus
or minus 20 points at n=15 and plus or minus 35 at n=4. A single run moving
one cell is not a signal, and the 2026 SWE-bench variance study puts
single-run noise at 2 to 6 points on a far larger suite. `--repeat N` runs
each cell N times and the report prints the pass count over N, so a
description change is judged on cells that moved across repeats.

**The tool surface drifts between runs.** The header has read 12, 13, 14,
15, 16, 17, 18, and 20 tools across fifteen runs, because every published
skill is a tool and the local database differed. `skill_ui-console-skill`
caught gpt-5.4-mini and haiku on four unrelated cases. The runner seeds a
fixed skill set, refuses any other, and records the tool list's hash, so two
runs with the same tool and store hashes are comparable by construction.

**No body quality.** The suite scores the tool and the argument keys. It does
not score whether the
memory body leads with the conclusion or the title states a claim, which is
what `capture-this` is for and what the redesign note found failing in
production. A judge per failure mode, validated against hand labels on real
`save_memory` arguments from `mcp_calls`, is the next evaluator worth
writing, and the only one that needs a model to grade.

**Divergence.** Macomber's harness at Ramp tracks the share of
questions whose answer or route differs by interface and model, and treats
any divergence as underspecified context rather than a model fault. The
same number here is the cases where the seven models did not all end on the
same tool. It makes "the descriptions are clear enough that any model agrees"
a number that moves. The report header, `index.json`, and
`npm run evals:trends` print it. Recomputed over the committed runs, it sat between 25% and 50% until the
read-only tools ran live and the eval store replaced the shared one:
`2026-10-18T12-52-49` is 8/39, `2026-10-18T12-54-10` is 11/39, and
`2026-10-18T13-24-17` is 9/40, with four provider errors left out. The nine
that still diverge are the three nudge cases, the three startup cases, one
reopened claim, one skill publish, and one implicit recall without the
reminder. The nudges and the startup brief are where the text still leaves
models a choice.

## Sources read for this note

- Anthropic, "Writing effective tools for agents — with agents",
  anthropic.com/engineering/writing-tools-for-agents. Realistic multi-call
  tasks, verifiable outcomes, held-out sets, read the transcripts, measure
  every description change.
- Hamel Husain, "AI Evals FAQ", hamel.dev/blog/posts/evals-faq. Error
  analysis before metrics, binary labels, one judge per failure mode
  validated against human labels, rerun analysis after every significant
  change.
- Ian Macomber, "The Shape and Feel of the Post-AI Data Stack",
  iandmacomber.com. Consensus divergence rate across interface and model.
- Spotify Engineering, "Better Experiments with LLM Evals — A funnel, not a
  fork", engineering.atspotify.com, May 2026. Offline evals filter
  candidates before the online experiment spends capacity.
- "On Randomness in Agentic Evals", arxiv 2602.07150. Single-run pass@1 on
  SWE-bench Verified varies 2.2 to 6.0 points; estimate from repeats.
- ai-evals-course/evals-skills on GitHub. Error discovery before writing
  evals; code checks for objective failures, judges only for subjective ones.
