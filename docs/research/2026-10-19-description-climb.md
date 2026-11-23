# Rival description trials

Date: 2026-10-19
Tickets: `todo:tdo_23a87217-efe9-487f-86a2-3b772972ca9a` and
`todo:tdo_19f44a6e-0ef5-46cf-a4f5-fd54eac896fc`

## Conditions

Existing OpenRouter credentials were present. Tiny probes reached
`openai/gpt-5.4-mini` and `x-ai/grok-4.3`. The model registry listed the four
models used below. The Claude CLI reported an existing subscription login, but
`evals/run.mjs` refuses `--harness claude --distractors 20`. The OpenRouter lane
therefore measured the actual rival-tool condition. No login, credential,
account, billing, or infrastructure changes were needed.

All rival trials used the isolated worktree store on
`http://localhost:5185/mcp`, reranking off, `--distractors 20 --repeat 3`.
Baselines used tools `01534742f089`, store `b7467a0bd162`, and distractors
`e5a4b0e718b8`. Every candidate changed one tool description by one appended
sentence. The other descriptions, schemas, and skill body stayed at baseline.
The runner snapshots `tools/list` before its model calls. Later candidates
could run while an earlier run finished because those tool lists were already
fixed. No candidate executed a write.

The seven-model baseline in the ticket was reduced to two initial models and
targeted supplements. That supplied two historically affected models per
description without paying for every model on every case. It is not the
requested seven-model matrix.

## Baselines

| Run | Cases | Models | Passing rows |
| --- | --- | --- | --- |
| `2026-10-19T20-10-38` | Five losing cases | Grok, Luna | 7/15, 10/15 |
| `2026-10-19T20-10-53` | `recall-control` | Mini | 0/3 |
| `2026-10-19T20-12-53` | Two memory and two to-do cases | Kimi | 10/12 |

These focused rows pass 27/45, or 60%. This is not a full-suite +20 pass rate.
Grok picked `remember` on both memory cases in all six episodes. Luna picked
`create_issue` on `todo-create` in all three. Luna's recall-control passed 1/3
and Mini's 0/3. Kimi passed memory-preference 1/3, memory-decision 3/3, and both
to-do cases 3/3. Historical losses do not imply a model must still lose today.

## Candidate sentences

Each sentence below was appended to the shipped description independently,
not accumulated with another candidate.

| Tool and run | Sentence |
| --- | --- |
| `save_memory`, `2026-10-19T20-12-14` | Use this for the shared workspace's memory of the user and their work in future conversations. |
| `save_memory`, `2026-10-19T20-13-17` | Returns a `memory:mem_<id>` id that any connected client can fetch. |
| `search`, `2026-10-19T20-11-46` | Retrieve stored context at the start of a task or when earlier decisions, preferences, or insights might help. |
| `search`, `2026-10-19T20-12-17` | Returns shared-workspace skill:, memory:, and todo: ids, including work saved by other clients. |
| `create_todo`, `2026-10-19T20-13-52` | File tickets for the shared workspace's agents here, not in an external team's issue tracker. |

## Results and stopping points

| Tool and case | Model | Baseline | Purpose sentence | Id sentence |
| --- | --- | --- | --- | --- |
| `save_memory`, memory-preference | Grok | 0/3 | 0/3 | 0/3 |
| `save_memory`, memory-decision | Grok | 0/3 | 0/3 | 0/3 |
| `save_memory`, memory-preference | Kimi | 1/3 | 2/3 | 0/3 |
| `save_memory`, memory-decision | Kimi | 3/3 | 3/3 | 3/3 |
| `search`, recall-control | Luna | 1/3 | 0/3 | 1/3 |
| `search`, recall-control | Mini | 0/3 | 2/3 | 1/3 |

Neither sentence improves both models on either description. Grok never left
`remember`. The search purpose sentence also loses Luna's baseline pass, and
one of Mini's two accepted endings is `list_ready`, not `search`. Both
descriptions stop after two reversions. Their rival sentences do not ship.
The single-repeat historical trials remain unresolved by themselves. These
repeat-3 trials reject these particular sentences, not all possible rewrites.

The `create_todo` purpose sentence passes 12/12. Luna's `todo-create` changes
from 0/3 to 3/3. Kimi stays at 3/3, so this is a promising single-model move,
not improvement on two models. The sentence remains an experiment. No full
+0 regression ran on it, and the to-do climb did not reach two reversions.
That work remains on the existing ticket, not a second queue.

No rival sentence is retained in shipped descriptions. The `save_memory`
human-approval correction is a separate capture-quality experiment, not a
claim of victory over `remember`. No dead-end memories were written to
production. The committed runs and this file retain the evidence instead.

The twelve stream-5 tool-choice runs, including capture baselines, treatment,
and regression, contain 173 rows at $0.527801 by the recorded provider usage.
That excludes the two tiny access probes. Per-tool hashes confirm that each
of the five rival trials changes exactly its named tool and keeps the baseline
store hash. All five have two models, three repeats, and twenty distractors.

## Commands

Prefix these commands with `VALISE_MCP_URL=http://localhost:5185/mcp`.
The candidate note in each run records the exact sentence.

```sh
node evals/run.mjs --models x-ai/grok-4.3,openai/gpt-6-luna --case memory-preference,memory-decision,recall-control,todo-create,todo-facet --distractors 20 --repeat 3
node evals/run.mjs --models openai/gpt-5.4-mini --case recall-control --distractors 20 --repeat 3
node evals/run.mjs --models moonshotai/kimi-k2.6 --case memory-preference,memory-decision,todo-create,todo-facet --distractors 20 --repeat 3
node evals/run.mjs --models x-ai/grok-4.3,moonshotai/kimi-k2.6 --case memory-preference,memory-decision --distractors 20 --repeat 3
node evals/run.mjs --models openai/gpt-6-luna,openai/gpt-5.4-mini --case recall-control --distractors 20 --repeat 3
node evals/run.mjs --models openai/gpt-6-luna,moonshotai/kimi-k2.6 --case todo-create,todo-facet --distractors 20 --repeat 3
```

## Completion, 2026-10-20

Run `2026-10-20T11-46-03` completes the requested seven-model baseline on
current main plus the explicit-human-approval capture guidance: Haiku, Luna,
Mini, Gemini, Grok, Kimi and Sonnet; five losing cases, +20 distractors, three
repeats. Tools `d1451f8600f0`, store `a1fc5cb45656`, 105 rows, $0.7474.
It is a new surface (17 tools), not a missing sample to pool into yesterday's
15-tool baseline.

The focused +20 pass rate is 77/105 (73.3%), including one provider error and
one capped Gemini route. It is not a full-suite pass rate. The two to-do cases
pass 42/42; Luna's historical `create_issue` loss does not reproduce. Grok still
chooses `remember` on both memory cases, and recall-control still loses to
`recall` on several models. The historical save/search clauses remain rejected,
not proven remedies on this newer surface.

Two current-surface to-do trials complete its stopping rule:

| Run | Appended sentence | Luna create / facet | Kimi create / facet | Verdict |
| --- | --- | --- | --- | --- |
| `2026-10-20T11-46-03` | None, baseline | 3/3 / 3/3 | 3/3 / 3/3 | Baseline |
| `2026-10-20T11-44-42` | File tickets for the shared workspace's agents here, not in an external team's issue tracker. | 3/3 / 3/3 | 3/3 / 3/3 | Revert: no gain |
| `2026-10-20T11-46-09` | Returns a todo:tdo_<id> ticket that another connected agent can claim. | 2/3 / 3/3 | 3/3 / 3/3 | Revert: one `create_issue` loss |

Run stamps mark completion, so the seven-model baseline finishes after the
shorter purpose trial. The runner captured each actual `tools/list` before
calling models; only `create_todo` differs in each candidate's per-tool hashes.
Both candidates retain the baseline store, distractors and repeat count. Neither
sentence remains in the source. Two consecutive reversions end the to-do climb;
no kept rival step requires a +0 promotion regression.

Each rejected save/search clause was saved as a separate insight with its run
stamp on 2026-10-20, as the ticket requested. The to-do dead ends are recorded
the same way. The result is a completed bounded experiment with no winner, not
a claim that all rival-tool confusion has been solved.
