# Carrying a reason on a tool call (2026-10-16)

Research behind ADR-0007. The question it answers: should a Valise tool take an
argument where the model says why it called, and if so, which tools and on what
terms. The ADR records the decision. This records the evidence, including the
parts that argue against it.

Every quote below was read from the primary source on 2026-10-16: the file in
the repository that defines the schema, the SEP text in its pull request, or
the vendor's own documentation page. Where a claim comes from a sweep rather
than from a file read here, the text says so.

## Three questions, three homes

Three things get called "context on a tool call" and they belong in different
places. Confusing them is how a tool surface grows a field it cannot use.

**Who is calling.** The client, its version, and which conversation a request
belongs to. This is the transport's job. It costs no model tokens because no
model writes it.

**Why this call.** A sentence the model composes. It costs tokens, it cannot be
verified, and it is the only one of the three that is a design decision.

**What the call does.** The ordinary arguments. `search(query)` already answers
why it was called, because the query is the reason.

Valise was dropping the first and paying attention only to the third.
`initialize` carries `clientInfo`, and `observed()` in `workers/mcp.ts`
recorded a resource uri for non-tool methods and nothing else. Every row in
production reads `oauth` as its client, so the log cannot tell Claude Code from
Claude Desktop. V1-14 records the whole `params` for a non-tool method, which
captures `clientInfo` today at no cost.

## What the spec says about who is calling

The current protocol revision is 2026-07-28, and it is explicit that a
connection is not a session:

> Servers **MUST NOT** rely on prior requests over the same connection to
> establish context (e.g., capabilities, protocol version, client identity).
> Every request supplies this metadata in its `_meta` field.

> This implies that an open connection, such as a STDIO process, is not a
> conversation or session: clients may interleave unrelated requests on the
> same transport, and a server must not treat connection or process identity as
> a proxy for conversation or session continuity.

So a session identifier is not something you invent a tool argument for. That
revision reserves these `_meta` keys on a client request:

| Key | Required | Carries |
| --- | --- | --- |
| `io.modelcontextprotocol/protocolVersion` | Yes | The revision this request speaks |
| `io.modelcontextprotocol/clientCapabilities` | Yes | What the client supports |
| `io.modelcontextprotocol/clientInfo` | No | Client name and version |
| `io.modelcontextprotocol/logLevel` | No | Minimum log level for this request |
| `progressToken` | No | Opts into progress notifications |
| `traceparent`, `tracestate`, `baggage` | No | W3C Trace Context, by explicit exception to the prefix rule |

> Clients **SHOULD** include `io.modelcontextprotocol/clientInfo` on every
> request unless specifically configured not to do so.

The spec also fences off what that identity is for, in terms that match the
limits on a model-written reason almost word for word:

> `io.modelcontextprotocol/clientInfo` and `io.modelcontextprotocol/serverInfo`
> are self-reported by the sender and are not verified by the protocol. They are
> intended for display, logging, and debugging. Implementations **SHOULD NOT**
> use them to change the behavior of the client or server, and **SHOULD NOT**
> rely on them for security decisions.

Valise cannot read those per-request fields yet. `@modelcontextprotocol/sdk`
pins `LATEST_PROTOCOL_VERSION = '2025-11-25'`
(`node_modules/@modelcontextprotocol/sdk/dist/esm/types.js:2`), and that
revision reserves only `progressToken`. Recording the whole `params` object
rather than named fields means the day the SDK moves, the data arrives without
a second change.

Source: https://modelcontextprotocol.io/specification/2026-07-28/basic/index

## What the spec says about why

SEP-2817, "AI Invocation Audit Context in Request `_meta`", proposes exactly
this data and puts it outside tool schemas. Status: Draft, Standards Track,
opened 2026-05-29 by HyunJong Cho, still open and still seeking a sponsor. Its
originating discussion (#2704, opened 2026-05-09) has 41 comments and no
accepted answer.

The envelope:

```ts
_meta["io.modelcontextprotocol/aiInvocation"]?: {
  invocationReason?: { text: string };
  model?: { name: string };
  userIntent?: { text?: string; redacted?: boolean };
  turnId?: string;
}
```

Four fields, and the fourth is the session question answered properly.
`turnId` "correlates MCP requests that were caused by the same user turn",
where a turn is "one user input or initiating event that may produce multiple
MCP client-to-server requests". It is opaque, clients and servers "MUST NOT
parse semantics from the value", and the SEP spells out what it is not: not an
idempotency key, not a replacement for the JSON-RPC `id`, not a replacement for
`progressToken`.

On why the fields do not go in the arguments:

> Today, implementations that need this context must invent server-specific
> arguments such as `user_query`, `invocation_reason`, or transport-specific
> model metadata. That pollutes tool schemas, does not generalize across
> transports, and fragments audit logs across MCP servers.

> Tool arguments are part of each tool's semantic contract. Audit fields such
> as `user_query` or `invocation_reason` are useful locally but force every
> server to define its own convention. They also make audit metadata look like
> business input.

And on how far to trust what arrives:

> `invocationReason` is client/AI-asserted and may be inaccurate, incomplete,
> or hallucinated.

> `invocationReason` MUST NOT be used as authorization evidence.

Source: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2817

## Who ships an intent parameter

GitHub's official MCP server is the closest prior art and the most carefully
designed. The `copilot_issue_intents` toolset is opt-in, described in the
README as "Opt-in Copilot issue assignment tools that carry intent metadata
(rationale, confidence, suggestion)".

In `pkg/github/copilot.go:582`, on `assign_copilot_to_issue_with_intent`:

```go
"rationale": {
    Type: "string",
    Description: "One concise sentence explaining what specifically about the issue led to choosing Copilot. " +
        "State the concrete signal (e.g. 'Well-scoped task with clear acceptance criteria').",
    MaxLength: new(280),
},
"confidence": {
    Type:        "string",
    Description: "How confident you are in this choice. 'HIGH' for clear signal or explicit user request, 'MEDIUM' for reasonable inference with some ambiguity, 'LOW' for best guess with limited signal.",
    Enum:        []any{"LOW", "MEDIUM", "HIGH"},
},
```

That tool is declared at line 550, and its `Required` list is
`{"owner", "repo", "issue_number", "rationale", "confidence", "is_suggestion"}`.
The plain `assign_copilot_to_issue` is declared at line 169 in the same file,
requires `{"owner", "repo", "issue_number"}`, and has no rationale at all. The
intent-bearing tool is a second tool, not a tax on the first.

`pkg/github/issues_granular.go` carries the same field four times, on the tools
that set an issue's assignees (line 270), labels (405), type (538), and state
(665). Each is capped at 280 characters and asks for "one concise sentence
explaining what specifically about the issue led you to choose this label", or
type, or state. None of the four lists `rationale` in `Required`.

Read that split as a rule: GitHub requires a reason on the one call that spends
real resources by launching an agent, and makes it optional on the calls that
classify something a person can reclassify.

Three others, each narrower than it first sounds:

- **Slack**, read live from the connector in this session.
  `slack_search_public` takes an optional `natural_language_query`: "The user's
  question restated in conversational tone. Used for semantic reranking. Do not
  include filter-like content (people, channels, dates) — those belong in
  filters. Pass an empty string when the query is purely structural (only
  filters, no semantic question)." Note the second sentence. Slack's server
  consumes this field, so it is a functional argument that happens to read like
  intent. Valise's `why` is not consumed by anything.
- **Google ADK**, `src/google/adk/tools/transfer_to_agent_tool.py:49`.
  `transfer_to_agent` takes `transfer_reason: str = ''`, documented as "the
  reason for transferring to the target agent". `TransferToAgentTool.__init__`
  defaults `include_transfer_reason` to `False`, and when it is false the class
  deletes the property from the declaration it publishes. The changelog for
  2.9.0 gives the motive: "add transfer_reason to transfer_to_agent to prevent
  loops".
- **OpenAI Agents SDK** documents `reason` as handoff metadata, on handoffs
  only, in `docs/handoffs.md`. The default handoff input schema is empty.

One cautionary case. octocode-mcp accepts `mainResearchGoal`, `researchGoal`,
and `reasoning` on every query object and then drops them. Its own research
manifest, `docs/OCTOCODE_RESEARCH_MANIFEST.md`, traces them through the source
and says they are "accepted and typed, then explicitly excluded from the echoed
payload by name", which it summarises as "accepted and typed, not (yet)
consumed downstream". It is honest about what that leaves: "Their real value is
forcing the *agent* to state what it's trying to learn and why this specific
call advances it before the call fires. That's a discipline against impulsive,
ungrounded queries, not a server-side feature. Use the discipline; don't
oversell what isn't wired up yet."

Valise is in the same position. Nothing reads `intent`. The difference is that
Valise shows it to a person on the logs tab, which is a use, if a modest one.

## Who does not

A sweep of production MCP servers found no intent parameter on Linear, Notion,
Chrome DevTools, Ahrefs, Guru, Ordinal, Exa, Sentry, Context7, Ref, Goose, or
Cloudflare's own servers. That sweep is a secondary source; the servers were
read by a research agent rather than opened here, apart from Slack and Exa.

GitHub's own non-opt-in tools have none either, and that one was checked
directly: `pkg/github/search.go` contains the string `rationale` zero times,
and its first search tool declares `query`, `sort`, `order`, and
`minimal_output` with `Required: []string{"query"}`.

Exa is the instructive near-miss. In `src/tools/webSearch.ts:37` its `query`
asks for "Natural language search query. Should be a semantically rich
description of the ideal page, not just keywords." That is intent carried by
the functional argument, which is the shape most tools should aim for, and the
reason Valise's `search` does not get a `why`.

The `sequentialthinking` reference server's `thought` parameter is not prior
art. It is the entire payload of a tool whose only job is to hold a thought. It
annotates no action.

## The name is a refusal risk, not a style choice

Anthropic's refusals documentation defines a `reasoning_extraction` category:

> The request asks the model to reproduce its internal reasoning in the
> response text.

The page lists what triggers it, and the second bullet names this exact design:

> * A `<thinking>`, `<reasoning>`, or scratchpad section that the model fills in before it answers
> * A `reasoning`, `thinking`, or `trace` field in JSON output or in a tool input
> * The model's private notes, or a running log of its reasoning
> * Reasoning asked for verbatim or in full

> The wording can sit in a system prompt, a skill, or a tool description, so
> check those too.

The permitted version is right there too:

> You can still ask Claude to explain its answer. Ask for a short explanation,
> the evidence behind a result, or a summary of the actions it took.

This is not a free mistake. `reasoning_extraction` is one of three categories
billed even when the refusal arrives before any output, alongside `"bio"` and
`"frontier_llm"`. The page also says the category has no recommended fallback
model, so a server that trips it cannot retry its way out; it has to reword.

That decides the name and the wording. The field is `why`. It asks for an
explanation in one sentence. It never asks for reasoning, thinking, or a trace.

Source: https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback

## Whether the answer can be believed

Anthropic measured how often a model mentions something that actually changed
its answer:

> On average across all the different hint types, Claude 3.7 Sonnet mentioned
> the hint 25% of the time, and DeepSeek R1 mentioned it 39% of the time.

> The models very rarely admitted to using the reward hacks in their
> Chain-of-Thought explanations, doing so less than 2% of the time in most of
> the testing scenarios.

Instead of admitting the shortcut, the models "constructed fake rationales for
why the incorrect answer was in fact right".

That research measures narrative chain-of-thought, not a structured argument in
a tool call, and nobody has measured the second. The transfer is an inference.
It is strong enough to set the rule: treat `mcp_calls.intent` as a thing the
model said, never as the reason it called. Nothing in Valise reads the column,
and a change to that is a new ADR.

Source: https://www.anthropic.com/research/reasoning-models-dont-say-think

## What it costs in Valise

Measured against the live `tools/list` on 2026-10-16, with the seed skill and
nothing else published, so the surface is twelve tools:

| `why` on | Added characters | Added tokens | Share of the surface |
| --- | --- | --- | --- |
| no tool (baseline 13,985 chars) | — | — | — |
| three tools | 657 | ~183 | 4.7% |
| four tools | 876 | ~243 | 6.3% |
| all twelve | 2,628 | ~730 | 18.8% |

One tool costs 219 characters. The last row matters more than it looks: every
published skill is also a tool, so a field on all tools grows with the skill
corpus rather than staying fixed.

Reproduce the measurement by starting `npm run dev` and reading the surface:

```sh
curl -s localhost:5173/mcp \
  -H 'accept: application/json, text/event-stream' \
  -H 'content-type: application/json' \
  -H 'mcp-protocol-version: 2025-11-25' \
  -H 'x-valise-agent: probe' -H 'x-valise-client: script' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | sed -n 's/^data: //p' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).result.tools;console.log(t.length,"tools,",JSON.stringify(t).length,"chars")})'
```

Token figures divide characters by 3.6 and are approximate. The character
counts are exact.

## What happened when we shipped it

Four runs, named by stamp below; raw eval runs stay local and are not
published. Each sends sixteen cases to seven models and
records where the route ends.

| Run | Tools | `why` on | Tool choice | Arguments valid | Said why |
| --- | --- | --- | --- | --- | --- |
| `2026-10-16T09-35-24` | 13 | none | 103/112 | 105/112 | — |
| `2026-10-16T10-01-05` | 12 | 3 tools | 105/112 | 107/112 | 10/10 |
| `2026-10-16T10-41-13` | 12 | 4 tools | 105/112 | 107/112 | 29/29 |

Two findings.

Models volunteer a reason whenever one is offered. Fill rate is 29 of 29 across
all seven models, including the two cheapest. Nobody skipped it.

Adding the field changes no score. Tool choice and argument validity are
identical between the three-tool and four-tool runs, 105/112 and 107/112. One
model swapped which case it fails and nothing else moved.

The first two runs are not a clean comparison. `2026-10-16T09-35-24` ran
against thirteen tools because a Playwright run had left a test skill in the
local database, and every skill is a tool. That is a standing trap, now
documented in `evals/README.md`: check the tool count in the report header
before reading a regression as a regression.

`why` stays out of the harness's `requiredArgs`. The argument-validity column
fails zero rows on a missing argument, so adding an advisory field to that gate
can only convert volunteered silence into a regression in the one column that
is currently clean. Fill rate measures the question worth asking instead.
Cloudflare's own eval harness makes the same split, in
`packages/eval-tools/src/scorers.ts`: the answer is an enum and carries the
score, while `rationale` is a free-text field read when a score looks wrong.

## What a trace view would need

A logs tab that reads like an agent-framework trace view would show one row per
user turn: the ask, the answer, the steps rolled up, and the cost. Two of those
four are out of reach for an MCP server, and the other two are blocked on data
no client sends yet.

**The ask and the answer are not ours.** Valise sees `tools/call`, not the
conversation. An agent framework shows input and output because it owns the
loop. The closest Valise can get to the ask is SEP-2817's `userIntent.text`,
"what user intent caused the work", which the client would have to send.

**Tokens and cost are not ours either.** They belong to the model, and the
model is on the other side of the client. `mcp_calls` has `duration_ms`, which
is server time only and excludes everything the model spent thinking.

**Grouping is blocked on an identifier nobody sends.** `mcp_calls.session` is
populated from `principal.tokenId` for a bearer token and is null for OAuth
(`app/auth/principal.ts:63`). Every row in the local database has
`session = null`. A bearer token identifies a credential, not a conversation,
so even when it is set it cannot group a turn. `turnId` is the field designed
for this, and no shipping client sends it.

What is reachable today: group by `(agent, client)` within a time window,
roll up the calls in each group, and sort by duration, error count, or argument
size. That is a useful view and an honest one, as long as the grouping is
labelled as a heuristic rather than as a turn.

## What we did not do

**No `confidence` enum.** GitHub pairs its `rationale` with one, and it earns
its place in issue triage, where a model picks one label from many under real
ambiguity. `complete_todo` on a named id is not that call.

**Nothing required.** GitHub requires a rationale only on the call that launches
an agent. Valise has no equivalent. A `claim_todo` that fails because the model
omitted a sentence is strictly worse than a lease with no sentence attached, and
a stranded lease is the failure `claim_todo` exists to prevent.

**No `userIntent` and no `turnId` yet.** `callIntent()` in `workers/mcp.ts`
reads `invocationReason.text` from the SEP-2817 envelope and stops there. The
other two fields are worth reading once a client sends any of them. None does
today.

**No measurement against a real client.** The 29/29 fill rate comes from
OpenRouter models given the raw tool schema. Claude Code and claude.ai wrap a
server's tools in their own system prompt, and whether that changes the fill
rate is untested. Test it once V1-14 is deployed, by filtering the logs tab to
calls that carried an intent and comparing against the same tools' total.
