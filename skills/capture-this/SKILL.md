---
name: capture-this
description: How Valise wants a memory written, before you call save_memory. Read this when you are about to save one and want it findable by another client later. This is guidance, not a substitute for save_memory.
---

A memory is read by an agent that was not in this session. It sees a list of
titles, fetches one body, and acts on what it finds. Write for that agent: if
it could not act on the body alone, the capture has failed.

## What to save

The part of this session that would be expensive to rediscover: the
conclusion, the decision and what it rejected, the number that settled a
question, the dead end that looked promising. Not a summary of what happened.
If nothing here would be expensive to rediscover, save nothing.

## Choose the type

Default session learnings to `insight`. An agent trying an approach and finding
why it works is an insight, even when it considered and rejected alternatives.
Use `fact` for observed system or project state. Use `episode` when the history
itself is worth keeping, `preference` for how the user wants things done, and
`reference` for where a resource is and what it is good for.

Use `decision` only for a choice a person explicitly made or approved in the
conversation. Name who decided and point to that approval. Approval of a plan
counts for the choices the plan names. A request to implement a goal or capture
the session does not approve every implementation choice the agent made.
Without evidence of a person's choice, capture the learning as `insight`.
The source agent records the memory. It is not evidence of who decided.

For a decision, make the title and first body line the rule a future agent can
apply. "When X, do Y, because Z" is one shape, not a required template. A
one-off choice can name its concrete scope instead. Then give who approved it
and where, the reason, the rejected alternative, and the evidence. Put branch
history and shipped work last, or in a separate `episode` if worth keeping.

## Shape

One memory per claim. A research session that settled three questions is
three memories, not one digest. A focused body ranks far above a mixed one,
and an atomic memory can later be corrected or archived on its own.

- `title` is the claim itself, in one sentence, judgeable from a result list.
  "Valise search uses one shared FTS5 corpus, not per-concept indexes" is a
  title. "Notes on search" is not.
- `body` is Markdown, conclusion first. Then the evidence or reasoning, the
  alternatives considered and why they lost, and pointers back: file paths
  with their branch, URLs, ticket ids, the conversation when it matters. A
  memory without pointers strands the next agent exactly where it gets
  interesting.
- `type` answers the recall question defined above.
- `tags` are a few narrow topic words another agent would plausibly search.
- `project` is set when the memory belongs to one project.

## Examples

The user says they query the team's warehouse through its MCP rather than
ad hoc scripts. That is a `preference`, title "Query the warehouse through its
MCP, not ad hoc scripts", tagged `warehouse` and `tooling`.

The user explicitly says, "Use BM25 for this docs prototype, not embeddings."
That is a `decision`. Title it "Use BM25 for the docs prototype, not
embeddings". Open the body with that scoped rule. Then cite the user's choice
in the conversation, the measured reason, the rejected alternative, and the
eval doc and branch. State only reasons the session actually established.

If the agent picked BM25 while implementing the prototype and the user later
asks to capture the session, save an `insight` about what the comparison
showed. Do not turn the agent's choice into an approved rule.

If the session only confirmed that a redirect shipped, save the live location
as a `fact` when it is worth retrieving. Shipping work alone is not a decision.

## Unfinished work goes in a to-do

When the session leaves work for another agent, that is a to-do, not a
memory. Its next step copies names exactly as the user or a tool gave them:
the step or task identifier, file path and parameter values. Never invent a
command nobody gave. If the user said the remaining step is `reindex-full` on
shard `eu-2`, write "run `reindex-full` on shard `eu-2`". "Rebuild the European
index" sends the next agent guessing, and `scripts/reindex.sh --shard eu-2` is
a guess dressed as an instruction.

## Do not save

Credentials, access tokens, or private source material, unless the user
explicitly asks to store it. Session play-by-play that a transcript already
owns.

## Project rollup, only on request

When the user asks for an overview of a project, answer it, then offer to
save the answer as the project's rollup, and write it only if they say yes.
`type` is `episode`, `project` is set, and `tags` are `rollup` and
`covers_up_to:YYYY-MM-DD`, the date of the newest memory it covers. The body
says what the project is and where it stands, where it came from, the
decisions that shaped it with each memory's id, and the open threads. A
refresh is a new rollup with a later date.
