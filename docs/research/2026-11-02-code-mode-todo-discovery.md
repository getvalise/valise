# Code Mode for batched to-do discovery

To-do `todo:tdo_db61b119-3555-493f-bf17-f33b3d86730b` asked whether Code Mode
is worth adopting for to-do discovery. It is not, for this task: it met none
of the screening targets. Valise changes nothing.

## Where the program runs

Code Mode belongs in the client, not in Valise. The referenced
[article](https://lucumr.pocoo.org/2026/10/6/codemode/) calls a sandbox
inside an MCP server "pretty bad": results are JSON-escaped twice, and the
inner code "cannot call the outer tools". It runs the program in the
harness, and asks MCP servers only for consistent structured output.

OpenCode V2 ships that client-side mode. Its `execute` tool runs a program
that calls MCP tools. Valise needs no new tool or Worker Loader to support it:

- `fetch` on a to-do returns up to 50 children with their states, plus
  `child_progress` and `children_truncated`.
- Every output has an `outputSchema`.

## The task

One level of children is a single `fetch`, so there is nothing to batch.
Two levels take one `fetch` per child. The task is "the id of every to-do
two levels under this parent, and whether the list is complete":

- **small:** 3 children with 3 grandchildren each, 4 fetches
- **larger:** 8 children with 6 grandchildren each, 9 fetches

`evals/codemode/run.mjs` seeds a fresh hierarchy per episode in its own
project. It runs OpenCode 2.2.0 through the existing OpenCode lane in two
arms:

- `codemode: false`, the direct arm
- `codemode: true`, with `execute` allowed; OpenCode exposes the tools
  directly when `execute` is denied

An answer is correct when it names every grandchild and no other id.

## Result

Code Mode run `2026-11-02T17-32-05` (raw runs stay local, not published), Haiku 5.5 through
OpenRouter, three repeats per cell, $0.034 in total. Every Code Mode episode
ran `execute`.

| Size | Arm | Correct | Median ms | p95 ms | Median prompt tokens | Median MCP calls | Cost per success |
| --- | --- | --- | --- | --- | --- | --- | --- |
| small | direct | 3/3 | 7,607 | 7,638 | 48,756 | 4 | $0.0014 |
| small | Code Mode | 3/3 | 8,645 | 8,986 | 19,075 | 4 | $0.0018 |
| larger | direct | 3/3 | 17,251 | 19,916 | 82,344 | 10 | $0.0041 |
| larger | Code Mode | 2/3 | 15,360 | 23,735 | 38,189 | 9 | $0.0061 |

The screening targets were at least 20% lower median latency and 15% lower
cost per successful task, with no correctness loss:

- **small:** latency 14% higher, cost per success 29% higher.
- **larger:** latency 11% lower, below the 20% target. Cost per success 49%
  higher. Correctness fell to 2/3: one answer named every grandchild plus
  one extra id.

Code Mode halves prompt tokens, but cost does not follow. The direct arm
already batches: Haiku issues the fetches as parallel tool calls, 10 or 11
in 4 turns. Most of its larger prompt is cache reads, which cost little.

## What would reopen it

- A task whose intermediate results are large and mostly discarded, so they
  never need to reach the model.
- A client that cannot issue parallel tool calls.
- Depth beyond two levels.

None is a Valise workload today. The OpenCode lane's `codemode` option and
the script stay, so the comparison can be rerun:

```sh
VALISE_STATE=.wrangler/evals VALISE_RERANK=off npm run dev -- --port 5291
VALISE_MCP_URL=http://localhost:5291/mcp OPENROUTER_API_KEY=... \
  node evals/codemode/run.mjs --repeat 3 --max-cost 1
```

## Proof boundary

Three repeats per cell with one model, on a loopback store. The small run
of one episode per arm (`2026-11-02T17-29-16`) is kept as the harness smoke.
This rejects Code Mode for two-level discovery with Haiku in OpenCode. It
says nothing about other models, other clients, or tasks with large
intermediate results.
