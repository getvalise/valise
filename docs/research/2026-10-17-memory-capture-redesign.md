# Memory capture redesign: typed claims, not session summaries

Date: 2026-10-17
Status: proposal, with the console and skill changes implemented in V1-18.
Hooks and auto-capture are design-only, recorded under "Capture without being
asked" below.

## What prompted this

Three weeks of real captures show the same failure. Asked to capture a
conversation-history dig into BM25, the agent saved one neutral paragraph of
what the eval framework plans, with no conclusion, no discarded alternatives,
and no pointer back to the conversation it came from. The console renders that
paragraph as raw Markdown in a three-column card grid that stops working past
a dozen memories, and the only search over it is a LIKE filter with free-text
project and tag boxes. Four problems, three of them distinct:

1. Capture quality: the skill never says what makes a memory worth
   retrieving, so agents write minutes instead of findings.
2. Classification: `type` is an open string with four ad-hoc values and no
   definition anywhere, so nothing filters on it reliably.
3. The console surface: cards that scale to ten memories, not a thousand,
   Markdown shown as source, and no clickable facets.
4. Capture only happens when asked.

## Where the typing should come from

The classification literature for agents settles the top level. Tulving's
trichotomy — episodic (what happened), semantic (what is true), procedural
(how to act) — is the frame the CoALA paper
([arxiv 2309.02427](https://arxiv.org/abs/2309.02427)) maps onto language
agents, and every 2025–26 agent-memory survey since uses the same functional
split. Valise already encodes it at the concept level: skills are the
procedural store, to-dos are prospective memory, and memories hold the
declarative rest. So `memory_type` should not re-answer "episodic or
procedural" — it classifies within declarative memory, and the useful axis is
the question an agent asks at recall time, not the topic (tags own topic).

The vocabulary, one type per recall question:

| Type | The recall question it answers |
|---|---|
| `decision` | What rule did a person explicitly choose or approve, who decided and where, why, and what did they reject? |
| `insight` | What did we learn, including an agent's implementation choices? |
| `fact` | What is true about this system, project, or the world? |
| `preference` | How does the user want this done? |
| `reference` | Where is the thing, and what is it good for? |
| `episode` | What happened, in a session worth retelling? |

Default session learnings to `insight`, or use `fact` for observed state. An
implementation request or a later capture request does not approve the agent's
specific choices. A decision's title and first body line state the applicable
rule, followed by who approved it and a pointer to that approval. The source
agent identifies the recorder, not the decision-maker.

The old seeded values map in: `user` and `feedback` become `preference`,
`project` becomes `fact` with the project field set, `reference` stays. A
"research" capture is not a type: a research session that settled three
questions is three memories (each an `insight`, `fact`, or `decision`), plus
at most one `episode` if the path itself is worth keeping.

The vocabulary is enforced softly, on purpose. The column stays an open
string (the schema comment already says so), the contract `describe()`s the
six types with one-line definitions, the capture-this skill teaches them, and
the console's type filter is built from `SELECT DISTINCT memory_type` rather
than from the constant — so vocabulary drift is visible in the UI instead of
rejected at the write. A new kind of memory is an edit to one constant in
`app/mcp/contracts.ts`, not a migration. A `memory_types` table would be
machinery for a problem a single user does not have.

## The title is the retrieval surface

`search` returns titles and snippets; the console table shows titles. An
untitled memory is invisible in both. So `title` becomes required in
`saveMemoryInput`, and the skill defines it as the claim in one sentence —
judgeable from a result list without fetching the body. This is the "full
capture plus a single line" split: title carries the claim, body carries the
evidence. No new column; the two fields already exist, they were just
optional and undefined.

## What capture-this now demands

The BM25 capture failed because the skill asked for "a fact, preference,
decision, or feedback" and stopped. The rewrite states the test — a cold
agent, not in this session, must be able to act on the body alone — and the
shape that passes it:

- Conclusion first, then evidence.
- Alternatives considered and why they lost. The discarded idea is often the
  expensive part to rediscover.
- Pointers back: file paths with branch, URLs, ticket ids, the session. A
  memory without pointers strands the next agent exactly where it gets
  interesting. Provenance columns record who wrote it; in-body pointers
  record where the material lives. Both are needed.
- One memory per claim. BM25 ranks a focused body far above a digest, and an
  atomic memory can be superseded or archived without collateral.

The `save_memory` tool description carries a compressed version of the same
discipline, because most clients call the tool without ever reading the
skill. Both are eval-gated surfaces; `npm run evals` must be rerun.

## The console surface

The memories page follows the V1-15 skills precedent: a dense table (title
over a body snippet, type, project, tags, age), one row per memory, detail in
a modal. The modal renders the body as Markdown (react-markdown — React
output, no raw HTML pass-through, SSR-safe), shows provenance and timestamps,
and keeps the edit form and archive action. Type, project, and tag cells are
links that set the corresponding filter, and the filter bar gains a type
select fed by the distinct types in the store.

## Capture without being asked

Valise is a server; it cannot install behaviour into a harness, and the
landscape research already drew the honest line: an MCP server never sees the
conversation, so server-side capture can never be more than a nudge. Three
tiers, none of which belong on the MCP server as a toggle:

1. A Claude Code plugin shipping hook configs. A `SessionEnd` or `Stop` hook
   that injects one line — "if this session produced a decision, insight, or
   dead end another session would pay to rediscover, call `save_memory` per
   capture-this" — puts the capture decision in the model that holds the
   context, which is the same write-time-classification argument the spec
   already makes. The on/off switch is the hook's presence in the plugin
   settings, client-side, per harness.
2. Response nudges from the server: `complete_todo` already receives a
   summary, and its result could append the same one-line reminder. Reaches
   every harness with zero client setup. Cheap to try, easy to pull if it
   produces noise.
3. Transcripts (v1.5, already in the spec) are the lossless tier. Memories
   stay curated claims; "capture everything" is the transcript pipeline's
   job, not a hook's.

An MCP-server toggle for hook behaviour is the one shape that does not work:
the server cannot see whether a hook fired, and a config that lives where the
behaviour does not is a drift machine.

## Open questions

- Console search still runs LIKE over title and body while agents get BM25.
  Routing the console search box through `search()` would make the console
  show what agents see, which is the honest view — deferred until the LIKE
  filter actually misleads.
- Staleness. A `fact` from March can be wrong in October. The v2
  classification slice (spec: suggestions in the UI, never silent writes) is
  the natural home for "this memory contradicts that one"; nothing in v1
  blocks it, since revisions and archive already exist.
- Whether `episode` earns its place. If three months of captures show zero
  episodes, delete the type from the constant and this doc gains an
  amendment.
