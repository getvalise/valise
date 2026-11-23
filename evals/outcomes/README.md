# Cross-agent handoff outcomes

The [current-main comparison](2026-10-24-current-main.md) records a 19/30
baseline against 17/30 for the orientation candidate, with failures retained.
The [2026-10-29 multi-model baseline](2026-10-29-multi-model-baseline.md) adds
the hooked arm on three models; its candidate half is not yet run.

`run.mjs` starts each model episode with an empty conversation, a user request,
the live MCP tool surface, and, per arm, nothing, the shipped SessionStart
reminder, or the shipped hook's whole SessionStart output.
The previous agent's task progress exists only in the store. Reads execute
against the Worker through MCP, including every parallel tool call. An answer
is scored after the reads finish, not when a tool is chosen.

```sh
npx wrangler d1 migrations apply DB --local --persist-to .wrangler/outcomes
VALISE_STATE=.wrangler/outcomes VALISE_RERANK=off npm run dev -- --port 5291 --strictPort
# In another terminal, with OPENROUTER_API_KEY:
node evals/outcomes/run.mjs --label baseline --revision "$(git rev-parse HEAD)" --repeat 3
node evals/outcomes/report.mjs evals/runs/outcomes/*-baseline.json
```

Use a dedicated empty state directory and a distinct port per server revision.
`--endpoint http://localhost:5292/mcp` compares another checkout; `--revision`
must name that server's commit, not the runner's. The runner records both, its
source hash, the tool surface/hash, fixture/hash, full messages, results,
arguments, answers, and provider usage. It checkpoints after every episode.
No outcome runs enter the existing tool-choice index.

Setup uses the real MCP write tools and coordinator to create seven tasks,
two conflicting decisions, and 64 published skill procedures. One task has
durable progress from an earlier agent: parser done, integration check remains.
Another is blocked on vendor signoff. Four completions bracket a fixed UTC
window, including its exact lower and upper boundaries; `updated_at` is
deliberately unrelated to completion time. SQL through Local Explorer pins
timestamps after coordinator mirrors settle; no state transitions bypass the
coordinator. Searchable bodies and projections use the normal write paths.

The fixture manifest records generated IDs and is reused for repeats. An
unrecognized nonempty store is refused. For a fresh comparison, stop the server
and choose a new state directory and port. Do not point this at a developer's
existing store. Only loopback endpoints are accepted.

## Measures

Five cases cover unknown-task resumption, the latest decision, exact completion
sets in `[since, until)`, direct-ID recovery, and arithmetic with no recall.
Answers use a common JSON envelope, without supplying the expected values.
Exact IDs, short action identifiers present in evidence, blocker identifiers,
algorithm names, and completion sets make scoring deterministic without a paid
judge. Completion sets reject extra IDs and duplicates. The scorer tests include
wrong windows, missing blockers, malformed answers, provider errors and caps.

Version 2 scores the recovered answer separately from authoritative fetches.
A correct answer from a sufficient search snippet passes; `missingEvidence`
and `authoritativeFetch` retain whether full source records were fetched. The
two pilot artifacts required fetching for a pass and remain unchanged. Their
headline rates must not be pooled with version 2.

`needs_user_context` records requests to reconstruct the earlier session.
`missedBlockers` counts missing required blockers. `needlessSearches` counts
search calls beyond each case's declared allowance (zero for an ID in hand or
arithmetic, one otherwise); it is a cost diagnostic, not a correctness gate.
All tool calls and token counts remain visible, including skill-list reads.
Write attempts are recorded and refused, and fail the read-only outcome.
The arithmetic control fails any tool call. Tool/domain errors are distinct
from provider/episode errors. Missing provider cost is marked incomplete.

The default Mini model runs at most eight rounds with 2,048 output tokens per
round. `--max-cost 1` stops before the next episode when cumulative billed cost
reaches $1; one episode can overshoot. `--case resume,completion-window` narrows
the run. Sonnet and Opus require `--allow-expensive`. `--seed-only` calls no
model. `--catalog 0` gives a small-catalog control in a fresh store.

`--arms` picks the arms, default `hookless,reminder,hooked`. `reminder`
injects only the reminder text from `--print`, as the 2026-10-24 runs did.
`hooked` injects what the shipped hook prints at SessionStart for this store:
the runner mints a `config:read` bearer token in the store, runs the hook's own
`--refresh` against the server, which caches `/config/hooks` and
`/config/brief`, then runs the hook on a SessionStart payload. The text,
reminder plus brief, is generated once per run and recorded with its hash as
`hooked` and `hookedHash`. Minting the token needs the server's pepper, so start
the server with `TOKEN_PEPPER=<value>` and the runner with
`VALISE_TOKEN_PEPPER=<the same value>`.

`report.mjs` also counts invented cursors: a `list_todos` cursor that no
earlier call in the episode returned as `next_cursor`. Null and `""` count as
omission.

## Scope

This is a fresh-agent read-only handoff assessment, not an autonomous coding
benchmark. It measures recovery of the correct remaining work, not execution
of that work. The reminder and hooked arms inject text into the system prompt;
neither certifies a real client's lifecycle delivery of it. Supersession
is explicit in the stored decision text, not a first-class relation. The
separately owned orientation and relations implementations are not modified by
this runner. A whole-candidate-head comparison does not isolate unrelated
changes on that branch.

## Write-capable lane: Agent A writes back, fresh Agent B executes

`../writeback/` is the separate J4 lane where writes are allowed and scored.
Its results are never pooled with the read-only numbers above, and the
read-only scorer still refuses writes. Scenarios, scoring rules and failure
variants are in [`../writeback/README.md`](../writeback/README.md).

Agent A gets the user's request and the live MCP tools on an isolated loopback
store. Fresh Agent B gets a new message array with the project goal only: no A
transcript, IDs or expected step. B also gets one extra tool,
`run_checksum_check`, which hashes a synthetic fixture under B's live claim and
writes a receipt. The scorer reads the store directly through Local Explorer
SQL and MCP fetch/search after each agent: rows, revisions, update history,
projection and search visibility, foreign claims, the blocked deployment, and
every record outside the run's project. Reported IDs must equal the records
that actually changed.

### Run it

`--serve <port>` starts `scripts/ui-test-server.mjs` on a fresh state
directory, runs, and removes that directory. `--endpoint` points at a server
you started yourself; the runner refuses a nonempty store either way.

```sh
# Provider-free unit tests: scripted agents against an in-memory store.
node --test test/evals/writeback.test.mjs

# Dry run: scripted A and B against a real local Worker. No provider, no key.
node evals/writeback/run.mjs --dry-run --serve 4622 --case all
# Prove a failure is caught, for example a retry after a lost write receipt:
node evals/writeback/run.mjs --dry-run --serve 4622 \
  --case lost-receipt --a-variant retry-after-lost-receipt

# Paid: one case per fresh store, with OPENROUTER_API_KEY set.
node evals/writeback/run.mjs --serve 4623 --case new --arm hookless \
  --model openai/gpt-5.4-mini --revision "$(git rev-parse HEAD)" \
  --ledger evals/runs/writeback/ledger.json \
  --output evals/runs/writeback/new-hookless-mini.json
```

The dry run passes all seven cases in about 90 seconds. Every A and B variant
in `scripted.mjs` fails with its named reason. It proves the harness and the
scorer, not model behavior. `--arm injected` adds the shipped SessionStart and
Stop reminder text from `valise-hook.mjs --print`, the Stop only where the
hook's own gate would fire it; it is labeled injected and is not real-client
lifecycle evidence.

A paid run takes exactly one `--case` per invocation, because B searches the
whole store and an earlier case's to-dos would leak into it. Use a new
`--serve` port or a new state directory for each case and arm.

### Cost knobs

| Flag | Default | Bounds |
| --- | --- | --- |
| `--max-cost` | `1` | Dollars across the whole `--ledger`, every case, arm and model sharing it |
| `--max-episodes` | `24` | A and B count separately; one model's 7 cases × 2 arms is 22 |
| `--rounds` | `12` | Model requests per episode; scripted B needs 7 in either arm, because its `complete_todo` keeps the injected Stop quiet |
| `--max-calls` | `32` | Tool calls per episode |
| `--max-tokens` | `1024` | Output tokens per request |
| `--catalog` | `64` | Synthetic skills seeded once per store |
| `--allow-expensive` | off | Needed for any model outside the Mini, Haiku or Flash class |

The runner reads live OpenRouter pricing before the first request and reserves
each request's worst case before dispatch: request bytes plus a 32 KiB framing
allowance at the input price, plus `--max-tokens` at the output price. The
prices are the highest any provider lists for the model
(`/api/v1/models/<id>/endpoints`), cache writes included, because the model's
own listing is its cheapest provider's and OpenRouter may route elsewhere. GLM
5.3 lists 48 providers from $0.07 to $2.80 per million input tokens. Billed
usage settles the reservation. Unknown usage keeps it. Billing above a
reservation stops the run. The ledger's `.lock` file survives a crash on
purpose; reconcile the ledger before deleting it. Reuse the same knob values
for every run that shares a ledger, or the runner refuses it.

### Cost per episode

The dry run's request sizes, at about four bytes per token, give the floor a
model starts from. Each request carries about 9,000 tokens of tool schemas
and prompt before any tool result.

| Episode | Scripted rounds | Input tokens |
| --- | --- | --- |
| A, capture case | 3–4 | 28,000–38,000 |
| A, ephemeral or arithmetic control | 1 | 9,000 |
| B, recover, claim, execute, complete | 7 | 70,000 |

At October 2026 OpenRouter list prices, with about 300 output tokens a round:

| Model | Input / output per million | A capture | B | A then B | One 22-episode matrix |
| --- | --- | --- | --- | --- | --- |
| `openai/gpt-5.4-mini` | $0.75 / $4.50 | $0.03 | $0.06 | $0.09 | $0.80 |
| `anthropic/claude-haiku-5.5` | $0.10 / $0.50 | $0.004 | $0.008 | $0.012 | $0.10 |
| `anthropic/claude-haiku-4.5` | $1.00 / $5.00 | $0.04 | $0.08 | $0.12 | $1.03 |

A matrix is ten capture A episodes, four control A episodes and eight B
episodes; `refused-write` stops after A. These are list-price figures with no
prompt caching. The read-only runs above
billed gpt-5.4-mini at about $0.15 per million input tokens once caching
applied, a fifth of list. A model that takes more rounds than the script can
cost up to about twice the floor before `--rounds` stops it.
