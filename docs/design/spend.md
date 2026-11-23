# Spend per account

An admin answers one question on `/workbench?tab=costs`: who is costing money
this month, on what, and what can be done about it. This is an estimate from Valise's own ledgers
at list price. It is not the Cloudflare invoice. Owner request of 2026-11-08,
`todo:tdo_48a6d141-0b8f-456f-85c6-d1a0c698e4d2`.

Account-level alerts already exist outside the app: Cloudflare budget alerts at
$10, $25 and $50, and usage alerts on Workers requests (10M), D1 rows read
(10B), D1 rows written (50M), D1 storage and R2 storage. They say that spend
rose. This view says who and on what.

## Interaction contract

| | |
|---|---|
| User job | An admin finds the account, or the system job, driving spend in the last 30 days, and changes that account's cap or knows whom to ask. |
| Default populated view | A table above the existing review-cost caps: one row per account, plus a `System` row and an `Unattributed` row, sorted by estimated USD over 30 days, descending. Columns: account, estimated USD (30 days), share of the metered total, the largest category, last 7 days against the 7 before. A total line sits under the table. |
| Primary action | Open a row. The disclosure shows that account's categories with calls, units and USD, a 30-day daily series, and a link to its cap form on the same tab. |
| Disclosed secondary details | Per-category units (tokens, input bytes, calls), the price each category uses with the date the price was read, and MCP call count as the request-load proxy. |
| Failure states | An account with no metered rows shows $0.00, not a missing row. A failed read shows `unavailable` in place of every figure, never $0; categories share one table, so they fail together (amended 2026-11-08, see Data). A model call with no price shows `unpriced` and the units it used. Seven or more days without rows for a category flags it as stale (a meter that stopped writing). |
| Loading budget | One `db.batch` of aggregates over the window. Rows read are bounded by ledger rows in 30 days, not table size. A query-plan test (as in `test/d1/source-query-plans.worker.test.ts`) pins every aggregate to a `(user_id, day)` or `(day)` index. Under 300 ms server time at 50 accounts and 90 days of rows. |
| Evidence boundary | Workers AI and TypeSafe calls at list price, from Valise's own records. Free daily allocations are not subtracted, because they cannot be split per account; the total can exceed the invoice for that reason. D1 rows, Worker CPU, Durable Object time and R2 operations are not attributed per account. They appear in `System` and `Unattributed`, with MCP calls as the only per-account proxy. The invoice stays the truth; the API token in use cannot read billing (403 on `/billing/*`). |

Principles that apply: cite `docs/design/principles.md` numbers in review. A
number on screen states its unit and window. An estimate is labelled as one.

## Why a `System` row

The 2026-10-29 to 2026-11-08 cost incident was a per-minute drain reading 2.3B
D1 rows a day (PR #366). No account caused it. A view that only ranks accounts
would have shown nothing. Every cron job in `workers/app.ts` runs through
`meterJob()` (`app/concepts/spend.ts`) on a `DB` that adds up `rows_read` and
`rows_written` from each result's meta, then writes one `d1:<job>` row to the
`(system)` account at D1 list price. That incident would have read as
`D1 load: source enrichment`, about $2.30 a day, at the top of the table.

Model calls a drain makes on an account's behalf (summaries, embeddings,
memory upkeep) belong to that account, not to `System`; each drain already
knows whose item it is working on.

`Unattributed` holds MCP requests refused before sign-in and the rows of
accounts that no longer exist. Worker requests, CPU, Durable Object time, R2
operations and request-path D1 are not metered at all; the evidence boundary
names them.

## What is metered

Inventory of 2026-11-08: `grep -rn "\.run(\|toMarkdown\|typesafe" app`.

| Category | Call site | Unit | Price |
|---|---|---|---|
| `bookmark_summary` | `source-enrichment.ts`, `env.AI.run(SUMMARY_MODEL)` | tokens reported | `SUMMARY_MODEL`; no usage report counts the ceiling |
| `file_summary` | `asset-processing.ts`, `env.AI.run(SUMMARY_MODEL)` | tokens reported | `SUMMARY_MODEL`; no usage report counts prompt bytes plus the 900-token cap |
| `file_conversion` | `asset-extraction.ts`, `ai.toMarkdown` | calls | documents free; an image description is `unpriced` |
| `memory_review` | `memory-review.ts`, `reserveReviewCall`: review, lessons and reflections, Workers AI or OpenRouter | calls | the reservation at the chosen model's list price |
| `review_ranking` | `memory-review-ranking.ts`, the Jev stage | input bytes | the reservation, Jev $0.042/M |
| `embedding` | `reserveEmbedding`: memory, asset and bookmark passages, search queries, the ranking's embedding stage | input bytes | bge-m3 $0.0118/M tokens, one token per byte |
| `rerank` | `rerank.ts`, Jev or a Workers AI reranker on `search` | input tokens reported | Jev $0.042/M, clef $0.24/M; a stage that failed before reporting is `unpriced` |
| `mcp_requests` | `recordMcpCall`, batched with the `mcp_calls` row | calls | not priced; the request-load proxy |
| `d1:<job>` | `meterJob` around every cron job | rows read | D1 $0.001/M read, $1.00/M written |

Not metered: request-path D1, Worker CPU and requests, Durable Objects, R2,
and Vectorize. `/__dev/*` routes run only on a local Worker.

## Data

`spend_daily(user_id, day, category, calls, unpriced_calls, units,
microusd)`, primary key `(user_id, day, category)`, index `spend_daily_day`.
`user_id` is never NULL: SQLite treats NULLs in a primary key as distinct, so
an upsert keyed on a NULL account would add a row per call. The system and
unattributed accounts are the literals `(system)` and `(unattributed)`.
`unpriced_calls` counts the calls with no list price, whose units count and
whose money does not, so an unpriced model reads `unpriced` rather than $0.

A reservation and its spend row share one `db.batch`, and the spend upsert
carries `WHERE changes() > 0`, so a refused reservation records nothing.
`test/d1/spend.worker.test.ts` proves the guard on an empty `INSERT … SELECT`
and on an upsert whose `WHERE` refuses.

The read is one `db.batch`: the window's per-account, per-category sums, the
daily series, and each category's newest day within 90 days. Each reads
`spend_daily INDEXED BY spend_daily_day`; the plan test seeds 50 accounts × 90
days and fails on a `SCAN spend_daily`. The window's 6,000 rows read as
12,000, an index entry and a row each. With one table, a failed read fails
every category together: the whole view shows `unavailable`, never $0.

`drizzle/0066_spend_daily.sql` backfills from `source_enrichments`,
`asset_processing_outputs` (file summaries before this recorded no usage, so
they are `unpriced`), both review budgets (the ranking reservation then
included its embedding stage), `embedding_usage_daily` and `mcp_calls`. There
was no D1 meter before; `System` starts on the deploy day. Rows are kept 400
days and trimmed by the nightly cron. The table is in `TABLES` in
`scripts/recovery-policy.mjs`.

## Slices

1. Inventory call sites; add `spend_daily`, its writes and the backfill; d1
   tests for each category and the plan test.
2. The table and disclosure on the costs tab; Playwright at desktop and
   320 px with 0, 3 and 50 accounts, an `unavailable` category and an
   `unpriced` one.
3. Walk through on production as the owner; record the default view and the
   primary action in `docs/design/evidence/`.

Slice 2 evidence, 2026-11-08, on synthetic accounts in a local Worker (no
private content): `docs/design/evidence/2026-11-08-spend/` holds the default
view at 1280 and 390 px, an account opened at 1280 and System opened at 390.
`test/ui/spend.spec.ts` walks the job at 1280 and 320 px with 0, 3 and 50
accounts, a failed read, an unpriced category, a stale one, and the row
opened with scripting off. The opened row is `?spend=<account>`; the loader
does not rerun for it, because the view already holds every account (P3, P4).

## Open questions

- Per-account caps on categories other than memory review. The daily
  bookmark budget (`VALISE_SOURCE_DAILY_USD`) is per account but global in
  value. Forced by the first outside account whose spend passes $1 a day.
  Kept open because one owner and two test accounts give no distribution to
  set a cap from.
- A Cloudflare `usage_block` spend policy (Workers, Durable Objects) is a
  hard account cap that would stop production. Forced by opening sign-ups.
  Kept open because blocking everyone to stop one account is worse than a
  per-account cap.
