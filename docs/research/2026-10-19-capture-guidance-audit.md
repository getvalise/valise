# Decision capture audit

Date: 2026-10-19
Ticket: `todo:tdo_1e8f55b6-4942-4de7-868f-9ad4c75c2363`

## Scope

Read-only, search-selected sample of 11 production memories whose fetched
metadata says `type: decision`. Discovery used MCP `search` with `type:
"memory"`, queries `decision`, `decided`, the owner's name, `rejected`, and `shared
workspace`. Each listed memory was fetched in full. Search's type filter names
the concept, not the memory subtype. These results are not a production census
and cannot estimate the store-wide error rate.

The ticket's user correction supplies the interpretation of the docs-layout
example. For the other memories, missing attribution means approval is not
established by the memory, not that a person never approved the choice. The
writer's `source_agent` identifies the recorder, not the decision-maker.

No production memory was edited, retyped, archived, or linked. No skill was
published.

## Findings

Three bodies explicitly attribute a choice to a person. Eight do not. The
docs-layout example is among those eight, and the ticket confirms that its
layout was an agent's choice. The shared-FTS memory attributes the pick to a
Codex judge. A PR, an ADR, a rejected alternative, or a successful test does not
by itself establish human approval.

The four requested classification buckets, with missing approval taking
precedence over prose shape, contain 0 rule-first approved decisions, 0
history-only approved decisions, 3 mixed approved decisions, and 8 memories
without established human approval. Empty buckets have no examples to supply.

An independent prose-shape pass finds 3 rule-first openings, 1 history-led
implementation record, and 7 mixed openings. The rule-first test asks whether
the opening states an applicable choice before narrating its context. It does
not ask whether the body contains history anywhere.

| Memory id, prefixed with `memory:` for fetch | Subject | Human approval in body | Opening shape |
| --- | --- | --- | --- |
| `mem_450d2ae5-fa34-4238-ba00-2300af3a8f68` | Warehouse migration hub and source guides | None. Ticket confirms agent choice | History |
| `mem_1cd260d7-91c1-41a2-add0-c9bc02e90623` | Jev reranker and data sharing | Owner, 2026-10-19 | Mixed |
| `mem_b4d127b6-8331-4529-b936-5781667bddb0` | Hook token `config:read` scope | Owner, 2026-10-17 | Mixed |
| `mem_f667cb2e-8053-43e6-a52b-488d2921bad7` | POC tools are not frozen | Owner, 2026-10-17. Detailed tool proposal is separate | Mixed |
| `mem_ee1b8200-3515-4abf-b919-76c0154eff26` | One shared FTS corpus | Codex judge named, not a person | Rule |
| `mem_aa731029-1590-48c5-b099-c4e2420c9ee1` | AND semantics for tag filters | PR named, no person | Mixed |
| `mem_07b6ad85-f406-455a-a290-3790301b9649` | Inline editor geometry | PR named, no person | Mixed |
| `mem_c5b147ee-0854-4717-b72a-9ebb845644d0` | Startup brief recency proxy | Implementation named, no person | Mixed |
| `mem_7faa6e9f-1e1d-4fb9-af16-0bb9de184d60` | Bounded startup brief | Proposal and evidence, no person | Rule |
| `mem_87506841-263a-4004-a88e-b4e3733e68b3` | Keep Save and Cancel | Design sources and user complaint, no approval | Rule |
| `mem_b490264a-ea97-4ba1-8dca-9c5f6bb4eaad` | Recall-on-error defaults | Experimental selection rule, no person | Mixed |

Three examples with established approval are the owner choosing Jev, the owner
choosing `config:read`, and the owner lifting the tool freeze. Three without it are
the docs layout, the Codex judge's FTS choice, and the tag-filter implementation.
The last row also illustrates why a memory must carry its scope and evidence
rather than claim current production truth from an old experiment.

## Guidance under test

Default session learnings to `insight`, or use `fact` for observed state. Reserve
`decision` for a choice a person explicitly made or approved in the conversation.
A request to implement a goal or capture a session does not approve every choice
the agent made along the way. Approval of a plan counts only for choices the
plan actually names.

For a decision, put the applicable rule in the title and first body line. Then
name who approved it, cite the approval, give the reason and rejected path, and
put implementation history last. One-off choices can state the concrete scope
instead of inventing a recurring "when".

`capture-human-decision`, `capture-agent-insight`, and `capture-shipped-fact` in
`evals/cases.json` distinguish approval, agent learning, and shipped state. The
runner scores their type and skill read. Their `why` fields give the manual
rubric for rule-first prose and unsupported attribution. Type checks alone do
not prove the prose follows that rubric.

The sample does not authorize changes to the stored memories. The census below
replaces it for store-wide counts.

## Evaluation evidence

Grok and Luna each ran all three cases at `--repeat 3`, with no distractors.

| Run | Change | Exact-type pass | Unsupported decisions on agent-choice case |
| --- | --- | --- | --- |
| `2026-10-19T20-10-45` | Baseline | 12/18 | 6/6 |
| `2026-10-19T20-16-07` | Skill body only | 17/18 | 0/6 |
| `2026-10-19T20-17-15` | Skill plus schema and save description | 17/18 | 0/6 |

The two later runs each have one Luna `fact` instead of the expected `insight`.
Human-choice and shipped-state controls pass all twelve episodes in each run.
The skill-only run keeps the baseline tool hash `01534742f089`. Its store hash
changes from `b7467a0bd162` to `a1fc5cb45656` because the seed skill body changes.
The final guidance changes the tool hash to `8d02e91891a6` and keeps that skill
store hash. This isolates the skill's effect before adding schema guidance.

Manual review of the final run finds rule-first titles and openings and user
attribution in all six approved choices. None of the agent-choice bodies
invents human approval. Broader prose checks are not perfect. Grok's approved
choice repeats 0 and 2 omit the two-page cost, and repeat 2 puts history before
the rejected option. Luna's shipped-fact repeat 0 introduces a docs hostname
not supplied by the scenario. These defects remain visible in the run JSON.

The bounded +0 regression, `2026-10-19T20-17-50`, passes 26/26 over thirteen
existing save, capture, no-tool, and procedure-routing cases on the same two
models. Luna's `complete-nudge-capture` takes three turns against a budget of
two. It is not a full-suite model run, a repeated regression, or a test of
uncued classification without the skill. The schema test proves only that
the live tool advertises the guidance, not that a model follows it.

Reproduce the classification run against an isolated local dev server:

```sh
VALISE_MCP_URL=http://localhost:5185/mcp node evals/run.mjs \
	--models x-ai/grok-4.3,openai/gpt-6-luna --case 'capture-*' --repeat 3
```

The bounded regression used:

```sh
VALISE_MCP_URL=http://localhost:5185/mcp node evals/run.mjs \
	--models x-ai/grok-4.3,openai/gpt-6-luna \
	--case memory-preference,memory-decision,skill-direct,save-uncued,stop-nudge-capture,stop-nudge-nothing,complete-nudge-capture,complete-nudge-nothing,procedure-not-memory,no-tool-chitchat,no-tool-general,no-tool-local-scratch,no-tool-already-answered \
	--repeat 1
```

The repository skill source is retained for review. The production copy read
for this audit was v3. No candidate was published. Publishing it is a separate,
authorized action.

## Census, 2026-10-20

Read every live decision directly from production D1, before editing any memory:

```sql
SELECT memory_id, title, body, project
FROM memories
WHERE memory_type = 'decision' AND deleted_at IS NULL
ORDER BY memory_id;
```

The query returned 20 rows: 18 Valise and two acme-docs. All 20 bodies
were read. Four establish explicit human approval; 16 do not. Missing approval
in a body is not proof that approval never happened, so those 16 are review
candidates, not permission for bulk retyping.

With missing attribution taking precedence, the four requested buckets are:

| Bucket | Count | Examples (memory id suffix) |
| --- | --- | --- |
| Approved, rule-first | 1 | `63e2d20d`: exact-head local verification while Actions billing is unavailable |
| Approved, history-only | 0 | No examples in this census |
| Approved, mixed | 3 | `1cd260d7`: Jev choice; `b4d127b6`: hook config scope; `f667cb2e`: POC tool freeze lifted |
| Approval not established | 16 | `450d2ae5`: agent-chosen docs layout; `ee1b8200`: Codex judge's FTS choice; `c5b147ee`: implemented startup recency proxy |

There cannot be three examples in a bucket containing fewer than three rows.
Independently of approval, opening shape is nine rule-first, four history-only,
and seven mixed. The full classification is below; prefixes are sufficient to
identify the rows in this census, not replacement IDs for `fetch`.

| Memory prefix | Subject | Approval established | Opening |
| --- | --- | --- | --- |
| `07b6ad85` | Inline editor geometry | No | History |
| `1cd260d7` | Jev and data sharing | Owner | Mixed |
| `2bb15aea` | No undo toast | No | Rule |
| `3d9c038c` | Earlier BM25-only experiment | No | Mixed |
| `3fca0039` | Creatable combobox behavior | No | History |
| `450d2ae5` | Docs hub layout | No; user confirms agent choice | History |
| `63e2d20d` | Local/Cloudflare verification | Owner | Rule |
| `7df0743e` | Planned docs retrieval condition | No | History |
| `7faa6e9f` | Bounded startup brief | No | Rule |
| `81ec18d5` | Selective skill discovery | No | Rule |
| `87506841` | Keep Save/Cancel | No | Rule |
| `aa731029` | AND tag filters | No | Mixed |
| `b490264a` | Earlier recall-on-error experiment | No | Mixed |
| `b4d127b6` | Hook config scope | Owner | Mixed |
| `c5b147ee` | Startup recency proxy | No | Mixed |
| `c77d6891` | Use instr rather than LIKE | No | Rule |
| `c858ee34` | Quick-add syntax | No | Rule |
| `df887068` | Design principles source | No | Rule |
| `ee1b8200` | Shared FTS corpus | Codex judge, not a person | Rule |
| `f667cb2e` | POC tool freeze lifted | Owner | Mixed |

The ticket's 2026-10-19 user correction already settles the guidance: insight by
default; decision only for explicit human choice; rule first and approval cited.
The later blocker saying not to adopt that criterion misread the correction.
The owner asked on 2026-10-20 to finish stale claimed/blocked work. The retained
implementation and eval trio follow that explicit correction, not a new policy
invented by this audit.

Only `memory:mem_450d2ae5-fa34-4238-ba00-2300af3a8f68`, explicitly named by the
user, was retyped to insight and given a rule-first title/body on 2026-10-20.
Its implementation pointers and tradeoff remain; `edit_memory` preserves its
previous wording in append-only history. No other census row was changed.

## Current-surface classification check

Run `2026-10-20T11-51-19` repeats the three capture cases on Luna and Mini,
three times each, with current integration tools `d1451f8600f0` and store
`a1fc5cb45656`. All 18 routes read capture-this and call save_memory. Exact type
is 17/18: Luna labels one agent choice `episode`, not `insight`. No agent choice
is called a decision (0/6); explicit human choices are decisions 6/6 and shipped
locations are facts 6/6. This does not establish uncued classification quality.

Manual review of all 18 payloads finds rule-first titles in all six approved
choices. Five approved bodies lead with the rule; Mini repeat 1 leads with
approval attribution before stating it. Mini's three approved bodies omit the
two-page tradeoff. Luna shipped-fact repeats 1 and 2 infer different unsupplied
hostnames; the scenario supplies paths only. Those prose defects are retained
in the run rather than hidden by the 18/18 tool-route score.

Run `2026-10-20T11-53-52` covers the full applicable +0 suite on Luna and
Mini: 103 cases each, 206 rows. The runner explicitly skips 12 real-shell cases
and seven corpus-dependent retrieval cases. Accepted endings are 86/103 and
76/103; valid arguments are 84/103 and 72/103. All six capture-trio rows in that
single-repeat run have the expected type. Mini's startup-brief-rollup hits a
provider 400 about a missing tool output. Other misses include hook experiment
over-fire, skill routing and duplicate handling. The raw routes remain committed.
This is coverage on two models, not an all-green model suite or a paired estimate
of regressions caused by the guidance. Deterministic repository verification is
recorded separately against the final PR head.
