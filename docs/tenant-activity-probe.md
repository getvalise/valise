# Tenant activity query probe

Run from the repository root:

```sh
npx vitest run --config vitest.d1.config.ts test/d1/tenant-activity-probe.worker.test.ts --disableConsoleIntercept --reporter=verbose
```

The test runs against disposable local D1 with the repository's migrations.
It inserts 20,000 foreign-tenant rows and 60 rows each for a member, the owner,
and anonymous traffic, into each activity table. Shared session and memory ids
make tenant leakage affect the assertions. Successful fetches include both
explicit targets and legacy argument ids; unsuccessful fetches do not count.

It captures SQL and bindings from the actual application readers, executes
`EXPLAIN QUERY PLAN`, and records result count, D1 `meta.rows_read`, and local
`meta.duration` before and after the two indexes in migration 0034. The existing
global indexes remain present. The test temporarily removes only the two new
indexes, then restores them in `finally`. It asserts tenant isolation, owner
access to anonymous events, usage counts, tenant-index selection, unchanged row
counts, and at least a tenfold reduction in rows read for this fixture.

Observed on 2026-10-23, local workerd/D1, base `3cab9ab`:

| Reader / statement | Before rows read | After rows read | Result rows |
| --- | ---: | ---: | ---: |
| Member activity totals | 20,220 | 100 | 1 |
| Member outcomes | 20,222 | 162 | 2 |
| Member logins | 20,039 | 120 | 25 |
| Member known tools/clients | 20,180 | 60 | 2 |
| Owner activity totals | 20,260 | 202 | 1 |
| Owner outcomes | 20,262 | 324 | 2 |
| Owner logins | 19,989 | 242 | 25 |
| Owner known tools/clients | 20,180 | 61 | 2 |
| Member calls | 20,220 | 160 | 60 |
| Member client sessions | 40,423 | 183 | 1 |
| Member runs | 21,006 | 886 | 60 |
| Member memory usage | 26,990 | 200 | 1 |

Reports follow this table's order. Before, activity used global `at` or
`outcome_at` indexes; usage scanned successful outcomes across tenants. After,
both memory-usage branches use `mcp_calls_user_at (user_id=?)`; windowed activity
uses `(user_id=? AND at>?)`. Owner/member OR predicates use `MULTI-INDEX OR`
with the same tenant-leading index. Auth reads use `auth_events_user_at` and
sort the matching rows. Temporary grouping/sorting work remains visible in the
plans. Local durations were 1–3 ms before and 0–1 ms after; zero is the local
timer's resolution, not zero work.

These two indexes cover the observed tenant predicates without another
tool/outcome-specific index. Each adds one index entry per log insert. The
global time indexes still support retention. Memory usage still aggregates all
retained calls for the selected tenant; the indexes do not bound a large
tenant's own work. This probe measures query plans, local rows read and result
correctness for one fixed skew. It does not measure concurrent requests,
network latency, production throughput, tail latency or storage capacity.
