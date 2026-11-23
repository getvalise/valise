# Tool-choice evals

Fresh-agent handoff answer/evidence evals live in
[outcomes/README.md](outcomes/README.md). They exercise a controlled live MCP
store and keep correctness, source reads, blockers, completion windows, and
costs separate from the tool-choice scores below.

Real-client skill registration, MCP prompt commands, and discovery-hook probes
live in [skills/README.md](skills/README.md). They record protocol routes and
client registries separately from the model-choice scores below.

ADR-0003 made tool descriptions the product: in a client that does not speak
SEP-2640, the description is the only thing the model reads before deciding.
Nothing tested that. This does.

Each case is a user turn plus the tool that should answer it. The runner reads
the tool definitions from a live `tools/list`, so an eval can never score a
surface the server does not actually serve — which also means it scores
whatever skills the store holds, because each skill is a tool up to ten
(ADR-0005), and whatever a
live `search` finds there. The evals get a store of their own for that reason,
built empty by `npm run evals:store` and seeded by the runner, so a skill
published from the console or from `npm run test:ui` cannot reach a run.

The runner sends every case to every model
through OpenRouter, and records the tool the model chose and the arguments it
built. `--harness claude` or `--harness opencode` sends the cases through the
corresponding headless client instead; see the harness lanes below.

OpenRouter function definitions explicitly set `strict: false` to preserve
the live schema's optional fields. On 2026-10-22, leaving it unset caused both
OpenAI models to fill optional `type` and `project` with narrowing values on
the broad-library case, including invented `*` or `default` projects. A direct
four-call comparison on the same surface returned those fields when unset and
omitted them with false. This is a transport correction, not a description
gain; the explicit flag participates in the tool hash. Older runs stay intact.

## Run it

```sh
npm run evals:store               # a fresh store in .wrangler/evals
VALISE_STATE=.wrangler/evals VALISE_RERANK=off npm run dev   # in another terminal
export OPENROUTER_API_KEY=...
node evals/run.mjs --list         # the cases, calling no model
node evals/run.mjs                # the default six, lower-cost models
node evals/run.mjs --models anthropic/claude-haiku-5.5 --case todo-create
node evals/run.mjs --models anthropic/claude-sonnet-5.5 --case memory-preference
node evals/run.mjs --models anthropic/claude-sonnet-5.5 --case memory-preference,todo-create --allow-expensive
node evals/run.mjs --repeat 3 --case stop-nudge-capture,complete-nudge-capture
node evals/run.mjs --case todo-claim --note "claim_todo: claim an id in hand"
npm run evals:verdict -- last dropped "haiku searched 3/8 with and without"
```

`wrangler.jsonc` sets `VALISE_RERANK` to `hybrid`, as production runs. Without
`TYPESAFE_API_KEY` and the vector bindings, `/__dev/rerank` then answers 503
and the runner stops, so plain runs pass `VALISE_RERANK=off`.

The runner calls `/__dev/seed` before the first case, so the store holds the
seed's one skill, one memory, and one to-do. Then it reads `tools/list` and
refuses to run if the skill tools are anything other than
`skill_capture-this`, naming the ones the seed did not put there. Up to ten
published skills are tools, ranked by recent loads, so a skill that
`npm run test:ui` or a console session left in the store changes what every
case is shown. `npm run dev`
without `VALISE_STATE` works only while the default store holds no other
skill.

The report header carries two hashes. The tool hash covers the list as
served: names, descriptions, and input schemas, in order. The store hash
covers `/__dev/store`, which is every row `search` and `fetch` can reach, the
to-do states `list_ready` reads, and the hook documents, without timestamps.
The same line names the repeat count when a run used `--repeat`, and the
client version when it used `--harness`.
A fresh store and the seed hash to `a5ac75236487`. The seed publishes
`skills/capture-this/SKILL.md`, so an edit to that file moves the store hash:
runs before its to-do section (J4 round 2, 2026-10-25) read `a1fc5cb45656`,
earlier ones `b7467a0bd162`, and runs before the rollup section
`e9268cdfed48`. Two runs with the same
hashes saw the same surface and the same data. A description edit changes the
tool hash on purpose; any other change to it is something the run did not
mean to test.

`npm run evals:trends` opens with the surfaces behind its rates: one line per
tool hash, with the run count and the newest run. Runs from before the runner
recorded the hash group on a hash of their tool names, prefixed `names`, and
the runs that saw unseeded skills are listed by stamp. `--tools <hash>`
restricts the rates to runs on one surface; pass `"names <hash>"` for an
older one.

Each run writes `evals/runs/<timestamp>.json` and `.md`, and refreshes
`evals/runs/index.json`, which is what the console's evals tab reads. Rebuild
the index on its own with `npm run evals:index` after deleting or restoring a
run file. Keep the runs that mark a change; a regression is then a diff rather
than a memory.

`evals/runs/` is ignored: recorded runs stay on the machine that made them
and are not published. The console's evals tab reads `evals/runs/index.json`
when it exists at build time and otherwise
`evals/fixtures/runs-index.sample.json`, a committed index of 53 runs from
2026-10-25 to 2026-11-08, trimmed and scrubbed. Drop a run by deleting its
file and rebuilding the index.

The run stamps this file cites, such as `2026-10-18T13-10-07`, name those
local recordings. The counts and conclusions quoted beside each stamp are
what the run measured; the raw run files behind them are not published.

The index carries scores, not payloads. The arguments a model built stay in
the per-run file. The arguments a real client
sent are in the logs tab, including the harness's own calls — it talks to a
live endpoint, so it logs itself under the agent `valise-eval`.

It does carry the cases, because a run is scored against the cases as they
stood when it ran. Editing a prompt and then reading an old run would
otherwise print the new text under the old score.

## Repeats

A cell run once is one sample. Temperature 0 does not make a provider
deterministic. Run `2026-10-18T13-10-07` sent the same `stop-nudge-capture`
turn to gemini-3.8-flash three times and got two saves and one `search`.
`--repeat N` runs every case on every model N times, default 1. Each row
carries its `repeat` index, and the run records `repeat` at the top.

With N above 1, a per-case cell reads `k/N`, then the turns each pass took,
then each distinct way the misses ended, as in `2/3 · 1,3t · search`. The model totals count every row, so a
model's 50/50 at one repeat reads 150/150 at three. On the evals
tab the cell shows `k/N`, and opening it shows the route of the first miss.

Cost scales with N. Repeat the cases a change targets at N=3, and run the
full regression pass at N=1. The default model set omits Sonnet: the user's
OpenRouter spend showed $46.76 against $11.04 for the next-highest model.
Keep Sonnet for targeted cases when its behavior matters or deliberate
validation; include it explicitly with `--models` rather than paying for it on
every routine run or repeat. `--models` replaces the default list, so name all
the models you want in that run. A multi-cell OpenRouter run that includes
Sonnet stops before making model calls unless it also has `--allow-expensive`;
a single case at one repeat needs no extra flag. This guard does not apply to
the Claude Code harness lane, which does not bill through OpenRouter.

`npm run evals:trends` counts a run's rows per repeat when it decides what
is a full run, so a focused run at N=3 stays out of the rates however many
rows it wrote. A full run at N=3 adds three samples to every cell.

`--repeat` applies to the harness lane too. Every harness episode re-seeds
the store first, so one repeat's claim does not change what the next sees.

## Reading the result

`Said why` is the fill rate on the four tools that offer an optional `why`:
of the calls that landed on one, how many volunteered a reason. ADR-0007 keeps
that field out of `requiredArgs` on purpose, because the argument column fails
nothing today and gating on an advisory field could only turn silence into a
regression. Under about 60%, delete the field rather than promote it. A `—`
means the model never reached one of those four tools.

Turns, tokens, and cost sit beside the scores, because a description two
models both read correctly can still cost one of them a skill round trip and
four thousand reasoning tokens. Turns count model calls rather than tool
calls: a route that reads a skill and then acts is two turns, and a route that
answers in prose is one turn and no calls. Cost comes from OpenRouter's own
accounting, which the runner asks for with `usage: { include: true }`.

Tool choice and argument validity are scored apart. A model that picks
`create_todo` and omits `project` read the description correctly and tripped
over the schema; the fix is the schema or its field descriptions. A model that
picks `search` for a turn that names an id read the description wrong; the fix
is the description.

The four `no-tool-*` cases matter as much as the rest. A surface that fires on
every turn costs the user more than one that fires on none.

An episode runs up to three rounds, not one; a case's `maxRounds` raises
that. A skill tool returns instructions
and takes no action, so when a model calls one the runner executes it for real
against the endpoint, feeds the SKILL.md back, and asks again. The read-only
tools run the same way: `search`, `fetch`, `list_ready`, `list_skills`,
`get_skill`, and `list_hooks`. A model that checks the store before it acts is
what a real client lets continue, so the case is scored on where the route
ends rather than on the check.

A read the case accepts, as its `tool` or in `alsoAccept`, ends the episode
instead of running. On `search-recall` the search is the answer, and running it
would score what the model did with the hits. This is also how a case opts a
read out: name it in `alsoAccept`.

`stopOn` names tools that end the episode as a miss, before they run. It is
for a case that scores the first move: a `search` the case exists to catch
would otherwise run, and the route would go on to end somewhere that passes.
It is also for a read the eval store would answer differently from a real
store, such as a `fetch` on an id the store does not hold. `alsoAccept` and
`stopOn` both apply to `harnessTools` as well, so a harness tool named in
either ends the episode instead of returning its canned `result`. The harness
lane ignores `stopOn`, because a Claude Code session runs every call for real.

On the OpenRouter lane every other tool ends the episode before it runs, so
writes never execute and a run leaves no rows behind beyond its own lines in
the call log, unless a case lists the tool in `live`. The harness lane runs
writes for real; see below.

### Parallel tool requests

An OpenRouter completion may request several tools. A continuing episode answers
every nonterminal call with its actual live result or the case's declared fixture
result, using each original `tool_call_id`, before requesting another completion.
The complete assistant message, including provider reasoning metadata, is replayed
unchanged. The calls are executed in provider order; a batch still costs one
model round, not one round per tool.

If any call is terminal under the existing rules (`tool`, `alsoAccept`, `stopOn`,
or a tool the episode may not execute), the episode ends before executing that
batch. The first terminal call in provider order is scored, even if a later
sibling would pass. An accepted terminal `fetch` remains a fetch choice, not
evidence that its body was consumed. A skill requested beside a terminal action
was not read before that action and cannot satisfy `via` or count as a prior
skill read. Delivered reads from earlier rounds still count.

New OpenRouter runs record `episodeProtocol: "all-tool-calls-v1"`. `route` keeps
every requested tool name, including unexecuted terminal-batch siblings.
`routeCalls` in the full run JSON retains every call ID, parsed arguments, exact
argument string, zero-based model round and execution status; `endingIndex`
identifies the scored terminal request, or is null for the usual last-call ending.
Arguments remain outside the bundled console index. Older runs are not rewritten
to invent missing parallel-call evidence.

A provider or tool transport failure remains an error, with the known earlier
route and usage retained. A malformed call or missing declared fixture result
also fails rather than producing a synthetic output. No further model request
is sent with a partially answered batch. Provider failures without returned
usage are not assigned an invented cost.

## Turns, budget, and the round cap

Pass says where a route ended. It does not say how long the route took to get
there, and once the reads run, a model that searches twice before the right
call passes the same as one that calls it outright. Every case therefore
carries a `turnBudget`: the model calls a good route needs. The suite default
is the `turnBudget` at the top of `cases.json`, which is 1. A case whose good
route reads first raises it:

- 2 on every save and capture case, because reading `skill_capture-this`
  before `save_memory` is the route the house wants.
- 2 on `hooks-add`, which reads the entries with `list_hooks` first.
- 3 on the two `skills-search-*` cases, a registry search then a load then
  the save, and 2 on their preloaded control.

The runner refuses a budget above the case's `maxRounds`, because a route can
never spend it and every pass would read as within budget.

A passing cell prints the turns it took: `✓ 1t`, `≈ fetch 2t`, and `✓ 3t over`
when the turns ran past the budget. The per-case table has a `Budget` column
beside `Expected`, and the summary has `Within budget`: rows that passed in no
more turns than their budget.

Running past the budget does not fail the cell. `Arguments valid` stays the
headline, so every run before the budget existed still compares with the ones
after it. A route that reads before the right call is slower, not wrong; it
costs a client a round trip, which is a different claim from picking the wrong
tool, and folding the two into one number would hide which one moved. The
budget is the second number to read: a clause that removes the reason to read
first leaves pass at 100% and moves `Within budget`.

A route that spends every round on reads, skill reads included, has not ended
anywhere. The runner marks the row `capped` and the cell prints `(cap)` rather
than the last read, so running out of rounds reads apart from picking a wrong
tool. A capped row fails, even when its last read is something the case
accepts, and the summary counts them under `Capped`. The JSON keeps the real
last call in `chose`. Runs before the cap was recorded print their last read.

`npm run evals:trends` prints, under each case, the mean turns per model over
its passing rows, so a change reads as `gpt-6-luna 2.4` against `1.1` rather
than as a flipped mark. `-v` adds the spread, as in `1×14 3×2`.

Run `2026-10-18T15-08-01`, gemini-3.8-flash and kimi-k2.6 on the two capture
nudges, three repeats: 5 of the 12 Stop-hook and `complete_todo` episodes
capped. Gemini read the skill and then searched twice. Kimi searched twice
and then called `get_skill`; without the mark that cell reads as a wrong
`get_skill`. Gemini's two saves took three turns against a budget of two,
`✓ 3t over`, where a bare `✓` reads the same as a direct save.

`≈ some_tool` means the route ended on something in `alsoAccept` rather than
the primary expectation. It passes, and it is the column to read when a number
looks suspiciously perfect.

The line under the hashes carries two numbers that no single model's score
shows. `divergent cases: k/n` counts the cases where the models did not all end
on the same tool, after Ian Macomber's consensus divergence at Ramp: when
models disagree on a turn, the surface left the choice open. A description
change that lowers it made the turn clearer for every model, which is a
different claim from raising one model's pass rate. Errored rows are left out,
and a case only one model answered is not counted. Under `--repeat` a model
stands for its most common ending, and harness columns compare within their
lane. `npm run evals:trends`
prints the same line per run, and `index.json` carries it as `divergence`.

`save_memory after a skill read: k/n` is the share of routes ending on
`save_memory` that read a skill first, the number the production log gives as
6/37 for the week to 2026-10-18. The `Read a skill` column on the per-case
table is the same count per case. It is kept apart from pass because a case
with no `via` passes either way; `save-uncued` against `skill-direct` is the
pair to read it on, the same fact with and without the cue toward the house
procedure.

## The evals tab

The tab shows the suite, not a run. A cell is that model's newest result on
the case, from whichever run produced it, so `--case todo-claim` moves the
`todo-claim` row and leaves the other rows on the runs that last sent them.
The summary table is computed over those cells. A delta compares each cell
with the result it replaced, and only when both have the same repeat count.
A `↑` or `↓` in a cell marks a cell that moved; its title names the run it
moved against.

Results under rival tools, a seeded memory corpus, or the harness lane are
each their own condition, chosen above the summary as `?on=`, because none
of them measures the plain surface.

Clicking a case opens it beside the matrix, as `?case=<id>`: the turn as
sent, what the case expects, each model's newest result and its pass rate
across the runs that count, and every run that sent the case, newest first.
Each of those runs carries one mark per model, its verdict, what it tested,
and what changed since the run before it that sent the same case: the case
text, the description of a tool the case expects, accepts, or routes through,
or something else on the surface. Runs before `toolHashes` can only say the
surface changed.

The Runs table under the matrix is every run on disk with its note and
verdict.

## Notes and verdicts

`evals/runs/notes.json` says, per run, what the run tested and what became of
it. It is the one file in `evals/runs/` a person edits; run files stay as the
runner wrote them. Like the runs, it stays local.

- `--note "…"` on the runner writes the note when the run starts. A run
  without one is a row of marks nobody can read a week later.
- `npm run evals:verdict -- <stamp>|last kept|dropped|baseline "why"` writes
  the verdict once the run is read. `<stamp>` takes a comma list, for the
  repeats of one trial. `--note "…"` in place of the verdict rewrites a note.
- `kept` means the text under test shipped, `baseline` that the run is what a
  change was compared against, and `dropped` that the text did not ship.

A dropped run stays in every case's history and never counts as a newest
result. Without that, the tab would score a wording that is not on `main`.
The runs from before the file existed were annotated from the pull requests
and research notes that recorded them; six of them carry a note and no
verdict, because nothing written says what became of them.

## Adding a case

Append to `evals/cases.json`:

```json
{
  "id": "short-slug",
  "prompt": "the user's turn, verbatim",
  "tool": "the_tool_the_route_must_end_on",
  "via": "skill_something_it_must_read_first",
  "turnBudget": 2,
  "alsoAccept": ["a_defensible_second_choice"],
  "requiredArgs": ["field", "the", "call", "must", "carry"],
  "why": "one sentence on what this case is actually measuring"
}
```

`"tool": null` means no tool call is the right answer. `turnBudget` is
optional; leave it out when the good route makes its call on the first turn. `via` is optional and
names a skill the route has to pass through; `get_skill` on the same name
counts, because it returns the same body. `alsoAccept` is for cases with
more than one defensible ending; it counts toward tool choice but not toward
argument scoring, which only applies to the primary expectation.
`expectAnswer` is a list of strings for a case whose right ending is prose:
the answer has to contain one of them, or the cell reads `unnamed`. It is
checked on the whole answer, though the run file keeps the first 600
characters.

`absentArgs` lists fields the expected call must omit. The broad-library case
requires `include_library: true` without `type` or `project`: passing
the flag while narrowing to memories or inventing a project would still miss
the uploaded book. A present forbidden field counts in `wrongArgs`, including
an explicit null or empty array. Existing run scores are not rewritten.

## Scenario cases

A nudge is not a user turn, so the nudge cases carry the conversation that
leads up to it. `context` is appended to the system prompt, the way a
SessionStart hook adds context. `history` is the conversation so far, in
OpenAI chat format, and may end on a tool result instead of a user turn.
`prompt` is optional when `history` is set.

`{{hook:Stop}}`, `{{hook:SessionStart}}`, `{{hook:PostToolUseFailure}}`,
`{{server:claim_todo}}`, `{{server:complete_todo}}` and
`{{server:save_memory}}` are replaced with the live texts: the hook ones from
the plugin's `valise-hook.mjs --print` defaults, the server ones from
`app/mcp/nudges.json`, which the server imports.
`{{shipped:PostToolUseFailure}}` is the hook's line in the wrapper Claude Code
adds after a failed Bash result, or nothing when `--print` reports
`recall-on-error` disabled. Changing a nudge's wording changes what the next
run scores, with no copy in `cases.json` to update.

To score a candidate wording before it ships, give the case a `nudges` map,
such as `"nudges": { "server:complete_todo": "..." }`. It replaces the live
text for that case alone, so the candidate and the shipped line run side by
side in one run. A name that is not one of the `hook:` or `server:` texts
fails the run, because a misspelt override would score the shipped text under
the candidate's name.

A hook override goes through `valise-hook.mjs --print` as a config file, so
the hook's own limits apply: a text over `MAX_TEXT_LENGTH` (2,000 characters)
or a Stop total over `MAX_COMBINED_TEXT_LENGTH` (8,000) fails the run instead
of scoring a text no client could ship. The run file keeps `nudges` and the
resolved transcript, so the text under test is in the record.

The cases come in pairs. `stop-nudge-*` and `complete-nudge-*` each have a
session worth capturing and one that is not, because a nudge that saves
after a typo fix is as wrong as one that never saves. `recall-reminder*` and
`recall-control*` are the same turn with and without the SessionStart text,
so the gap between them is what the reminder does. A run records each
scenario as a transcript in its `prompt`, which is what the evals tab shows.

A route that reads `skill_capture-this` and then stops counts as ending on
the skill. The `-nothing` cases name it in `alsoAccept`, so reading the
skill and then saving nothing passes as `≈ skill_capture-this`: the model
checked what qualifies and decided nothing did, which is the right outcome.
The read still shows in the turns and cost columns. A skill named in
`alsoAccept` still runs, so a model that reads it and then saves fails the
case, and `get_skill` on the same name counts as the same ending.

`stop-nudge-*-call-first` and `stop-nudge-*-read-then-save` score two Stop
texts against the shipped one. Call-first names `save_memory` as the call and
the skill as the shape. Read-then-save keeps the skill read and names
`save_memory` as the step after it. Runs `2026-10-18T13-12-01`,
`2026-10-18T13-12-08` and `2026-10-18T13-17-08`, seven models each, the seed
store:

| Stop text | Capture | Nothing |
| --- | --- | --- |
| shipped | 14/21 | 21/21 |
| call-first | 16/21 | 21/21 |
| read-then-save | 15/21 | 21/21 |

The default stays. gpt-5.4-mini read the skill and stopped in 9 of 9 capture
episodes, under all three texts, so no wording here moves it. The other misses
are kimi and gemini searching the store before saving and running out of
rounds, which the wording does not cause either. Sonnet, haiku, gpt-6-luna
and grok saved under every text. None of the three texts saved after
arithmetic.

`complete-nudge-*-question`, `-noskill` and `-you` hold three candidates for
the `complete_todo` line that lost to the shipped one. They stay as controls,
so a future rewording is scored against the wordings already ruled out. Runs
`2026-10-18T13-09-53`, `13-14-00` and `13-17-53`, seven models each, saved
and stayed silent as follows:

| Line | Capture | Nothing |
| --- | --- | --- |
| shipped | 18/21 | 21/21 |
| question first, names the call | 15/21 | 20/21 |
| shipped minus "following the capture-this skill" | 15/21 | 20/21 |
| second-person order, condition after | 15/21 | 20/21 |

Every variant's misses are mostly gemini-3.8-flash and gpt-5.4-mini closing
in prose, the same `(none)` the shipped line gets less often.

### Capture classification

The three `capture-*` cases distinguish an explicitly approved choice, an
agent's implementation choice, and a shipped redirect. `expectArgs.type`
scores classification rather than only whether a `type` key exists. Each
requires a `capture-this` read. [The review rubric](capture-review.md) covers
rule-first titles and bodies, approval attribution, and implementation evidence.

Grok and Luna, three repeats each:

| Guidance | Human choice, `decision` | Agent choice, `insight` | Shipped state, `fact` | Run |
| --- | --- | --- | --- | --- |
| Baseline | 6/6 | 0/6 | 6/6 | `2026-10-19T20-10-45` |
| Skill body only | 6/6 | 5/6 | 6/6 | `2026-10-19T20-16-07` |
| Skill, schema, and save description | 6/6 | 5/6 | 6/6 | `2026-10-19T20-17-15` |

Both later runs have one Luna `fact` on the agent-choice case. Neither labels
an agent choice `decision`, against all six baseline episodes. Their exact-type
score is 17/18. The schema and save description carry the rule for clients that
skip the skill; these cued cases do not isolate their effect without a skill
read. The deterministic MCP test checks that the live schema serves the guidance
and that classification remains advisory, including custom types.

The final run's six approved choices all open with the rule and attribute the
choice to the user. Manual review still finds omissions. Grok repeats 0 and 2
omit the two-page tradeoff, and repeat 2 places implementation history before
the rejected option. Luna invents an unspecified docs hostname once on the
shipped-fact case. The automatic score does not catch these prose defects.

Current integration run `2026-10-20T11-51-19`, Luna and Mini at three repeats,
again scores 17/18 exact types: one Luna `episode` rather than `insight`, zero
unsupported decisions on the six agent-choice rows. All 18 read the skill and
save. Manual review retains five of six rule-first approved body openings,
omitted tradeoffs and two inferred hostnames; the audit records the exact rows.

## Check-on-save cases

`save_memory` lists up to three memories that may already hold the claim,
found by searching memories for the new title before the insert, the same
project first. When the list is not empty, the result carries the
`{{server:save_memory}}` line, which asks the model to tell the user both ids
if the new memory restates or replaces one. The memory is saved either way.

`save-similar-duplicate` saves a claim the store already holds three times;
`save-similar-new` saves a different claim whose list shares its nouns. Each
history ends on the `save_memory` result the server returned on the retrieval
store at 500 memories, and `test/d1/retrieval.worker.test.ts` checks that the
store still lists those copies. The `-listonly` pair drops the line and keeps
the list. The duplicate passes on an answer that names an older id
(`expectAnswer`) or on a `fetch`; the new claim passes on anything but a
second save.

Runs `2026-10-18T16-02-18` and `2026-10-18T16-08-05`, three repeats on seven
models each:

| Text | Duplicate named | New claim, no second save |
| --- | --- | --- |
| list and line | 26/42 | 42/42 |
| list only | 0/42 | 42/42 |

- Sonnet, Haiku, Grok and Kimi named the older ids in every episode.
- gpt-6-luna named them in 6 of 6, but in 4 it read `skill_capture-this`
  first, and the runner scores a read followed by prose as the read.
- gpt-5.4-mini and gemini-3.8-flash answered "saved" in all 12 episodes under
  either text.
- On the new claim no answer called it a duplicate. gpt-5.4-mini hedged
  once: "If this is replacing one of the similar older copies, you may want
  to archive the duplicate(s) too."

The list holds the duplicate only when FTS finds it. A target's paraphrase
saved as a title lists the target 22/25 times at 50 memories, 10/25 at 500,
and 7/25 at 5000. The case's restatement shares its nouns with the stored
claim and lists all three copies at 500 and 5000.

## Recall on error

A stored fix is worth its tokens only if it reaches the session when the
problem comes back, and the problem usually comes back as a failed command.
Nothing in that turn names Valise. `recall-on-error-*` replays one: the history
ends on `gh pr merge` failing on a stacked PR whose parent was squash-merged,
which two memories in the production store already explain. A `bash` tool is
on the surface. The cases score the first move after the error: `search`
passes, and another `bash` call ends the route as a miss (`stopOn`).

- `recall-on-error-control` has no startup text.
- `recall-on-error-reminder` has the shipped defaults: the SessionStart text,
  and the `recall-on-error` hook line after the error when that hook ships
  enabled. `{{shipped:PostToolUseFailure}}` at the end of the tool message
  renders the line as Claude Code does, or nothing when the shipped config
  has the hook off, so the case follows the default without a copy of it.
- `recall-on-error-reminder-typo` is the over-fire control: `npm run tset`
  fails with "Missing script", and the error names the fix. Rerunning passes;
  a `search` fails.

The memories are not seeded. `search` and `fetch` are endings in these cases,
so they never run, and adding rows to `/__dev/seed` would move the store hash
for every case.

The last sentence of the SessionStart text came out of these cases. Runs
`2026-10-18T14-12-23`, `2026-10-18T14-14-13` and `2026-10-18T14-32-10` scored
two candidate sentences beside the reminder of the time, seven models, three
samples per cell:

| SessionStart text | Searched on the conflict | Searched on the typo |
| --- | --- | --- |
| none | 1/21 | — |
| reminder only | 1/21 | 0/21 |
| + "When a command fails, search Valise for the error text before trying something else." | 12/21 | 9/21 |
| + "When a command fails with an error the message itself does not explain how to fix, search …" | 8/21 | 0/21 |

The broad sentence sent haiku, gpt-6-luna and gemini to search on a typo in 9
of 21 episodes. The narrow one moved sonnet (3/3), gpt-5.4-mini (3/3) and
gpt-6-luna (2/3) without a single search on the typo, and it shipped. Haiku,
gemini, grok and kimi shelled out first under every text; the next thing to try
for them is a PostToolUse hook on a non-zero exit, which puts the line next to
the error instead of at the start of the session. `startup-brief-unrelated`
with the broad sentence stayed silent 7/7.

Run `2026-10-18T14-51-44` is the whole suite with the narrow sentence shipped.
`recall-on-error-reminder` searched 2/7 (sonnet and gpt-5.4-mini; gpt-6-luna
shelled out this time), and grok searched on the typo once, the first search
there in 28 episodes. Every `recall-*`, `startup-*` and `no-tool-*` case
scored as it did in `2026-10-18T14-32-10`.

The OpenRouter lane skips `recall-on-error-live*`, and the harness lane skips
the rest: their history replays a tool call and adds a tool, and
`skipReason` refuses both.

### The failed-command hook

`recall-on-error` is the plugin's third hook. Claude Code reports a non-zero
Bash exit as `PostToolUseFailure`, never as `PostToolUse` (probed on 2.1.302:
`echo ok` fired `PostToolUse`, `ls /missing` fired only `PostToolUseFailure`
with `error: "Exit code 2\n..."`), so the hook registers there and costs
nothing on a command that succeeds. It renders as
`<system-reminder>PostToolUseFailure:Bash hook additional context: …` right
after the failed tool result. `{{hook:PostToolUseFailure}}` puts that line at
the end of the tool message in `recall-on-error-hook*`, which otherwise match
`recall-on-error-reminder*`, SessionStart sentence included.

Seven models, three samples per cell, searched on the conflict and on the
typo:

| PostToolUseFailure text | Conflict | Typo | Runs |
| --- | --- | --- | --- |
| none (SessionStart sentence only) | 16/42 | 9/42 | `20-30-21`, `20-55-21` |
| "This command failed. Before trying something else, search Valise for the error text; a stored memory may explain it." | 20/21 | 9/21 | `20-30-21` |
| "…If the error does not say how to fix it, search …" | 10/21 | 4/21 | `20-36-38` |
| "…If the message itself does not explain how to fix it, search …" | 10/21 | 6/21 | `20-36-38` |
| "…If the error names its own fix, such as a typo or a missing flag, apply it. Otherwise search …" | 11/21 | 1/21 | `20-36-38` |
| "…Search … before your next attempt; one search costs less than a wrong fix. Skip it only for a typo in the command itself." | 19/21 | 7/21 | `20-40-44` |
| "This command failed. Unless the error is a typo in the command you just ran, search Valise for the error text before trying something else; a stored memory may explain it." | 35/42 | 12/42 | `20-40-44`, `20-55-21` |
| the same, SessionStart sentence removed | 16/21 | 6/21 | `20-42-53` |

All stamps are `2026-10-18T…`. A condition about whether the error explains
its fix loses the models the hook exists for: the `gh` conflict prints a
command to run, so haiku, gemini and kimi read it as explained and shell out.
Naming the typo as the one exception keeps them. Haiku, gemini, grok and kimi
searched on the conflict 17 of 24 times under the shipped text, against 0 of
24 with the SessionStart sentence alone.

The typo did not stay at 0 under any wording that moved them. gpt-5.4-mini and
grok searched on `npm run tset` in all 12 episodes under the shipped text, and
in 9 of 12 with the SessionStart sentence alone, so most of that over-fire is
already there without the hook. The last text in the table is the one that
ships.

`recall-on-error-live` runs the conflict through the harness lane for real: a
stub `gh` on the `PATH` prints the conflict and exits 1, Bash is allowed for
`gh` only, and the hook runs on the shipped config. `recall-on-error-live-off`
turns it off through `hookConfig`. Run `2026-10-18T20-51-11`, with the hook
on, three samples each:

| Lane | Hook on | Hook off |
| --- | --- | --- |
| `claude-code+plugin/sonnet` | 3/3 | 0/3 |
| `claude-code+plugin/haiku` | 2/3 | 0/3 |
| `claude-code+mcp/*` (no hooks) | 0/6 | 0/6 |

`session.injected` on each plugin row holds the text the hook added, once per
failed `gh` call: two or three times a session.
With the hook off, the SessionStart sentence was in every plugin session and
neither model searched, including Sonnet, which searches 3/3 on the same
sentence in the OpenRouter lane. In Claude Code that sentence did not carry
the failed-command case on its own.

### Which default ships

Four arms, scored on the conflict and the typo in one run per lane. The
SessionStart text is pinned per case, so the arms do not move when a shipped
text does: `recall-on-error-neither*` sends the recall reminder without the
failed-command sentence, and the other `-live*` cases write the reminder text,
and the hook's `enabled` where the arm sets it, into `hookConfig`.
`recall-on-error-live` and `-live-typo` carry no
`hookConfig` and run the shipped config, arm 4. The harness typo cases stub
`npm` to fail only on `run tset`.

| Arm | SessionStart sentence | Hook | Conflict | Typo | Tokens | Harness conflict | Harness typo |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | no | off | 1/21 | 0/21 | 171k | 0/6 | 0/4 |
| 2 | yes | off | 8/21 | 4/21 | 173k | 1/6 | 0/5 |
| 3 | no | on | 16/21 | 7/21 | 174k | 6/6 | 0/2 |
| 4 | yes | on | 19/21 | 6/21 | 175k | 6/6 | 1/5 |

The OpenRouter columns are run `2026-10-18T21-17-54`, seven models, three
samples per cell; tokens are prompt plus completion over both cases. The
harness columns are `2026-10-18T21-41-45`, `claude-code+plugin` with Sonnet
and Haiku, three samples each. The harness typo counts only the sessions in
which `npm` failed: given `npm run tset` in the prompt, Sonnet and Haiku often
ran `npm run test` straight away, so the hook never fired in four of the six
hook-only sessions. The run file records the hook's injected text, so the
arm 3 and 4 denominators reproduce from it; arms 1 and 2 have no hook, and
their 4 and 5 were counted from the session transcripts.

Arm 4 ships: the failed-command sentence and `recall-on-error`, both on, with
the texts above. The rule set before the runs, the arm with the most conflict
searches whose typo searches are at or below arm 2's, picks arm 2: arms 3 and
4 search on the typo more than arm 2 in the seven-model lane, and pooled with
`20-30-21`, `20-42-53` and `20-55-21` they still do (13/42 and 18/63 against
13/63). The rule does not split by client, and the hook fires in one.

Every typo search under the hook came from gpt-5.4-mini, grok, and once
gpt-6-luna. Sonnet and Haiku did not search on the typo under any arm in
either lane, except one Haiku session under arm 4. Claude Code is the only
client that fires `PostToolUseFailure`, and for the models it usually runs
arm 3 searched on the conflict 12 of 12 times with no typo search, against 4
of 12 under arm 2. Clients without the event get arm 2, because the sentence
is all that reaches them.

Run `2026-10-19T10-28-12` is the harness lane on the shipped config,
`claude-code+plugin` with Sonnet and Haiku, three samples each:
`recall-on-error-live` searched 6/6 and `recall-on-error-live-typo` 0/6, and
`session.injected` shows the hook fired in all twelve sessions, one or two
times each. `claude-code+mcp` has no hooks and searched on the conflict 0/6.

Run `2026-10-19T10-22-13` is the whole suite on the shipped defaults, seven
models, one sample per cell. Against `2026-10-18T22-12-49`, 456 of 497 shared
cells scored the same. `recall-on-error-reminder` now carries the hook line
and searched 6/7 against 2/7: gemini, grok and kimi searched for the first
time in 20 samples each. `recall-on-error-reminder-typo` searched 2/7 against
1/7 (gpt-5.4-mini and grok), inside the 5/21 of arm 2's three-sample runs.
`recall-on-error-reminder-port` searched 7/7, as arm 4 did in 42 of 42. The
other 36 moves are on cases whose text this change does not touch, with the
same tool and store hashes. Four of them fell outside their history:
`recall-on-error-hook-only-typo` on kimi, `stop-nudge-capture-call-first` on
haiku, and `memory-preference` and `stop-nudge-capture-read-then-save` on
gemini. Run `2026-10-19T10-35-43` reran each at three samples, and all four
passed 3/3.

### Conditioning on whether the fix is obvious

The shipped sentence conditions on "an error the message itself does not
explain how to fix". A model can read that literally, look only inside the
error text, and search on a terse error whose fix is obvious anyway. Two
wordings condition on the fix instead of the message, each as a sentence and
as a hook line:

- `-unclear`: "When a command fails and the fix is not immediately clear from
  the output, search Valise for the error text before trying something
  else." and "This command failed. If the fix is not obvious from the output,
  search Valise for the error text before trying again; a stored memory may
  explain it."
- `-unclear-short`: "When a command fails and the fix is not obvious, search
  Valise for the error text first." and "This command failed. If the fix is
  not obvious, search Valise for the error text first."

`recall-on-error-{reminder,hook,hook-only}-unclear*` carry them as per-case
`nudges`, so no shipped text moves; `recall-on-error-hook-unclear-line*` pairs
the shipped sentence with the `-unclear` hook line. Every arm also has a
`-port` case, a second over-fire control in which `node server.js` dies on
`EADDRINUSE` on port 3000. The message names no fix, and the case scores a
`search` as a fail, on the view that anyone who has seen it picks another port
or stops the old server. That is a weaker control than the typo. A port
conflict has a real choice in it, which port or which process to stop, and a
stored memory could answer it, so a search there is debatable over-fire.
`recall-on-error-live-unclear*` and `-live-hook-only-unclear*` run the
`-unclear` pair through the harness lane with the hook on.

| Arm | SessionStart sentence | Hook line | Conflict | Typo | Port | Harness conflict | Harness typo |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | none | off | 2/21 | 0/21 | 0/21 | — | — |
| 2 | shipped | off | 15/42 | 10/42 | 29/42 | — | — |
| 2 | `-unclear` | off | 13/42 | 11/42 | 32/42 | — | — |
| 2 | `-unclear-short` | off | 8/42 | 5/42 | 34/42 | — | — |
| 3 | none | shipped | 33/42 | 10/42 | 31/42 | — | — |
| 3 | none | `-unclear` | 25/42 | 1/42 | 22/42 | 2/5 | 0/4 |
| 3 | none | `-unclear-short` | 16/42 | 6/42 | 21/42 | — | — |
| 4 | shipped | shipped | 39/42 | 12/42 | 42/42 | 5/6 | 0/4 |
| 4 | shipped | `-unclear` | 23/42 | 12/42 | 37/42 | — | — |
| 4 | `-unclear` | `-unclear` | 33/42 | 9/42 | 41/42 | 4/6 | 1/5 |
| 4 | `-unclear-short` | `-unclear-short` | 32/42 | 7/42 | 39/42 | — | — |

The seven-model columns pool runs `2026-10-19T07-49-33` and
`2026-10-19T08-18-02`, three samples per cell each; arm 1 is the second run
alone, and the shipped-sentence `-unclear` row is `2026-10-19T08-24-02` at six
samples. One gemini episode in the arm 3 `-unclear-short` conflict cell was a
provider 400 and counts as no search. The harness columns are
`2026-10-19T08-58-42`, `claude-code+plugin` with Sonnet and Haiku, three
samples each, counted over the sessions in which the hook fired; one Haiku arm
3 session timed out and is left out. As in the earlier harness run, the model
often ran `npm run test` straight away on the typo, so the hook fired in four
or five of the six typo sessions. A session counts when its `session.hooks`
in the run file lists `PostToolUseFailure`.

Over OpenRouter the wording moves the hook line and not the sentence. Under
arm 3, `-unclear` cut typo searches from 10/42 to 1/42, because gpt-5.4-mini
(4 to 0) and grok (5 to 1) reran the right script, and it cut port searches
from 31/42 to 22/42. It cost conflict searches, 33/42 to 25/42, mostly gemini
(4 to 0) and kimi (2 to 0). The `-unclear` sentence searched on the typo
11/42 against the shipped 10/42, with gpt-5.4-mini at 6/6 under both, and
`-unclear-short` halved typo and conflict searches together. Paired with the
shipped sentence, the `-unclear` hook line lost Haiku on the conflict (1/6)
and saved nothing on the typo. No wording brought the port case near arm 1's
0/21. Every text that names a failed command sends most models to search on
`EADDRINUSE`.

Claude Code is the only client that fires the hook, and there the `-unclear`
line lost Sonnet. It searched on the conflict 1/3 under arm 4 and 0/3 under
arm 3, against 3/3 under the shipped line, though it searched 6/6 on the same
line over OpenRouter. The conflict prints a command to run, and Sonnet took it
as the obvious fix. Haiku searched 5/5 on the conflict under the `-unclear`
line, and once on the typo. The shipped hook line is the one that kept Sonnet,
and neither sentence wording beats the shipped sentence.

## Startup and skill-discovery cases

`{{fixture:<file>}}` reads a file from `evals/fixtures/`, for a context or a
tool result too long to keep inline. A case can also change the tools it
offers:

- `hideTools` takes names, or `prefix*`, off the live surface.
- `harnessTools` adds tools the harness has besides Valise, each answered
  with the case's canned `result`.
- `live` adds Valise tools the episode runs for real, beyond the skill tools
  and the read-only set it already runs.
- `maxRounds` raises the three-call limit. Raise `turnBudget` with it when
  the longer route is the good one.

`firstPromptTokens` on each row is the input at the first decision: the
system prompt, the startup context, and the history. Compare it across a pair
to see what a startup payload costs before the model has done anything.

`startup-*` compares two startups. The old one: the reminder said to check
`list_ready`, so the session opened on the whole ready queue
(`fixtures/list-ready-15.txt`). The shipped one: the reminder followed by the
bounded brief from `GET /config/brief` (`fixtures/startup-brief.md`). The
brief holds the last three projects, five to-do titles with tags and project,
and three memories by id. "Most fetched" in the brief means `fetch` calls on
that memory id in `mcp_calls` over the last 30 days, with ties going to the
latest `updated_at`.

The fixture is the endpoint's own output. To regenerate it, load the fifteen
to-dos from `list-ready-15.txt` and a few memories with `fetch` rows into the
local D1, mint a `config:read` token, and save the body of
`GET /config/brief`.

`skills-*` measures discovery when skills are not preloaded. It uses a native
registry played by `find_skill` and `load_skill`, and Valise's registry
through `list_skills` and `get_skill`. `skills-search-native-only` hides
Valise's skills, the way a connector without MCP skill support would look.
`skills-preloaded-control` is today's surface, where every Valise skill is its
own `skill_*` tool.

Run `2026-10-17T22-28-53`, seven models, the seed store (one skill):

- A 15-item `list_ready` costs 1,500 to 2,600 input tokens at the first
  decision, depending on the tokenizer. That is about 175 per to-do (Sonnet
  7,675 against 5,070 with the brief). At the 100 cap it would be about
  17,000. The brief costs 320 to 450 more than the bare reminder.
- With the whole queue in view, 7/7 models went straight to the blog to-do:
  6 claimed it and 1 fetched it. With the brief, 7/7 asked for it by name:
  5 called `list_ready(project: "blog")` and 2 called `search`. None reread
  the whole queue. Both paths took the same number of calls, so the brief's
  saving is the tokens alone.
- On a question a stored decision answers, the brief's memory line was enough
  for 5/7 models to `fetch` it by id without searching. One searched, and
  gpt-5.4-mini answered without a call. With the reminder, 7/7 searched.
- On an unrelated turn the brief caused no calls (7/7).

Run `2026-10-17T23-07-20` repeats the startup cases with the brief as
shipped: the endpoint's output after the shipped reminder, which does not
mention `list_ready`. The brief costs 359 to 508 input tokens over the
reminder alone. It saves 1,489 to 2,561 against the 15-item queue. The
results match the first run:

- Blog work: 7/7 asked for it by name. 5 called `list_ready(project:
  "blog")` and 2 called `search`.
- Stored decision: 5/7 fetched the listed memory by id. gpt-6-luna and
  gpt-5.4-mini searched instead.
- Unrelated turn: 7/7 made no call.
- With skills not preloaded, 0/7 models searched either registry before
  saving, even when the context said to. All 7 saved directly. With the
  native registry alone, only gemini-3.8-flash called `find_skill` and loaded
  the skill. On today's surface, 5/7 read `skill_capture-this` first. Telling
  a model to search does not make it search. Exposing the skill as a tool
  does, for most models.

`startup-brief-miss-*` is the miss to each hit. `miss-todo` names a to-do
that is open in `list-ready-15.txt` but not among the brief's five, while two
listed to-dos are console work. `miss-memory` asks about a decision whose
memory is not among the brief's three, while a listed memory is about search.
The right route is `search`, or `list_ready(project)` for the to-do. The
wrong ones are answering from the brief as if it were the whole store and
taking the nearest listed item. `miss-memory` sets `stopOn: ["fetch"]`: the
eval store holds none of the brief's memory ids, so a live `fetch` would
answer not-found and push the model onto `search`, where a real store would
hand it the wrong memory.

Runs `2026-10-18T13-54-36`, `2026-10-18T13-59-43` and `2026-10-18T14-04-44`
scored four brief wordings on the three hit cases and the miss pair, seven
models, three runs each. The wordings were the shipped brief, the brief plus
"This lists 5 of 23 open to-dos and 3 of 140 memories.", the brief plus
"Anything not listed here needs a search.", and the brief plus both lines.

| Case | Shipped | Counts | Instruction | Both |
| --- | --- | --- | --- | --- |
| startup-brief-blog | 21/21 | 21/21 | 21/21 | 21/21 |
| startup-brief-memory, by `fetch` | 14/21 | 13/21 | 15/21 | 14/21 |
| startup-brief-unrelated | 21/21 | 21/21 | 21/21 | 21/21 |
| startup-brief-miss-todo | 21/21 | 21/21 | 21/21 | 21/21 |
| startup-brief-miss-memory | 21/21 | 21/21 | 21/21 | 21/21 |

- The shipped brief already handles the miss. Every model searched for the
  missing to-do or memory by its own words, or called `list_ready(project:
  "valise")` (gpt-5.4-mini, 3/3). None fetched the nearest listed memory.
  None claimed a to-do or answered from the brief. The `miss-memory` 21/21
  is measured under `stopOn`, not a live fetch.
- No line moved a cell. The `fetch` rate on the listed memory is 13 to 15 of
  21 in every arm. gpt-6-luna and gpt-5.4-mini search instead in every
  wording. The counts line costs about 22 input tokens, the instruction line
  about 10, and both about 40.
- The endpoint is unchanged. Its header line already says "for orientation
  only; search or fetch before relying on any of it", so the instruction
  line repeats it. The variant cases are gone from `cases.json`. Each run
  file keeps the texts it scored.

`startup-brief-rollup` and `startup-brief-no-rollup` ask the same broad
history question, "Where did the valise project come from", under two
briefs. `fixtures/startup-brief-rollup.md` is the shipped brief with the
pointer the endpoint adds when a project has a rollup memory:
`valise (overview memory:<id>, covers up to 2026-10-17)`. The rollup case
expects a `fetch` of that id. The control expects a `search` with `project`
set, since without a rollup the project's memories are the answer.

Three full runs, `2026-10-18T16-07-16`, `16-29-37` and `18-03-17`, seven
models each: with the pointer, 15 of 19 answered episodes fetched the rollup
id, 11 on the first turn. The other four searched instead: kimi twice,
gpt-6-luna and gpt-5.4-mini once each.
Without the pointer, 21/21 searched and 15 set `project`; haiku and kimi
never did, putting the name in the query instead. The brief text is a
fixture, so these cells do not move with the skill text.

The `capture-this` section that tells a model how to write a rollup is read
on every save, so it was scored on the save cases too. Three longer
wordings, one with "offer after closing a to-do in a project with more than
twenty memories" as a second trigger, held the totals but cost Sonnet on
`complete-nudge-capture`: 3/9 across runs `2026-10-18T16-46-26`, `17-19-44`
and `17-38-57`, each miss a skill read, a `fetch` of the closed to-do, and a
`search` until the cap. The skill without the section scored 3/3 in
`17-03-39`. The shipped section is five lines with the request as its only
trigger, and Sonnet scored 4/5 under it (`17-40-28`) against 4/5 without it
(`17-41-24`). Its budget score dropped: 2/5 passes within the two-turn budget
against 4/5, on 106k tokens against 85k, with one capped route in each arm.

On the eight save and nudge cases at three repeats, the shipped section
scored 100/126 (`18-18-44`) against 104/126 without it (`17-03-39`). Misses
after a skill read were 14 against 15. The gap is in routes that never read
the skill, 12 against 7, mostly kimi searching until the cap, which no
SKILL.md text reaches. By model, kimi went from 18/24 to 15/24, and Sonnet,
Haiku and Gemini lost one each; the routes do not explain the Haiku miss. The
section is a small measured cost on every save, inside run-to-run noise. Both
arms stayed silent on 41 and 42 of the 42 `-nothing` episodes.

## Library discovery cases

`search-broad-library-author` asks what is saved about Vaclav Smil without
naming a file type. It requires `include_library: true` and no type or project
filter. `search-saved-books` asks specifically for books and PDFs about energy
transitions and requires `type: "asset"`, without an invented project filter.
Both score the call arguments, not retrieval quality or file-content search.
MCP regressions separately upload a file, save a source and a memory, and
check mixed discovery, exact filters, cached default results, ownership,
expiry and metadata-only coverage.

```sh
node evals/run.mjs --case search-broad-library-author,search-saved-books --repeat 3
```

Run `2026-10-22T13-42-47`, six default models and three repeats, scores 36/36
with absent-filter checks. The same wording under the old unset-strict
transport scored 24/36 (`13-40-02`); that difference is transport, not prose.
The first wording over-broadened file requests (`13-33-48`); explicit file and
source guidance fixed their type selection (`13-35-37`), whose original
scoring still missed the invented filters. Those earlier artifacts remain
marked dropped or baseline rather than being rescored in place.

Full-suite Mini run `2026-10-22T13-46-45`, one repeat, scores 74/111 with zero
transport errors and 19 harness/corpus cases skipped. Both library cases,
typed search, the asset/source tools and the no-tool controls pass. Capture,
hook, recall and startup misses remain; this is not a full-suite success or
a controlled comparison with the old transport.

## Status cases

The 2026-10-23 orientation surface adds two cases:
`orientation-hookless` selects `get_brief(project)` and must omit an invented
`since`; `orientation-completed-window` selects `list_todos` with the requested
project and exact inclusive completion boundary. The filter implies done, so
an omitted state is valid. `status-project-activity` also accepts `get_brief`:
its state-separated samples carry progress and explicit omission bounds.

```sh
VALISE_MCP_URL=http://localhost:5283/mcp npm run evals -- \
  --case orientation-hookless,orientation-completed-window,todo-list-ready,todo-list-blocked,status-project-activity,no-tool-chitchat \
  --models openai/gpt-5.4-mini,anthropic/claude-haiku-5.5 --repeat 3
```

Baseline `2026-10-23T20-04-03` ran only the two new cases on Mini before the
tools existed: 0/2 ($0.0093). Trial `20-07-42` retains its original 8/12 score
and arguments: it overconstrained implicit done, rejected a useful brief for
status, and did not yet catch an invented brief date. Those old scores are not
rewritten. Final focused run `20-10-24` scores 35/36 ($0.0373), with both new
cases 6/6, ready/no-tool controls 6/6 each, and one Mini blocker check ending on
`get_brief` instead of the requested ready-plus-blocked listing. It has no
transport errors. Tool choice is still not proof that an agent consumed task
evidence or produced a correct final report. Controlled cross-agent outcome
evals, large skill-catalog and real hooked-client comparisons remain separate
work; no success rate for those is inferred from this run.

The miss belongs to the existing `todo-list-blocked` control, not either new
orientation case. Its expected tool remains `list_ready` with
`include_blocked`; no acceptance rule was widened for that miss. Mini's latest
earlier sample (`2026-10-22T13-46-45`) passed 1/1. On the new surface it missed
1/1 in `20-07-42`, then missed repeat 0 and passed repeats 1 and 2 in
`20-10-24`. The latter miss executed `get_brief`, then answered that no tasks
were blocked; the seed's brief did in fact contain no blockers. This is a
tool-choice regression sample on an existing control, not demonstrated wrong
task data. There is no matched repeat-3 pre-addition blocker baseline, so these
samples do not isolate causation or establish a regression rate. The miss and
its two-turn answer stay in the original run; it is not rerun away or counted
as green. The new orientation cases passed 12/12 samples combined.

`test/mcp/startup-brief.worker.test.ts` checks the actual shared HTTP/MCP read
model, ids for targeted fetches, the 24-hour completion boundary, omission
bounds, old-task fresh progress, a partial task's evidence across two caller
identities, tenant isolation, scope declarations/refusals and keyset paging
under timestamp ties, edits and backdated inserts. These are deterministic
application regressions, not model outcome scores. The hook's earlier
most-fetched-memory fixture below remains historical: current hook text renders
the state-separated brief and changed memories, capped at 7,800 characters.

On 2026-10-22 an agent asked "what is going on in project valise?" called
`list_ready`, saw the pending queue, and missed the managed-assets work whose
slices, verification and merge blocker sat in the updates of a to-do still
marked pending. ADR-0003's amendment of that date holds the fix. Three cases
reproduce the miss:

- `status-project-activity` asks the question cold. It passes on
  `list_ready` with `activity`, or on a `fetch`; `list_ready` without
  `activity` is the miss. It fails by construction on any surface from before
  `activity` existed.
- `status-pending-updates-digest` replays the turn after `list_ready` ran,
  from `fixtures/status-list-ready-digest.json`: the default result as it is
  now, the unchanged structured list plus the `last_updates` block. It passes
  when the answer names where the pending to-do stands (`#153`,
  `assets-finalize` or `four slices`, all from its latest update's summary),
  or on a `fetch`. Answering from titles fails on `expectAnswer`.
- `status-pending-updates-today` is its control, from
  `fixtures/status-list-ready-today.json`: the same result without the
  block, as `list_ready` answered before. Only a fetch passes it, so the gap
  between the pair is what the block adds.

The fixtures are hand-built to the shape `evals/run.mjs` feeds a model for a
live call, content blocks and `structuredContent` together. A `fetch` passes
whatever id it names, because `alsoAccept` scores no arguments; read the run
file to see which to-do a passing fetch opened. The default models have not
run them yet; that needs `OPENROUTER_API_KEY`. One harness run on haiku,
three repeats per lane, passed `status-project-activity` 6/6, each with
`activity: true`, and left `todo-list-ready` and `todo-list-blocked` at 6/6
with no `activity` in their calls. It was not kept: a single-case run
recorded last breaks the workbench matrix test. The harness lane skips the
two history cases.

On 2026-10-25 each `last_updates` entry began to lead with the to-do's
`status` and `status_at`, and `fixtures/status-list-ready-digest.json` was
updated to match what the server sends. `todo-fetch-older-page` replays the
first page of a paged `fetch` from `fixtures/todo-fetch-paged.json`: ten of
14 updates, newest first, with `next_cursor` `tdu_eval_05`. Asking for the
oldest updates passes only on `fetch` with that cursor. Focused run
`2026-10-25T15-33-09` passed it 6/6 on Haiku 5.5 and GPT-5.4 Mini, and full
run `15-42-23` passed it on both. No baseline exists: before paging, `fetch`
had no cursor to follow. The same evening the status moved into
`list_ready`'s structured rows, so the digest fixture's rows are #201's
trimmed id, title, project and blocked_on, with `status` and `status_at`
after each title. Later still, the `last_updates` block was removed, since
Claude Code never showed it to a model, and the digest fixture now holds the
structured result alone. The `-today` control keeps the shape it had before
2026-10-22. ADR-0003's amendment of that date has the rest.

`fixtures/startup-brief.md` predates the brief's last-update lines, so the
`startup-*` cases still score the brief without them.

## Subtask cases

`todo-subtasks` asks for a to-do with three named subtasks. The score checks
that `create_todo` carried a body; read the body in the run file to see
whether the steps are `- [ ]` lines.

- Run `2026-10-18T09-57-56`, before the `body` field described subtasks: 3/7
  models wrote `- [ ]` lines. The rest wrote plain or numbered lists, which
  the console cannot tick.
- Run `2026-10-18T10-39-38`, with the shipped wording: 7/7 wrote `- [ ]`
  lines. On `todo-create`, which names no subtasks, 3/7 still added a
  checklist of their own. A first wording without "do not invent them" did
  that on 5 of the 14 `todo-create` and `todo-facet` calls.

## Distractors

A real client carries other MCP servers beside Valise, and their tools
compete for the same turn. `--distractors N` adds N of them to every case:

```sh
node evals/run.mjs --distractors 20
npm run evals:trends              # a curve per surface, by N
```

The rivals are in `fixtures/distractors.json`: 124 tools over 16 servers,
with names and descriptions written like the real ones. A generic memory
server (`remember`, `recall`), web search, a Linear-shaped issue tracker,
notes, a task list, a filesystem, a knowledge graph, GitHub, Slack, Notion,
a calendar, SQL, a browser, git, mail, and a clock. The runner takes one
tool per server in turn, so 20 holds every server and 20, 50 and 100 nest.
Each server lists its strongest rival first. The distractors come before
Valise's tools on the surface, the order Claude Code lists other servers
before `valise`.

A call to a distractor ends the episode. On a case with a tool, that is a
miss. On a `tool: null` case it passes, because the case asks whether
Valise fires, and a filesystem tool answering "add a line to ./notes.txt"
is the right call in a client that has one.

The run records `distractors.count`, `hash`, and `names`, and the report
header prints them. `trends.mjs` keeps each N in its own cells
(`grok-4.3 +50`) and prints a pass rate by N for every model and for every
case that drops below its rate at zero. The harness lane takes no
distractors yet. Claude Code would need them as real servers through
`--mcp-config`.

Runs `2026-10-18T14-07-32` (+0), `14-26-12` (+20), `14-26-05` (+50) and
`14-27-25` (+100), all seven models, tools `72d0dbe0bdaf`, store
`e9268cdfed48`:

| Model | +0 | +20 | +50 | +100 |
| --- | --- | --- | --- | --- |
| claude-sonnet-5.5 | 95% | 97% | 97% | 97% |
| claude-haiku-5.5 | 95% | 95% | 95% | 90% |
| gpt-6-luna | 95% | 87% | 95% | 92% |
| gpt-5.4-mini | 87% | 82% | 79% | 79% |
| gemini-3.8-flash | 95% | 92% | 90% | 87% |
| grok-4.3 | 92% | 85% | 85% | 72% |
| kimi-k2.6 | 92% | 92% | 90% | 85% |

Each column is one run. `npm run evals:trends` pools every run on a
surface, so its +0 column also counts the other runs on `72d0dbe0bdaf`.
A full run cost $1.16 at +0 and $1.51, $1.94 and $2.45 at +20, +50 and +100.

- `remember` beats `save_memory`. grok-4.3 picks it on `memory-preference`
  and `memory-decision` at every N, and kimi joins at +50. At +100 seven
  save cases end on `remember`.
- `recall` beats `search`. gpt-6-luna and gpt-5.4-mini take it on
  `recall-control` and the `startup-*-memory` cases from +20 on.
- `create_issue` beats `create_todo` for gpt-6-luna and kimi on
  `todo-create` at +20.
- Web search never won a turn, at any N.
- Sonnet does not move. Grok loses the most, 20 points by +100.

Two rewrites were run at +20, one description per run, and neither
shipped. Naming Valise as the shared workspace in `search` (run
`2026-10-18T14-48-53`) left 2 `recall` endings on search cases. The
unchanged description had left 3 in one +20 run and 10 in another
(`2026-10-18T15-09-40`, which also carries the `save_memory` rewrite, tools
`571d5808f593`), so one run cannot tell a rewrite from the noise.
Telling `save_memory` to answer "remember" requests (run
`2026-10-18T15-09-40`) left grok on `remember` for both memory cases. The
next attempt needs `--repeat` at +20 before it can count.

Focused repeat-3 trials on 2026-10-19 use two affected models per description,
not the seven-model matrix. Baselines `20-10-38`, `20-10-53`, and `20-12-53`
pass 27/45, or 60%, across the selected losing cells at +20. This is not a
full-suite pass rate. Two clauses each on `save_memory` and `search` fail to
improve both models, so both stop after two reversions. A `create_todo` clause
moves Luna's `todo-create` from 0/3 to 3/3 while Kimi stays at 3/3. It remains
experimental, without a full +0 regression or improvement on two models. No
rival clause ships. Exact sentences, commands, hashes, and all stamps are in
[the trial record](../docs/research/2026-10-19-description-climb.md).

The focused +20 baseline on 2026-10-20 passes 77/105 (73.3%) over five
historically losing cases, seven models and three repeats, including one
provider error and one capped route. Both to-do cases already pass 42/42.
Purpose/ID clauses add no gain on Luna/Kimi and are reverted, completing the
to-do stopping rule. This is not a full-suite +20 rate. Run
`2026-10-20T11-46-03` and the trial record retain the comparison; neither the
old single-model gain nor a new rival clause is promoted.

## The harness lane

Every other run sends a bare system prompt and the tool list to a model over
OpenRouter. The harness lane sends the same cases through headless Claude
Code, so the turn carries Claude Code's own system prompt, the
`mcp__plugin_valise_valise__` prefix, and the plugin's hooks firing for real.

```sh
npm run evals:store                          # a fresh store in .wrangler/evals
VALISE_STATE=.wrangler/evals VALISE_RERANK=off npm run dev     # in another terminal
node evals/run.mjs --harness claude --case todo-claim,stop-nudge-capture
node evals/run.mjs --harness claude --models sonnet,haiku
```

It needs the `claude` CLI on the PATH and logged in. A subscription login
works; `ANTHROPIC_API_KEY` is not needed. `--models` takes Claude Code model
aliases, default `sonnet`. Each model gets two columns:

- `claude-code+plugin/<model>` loads a temp copy of `clients/valise` with
  `--plugin-dir`. The copy's `.mcp.json` adds the `x-valise-agent` and
  `x-valise-client` headers the loopback endpoint takes instead of OAuth, and
  `VALISE_MCP_URL` points the shipped URL at the dev server. The shipped
  `headersHelper` still runs and reports the `-p` session id. The plugin in
  the repo is not touched.
- `claude-code+mcp/<model>` names only Valise in `--mcp-config`, with
  `--strict-mcp-config` and the same headers. No hooks, no plugin header, so
  `complete_todo` answers as it does for a chat client.

Both lanes run with `--setting-sources ""`, `--tools ""`, and
`--no-session-persistence`, from an empty temp directory, with
`ENABLE_CLAUDEAI_MCP_SERVERS=false` and auto memory off. The plugin lane
cannot use `--strict-mcp-config`, because that drops the plugin's own
server. Without the connector variable, the claude.ai connectors attach
partway through the session: one memory turn cached 236k tokens and cost
$0.76 instead of $0.008.

Scoring reads the route from `mcp_calls`, not from the transcript. Each case
gets a fresh `--session-id`, and the lane reads that session's `tools/call`
rows through the dev server's Local Explorer
(`/cdn-cgi/local/explorer/api/d1/database/<id>/raw`). A session that leaves no
`tools/list` row is an error, not a silent no-call. The OpenRouter lane ends
an episode on the first call that would write. A Claude Code session keeps
going after that call, claiming a to-do and then fetching it. So a harness
case passes when the session made the expected call anywhere in its route,
and a `tool: null` case passes only when the session made no call at all.
Rows carry `lane` and the run carries `harness` (name and CLI version), so
`npm run evals:trends` keeps them in their own cells.

Writes run for real against the eval store. Before every case the lane
re-seeds with `/__dev/seed` and returns the seed to-do to pending with
`/__dev/todos/reset?todo=<id>`, which goes through the coordinator. Rows a
case creates, such as memories and to-dos, stay in `.wrangler/evals`, so the
next run's store hash differs from `b7467a0bd162`. Run `npm run evals:store`
before a run you want to compare against a fresh store. Pointed at the
default `.wrangler/state` instead, a saved memory titled like the seed memory
makes `npm run test:ui` fail its long-search case on a strict-mode match.

Each case is one `-p` turn, which bounds what the lane can express:

- A history with a tool call cannot be replayed. `complete-nudge-*` and
  `startup-broad-blog` are skipped, and the run prints and records each skip.
- A case that rewrites the tool surface (`hideTools`, `harnessTools`) plays
  a client Claude Code is not. The `skills-*` cases are skipped.
- A text-only history is folded into the prompt as a `[user] … [assistant] …`
  transcript. The model reads a pasted transcript, not its own earlier turn.
- `cases.json`'s `system` is not sent; Claude Code's system prompt replaces
  it. A case's `context` goes in with `--append-system-prompt`.
- In the plugin lane the hooks deliver `{{hook:SessionStart}}` and
  `{{hook:Stop}}` instead of the case. A case whose prompt is the Stop text
  sets the hook's `every_turns` to 1 through `VALISE_CONFIG`, so it fires
  after the first turn; `session.callsBeforeStop` on the row says which
  calls came before it. The SessionStart reminder fires on every case, so
  `recall-control` is not a control in that lane.
- A case with `shell` gets the Bash tool, allowed only for the commands it
  stubs, each a script on the `PATH` that prints the case's `stderr` and
  exits with its `exit`. A stub with `args` fails only on exactly those
  arguments and exits 0 on any other, so a corrected typo succeeds. Every
  other case runs with `--tools ""`. A case's
  `hookConfig` is written to `VALISE_CONFIG`, which is how a control turns a
  shipped hook off. `--include-hook-events` puts each hook's response in the
  stream, and `session.injected` keeps what a `PostToolUseFailure` hook
  added.
- There is no round limit and no turn budget. A session's `num_turns` runs
  past the call the case is about, so `Within budget` reads `—`. It runs
  until Claude Code stops, which on
  the `recall-*` cases was five to eight calls.

Run `2026-10-18T12-50-07`, ten cases, both lanes, Sonnet 5.5: $0.30 by Claude
Code's own `total_cost_usd`, $0.004 to $0.06 a case. On a subscription that is
plan usage, not an invoice.

- The plugin lane passed 9/10 and the MCP lane 10/10. Every single-turn case
  passed in both lanes.
- `stop-nudge-capture` in the plugin lane searched once on the pasted
  transcript, then made no call after the real Stop hook. The MCP lane, with
  the same text inline, read `capture-this` and saved. One sample each; the
  cell needs repeats before it means anything.
- `stop-nudge-nothing` stayed silent in both lanes, with the Stop hook firing
  in the plugin lane.
- "Let's pick up the BM25 calibration where we left off" ended in
  `claim_todo` in three of four sessions, after a search, a `list_ready`, and
  two or three fetches. A three-round OpenRouter episode cannot reach that
  call.

## The OpenCode harness lane

```sh
VALISE_STATE=.wrangler/evals VALISE_RERANK=off npm run dev     # another terminal, fresh eval store
node evals/run.mjs --harness opencode --case todo-claim,no-tool-chitchat
node evals/run.mjs --harness opencode --models openai/gpt-5.4-mini --case todo-claim
```

Requires OpenCode V2 on `PATH`; tested with installed `opencode v2.1.0`.
`--models` takes `provider/model` IDs, including nested model IDs and optional
`#variant`, not Claude aliases. The default is
`openrouter/openai/gpt-5.4-mini`, using `OPENROUTER_API_KEY`. The subprocess
also accepts `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` for their corresponding
providers. These are supported provider environment connections, not copies of
personal configuration. A saved subscription account alone is insufficient:
the lane neither opens nor imports the personal credential database. No login,
logout, service restart, or configuration change is made for the user.

Each case gets one `opencode+mcp/<provider/model>` column and a fresh private
foreground `opencode serve --hostname 127.0.0.1 --port 0` process. The harness
uses its authenticated V2 session API to submit the turn with the built-in
`build` agent and OpenCode's system prompt. It does not connect to the shared
service. The bootstrap password stays in memory and is never written to a run.

The cwd, `HOME`, all XDG config/data/cache/state/runtime paths and `TMPDIR` are
new private directories, removed after success or failure. Only `PATH` and the
three provider-key variables above are inherited; parent OpenCode session,
server, database, inline-config, plugin and Node-loader variables are not.
`OPENCODE_DISABLE_PROJECT_CONFIG=1` excludes repository instructions, while
the empty private config home excludes global instructions and personal hooks.
The config-source API must report exactly the generated config and its directory;
an unexpected source, including managed/system config, fails the episode rather
than silently altering it.

Only the loopback Valise eval MCP endpoint is configured. The connection uses
the eval agent/client/session headers rather than production OAuth. Native
tools are denied, and `codemode: false` exposes Valise's native
`valise_<tool>` names rather than the default Code Mode catalog. No personal
plugins or MCP servers attach. The harness explicitly connects Valise and
checks that it is the only connected server. It then waits for the observed
`tools/list` handshake to settle before submitting input: v2.1.0 refreshes its
model-visible registry asynchronously after reporting a connection. A connected
server alone is not evidence that the first model turn saw its tools.

Routes come from `mcp_calls` filtered by the fresh session ID and eval agent,
before the private server stops, never from model prose. The same ID is used
for the API session, the `x-valise-session` header, and OpenCode's tool-call
`_meta["ai.opencode/sessionID"]`. Re-seeding, live writes, transcript folding,
and scoring follow the Claude MCP lane. `context` is a generated instruction
file; hook placeholders are inline case text, not real hooks. Tool-replay and
surface-rewriting cases are recorded as skipped, as are `shell` cases, which
depend on Claude's Bash stubs and plugin hooks.

The run header records OpenCode's version. Session messages supply the answer,
model-step count, tokens and cost. Native session totals can include auxiliary
title generation, so they need not equal the primary answer's usage alone.
There is no turn-budget score; a twelve-step safety ceiling marks the row capped,
and a five-minute session wait or incomplete/failed session is an error.
The index and trends keep OpenCode apart from Claude Code and OpenRouter.

Run `2026-10-21T07-29-42`, installed V2.1.0 and the default model: the live
`todo-claim` route and `no-tool-chitchat` control both pass, $0.0074 total.
This is a compatibility smoke, not a model-quality baseline for the full suite.
Deterministic subprocess/API regressions run in `npm run test:clients` and cover
isolation, startup/catalog ordering, session attribution, cleanup, timeouts,
malformed output, connection failures and failed model sessions.

V2 references:
[CLI](https://opencode.ai/v2/docs/cli),
[configuration](https://opencode.ai/v2/docs/config),
[API](https://opencode.ai/v2/docs/api),
[MCP](https://opencode.ai/v2/docs/mcp-servers),
[provider authentication](https://opencode.ai/v2/docs/cli/providers),
[permissions](https://opencode.ai/v2/docs/permissions).

## Retrieval at scale

Memories pile up, with near-duplicates and stale versions. Two measurements
say whether `search` still surfaces the right one: one over the FTS query
alone, and one with a model choosing what to fetch.

Both read the same store, built by `evals/retrieval/corpus.ts` at any size:

- 25 targets from `fixtures/retrieval-memories.json`, each with labelled
  queries;
- a cluster of ten docs-search memories, three of which name a different
  embedding model on a different date;
- then a fixed sequence of generated memories, cut at the size. Most are
  distractors written from `fixtures/retrieval-pool.json`, 1,167 sentences
  taken from this repo's `docs/` on 2026-10-18 and frozen, so a doc edit
  cannot move the numbers. The rest are near-duplicates and superseded
  versions of the targets, at most three of each per target. A superseded
  copy keeps the target's title, moves every number, drops the last
  sentence, and is dated days earlier.

The sequence does not depend on the size, so the store of 500 is the first
500 of the store of 5000. The targets are written in the shape of
`save_memory` arguments, about this repo and three of the owner's other
projects. The to-do asked for real arguments from `mcp_calls`, scrubbed.
That export is a production read this lane has not had, and it would
replace the targets file without a code change.

### The FTS half

Each target has four queries: its exact title, a paraphrase written to
share as few content words with the memory as possible, the first block of
its id, and a natural question with the target's project as a filter. The
test asks whether the target is in the top five of `search`.

```sh
npm run test:d1 -- retrieval                                # 50, in verify
RETRIEVAL_SIZES=50,500,5000 npm run test:d1 -- retrieval --reporter=verbose
```

`verify` runs the 50 store and fails below the floors in
`test/d1/retrieval.worker.test.ts`. The larger stores print their table and
assert nothing. On 2026-10-18, targets in the top five out of 25, and how
many of those ranked first:

| Query | 50 | 500 | 5000 |
| --- | --- | --- | --- |
| Exact title | 25, 24 first | 25, 13 first | 25, 13 first |
| Paraphrase | 20, 8 first | 8, 3 first | 4, 2 first |
| Id fragment | 0 | 0 | 0 |
| Project-scoped question | 21, 15 first | 14, 5 first | 7, 3 first |

- Exact titles hold at 5000. From 500 on, a superseded copy with the same
  title ranks first about half the time, because BM25 favours its shorter
  body and knows nothing of dates.
- Paraphrases do not hold. Once the content words differ, the query falls
  back to ORed terms and matches on whatever filler it shares with 5000
  documents.
- A project filter halves the field and still loses half the questions at
  5000, for the same reason.
- An id fragment never matches. The projection indexes title, body, and
  tags, not the id, so an id is a `fetch`.

### The model half

`retrieval-contradiction-newest` asks which embedding model the docs search
prototype uses. The search a model sends returns the three contradicting
memories, and BM25 ranks the newest last of the three.
`retrieval-contradiction-brief` asks the same with a startup brief
(`fixtures/retrieval-brief.md`) that lists the newest by id. Both expect
`fetch` on the newest id, which `expectArgs` scores as a value rather than
a key. `corpus: true` skips a case unless the run seeds the store:

```sh
node evals/run.mjs --memories 500 --case 'retrieval-*'
```

`--memories N` posts the corpus to `/__dev/memories` after the seed, so the
store hash names the size: `13e1292fcfa6` at 50, `8944e85e249a` at 500,
`0b7b26c3f7b5` at 5000, each seeded upward from `npm run evals:store`. The
report header prints the size, and `npm run evals:trends -- --case
retrieval --min-rows 1` keeps each size in its own cell; a run of 14 rows
is under the default 16-row floor. A route that ends in prose records the
model's `answer`, which is how a snippet-only answer says which hit it
believed.

Runs `2026-10-18T13-59-24` (50), `2026-10-18T14-00-21` (500) and
`2026-10-18T14-01-27` (5000), seven models. Each run sends each case once
per model, so every cell is n=1, and a count like 2/3 below is over the
three sizes, not over repeats. `--repeat 3` on the same command gives each
cell an interval before these numbers decide anything:

- Without the brief, every model that fetched took the newest: Sonnet,
  Haiku, Gemini, Grok and Kimi, at every size. None fetched the first hit.
- The misses are not ranking. gpt-5.4-mini and gpt-6-luna fill every
  optional `search` field, with `project: "*"`, `"docs search prototype"`,
  `"general"`, or `type: "todo"`. The project filter is an exact match, so
  the search comes back empty. gpt-5.4-mini then said nothing was saved
  (3/3); gpt-6-luna searched until the rounds ran out (2/3) and once hit a
  400 from OpenRouter after a parallel tool call the runner does not
  answer.
- With the brief, Sonnet, Haiku, Gemini and Kimi fetched the listed id,
  mostly without searching, and gpt-6-luna did after a search in 2/3. Grok answered "embeddinggemma-300m" from the
  brief's title with no call (3/3), and gpt-5.4-mini searched and answered
  correctly from the snippets (3/3).
- Store size moved nothing here. The queries models wrote
  ("embedding model docs search prototype") share their content words with
  the memories, which is the exact-title regime the FTS half says holds.

### Paraphrased requests

The contradiction cases ask in the memory's own words. Four
`retrieval-paraphrase-*` cases send a fixture paraphrase as the user's
request instead, one FTS alone misses at 5000, and expect a `fetch` of the
target. `retrieval-title-logs` is the control: the same target as
`retrieval-paraphrase-logs`, asked in its own words. Each case allows four
rounds and budgets two turns, a search and a fetch.

```sh
node evals/run.mjs --memories 5000 --case 'retrieval-paraphrase-*,retrieval-title-*'
```

Runs `2026-10-18T15-50-20` (seven models) and `2026-10-18T16-01-05` (Haiku,
Gemini, Grok and Kimi, `--repeat 3`). Over Sonnet, Haiku, Gemini, Grok and
Kimi, 17 episodes per case:

- Models search with the user's words first. When that misses they rewrite
  with a guessed project, a guessed term (`NAS`), or words from the
  snippets they got back.
- The claim, meaning the target or one of its copies, was fetched in 15
  homelab, 10 cost and 8 logs episodes, and 16 of 16 on the control.
- On `dump`, 16 of 17 fetched a docs memory from the pool that states the
  same fact ("Lane 3: the unfiltered export failed..."). The case scores
  that as wrong. Read it as found.
- On `logs`, Sonnet and Haiku fetched the nightly-cron memory, which shares
  the word "nightly". That is a confident wrong answer.
- gpt-5.4-mini and gpt-6-luna miss the control too, on guessed `project`
  filters, as in the contradiction cases.

A row's `args.id`, looked up in `buildCorpus(5000)`, says which memory it
fetched. A copy shares the target's project, type and tags, and its title
keeps only the target's words, which is how `vectors.mjs` finds the claim.

### Would vectors find them

`evals/retrieval/vectors.mjs` ranks the labelled queries three ways against
the seeded store: the live FTS `search`, cosine over embeddings, and the two
fused by reciprocal rank. It counts the exact id in the top five and the
claim in the top five. The embedding models are the two Workers AI serves,
called through OpenRouter, plus `text-embedding-3-large` as a ceiling:

```sh
node evals/run.mjs --memories 5000 --case retrieval-title-logs   # seeds the store
VALISE_DEV_ORIGIN=http://localhost:5173 node evals/retrieval/vectors.mjs --memories 5000 --model baai/bge-m3
```

The claim in the top five at 5000, out of 25:

| Query | FTS | `bge-base-en-v1.5` | `bge-m3` | `text-embedding-3-large` |
| --- | --- | --- | --- | --- |
| Paraphrase, vector | 4 | 7 | 14 | 18 |
| Paraphrase, hybrid | | 10 | 12 | 13 |
| Project question, vector | 9 | 14 | 19 | 20 |
| Project question, hybrid | | 15 | 16 | 16 |

Exact titles hold at 24 or 25 every way. Fusion scores below vectors alone
with the two stronger models, because the FTS half's filler-word matches
take places in the fused top five. Hybrid missed three or four of the four
paraphrases the cases above use, with every model.

ADR-0013 reads these numbers as no to embeddings. A model with FTS reaches
the claim on about three paraphrased requests in four. Neither model
Workers AI serves gets a raw paraphrase to half.

### Would a reranker find them

`evals/retrieval/rerank.mjs` takes the FTS top 50, alone or unioned with the
`bge-m3` top 50, and reranks it with `bge-reranker-base`, Clef and Clef-flash
on Workers AI. It reaches them through the dev server's loopback
`/__dev/rerank` route, which uses wrangler's login, so it needs no Cloudflare
token. Jev runs too when `TYPESAFE_API_KEY` is set; it calls TypeSafe's
`/v1/systemone` directly, 30 documents per call, one `noul` relevance
question each, and ranks by the answer's `noul` field, the probability of
yes. `--rerankers jev` runs only the cells named, and `--depth 10,20,30,50`
sets how many candidates each side contributes, 50 by default. It prints
candidate recall, the top-five table with both runs when they differ, and
latency and cost per search:

```sh
node evals/run.mjs --memories 5000 --case retrieval-title-logs   # seeds the store
VALISE_DEV_ORIGIN=http://localhost:5173 node evals/retrieval/rerank.mjs --memories 5000
```

The claim in the top five at 5000, out of 25:

| Query | FTS | FTS 50 → Clef | FTS 50 → Jev | FTS 50 + `bge-m3` 50 → Clef | FTS 50 + `bge-m3` 50 → Jev |
| --- | --- | --- | --- | --- | --- |
| Paraphrase | 4 | 9 | 9 | 17 | 17 |
| Project question | 9 | 17 | 17 | 22 | 21 |

Each Clef cell equals the share of claims its candidates hold, so a
paraphrase FTS misses entirely stays missed. Jev ties Clef over FTS
candidates in both runs. `bge-reranker-base` scores 9 and 15 over FTS
candidates, at 0.4 s per search against Clef's 1.2 s through the dev proxy.
Jev took 0.45 s median and 0.65 s p95 called directly from a laptop, at
$0.30 per 1000 searches against Clef's $1.86, and sends the candidate bodies
to TypeSafe.

The MCP `search` tool reranks the same way. A dev server with
`TYPESAFE_API_KEY` in `.dev.vars` reranks the FTS top 50 with Jev, as
production does once the secret is set. `VALISE_RERANK=off` forces the FTS
order, and `VALISE_RERANK=fts` reranks with Clef instead. `hybrid` uses Jev
over the FTS/Vectorize memory union and requires the optional vector resources
and a completed backfill. Neither is provisioned by this read-path unit;
ADR-0013 lists the delivery and live-integration gaps. It does not embed the
store on a first search, and the mode-report route rejects an unconfigured
hybrid setup rather than recording lexical fallbacks as union evidence.
The runner refuses to run unless `--rerank` names the
server's mode, records it in the run, and `evals:trends` keeps reranked
cells apart:

```sh
VALISE_STATE=.wrangler/evals npm run dev   # another terminal, key in .dev.vars
node evals/run.mjs --memories 5000 --rerank jev --repeat 3 \
  --models anthropic/claude-sonnet-5.5,anthropic/claude-haiku-5.5,google/gemini-3.8-flash,x-ai/grok-4.3,moonshotai/kimi-k2.6 \
  --case 'retrieval-*'
```

Runs `2026-10-18T21-28-32` (FTS), `2026-10-18T21-19-04` (`fts`, Clef),
`2026-10-18T21-08-12` (`hybrid`, Clef) and `2026-10-19T09-01-51` (`jev`).
The claim was fetched in 28, 37, 45 and 36 of the 45 episodes on `logs`,
`homelab` and `cost`; `logs` alone went 7, 11, 15 and 11. In the Jev run,
122 of 124 searches reranked, in 264 ms median and 403 ms p95, and the other
two had no FTS hit to rerank. None fell back. The call log's
`rerank_json` column says so per search, and the logs tab shows it on the
row. ADR-0013's 2026-10-18 amendment reads these numbers.

#### How deep the candidates go

```sh
VALISE_DEV_ORIGIN=http://localhost:5173 node evals/retrieval/rerank.mjs \
  --memories 5000 --depth 10,20,30,50 --rerankers clef,jev,bge-reranker-base
```

The claim as paraphrase · project question, out of 25, at 5000, two runs per
reranker cell. Recall is the claim anywhere in the candidates; a reranker
column is the claim in its top five:

| Candidates | Mean size | Recall | Clef | Jev | `bge-reranker-base` | Input tokens, Clef · Jev · bge | Median ms, Clef · Jev · bge | Per 1000 searches, Clef · Jev · bge |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| FTS 10 | 8 | 6 · 11 | 6 · 11 | 6 · 11 | 6 · 11 | 1,869 · 1,839 · 939 | 313 · 241 · 261 | $0.45 · $0.077 · $0.0029 |
| FTS 10 + `bge-m3` 10 | 15 | 15 · 20 | 15 · 20 | 15 · 20 | 14 · 17 | 3,395 · 3,166 · 1,738 | 413 · 241 · 256 | $0.81 · $0.13 · $0.0054 |
| FTS 20 | 15 | 7 · 14 | 7 · 14 | 7 · 14 | 7 · 13 | 3,338 · 3,121 · 1,730 | 459 · 244 · 298 | $0.80 · $0.13 · $0.0054 |
| FTS 20 + `bge-m3` 20 | 31 | 16 · 20 | 16 · 20 | 16 · 20 | 12 · 16 | 6,926 · 6,431 · 3,652 | 764 · 480 · 365 | $1.66 · $0.27 · $0.011 |
| FTS 30 | 21 | 9 · 15 | 9 · 15 | 9 · 15 | 9 · 15 | 4,807 · 4,402 · 2,514 | 642 · 259 · 347 | $1.15 · $0.18 · $0.0078 |
| FTS 30 + `bge-m3` 30 | 46 | 17 · 20 | 17 · 20 | 17 · 20 | 12 · 14 | 10,453 · 9,485 · 5,547 | 1,097 · 507 · 480 | $2.51 · $0.40 · $0.017 |
| FTS 50 | 34 | 9 · 17 | 9 · 17 | 9 · 17 | 9 · 15 | 7,770 · 7,175 · 4,107 | 1,141 · 501 · 420 | $1.86 · $0.30 · $0.013 |
| FTS 50 + `bge-m3` 50 | 78 | 17 · 22 | 17 · 22 | 17 · 21 / 17 · 22 | 11 · 14 | 17,657 · 16,202 · 9,493 | 1,280 · 855 · 687 | $4.24 · $0.68 · $0.030 |

Clef and Jev match recall in every cell; the one run disagreement is Jev on
project questions over the union at 50. The union keeps 50 per side: 10, 20
and 30 all stop at 20 project questions against 22, so none is within one
hit of 50. That costs $4.24 per 1000 searches with Clef, $0.68 with Jev.
ADR-0013's 2026-10-19 amendment reads these numbers.
## Plain-language replies

A hook entry can change how a model writes, not only which tool it calls,
and `run.mjs` cannot see that. `evals/plain.mjs` scores the reply instead.

```sh
node evals/plain.mjs                              # every case, 3 repeats
node evals/plain.mjs --case adr-0002-lease --repeat 1
node evals/plain.mjs --model sonnet --judge opus  # defaults: opus, sonnet
```

Each case in `evals/plain/cases.json` is a document from this repo and a
question from a user who has not read it. Documents dense with internal names
are the point: PR bodies in `evals/plain/` and ADRs in `docs/adr/`. Every
case runs through headless Claude Code twice, with the harness lane's
isolation flags. The `control` arm has no hooks. The `rule` arm gets
`cases.json`'s `rule` as SessionStart `additionalContext` through
`--settings`, which is how the Valise hook delivers a custom entry. A judge
model then lists the names the reply used without explaining them and the
references this reader could not resolve, and says whether the first
paragraph answers the question. It needs no dev server or store.

Runs go to `evals/runs/plain/`, outside the index, because the console's
evals tab reads tool-choice scores. A full run is 24 replies and 24
judgements, about $10 on the subscription.

Run `2026-10-18T20-59-39` put the rule in the hooks as entry `custom-0`. It
cut undefined terms from 13.8 to 11.3 per reply, fewer on every case, and
answered first 11 of 12 times against 9. Vague references stayed at 5.8 and
replies grew from 423 to 498 words, since defining a term takes words. A
rewording of the rule is a change to `cases.json`'s `rule` and a rerun.

## From a change to a verdict

A description, a nudge line, a hook text, or a new tool is a hypothesis
about what a model will do. The loop below is how it becomes a number, and
how the number becomes the next change. It runs when the owner asks for a
measurement, or to investigate a tool-choice regression `mcp_calls` shows; a
change does not need it to merge (ADR-0003, amendment of 2026-11-15). It is short on purpose; the step
most often skipped is the first one.

1. **Read the routes before writing anything.** `npm run evals:trends -v`
   prints every cell's pass rate across the runs on disk and the wrong
   endings behind it. A cell that fails once is a sample. A cell that fails
   the same way across runs is a finding. Open the per-run JSON for that
   cell and read the arguments and the route, because the fix for "searched
   first" is not the fix for "answered in prose". Sort what you find into
   three bins: the runner scored a good route as a miss, the text under test
   did not land, or the model is the outlier. Only the middle bin is a
   Valise change.

2. **Write the case before the change.** A new tool or a reworded line gets
   its case in `cases.json` first, with `why` saying what the case measures
   and, where the point is a contrast, its control: the same turn without
   the text, the same session with nothing worth saving. A case with no
   control measures nothing (`recall-reminder` against `recall-control`;
   `stop-nudge-capture` against `stop-nudge-nothing`). Run the suite once
   before the change so the baseline is a recorded run, not a memory.

3. **Change one thing, and say which.** One description, one nudge line, one
   schema field. Two changes in one run cannot be told apart in the table.
   Pass `--note` with the change under test, because the tool hash says
   that something changed and not what.

4. **Run, and read the trend, not the run.** `npm run evals` for the whole
   suite, so a change aimed at one cell shows what it did to the others.
   Then `npm run evals:trends` again. A moved cell counts when it moved on
   more than one model, or on one model across repeats; a single cell on a
   single run is inside the noise the trends output shows you. A change
   that removes a read before the right call moves `Within budget` and the
   trends turns line, not pass. The runner
   refuses a stray skill, so the tool hash moves only with the text under
   test; the store hash should match the baseline's, because a row added
   to the store is a different search result.

5. **Check against the clients.** The suite scores descriptions in a vacuum.
   The logs tab, and `mcp_calls` behind it, record what the real clients
   did with the same tool: per-tool counts split by plugin header, the
   arguments they built, the errors. A description change that moves the
   eval and not the log has moved the eval. The research note of
   2026-10-18 carries one such gap: the capture skill was read six times
   in a week against 37 real saves, where the suite's cued prompt reads it
   before 90 of 103.

6. **Record the verdict, then ship with the run.** `npm run evals:verdict`
   marks the baseline, the run that justified the change `kept`, and every
   trial that did not ship `dropped`. The pull request carries the code and
   the case, and names the run stamps and their counts; the runs and
   `notes.json` stay local under `evals/runs/`. The ADR
   the tool belongs to gets an amendment naming the case (ADR-0003 does this
   for `todo-list-blocked`). A dropped run is a dead end on the tab already;
   save it as a memory too, with the stamp and the wording, when the reason
   it failed is worth more than the marks.

7. **Delete what stopped measuring.** A case every model passes on every
   run is a regression guard, and worth keeping only when the tool it guards
   still changes. A case whose premise moved with the product
   (`todo-update-needs-claim` changed its expected tool when `comment_todo`
   landed) gets rewritten, not left to pass for the wrong reason.

What the loop does not do yet, and the to-dos tagged `evals` that would
close each gap:

- Score the body a model wrote rather than the keys it filled.
- Isolate the harness lane with `--bare`, which needs `ANTHROPIC_API_KEY`.
  The lane isolates with `--setting-sources`, `--tools` and
  `--strict-mcp-config` instead, and only Claude Code is covered, not Codex.
- Send distractors through the harness lane, as real servers in
  `--mcp-config`.
