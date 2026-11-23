# Principle cards, 2026-11-08

J-E slice 2: the weekly reflection and "This week's lessons" on the Review
tab. Synthetic fixture content only (`installPrincipleCards` in
`test/ui/fixtures/memory-review.mjs`); no provider was called.

Data integrity: `test/d1/memory-reflection.worker.test.ts` (15 tests). The
evidence rule is checked in code; adoption writes the `decision` memory,
person-asserted `part-of` links and the to-do in one batch, and an archived
evidence memory refuses all of it; a rejected card's rule reaches the next
cluster call as known; another account's card is neither read nor decided.

Retrieval: not changed. Lesson lines and cards are not in `search_docs`; an
adopted principle is an ordinary memory and is searchable as one.

Browser usability: `test/ui/memory-review.spec.ts`, "J-E this week's
lessons". The cards sit above the housekeeping status; one card's evidence
opens; the rule is reworded and adopted with a to-do; the other is marked not
a rule with a reason. No horizontal scroll at 320 px.

The screenshots of two cards (the first with its evidence open) at 1280 px
and 320 px were removed before publication because they showed personal
project names.

Production observation: none yet. Nightly upkeep is off on the owner's
account, so no lesson line, reflection or card exists in production.
