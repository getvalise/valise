# 0007. One optional `why` where the arguments cannot say it, and the caller context already on the wire

Date: 2026-10-16
Status: accepted

## Context

The evidence behind this decision, with every quote traced to its source, is in
`docs/research/2026-10-16-tool-call-intent.md`. This records what was decided.

ADR-0006 gave the logs tab an answer to "what did the client send". It has no
answer to "why". For most of the surface that gap is imaginary: `publish_skill`
carries the skill and `search` carries the query — Exa writes its query
description as "a semantically rich description of the ideal page", and that is
the shape here too, where the functional argument *is* the intent.

Two places are not like that.

The claim path is the first. `claim_todo`, `update_todo`, and `complete_todo`
carry a `todo:` id, a fencing token, and little else. "Why did this agent
complete this to-do" is invisible in the row, and a stranded lease is exactly
the row you want to read.

`save_memory` is the second, and it is easy to miss, because the body is right
there and looks like an answer. It is not. ADR-0003 put classification on the
agent with the context — "`save_memory` requires type and tags in the schema" —
so the body says what was saved and nothing says why it was typed `project`
rather than `reference`, or tagged the way it was. That is the judgment a
person second-guesses three weeks later while reading the memories list.

The prior art is narrow but real, and GitHub's official MCP server is the
closest match. `pkg/github/copilot.go` and `pkg/github/issues_granular.go`
carry a `rationale` on an opt-in `copilot_issue_intents` toolset, capped at 280
characters and asking for "one concise sentence explaining what specifically
about the issue led you to choose this label", alongside a `confidence` enum.
The split is the interesting part: `rationale` and `confidence` are *required*
on `assign_copilot_to_issue_with_intent`, the one call that spends real
resources by launching an agent, and *optional* on the triage tools that set an
issue's labels, type, state, or assignees. The plain `assign_copilot_to_issue`
carries neither, so the intent-bearing variant is a second tool rather than a
tax on the first.

Elsewhere: Slack's `slack_search_public` takes an optional
`natural_language_query` beside `keywords` and `filters`. Google's ADK ships
`transfer_reason` on `transfer_to_agent`, added "to prevent loops", and strips
it from the declaration unless `include_transfer_reason=True`. The OpenAI
Agents SDK documents `reason` as exemplary handoff metadata, on handoffs only.
Shopify's dev MCP asks for the user's most recent message verbatim, which is
telemetry rather than debugging. octocode-mcp shipped three such fields, posted
them to a telemetry endpoint, and has since stripped them from its dist; its
own manifest says they were "accepted and typed, not (yet) consumed
downstream". The `sequentialthinking` server's `thought` is not prior art at
all: it is the entire payload of a tool whose only job is to hold a thought,
annotating no action.

Against that: Linear, Notion, Chrome DevTools, Ahrefs, Guru, Ordinal, Exa,
Context7, Ref, Sentry, and Cloudflare's own servers all carry nothing of the
kind. The pattern appears in two places only — where a call is a routing
decision, and where it records a classification a person will later
second-guess. Valise has one of each.

The MCP project has already argued this out. SEP-2817, "AI Invocation Audit
Context in Request `_meta`", is open and seeking a sponsor, and says of the
schema-argument approach: "That pollutes tool schemas, does not generalize
across transports, and fragments audit logs across MCP servers", and "They also
make audit metadata look like business input." It also says `invocationReason`
"may be inaccurate, incomplete, or hallucinated" and "MUST NOT be used as
authorization evidence".

That last point is not hypothetical. Anthropic's own measurement of chain-of-
thought faithfulness found Claude 3.7 Sonnet mentioned a hint it had used 25%
of the time and DeepSeek R1 39%, and that models "very rarely admitted to using
the reward hacks in their Chain-of-Thought explanations… instead of being
honest about taking the shortcut, the models often constructed fake rationales".
That research measures narrative reasoning rather than a structured argument,
but it sets the prior.

## Decision

**Take the free context first.** `initialize` carries `clientInfo`, and the log
discards it: the non-tool branch of `observed()` records a resource uri and
nothing else, which is why every production row reads `oauth` and no row can
tell Claude Code from Claude Desktop. The whole `params` object is recorded for
a non-tool method instead. That costs no model tokens, captures `clientInfo`
today, and captures whatever a later protocol revision adds without a second
change.

**Read `_meta` ahead of any argument.** SEP-2817's
`_meta["io.modelcontextprotocol/aiInvocation"].invocationReason.text` is read
when present. The SEP is draft and no shipping client sends it, so this buys
nothing today; it is three lines, and it means the argument can be deleted
rather than migrated if the SEP lands.

**One optional `why`, on four tools.** The three claim-path calls, whose
arguments are a `todo:` id and a fencing token, and `save_memory`, whose body
says what was saved and not why it was typed and tagged that way. ADR-0003 put
that classification on the agent with the context; GitHub attaches its
`rationale` to exactly this decision, on `update_issue_labels` and
`update_issue_type`, and optional there too.

Not the other eight, where the functional argument already answers it. `search`
is the clearest case: the query *is* the intent, which is why Exa writes its
query description as "a semantically rich description of the ideal page".

Measured against the real twelve-tool `tools/list`: 13,985 characters without
the field, 219 more per tool that takes it. Three tools cost about 183 tokens,
4.7%; four cost about 243, 6.3%; all twelve would cost about 730, 18.8%, and
that last number grows with every skill published, because each one is also a
tool.

**Named `why`, asking for an explanation rather than for reasoning.** A
parameter named `reasoning`, `thinking`, or `trace` that asks a model to
reproduce its thinking is a documented `reasoning_extraction` refusal class,
and a refusal is billed. A short explanation or the evidence behind a call is
explicitly fine. The description says "in one sentence", which caps generation
cost; without it models write paragraphs.

**The description states its own limits.** Logged for debugging, never shown to
the user, never used for access control. The first stops the model writing for
an audience, which is what makes a label out of a reason. The third is
SEP-2817's `MUST NOT` put where the model reads it, and where the next person
tempted to branch on it reads it too.

**Optional, never required.** Required guarantees full coverage with no
guarantee of truth, which is the worst pair: confident prose at 100% fill, and
a standing temptation to trust it. Optional makes silence informative. It also
keeps a missing rationale from stranding a lease, which is the failure
`claim_todo` exists to prevent.

**One `intent` column, not two.** Both sources are model-asserted, so recording
which one a string came from is a distinction without a difference.

**Out of the evals' `requiredArgs`; measured as a fill rate instead.** The
harness scores a missing required argument as a failure, and the argument
column has no headroom — the committed run fails zero rows on one. Adding an
advisory field to that gate turns volunteered silence into a regression in the
one column that is currently clean. Fill rate measures the question actually
worth asking: do models volunteer it? Under about 60%, delete the field rather
than promote it.

## Amendments

- 2026-10-16, V1-14. Scope corrected from three tools to four before merge.
  This ADR originally excluded `save_memory` on the grounds that "the arguments
  already carry the reason", which conflated two things: the body says *what
  was saved*, and nothing said *why it was typed and tagged that way*. A second
  pass over the prior art found GitHub attaching an optional `rationale` to
  precisely that kind of classification, on `update_issue_labels` and
  `update_issue_type`, which is the same shape as `save_memory`'s required
  `type` and `tags`. The cost is 219 characters, about 61 tokens, 1.5% of the
  surface. Everything else holds: still optional, still never read by the
  server, still out of the evals' `requiredArgs`.

## Consequences

Gained: the log rows for the claim path and for `save_memory` say what the
agent thought it was doing, and every row says which client connected. Both without a per-client variant and,
for the second, without a token.

Given up: about 243 tokens on every `tools/list`, and a column holding prose a
model wrote about itself. Treat `intent` as a thing the model said, never as
the reason it called.

Inherited: ADR-0004 settled that provenance comes from auth context rather than
caller-supplied strings, and that rule is untouched — `why` is not provenance
and answers no question about identity. If it is ever read by anything but a
person looking at the logs tab, that is a new ADR and this one was wrong.
