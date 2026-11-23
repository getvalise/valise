# 0010. Valise holds the work, and the plan stops being a checklist

Date: 2026-10-17
Status: accepted

## Context

`AGENTS.md` has carried two work surfaces since the program opened, and argued
for both. The plan answers whether v1 shipped: one box, one unit of work, a box
ticked only when its evidence exists. Valise answers what is claimable now and
who holds it: a to-do with a lease and a fencing token. The reference ran one
way — a to-do names its slice, the plan never names a to-do id — and the rule
beside it was that a third place is the thing to avoid.

Twenty-five slices in, the second surface costs more than it answers.

**The number is allocated by reading the tree while the tree moves.** A session
picks the next free `V1-NN` or `NNNN-` by looking at `main`, and a parallel
session looking at the same `main` picks the same one. `docs/adr/0008` was
written twice on 2026-10-17 — once as the migrations decision, once as the
key-value facets decision — and the facets ADR became 0009 after the collision
surfaced. The merge order says the same thing from the other side: V1-23 landed
as PR #18 and V1-22 as #16, both before V1-24 and V1-25 landed as #15. Valise
already solves exactly this for work, with an atomic claim and a fencing token,
and the numbering ignored it.

**The generated pair turns a tick into a conflict.** `docs/roadmap.html` and
`docs/roadmap.json` are 6,399 committed lines rebuilt from the plan, and
`npm run verify` fails when they are stale, so every plan edit carries them.
PR #17 ticked four merge boxes and shipped 23 changed lines across three files,
two of them generated, and still had to be rebased. Two sessions ticking boxes
in different slices conflict in a file neither of them wrote.

**The product's own queue is not load-bearing while a second tracker exists.**
Valise's argument is that one store serves a person and several agents at once.
A repo that keeps its real checklist somewhere else is not testing that claim,
and the gaps show up as reports rather than as bugs: the six design debts in
V1-25 came from a person using `/todos` for an afternoon, not from the plan
that had every one of those boxes unticked the whole time.

## Decision

**Valise is the only queue. The plan is a record, frozen where it stands.**

Work lives in the running instance as a to-do, with `project:valise` and a
`doc` ref at whatever explains it. `list_ready` and `/todos` are the two ways
to read it. There is no second list to keep in sync, which is the same rule
`AGENTS.md` already stated about a third place, now with one place left.

`docs/plans/2026-10-12-valise-v1-implementation.md` stays on disk and stops
moving. Its boxes keep the state they had at this commit, ticked and unticked
both, because they are the evidence trail for what v1 cost: the files each
slice touched, the measurement behind each decision, the lane that proved it.
Nothing ticks one again. The plan's open boxes that still name real work became
to-dos in the same change that froze it; the rest were per-PR rituals that were
never going to be ticked once.

The roadmap goes with the checklist it rendered. `scripts/roadmap.mjs`,
`docs/roadmap.html`, `docs/roadmap.json`, the workbench Roadmap tab and the
`roadmap:check` step in `verify` are all deleted rather than repointed. A
generated view of a frozen document is a stale file waiting to happen, and the
console already renders the live queue at `/todos`.

**The identifier comes from the insert, not from the tree.** A to-do id is
allocated by `create_todo` against one D1 row, so two sessions creating work at
the same moment cannot collide. `V1-NN` is retired with the plan — it names a
slice in a record, never a piece of open work. ADRs keep `NNNN-`, and keep the
race with it: the number is still read off the tree. That is one allocation
every few weeks against a surface a person owns, and the ADR README is where a
collision is caught. Revisit if it happens twice more.

## Consequences

Gained: one surface for work. A session reads the queue it already has an MCP
connection to, claims with a lease a parallel session has to respect, and
closes it when the PR merges. Ticking a box is a tool call rather than a commit,
so a progress update stops being a pull request.

Gained: 6,399 generated lines out of the tree and a step out of `verify`. Two
sessions working different slices no longer conflict in a file neither wrote.

Given up: the at-a-glance view, and reading the work without signing in. The
roadmap rendered percentages per slice and the ADR index beside them, offline,
in one file. The replacement is the console and `list_ready`, both of which
need an endpoint and a token, so the queue is unreadable from a plane and
unreadable in a PR review. Accepted: everything that was true about v1 is still
on disk in the plan, and open work was never the part a reviewer read.

Given up: the gate. `npm run verify` no longer fails when a shipped slice went
unrecorded, because there is nothing left to be stale against. A to-do left
claimed after its PR merged is now the only way that failure shows, and it
shows to whoever reads the queue next rather than to CI.

Made harder: reconstructing why something shipped, once the to-do that carried
it is closed and the plan no longer grows a section. The answer is that a
decision worth reconstructing goes in an ADR, which is where it should have
been, and a to-do's `body` and its `todo_updates` log carry the rest.

Unchanged: `AGENTS.md`'s loop, minus the roadmap step. Claim before working,
one box of evidence per claim, `npm run verify` before every push, and complete
the to-do when the PR merges rather than when the branch is pushed.
