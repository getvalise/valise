# Multi-model handoff baseline, hooked and hookless

This is half of a matched comparison. The baseline ran in full on two models
and in part on a third. The candidate half has not run yet: the OpenRouter key
reached its $100 limit during the Gemini baseline. Every request after that
returned "requires more credits", which is recorded as an episode error. No
rate in this file shows whether PR #221 improved handoffs.

## Design, fixed before the paid runs

| | |
|---|---|
| Baseline | main `e1c3404`, the parent of PR #221 |
| Candidate | main `18a8593`, PR #221 merged (not run) |
| Store | one fresh store per head, 64 synthetic skills, the fixture in `fixtures.mjs` |
| Arms | `hookless`; `reminder`, the reminder text only, as on 2026-10-24; `hooked`, the shipped hook's own SessionStart output (reminder plus the `/config/brief` it cached) |
| Models | gpt-5.4-mini, claude-haiku-5.5, gpt-6-luna, gemini-3.8-flash |
| Repeats | 3 per case and arm, 45 episodes per model and head |
| Caps | `--max-cost` 0.35 for Mini and Gemini, 0.15 for Haiku and Luna; $2.00 for all outcome runs |

Every run used the same runner and scorer. Each artifact records the source
hash, the fixture hash, the tool hash, the hooked text and its hash. The hooked
text is injected into the system prompt, so it shows what the hook prints, not
how a client delivers it.

## Baseline results on `e1c3404`

| Model | Arm | Outcomes | Missed blockers | Extra searches | Invented cursors | Calls | Cost | Episode errors |
|---|---|---|---|---|---|---|---|---|
| gpt-5.4-mini | hookless | 11/15 | 0 | 5 | 0 | 22 | $0.0496 | 0 |
| gpt-5.4-mini | reminder | 5/15 | 0 | 19 | 0 | 42 | $0.0786 | 0 |
| gpt-5.4-mini | hooked | 9/15 | 0 | 6 | 0 | 29 | $0.0490 | 0 |
| gpt-6-luna | hookless | 14/15 | 0 | 1 | 0 | 34 | $0.0106 | 0 |
| gpt-6-luna | reminder | 8/15 | 0 | 6 | 0 | 48 | $0.0130 | 0 |
| gpt-6-luna | hooked | 4/15 | 1 | 6 | 0 | 45 | $0.0117 | 0 |
| claude-haiku-5.5 | hookless | 8/15 | 2 | 3 | 0 | 42 | $0.0879 | 0 |
| claude-haiku-5.5 | reminder | 2/8 | 3 | 3 | 0 | 37 | $0.0626 | 0 |
| gemini-3.8-flash | all arms | 1/45 | — | — | 0 | 21 | $0.1958 | 42 |

Haiku reached its $0.15 cap after 23 episodes. Its reminder arm is partial and
its hooked arm did not run. Gemini cost $0.065 an episode, mostly in reasoning
tokens. Its three completed episodes are not a sample, and its 42 errors are
credit refusals, not model behavior.

| Case | Mini hookless | Mini reminder | Mini hooked | Luna hookless | Luna reminder | Luna hooked | Haiku hookless | Haiku reminder |
|---|---|---|---|---|---|---|---|---|
| resume | 2/3 | 0/3 | 0/3 | 2/3 | 0/3 | 0/3 | 1/3 | 0/3 |
| latest-decision | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 0/3 | 0/3 | 0/3 |
| completion-window | 0/3 | 0/3 | 0/3 | 3/3 | 3/3 | 3/3 | 2/3 | 2/2 |
| known-id | 3/3 | 2/3 | 3/3 | 3/3 | 0/3 | 0/3 | 2/3 | — |
| no-recall | 3/3 | 0/3 | 3/3 | 3/3 | 2/3 | 1/3 | 3/3 | — |

## What the baseline shows

On the baseline head, every resume episode with injected context failed: Mini
and Luna 0/6 each across reminder and hooked, Haiku 0/3 with the reminder.
Hookless resume passed 5/9. In the hooked arm the brief shows the saved task
with its first sentence only, "Parser already implemented at commit abc1234;
unit tests 18/18." The models answered from that line with `resume-rollout`,
`integration-test` or `deploy_after_vendor_signoff`. PR #221 adds the second
sentence, so this is the cell the candidate run has to move.

Mini's completion window fails 0/9 in every arm, and it fails the same way each
time. Mini calls `list_todos` with `completed_since` only and reports three
IDs, including the task completed exactly at the window's end, because the
baseline has no upper bound to pass. Mini sent no cursor on this head, so the
cursor invention from 2026-10-24 did not reproduce. The candidate's
`completed_before` is what this cell tests.

The scorer was not changed, and several misses are exact-format misses on
correct substance. Luna's hooked `latest-decision` answers say `SHA-256`
against the expected `sha256`. Its hooked and reminder `known-id` answers put
prose after `integration-check`. Haiku put its reasoning in the `decision`
field instead of the algorithm name. These count as failures, as they did
before.

Injected text also hurts the arithmetic control. With the reminder, Mini
called tools on arithmetic in 3/3 episodes. With the hooked text, Luna called
tools in 2/3. Compared with the reminder, the hooked arm cut Mini's extra
searches from 19 to 6, but did not reduce Luna's. No episode attempted a
write. Mini missed no blocker. Luna missed one, in the hooked arm, and Haiku
missed five.

## Spend

| Item | Cost |
|---|---|
| Tool-choice evals for PR #221 (`2026-10-29T09-12-52`, `09-15-59`) | $0.50 |
| Hooked-arm smoke episode (deleted) | $0.0024 |
| Baseline outcome runs in this file | $0.5590 |
| Total | about $1.06 of the $4 allowance |

## Finishing it

The candidate half needs the key's limit raised. Gemini should be dropped:
at $0.065 an episode, 90 episodes would cost about $5.90. Finishing Haiku costs
about $0.45, covering its 22 missing baseline episodes and its 45 candidate
episodes. Mini and Luna on the candidate cost about $0.22. On a fresh store,
with the server started as `TOKEN_PEPPER=<value>`:

```sh
VALISE_TOKEN_PEPPER=<value> node evals/outcomes/run.mjs \
  --endpoint http://localhost:<port>/mcp --label cand-18a8593-mini \
  --revision 18a8593 --model openai/gpt-5.4-mini --repeat 3 \
  --arms hookless,reminder,hooked --max-cost 0.35
```

Artifacts under `evals/runs/outcomes/`:

- `2026-10-29T10-21-29.214Z-base-e1c3404-haiku.json`, stopped at its cap
- `2026-10-29T10-24-26.923Z-base-e1c3404-luna.json`
- `2026-10-29T10-32-07.267Z-base-e1c3404-mini.json`
- `2026-10-29T10-34-55.802Z-base-e1c3404-gemini.json`, 42 credit errors
- `fixture-5391.json`, the store's ID mapping
