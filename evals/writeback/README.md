# Selective writeback and fresh-agent execution

This lane measures J4 in `docs/testing/user-journeys.md`: Agent A writes back
what the next session needs, and a fresh Agent B resumes and executes the
allowed step. The to-do is `todo:tdo_6d92f8c4-762c-4c32-b31e-056a0c826daa`.
How to run it and what it costs are in
[`../outcomes/README.md`](../outcomes/README.md#write-capable-lane-agent-a-writes-back-fresh-agent-b-executes).
The read-only lane in `../outcomes/` is unchanged, and the two lanes' scores
are never pooled.

## Modules

| File | Holds |
| --- | --- |
| `core.mjs` | Scenarios, prompts, the fault gateway, the scorer and the budget |
| `harness.mjs` | Loopback MCP client, the episode loop, the checksum executor |
| `store.mjs` | Seeding through MCP and the SELECT-only observer |
| `case.mjs` | One closed loop: seed, A, snapshot, B, snapshot, score |
| `scripted.mjs` | Provider-free A and B policies, good and failing variants |
| `run.mjs` | The command: `--dry-run` or a paid model run |
| `summarize.mjs` | Per model and arm, the pass rate of each criterion |
| `handoff.mjs` | Per model and arm, what A's to-do carried and what B sent |
| `client.mjs` | The same loop with A and B as real `claude -p` sessions |
| `executor-server.mjs` | The checksum executor as a stdio MCP server for a real client |
| `client-summary.mjs` | Per model and arm, what `client.mjs` runs persisted and executed |

`run.mjs` and `test/evals/writeback.test.mjs` both call `runCase`. The tests
swap in an in-memory store; the dry run uses a real local Worker.

## Fixture

Each case seeds, in its own project, a deployment to-do blocked on
`vendor-signoff` and an unrelated to-do claimed by another agent. Both are
protected: their rows, history and projection must not change. The first case
in a store also publishes 64 synthetic skills. The `matching` case seeds one
preliminary memory and one pending to-do for A to revise. Nothing comes from a
private corpus.

| Case | Required behavior |
| --- | --- |
| `new` | Save one scoped insight and one to-do with the next step, blocker and file ref. B executes. |
| `approved-decision` | Save a `decision` attributed to the synthetic owner Mira. B executes. |
| `matching` | Revise the seeded memory (revision advances) and update the seeded to-do. No duplicate. B executes. |
| `lost-receipt` | The first `save_memory` commits but its response is lost. Check the store, do not retry, report the real ID. B executes. |
| `refused-write` | Every write is refused before dispatch. Store unchanged, no IDs reported. |
| `ephemeral` | A status ping. No writes. |
| `arithmetic` | 17 + 25. No tool calls; answer 42. |

## Scoring

The observer reads `memories`, `todos`, `memory_revisions`, `todo_updates`,
`todo_comments` and `search_docs` through Local Explorer, then fetches and
searches each record over MCP. It waits until the rows hold still for three
seconds, because the coordinator mirrors a claim or completion into D1 a second
or two after the call returns.

A capture case passes only when all of these hold:

- one memory and one to-do in the project, with the right type and content
- the to-do is pending, references `fixtures/payload.txt`, names
  `checksum-check` and `vendor-signoff`
- both records are current in the projection and found by MCP search
- the IDs each agent reports equal the records that actually changed
- nothing outside the project and nothing protected changed
- B fetched both records, claimed the to-do, ran `run_checksum_check` under
  its live claim, and completed the to-do with the receipt digest
- B left the memory as A saved it

The executor accepts only the allowed task, the step `checksum-check` exactly,
and SHA-256 in any spelling (`sha256`, `SHA256`, `SHA-256`), recorded as
`sha256`. A rejection names each wrong field and the value sent, never the
accepted value, so B learns where to look without being handed the step. It
re-reads the claim before hashing, writes the receipt once, and re-hashes the
input to verify it. No shell, path or network is exposed.

An agent's final answer is bare JSON or prose ending in a fenced JSON block;
the last fence counts. Nothing looser parses: a JSON object inside a sentence
is not an answer.

The injected arm adds the shipped Stop text after an answer only when the
hook would: the episode called a tool and called no Valise write tool
(`captureDue` in `valise-hook.mjs`). It assumes the Stop lands on a due turn
of the cadence. When it fires, the run is scored on the answer given before
the reminder, which is the one the user saw, with the persisted IDs of both
answers. `resultOnFinalMessage` keeps the score on the reply to the reminder,
and `summarize.mjs <dir> final` tabulates it.

Fault events stay in the report and never reach either agent.

## Failure variants

Each variant has to fail, both in the unit tests and in a dry run against the
real Worker.

| Variant | Case | Caught as |
| --- | --- | --- |
| `--a-variant chatter` | `ephemeral` | unexpected durable write |
| `--a-variant retry-after-lost-receipt` | `lost-receipt` | duplicate finding |
| `--a-variant no-verify` | `lost-receipt` | reported IDs differ from actual changes |
| `--a-variant duplicate` | `matching` | duplicate finding and to-do |
| `--b-variant no-execution` | `new` | no verified execution artifact |
| `--b-variant override-blocker` | `new` | B changed protected work |

`override-blocker` shows a product fact: `claim_todo` on a manually blocked
to-do reopens it. The blocker holds only if the agent honors it, which is why
the scorer checks the protected rows rather than trusting the claim to fail.

## Real client

`client.mjs` runs one case with Agent A and a fresh Agent B as separate
Claude Code processes, each in its own temporary checkout holding only
`fixtures/payload.txt`, against a fresh loopback store:

```sh
node evals/writeback/client.mjs --serve 4741 --case new --arm hooked \
  --model sonnet --output <dir>/sonnet-hooked-new-r1.json \
  --ledger <dir>/ledger-sonnet.json --max-cost 1.5 --session-cap 0.40
node evals/writeback/client-summary.mjs <dir>
```

`--arm hooked` loads `clients/valise` with `--plugin-dir`, so Claude Code
fires the shipped SessionStart and Stop hooks itself; `hookless` loads no
plugin. `--strict-mcp-config` and `--setting-sources project` keep the
user's own plugins, hooks and MCP servers out. The hook gets an empty
temporary config, no token and the loopback origin. B also gets the
executor through `executor-server.mjs`. The fault cases need the OpenRouter
lane's transport gateway and are refused. The ledger reserves `--session-cap`
before each session and settles to Claude Code's reported `total_cost_usd`.

## Proof boundary

A dry run proves the harness, the fault injection and the scorer against the
real Worker. It says nothing about how a model behaves. `run.mjs` model runs
use OpenRouter sessions, not a real client's lifecycle; `--arm injected`
pastes the shipped hook text and is labeled as such. `client.mjs` runs the
real Claude Code lifecycle, hooks included, but on the loopback development
identity with the MCP server registered by the runner. Deployed OAuth and the
browser review stay with the J4 milestone,
`todo:tdo_125a5a13-e461-4ef6-b121-117496a5387d`.

The [2026-10-25 focused attempt](2026-10-25-focused-attempt.md) records the
first runtime try, which never reached MCP.
The [first paid run](../runs/writeback/2026-10-25-first-paid.md) scored no
capture case end to end; `summarize.mjs` rebuilds its tables from the run files,
and `summarize.mjs <dir> rescore` scores them again with the current scorer.
The [second round](../runs/writeback/2026-10-25-round-2.md) reran the matrix
after the harness and guidance fixes; Sol passed 3 of 8 capture cases end to
end, the cheap models 1 of 48.
The [third round](../runs/writeback/2026-10-26-round-3.md) asked for step
identifiers as given and never an invented command; no cheap model saved a
shell command, Luna's and GLM's B ran the step in 17 of 24 runs, and Haiku
paraphrased the step instead. `handoff.mjs <dir>` tabulates that handoff:
verbatim steps, shell commands, what B sent, missing memories and Stop
firings.
The [fourth round](../runs/writeback/2026-10-29-real-client.md) ran real
Claude Code sessions. A fresh Sonnet B resumed, ran `checksum-check` and
completed the to-do from durable context in 3 of 4 hooked chains and 0 of 4
hookless; Haiku's A tried to run the check itself and left no usable to-do.
No B touched the blocked deployment.
The [fifth round](../runs/writeback/2026-11-01-real-client.md) counted
claims and completions as persisted and told A that its session does not run
the check. Sonnet passed strict scoring in 8 of 8 chains, hooked and
hookless; Haiku's A stopped running the step but still wrote to the blocked
deployment in 6 of 8.
