# Review progression, ranking and subject approval

The October 30 implementation uses synthetic local D1 fixtures and external
provider doubles. Neither completed paid experiment was rerun. No private-memory
provider probe or production opt-in change is part of this evidence.

## Integrity

`test/d1/memory-review-progress.worker.test.ts` covers unchanged pair rotation,
changed evidence, indexed source history, selected subject membership, atomic
approval and stale-subject rollback. Ranking defaults off; independent request
and USD caps, consent revision/destination/model, account admission, pass owner
and overnight guards are exercised before external admission. Restoring a backup
clears ranking permission/manual qualification, increments its revision, retains
reservations and rebuilds the derived source-history index. Both real local
Wrangler recovery drills pass without remote resources.

## Retrieval

A provider-double test admits a current vector-only neighbor through the real
vector hydration adapter and rejects stale/foreign hints before Jev. The saved
selection record identifies vector retrieval and joint-review scoring. This
proves adapter wiring and tenant/current-head boundaries, not relevance quality.
The provisional 0.75 cutoff is not a truth score. The separately completed
`evals/memory-review/2026-10-29-candidates-run1/report.md` records the synthetic
quality evidence and its order/threshold limitations.

## Browser usability

The retained screenshots in `progression-2026-10-30/` show the populated default
view, subject primary action and requested source-history table at 1280px and
320px. P3 keeps the forms/history addressable; P4/P5 keep working rows in place;
P7 uses explicit membership checkboxes; P11 retains native forms; P14 keeps
history behind one line; P15 puts subject formation in a centred modal.

The native 320px subject test accepts with scripting disabled, follows the
accepted-subject link and confirms ranking remains off. The enhanced subject
test selects one source, nominates a summary, accepts and checks the resulting
subject's actual summary/membership. The first mobile history screenshot exposed
a clipped final column despite a passing page-width assertion. The corrected
table has a named keyboard-focusable horizontal scroll region, and the test
actually scrolls it before retaining the corrected evidence.

Subject freshness retains the existing conservative timestamp rule: a same-second
membership/summary write may display Needs review. The existing-subject picker
is bounded at thirty; pasted ids can add membership without replacing an
undisplayed summary. Neither these tests nor screenshots establish production
J2 insufficient-context acceptance.

## Production boundary

Build, version/traffic and deployed smoke observations belong to the merged PR
and the two owning Valise to-dos. Local integrity, retrieval and browser evidence
do not prove that production has deployed or that a private provider request
would succeed. Hybrid ranking ships off by default; synthesis stays separate.
