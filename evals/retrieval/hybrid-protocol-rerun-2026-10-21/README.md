# Affected hybrid protocol compatibility, 2026-10-21

Base: `a710a9534b3f684c7d227ff593b72737b1c27da3` (PR #146).
Condition: 50 fixture memories plus the seed, real remote Workers AI bge-m3,
Vectorize and Jev, local D1 on port 4546, `episodeProtocol: all-tool-calls-v1`.
Tools hash `d1451f8600f0`; store hash `aee4aee99624`.

This is bounded repaired-protocol compatibility evidence, not a rerun or
replacement of the original 5,000-memory quality experiment. The retained
`../rollout-2026-10-21/2026-10-21T08-35-20.json` still contains its four OpenAI
protocol errors, five Gemini 504s and strict failures. Its accepted real-index
ANN floors remain the 5,000-store evidence. No scores or denominators are pooled.

## Selection and strict results

The four original OpenAI errors occupy three unique model/case pairs. Luna's
dump repeats 1 and 2 failed, Luna's cost repeat 0 failed, and mini's logs repeat 1
failed. `selection.json` preserves those rows and the source SHA-256.
Only those pairs were rerun, three times each: nine model episodes, no retries.

| Model | Case | Strict pass | Errors | Capped | Executed calls |
| --- | --- | --- | --- | --- | --- |
| GPT-5.4-mini | Logs paraphrase | 0/3 | 0/3 | 2/3 | 11 |
| GPT-6-luna | Cost paraphrase | 0/3 | 0/3 | 3/3 | 18 |
| GPT-6-luna | Dump paraphrase | 0/3 | 0/3 | 0/3 | 9 |
| Total | | 0/9 | 0/9 | 5/9 | 38 |

Every episode used a nonexistent project filter: 33 calls used literal `*`,
two `general`, and one each `all`, `unknown` and `eval`. All 38 searches were
empty; none reached Jev reranking. These are unresolved tool-choice failures,
not passing retrieval episodes or evidence that ranking improved. The dump's
documented same-fact confound is not rescored.

There were zero missing-tool-output errors. Two Luna cost episodes requested
three-call parallel batches and continued to another completion after all
outputs. A third three-call batch occurred at the final capped round. All 38
`routeCalls` retain IDs, exact argument JSON, round and execution status in the
two raw runs. Serial episodes alone would not exercise the repaired batch path.

Reported OpenRouter spend is $0.00883255 (130,156 prompt and 2,012 completion
tokens). This excludes Workers AI, Vectorize and Jev, and is not a complete bill
or spending ceiling. Error and cap denominators are unchanged in `summary.json`.

## Real hybrid controls and isolation

The existing probe seeded a fresh local store and backfilled all 51 heads through
the shared outbox in three bounded batches: 20, 20 and 11; no delivery failures.
Actual sentinel visibility followed acceptance by 116,715 ms. All 75 probe
queries genuinely reranked, without fallback; titles, paraphrases and project
questions each reached 25/25 top-five targets, and 25 scoped ANN checks passed.
`floors-50.json` and `probe.log` retain these non-model checks.

Three additional operator MCP searches used the affected prompts without the
invented project filters. All three recorded `backend: jev, reranked: true` in
the real `mcp_calls` ledger. They are labeled controls, not additional model
episodes or repairs to strict scores. The first operator request omitted the
required Accept header and received HTTP 406; that negative remains in the audit.
Correcting only its headers produced the three successful controls.

`mcp-calls.json` retains 38 model searches, two tools/list requests, three valid
controls and the invalid operator request. `operator-mcp-controls.json` retains
control responses. The generated eval config selected only disposable
`valise-rollout-eval-protocol-20261021` and namespace `rollout-eval-protocol-v1`;
`project` and `docKey` metadata-index creation requests preceded all data. The
immediate listing still returned `[]`, retained in `metadata-indexes.json`;
subsequent actual project/docKey-filtered ANN queries passed, rather than treating
the asynchronous creation receipt as visibility evidence. D1, R2 and KV stayed
local. Only checked-in fixtures were embedded. No production memory was read,
and no production index, ledger, setting or deployment was changed.

## Reproduction and cleanup

`run-manifest.json` records both exact runner commands. Both use the existing
`--import ./scripts/vector-eval-freeze.mjs`, `--memories 50 --rerank hybrid
--repeat 3`, and only the selected model/case pairs. Raw runs and logs live here,
outside the console's full-run index. The runner-generated index was restored
byte-for-byte to this fresh worktree's base after each run; its SHA-256 is
`d90795c65820e826858f1769966e630ef34e4b849e3e743b6ff718e1f8cf169d`.

The disposable index was deleted after evidence capture. The account census
then contained only `valise-memories-v1`. This run's dev supervisor and children
exited, port 4546 has no listener, and its mode-0600 copied Jev credential was
removed. `cleanup.json` and `index-deleted.log` record the checks; server and
migration logs are retained without credential values. Terminal logs normalize
trailing whitespace only; their unmodified originals remain under `.wrangler/`.
JSON whitespace follows Biome. `artifact-integrity.json` records byte hashes
before/after formatting and verified JSON-value equality, including exact tool
argument strings. Unformatted originals remain in `.wrangler/hybrid-protocol-raw-json/`.

No runtime or harness code changed. All 17 focused protocol tests passed; their
log is `protocol-tests.log`. Repository lint passed after formatting only the new
JSON artifacts; `lint.log` retains the successful check. The initial generated-JSON
formatting failure remains local in `.wrangler/hybrid-rerun-lint.log`.
No full integration gate, push, PR, merge or
activation was performed here. Parent owns the exact-head activation gate and
deployed verification after cherry-picking this evidence.
