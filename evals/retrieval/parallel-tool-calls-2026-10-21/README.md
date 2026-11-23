# Parallel-call protocol repair, 2026-10-21

PR145 recorded four OpenAI retrieval episodes failing with `400 No tool output
found for function call`: Luna dump repeats 1 and 2, Luna cost repeat 0, and
Mini logs repeat 1. Its Gemini 504s are separate provider failures. The old
episode selected `message.tool_calls[0]`, replayed the entire assistant message,
and answered only that first call.

## Deterministic reproduction

`test/evals/episode.test.ts` supplies a completion with two real read requests.
Its next-request validator returns the same 400 unless both original IDs have
exactly one actual output. The extracted original loop failed this test before
the repair. Local red log:
`/private/var/folders/75/p5ymw8gs2nl_ww1fkqkvytlc0000gn/T/opencode/valise-tool-calls-red.log`.

The regression suite also covers assistant/reasoning preservation, first-terminal
selection, unexecuted fetches and terminal siblings, unread skill prerequisites,
caps, retained pre-error route/usage, actual MCP error results, transport failure,
fixtures, malformed non-first arguments and missing/duplicate call IDs.

```sh
npm run test:clients -- episode
```

The repaired loop appends every actual output before another model request. It
never fills gaps with invented results. A batch containing a terminal request
ends without execution, preserving fetch-choice semantics. The first terminal
request in provider order is scored; later favourable siblings cannot rescue it.
All requested calls and exact arguments remain in `routeCalls`, including on
errors, with explicit execution status and model-round grouping. `endingIndex`
selects the scored call independently of the full route's last sibling.

## Bounded live smoke

Only a separate local eval store was used, on port4516 with `VALISE_RERANK=off`.
The same checked-in 5,000 corpus gives tool hash `d1451f8600f0` and store hash
`96f8afe18b7e`, matching the rollout report. This smoke uses lexical retrieval,
not the deleted remote eval index or hybrid. It does not clear the vector
activation gate or replace affected hybrid repeats.

```sh
VALISE_MCP_URL=http://localhost:4516/mcp node evals/run.mjs --memories 5000 \
  --models openai/gpt-6-luna \
  --case retrieval-paraphrase-dump,retrieval-paraphrase-cost
VALISE_MCP_URL=http://localhost:4516/mcp node evals/run.mjs --memories 5000 \
  --models openai/gpt-5.4-mini --case retrieval-paraphrase-logs
```

Raw reports `2026-10-21T09-23-14` and `2026-10-21T09-23-28` are retained here.
All three affected-case smoke episodes have zero provider/protocol errors, but
strict scores remain 0/3: both Luna routes cap after four search rounds; Mini
searches three times and answers in prose rather than requesting the target
fetch. These episodes did not naturally request parallel calls. Their retained
OpenRouter accounting is $0.005713305. There is no pass-rate improvement claim.

`parallel-mini-smoke.json` is one additional synthetic protocol probe through
the real Mini provider and the same local MCP store. Its complete prompt is
recorded, explicitly requesting two independent searches together, followed by
a fetch choice. The provider requested two searches in round0, both executed
for real, then successfully continued with another search in round1 and prose
in round2. There was no missing-output error, and all three call IDs/arguments
are retained. It did not request the final fetch, so this is successful batch
continuation evidence, not a passed retrieval case. Reported cost: $0.00205815.

The four smoke episodes total $0.007771455 in retained OpenRouter accounting.
No broad suite, production store, vector resource, runtime or configuration was
changed. Focused artifacts stay outside `evals/runs/`; the console's full-run
index and notes remain byte-for-byte unchanged. Historical routes and errors
are not rewritten to invent the calls they omitted.
