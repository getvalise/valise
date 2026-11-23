# Release route check, 2026-10-25

One paid call per offered model through the production adapter
(`draftMemoryReview`) and validator (`validateReviewProposal`), using the
synthetic Ada/Bo apple-crate contradiction fixture. This proves each route
answers with a schema-valid proposal under the production request shape. It is
not a quality comparison; that evidence is in `../2026-10-24-shortlist/`.

Command:

```sh
node scripts/memory-review-routes.mjs --allow-three-paid-synthetic-calls evals/memory-review/2026-10-25-routes
```

| Model | Valid | Kind | Route | Tokens in/out | Reasoning tokens | Billed USD | Reserved USD | Latency |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| `anthropic/claude-haiku-5.5` | yes | contradiction | Azure | 823 / 504 | 0 | $0.0003343 | $0.001002 | 2.67s |
| `anthropic/claude-sonnet-5.5` | yes | contradiction | Azure | 824 / 500 | 0 | $0.006648 | $0.020040 | 4.21s |
| `deepseek/deepseek-v4.1-flash-1017` | yes | contradiction | DeepInfra | 518 / 170 | 0 | $0.0001007 | $0.002546 | 2.23s |

Three calls, no retries. Billed total $0.0070830 by OpenRouter's reported
usage; reservations total $0.023588. DeepSeek left the body empty, which the
contract allows for a contradiction. Sonnet ran with reasoning effort `low` and
reported zero reasoning tokens.

The known prompt issue stands: the
[2026-10-24 journey](../2026-10-24-journey/report.md) recorded Haiku labelling
compatible claims a contradiction. This check does not test that case.
