# 0006. Log every MCP call to D1, and read eval runs from a bundled index

Date: 2026-10-16
Status: accepted

## Context

Two questions about Valise have no surface that answers them.

The first is what agents actually send. ADR-0003 made tool descriptions the
product: in a client that does not speak SEP-2640, the description is the only
thing a model reads before it decides. V1-9 measures whether a model picks the
right tool in a harness, but nothing records what the real clients do once
connected — which tools they reach for, which arguments they build, which calls
come back as errors, and which fail the preflight before the SDK sees them. The
Worker has `observability.enabled`, so a failure can be found in the Cloudflare
log stream, but a log stream is a tail of text with a retention window, not a
per-tool error rate a person reads on a Tuesday.

The second is where eval results live. V1-9 writes `evals/runs/<stamp>.json`
and a markdown table beside it, in a local directory that is not published. Both are read by opening a file in the repo,
which means a run is invisible from the console that is otherwise the one place
the state of the thing is shown.

## Decision

**One table, `mcp_calls`, written on every MCP request.** The row records the
transport (`oauth`, `bearer`, `loopback`), the principal, the provenance triple
the concepts already carry (agent, client, session), the JSON-RPC method, the
tool name, the full arguments, the required scope, the outcome, the duration,
and the response size. `protocol_error` is its own outcome rather than a kind
of tool error: a client that sends the wrong `Accept` header never reaches a
tool, and that refusal is one of the few things a connection problem shows up
as. Written from one place: the wrapper around
`mcpHandler.fetch` and `handleMcp` in `workers/mcp.ts`, which every path
already passes through, including the rate-limit and preflight rejections that
return before `dispatch`. The write goes through `ctx.waitUntil`, so a row
never costs the caller latency, and a failure to log never fails a call.

**Arguments are stored, capped at 8KB.** The point of the table is to answer
"what did it send", which a count cannot. `args_bytes` keeps the original
length, so a truncated payload is visible as a truncation rather than as the
whole story. Valise is single-user; the arguments are the user's own content.

**D1, not Workers Analytics Engine.** AE is the cheaper write and the right
answer for counters at volume. It is the wrong answer here: it samples, it caps
all blobs on a data point at about 5KB together, and it is readable only
through the SQL API with an account token, which a console loader cannot reach
through a binding. D1 is already bound, stores the full argument text, and is
queryable from the loader that renders the page. At one user's call volume the
extra write is noise. Revisit when calls per day reach five figures.

**A second table, `auth_events`, for the things that are not MCP calls.**
Console sign-in, failed sign-in, sign-out, OAuth consent granted, and consent
denied. `sessions.created_at` already implies the successful logins, but
nothing records a refusal, and a refusal is the row worth having when something
is wrong. Bearer-token use needs no row here: `mcp_calls` carries the token
label on every call it makes.

**Both new tables keep time in milliseconds**, while every other timestamp in
the schema is Unix seconds. Ordering inside one second matters in a log, and
durations are milliseconds anyway. Neither table joins to one that uses
seconds. The columns say so where they are declared.

**Retention is a nightly cron**, `0 4 * * *`: `mcp_calls` to 30 days,
`auth_events` to 90, and expired `sessions` with them. The spec allots one cron
trigger for the nightly backup export; this is that trigger, arriving before
the backup that will share it.

**Eval runs reach the console as a bundled index.** `evals/run.mjs` writes
`evals/runs/index.json` next to each run: per-model totals, the per-case cell
every markdown report already prints, and the route a model took to get there.
The workbench reads it on the server, so one run rather than every run crosses
the wire.
The index holds no arguments and keeps the newest twenty runs, so the client
bundle grows with a bound. Full arguments stay in the per-run file on disk, and
the real ones are in `mcp_calls` — the eval harness talks to a live endpoint,
so its own traffic logs itself under the agent `valise-eval`.

## Amendments

- 2026-11-02. A call without an `mcp-method` header is rate-limited by its JSON-RPC method instead of the shared `rpc` fallback, when that method is one of the MCP methods in `LIMITER_METHODS` (`workers/mcp.ts`). Anything else stays in `rpc`, so a client cannot open buckets by naming methods, and `mcp-name` keeps its `unclassified` fallback, so header-less tool calls still share one `tools/call` bucket. A sent header still decides. `limiter_method` records the same effective value. From 2026-10-21 to 10-30 OpenCode 2.1 polled `resources/list` and `resources/templates/list` about 24 times per connection without the header. Its subagents filled the one per-user bucket, and 1,069 `initialize` and 161 `tools/list` calls were refused, every refused discovery call that recorded a key having used `rpc:unclassified`. Those sessions had no Valise tools. Raising the 60-per-minute limit was rejected: the busiest shared minute held 982 calls. `test/mcp/rate-limit.worker.test.ts` fills a 60-per-key limiter with `resources/list` and admits `initialize` and `tools/list` after it; that case fails on the previous key.
- 2026-10-21. The OpenCode V2 eval lane uses one private foreground server and API session per case, without the user's service, configuration, plugins or credential database. It awaits the observed catalog handshake before admitting input and reads the route from `mcp_calls` for that same session and eval agent. Run headers carry the client version, and the bundled index labels OpenCode as its own condition. `evals/README.md`, "The OpenCode harness lane".

- 2026-10-23. `mcp_calls` records `limiter_method` and `limiter_name`, the capped, trimmed `mcp-method` and `mcp-name` dimensions used in the MCP rate-limit key, including `rpc` and `unclassified` fallbacks. They are shown in call details so a refusal can be tied to the bucket it used. Older rows remain null.

- 2026-10-20. `http_method` records the HTTP verb separately from the RPC method; older rows keep null rather than a guessed verb. A bodyless authenticated GET explicitly accepting an event stream, with no session or resumption headers, is an optional stream probe. The stateless SDK's exact 405 refusal is recorded as `ok` with its real HTTP status, labelled "stream not offered", and grouped with handshakes. Other transport refusals remain errors. Historical 405 rows cannot be reclassified safely because their HTTP method and headers were not recorded.

- 2026-10-19. `search_result_ids_json` holds at most the first ten ids actually delivered by a successful `search`, deduplicated within the call. `observeCall` reads the response's structured results after reranking, never the candidate list or rerank metadata. Other calls and failures store null. A capped JSON column and `json_each` keep this bounded, single-user read in the existing thirty-day retention path; an indexed side table is deferred until the five-figure daily call volume above forces it. Memories show search appearances and fetches as separate counts. These telemetry writes never touch the content projection.

- 2026-10-18. The evals tab reads the suite rather than a run. The index holds, per condition (plain, rival tools, a seeded corpus, a harness lane), each case and model's newest result from whichever run produced it, the summary over those, every case's history across every run on disk, and a run log. The twenty-run cap is gone: the index is read on the server and carries one cell per case and model per condition, not one per run. `evals/runs/notes.json` records what each run tested and its verdict, `kept`, `dropped` or `baseline`, and a dropped run never counts as newest, so the tab cannot score a wording that did not ship. Runs record `toolHashes`, one digest per tool, so a case's history names the description that changed. `evals/README.md`, "The evals tab" and "Notes and verdicts".
- 2026-10-18. The row gains `target_id`, the item the call acted on: the `id` argument of `fetch`, `claim_todo`, `update_todo`, `complete_todo` and `comment_todo`, or `structuredContent.id` in the result of `create_todo`, `save_memory`, `publish_skill` and `get_skill`. Read from named fields per tool, never from any string shaped like an id. Indexed on `(target_id, at)`, so the logs tab can show it per row and filter or count on it without `json_extract`. Rows from before the column read null and age out with the thirty-day trim.
- 2026-10-17, V1-17. The logs tab lists runs rather than calls. A run is consecutive calls from one agent and client with no idle gap over ten minutes, sessionized in SQL with `LAG` and a running sum. It stands in for a user turn, which this server cannot see: SEP-2817's `turnId` is the field designed to carry one and no client sends it, and `session` holds a bearer token id rather than a conversation. The row carries only what the log can honestly support, so there is no prompt, no answer, no token count, and no cost; wall-clock span and summed server time are labelled apart because neither is how long the model took.
- 2026-10-16, V1-14. The row gains an `intent` column, and a non-tool method's whole `params` is recorded rather than its resource uri alone, so `initialize` puts the client's own name in the log. ADR-0007.

## Consequences

Gained: a per-tool error rate, an argument payload a person can read, and the
record of who signed in and who was refused, all on the page they are already
looking at. The eval tab makes a description change show up as a moved number
without opening the repo.

Given up: a D1 write on every MCP call, and a database that grows with use
until the cron trims it. A run has to be indexed and the console redeployed
before it appears in the eval tab, which is the cost of bundling rather than
storing.

Inherited: classifying the outcome reads the response from a clone, which
buffers for whichever branch finishes last. Every response the handler returns
today is a complete, short SSE frame, so that costs nothing; a tool that one
day streams a long result would need the classifier to stop at the first frame
instead. The index is generated and nothing checks its freshness, because a missing run
is a missing row rather than a wrong one. If the eval tab
starts leading a decision, the index moves into D1 and that stops being true.

## Amendment, 2026-10-17

This record compared the eval index to the roadmap pair, which ADR-0010 deleted
along with the plan checklist it rendered. The sentences above were corrected to
describe the index on its own terms. The decision is unchanged: eval scores
reach the console as a generated file read on the server, and nothing gates on
its freshness.

## Amendment, 2026-10-29: the member activity trail

The call log answers what clients sent. A member asks a different question,
what changed in my case while I was away, and the owner wants that answered
without raw tool calls (J9). `/activity` answers it for every signed-in person,
about their own tenant only. The call log, latency and errors stay on the
owner-only Workbench, enforced by `requireConsoleOwner` on the server.

The trail reads the writes themselves, never `mcp_calls`: to-dos created,
claimed, progressed, commented on, blocked, released and completed; memories
saved and edited; skill versions published; sources saved; files uploaded.
A hundred reads that changed nothing are not activity, and call volume is
never shown as output.

Interaction contract:

- User job: after time away, see what my agents and I changed, and open any
  item from there.
- Default populated view: the last seven days, newest first, in blocks of
  consecutive changes by one session and client, under UTC day headings. A
  line above the blocks counts outcomes: to-dos completed, created and
  blocked, memories saved and edited, skill versions, sources and files.
  Claims, releases and progress stay in the blocks and out of that line.
- Primary action: a line's title opens its item, a to-do or memory in its
  pane, a skill in its dialog, a source or file through Library search.
- Secondary: a day picker narrows to one UTC day; a project field, or a
  line's project chip, narrows to one project. Both are a native GET form,
  so the URL holds the view (P3) and it works without scripts (P11).
- Failure states: an empty window says nothing changed and how to widen it.
  A malformed day falls back to the default window.
- Loading budget: one D1 batch of two statements per table, each filtered by
  owner and window first and capped at 301 rows; the page shows the newest
  300 and says so when there are more. The outcome counts cover the whole
  window.
- Evidence boundary: second-resolution timestamps and mostly random ids, so
  same-second rows group by author and session, then order by lifecycle step
  (created, claimed, progress, blocked, released, completed). A comment carries no session name; its
  block is keyed on the author alone. Deleting an item does not remove its
  lines.

`test/mcp/trail.worker.test.ts` checks tenant filtering, ordering, outcomes
and windows; `test/ui/activity.spec.ts` the page, its links, 320px and no
scripts; `test/journeys/j9-activity.journey.ts` the member journey.
