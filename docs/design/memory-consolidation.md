# Memory consolidation journeys

Memory review (ADR-0012, amendments of 2026-10-24 to 2026-10-30) can draft a
merged memory, a summary or a conflict link from memories an agent saved. This
file says how a person who is not the owner and not an engineer uses it. Each
journey carries the interaction contract `AGENTS.md` requires. The
mechanism, consent and budget rules stay in
[memory inbox operations](../operations/memory-inbox.md); nothing here
changes them.

The person in these journeys has a few hundred memories written by two or three
agents. They know what a memory is, because they saw their agents use them.
They do not know what a provider, a fingerprint or a pass is, and they should
not have to. What they want is fewer near-duplicates, clear summaries of
facts that belong together, and a warning when two memories disagree. They
want this without losing anything an agent still needs and without reading
every memory.

## J-0. Nightly upkeep, the journey the others serve

Added 2026-11-04 at the owner's request: "In the end this should work
overnight, consolidate automatically where possible, and only surface user
questions if needed." Before this, every draft waited for a click, a night
made two model calls against a queue holding the whole store, and three
separate switches stood between a person and a nightly run. J-A to J-C below
are now steps inside this journey: J-A is reading the questions, J-B checking
one memory by hand, J-C turning it on.

The person turns it on once. Each night Valise compares what their agents saved
since the last run, applies what only adds, and leaves a question only where a
person has to judge. They open Review when they choose, not every morning; its
status line says what the last run did and how many questions wait. Since
2026-11-08 the Review entry in the Memories sections carries the same number
on every Memories page, so a person sees that something waits without opening
Review (`todo:tdo_db97cd77-a88f-497d-a315-de730a503bde`):

| Contract | Waiting count beside Review |
| --- | --- |
| User job | Notice that nightly upkeep left a question while doing something else under Memories, without opening Review to find out. |
| Default populated view | On `/memories`, `/memories/subjects`, a subject page and `/memories?tab=review`, the sections read "All memories  Subjects  Review 3": the figure in the console's mono, ink rather than the section's muted grey, no badge or colour. The figure counts questions (`proposal` rows) for the whole account, not the J-B one-memory narrowing, so it reads the same on every page. |
| Primary action | Follow Review, which opens on Questions (J-0). The count is not a control of its own (P13). |
| Disclosed secondary details | None on the entry. A screen reader hears the link as "Review", with "3 questions waiting" as its description, so the accessible name the tests and assistive tech rely on stays one word. The per-view counts stay inside Review. |
| Failure states | No questions: no figure, the entry reads "Review" as before. The count read fails: no figure and a logged error; the page itself still renders. Reviews turned off with questions left: the figure still shows, because Review still lists them. |
| Loading budget | One `COUNT(*)` per Memories page load, on the `memory_review_retry (user_id, state, retry_at)` index; no provider call, no extra session lookup. The workspace strap does not carry it, so other pages pay nothing. |
| Evidence boundary | A D1 test shows the count is the person's own `proposal` rows and that the query plan uses the index; browser tests show the figure and description on four Memories pages at 1280 and 390px and no figure when nothing waits. Whether the owner notices upkeep's questions sooner is observed on the live instance, not tested. |

What a run decides on its own, and what it asks:

| Result | What the run does | Why |
| --- | --- | --- |
| Compatible summary (`summary`) | Applies it: a new memory tagged `rollup`, `related` links asserted by the model, originals untouched and searchable | It only adds. Undo archives the new memory. |
| Outdated summary (`stale-summary`) | Applies it the same way | It only adds; the old summary stays until a person removes it. |
| Duplicates (`consolidation`) | Asks: merge into one memory and hide the originals from search | Hiding originals needs a person's check that nothing true is lost (ADR-0012). An owner answer could move this to the left column; the question is on `todo:tdo_c312ae39-c8e1-4a41-89ed-6ec0ab6a2134`. |
| Conflict (`contradiction`) | Asks: confirm the two memories disagree | Only a person can judge which is current; Valise never picks a winner. |
| Nothing useful (`noop`) | Records it, shows it only under All activity | Coverage, so the same pair is not sent again. |
| Failure | Retries once an hour later, shows the count on the status line | Operational, not a question. |

| Contract | This journey |
| --- | --- |
| User job | Keep memories tidy without reading them: overlapping facts become one clear summary on their own, and only real judgments reach the person. |
| Default populated view | `/memories?tab=review` opens on the status line: "Nightly upkeep is on with Claude Haiku 5.5", then the last run in words ("Last run, Nov 4 02:00 UTC: compared 31 memories, added 3 summaries, 1 question for you"), and when the next run is due. Below it, three views: Questions (n), the default; Applied automatically (n); All activity. Questions lists what waits on the person, kind in plain words, plus the rows they decided, which stay in place (P5) until Hide decided. |
| Primary action | Answer a question: open it, read the proposed memory or the two conflicting claims, then Accept (merge, or confirm the conflict) or Dismiss. Next waiting question follows (P3). With no questions the empty state says so and points at Applied automatically. |
| Disclosed secondary details | Applied automatically: each row opens the added memory, its sources and quotes, and Undo, which archives the added memory and keeps the pair from being proposed again (P12). Check now and today's counts: "Today: 3 of 25 memory checks by hand, 12 of 50 at night", and with ranking on, "Candidate ranking today: 6 of 50 requests by hand, 24 of 100 at night", so a ranking stop always sits beside the ranking count it hit. Advanced: model, the two counts, ranking, and "Only check when I ask" (reviews on without nightly runs). How it works. |
| Failure states | No key for the model: the switch is disabled and the reason shown, no text is sent. Tonight's memory checks are used up: the last-run line says so and that the run continues next night. The account's cost cap ended the run: the last-run line says the cost cap, not the count, ended it. A failed check: the status line counts it; All activity says why. A source changed before the run could apply: the result stays a question. The person turned upkeep off mid-run: the in-flight call may finish, nothing further is sent or applied. Account no longer admitted: nothing runs and nothing is deleted. |
| Loading budget | The page reads settings, the last-run record, the grouped counts and thirty compact rows, as before; no provider call on any view. A run is one bounded pass a minute (eight starting memories, two model calls, 24 KB, 30 s per call) per due account, at most five accounts a minute, until the queue is empty, tonight's memory checks or the account's cost cap are used, or forty passes; then the next run is due at 02:00 UTC. |
| Evidence boundary | D1 tests with an injected drafter show what a run applies, asks, records and how it is rescheduled; browser tests show the views at 1280, 390 and 320px with seeded rows. Neither shows a provider producing these results in production; that is observed on the live instance after the owner turns upkeep on. |

Turning it on is one switch, "Tidy my memories every night", that names the
model and states the limits: up to 50 memories a night and at most the
account's daily cost cap, $0.50 unless an admin set another.
It turns on model reviews, nightly runs and automatic application together,
bound to the model the form displayed, and the first run starts within a
minute. Turning it off stops nightly runs and automatic application; checks
by hand stay available. Changing the model turns all three off, as before.

Three things follow, and they shape every journey below.

- The draft is the object, but only once they know what it does. The pane
  says in one line what accepting changes and lists the memories it comes
  from, then why, then the memory that would be saved, with Accept and Dismiss
  under it (P1, P13). The owner could not tell, on 2026-11-03, whether a draft
  added a memory or from which memories it came. Quotes come next, as the
  evidence for that judgment. Revisions, agents, fingerprints and model JSON
  are on request.
- Decisions are quick and reversible. Dismiss has Reopen on the same row (P12).
  Accepting adds a memory and never removes one unless they ask, so the
  ordinary accept needs no confirmation.
- Cost and destination are stated once, in plain words, where consent is
  given. They are not repeated above the list on every visit.

## J-A. Morning skim of overnight suggestions

The person turned on nightly checks last week. Overnight, Valise compared what
their agents saved yesterday and left three suggestions. They have five
minutes with a coffee.

| Contract | This journey |
| --- | --- |
| User job | Clear the suggestions that are waiting: keep the good merges and summaries, confirm real conflicts, drop the rest. |
| Default populated view | Since 2026-11-04 this is J-0's Questions view: `/memories?tab=review` opens on the upkeep status line, then the list of thirty questions and decided rows, newest first. Applied results live in their own view. Model, daily limits and candidate ranking are one collapsed Advanced disclosure with one Save for all limits; How memory review works is three one-sentence steps. A row's title is the drafted memory's title. Its description is the kind in plain words ("Combine overlapping memories", "Check a possible conflict") and the source titles. Its pill reads Waiting, Accepted, Dismissed or Failed. Decided rows stay in place (P4, P5). Hide decided (n) above the list removes them, and Show decided (n) brings them back. |
| Primary action | Open a waiting row. The pane leads with one line saying what accepting does ("Combine 3 memories that repeat each other into one new memory. The originals stay."), then the memories it comes from, each a link, with any compared but unquoted one marked "compared, not used". Why follows, then the proposed memory, whose body shows its first lines and Show the full text when long, then Accept and Dismiss. Read the proposed memory, accept it. For a conflict, confirm the conflict link. After the decision the pane offers Next waiting suggestion, which opens the next waiting row in list order with `replace` (P3). The person can work down the list without closing the pane. |
| Disclosed secondary details | Edit the draft's title or body (P2, P6). "Also replace the originals in search", with its separate retained-truth check. Accept and organize as subject (P15). For each source: the quote the draft relies on is shown, and revision, agent, how the source was picked, the full text and previous reviews are one disclosure away (P14). The original model response and the human decision history sit in one disclosure at the end of the pane. |
| Failure states | A source changed since the draft: the refusal is shown inline, and the edited draft stays (ADR-0012, stale refusal). A failed check names its fixed category and whether a retry is still due; a retry cancelled because its memories or the model changed says so. A check stopped by candidate ranking names the stage and the reason in words (Jev refused with its HTTP status, Jev timed out, today's ranking requests are used up, the admin's ranking cost cap is used up, Workers AI failed), on the check's report and on the status line until the next successful ranking. A save under Advanced that is refused shows its reason inline and keeps Advanced open; a limits form whose shown values changed elsewhere is refused with a reload instruction. Nightly checks turned off, or reviews turned off: the status line says so, and its switch is right there. Today's memory checks are used up: the report says so, when they reset, and that Advanced raises them. The admin's cost cap is used up: the report names the cap and that an admin sets it; the person has no money field (ADR-0012, 2026-11-04 limits). |
| Loading budget | Thirty compact rows. Load more adds thirty, up to a hundred. Opening a row loads one group's snapshots, its last fifty events and at most four source histories of eleven rows each. Browsing never calls a provider. The counts for the status line and the Hide decided toggle are one grouped query over the person's review groups. |
| Evidence boundary | Local synthetic review rows seeded into an isolated D1, at a volume of forty-five groups. This shows the layout and the decision flow. It does not show that a nightly cron ran or that a provider produced these drafts. That is J2 acceptance, `todo:tdo_dcd7f6e3-46b8-42d1-a4d9-fcfaf37e8b45`. |

## J-B. Check one memory now

The person is reading a memory in `/memories` and suspects it repeats two
others their agents wrote last month. They do not want to wait for tonight.

| Contract | This journey |
| --- | --- |
| User job | See whether this memory overlaps or conflicts with others, and act on it now. |
| Default populated view | The memory pane has one line under its history: "Memory review: in N suggestions", or "Memory review: check for overlaps" when it has none. The line links to `/memories?tab=review&memory=<id>`. That view keeps the same list and pane, narrowed to the suggestions whose sources include this memory. Above the list are the memory's title, Show all suggestions, and the action. |
| Primary action | Check this memory now. It runs the existing bounded check with this memory as its only starting memory. The same consent, lock, daily limits, two-call cap, 24 KB input bound and pair coverage apply. A new suggestion appears as a row in the narrowed list. The report line says what happened in words: found a suggestion, nothing new to compare, limit reached, already running. |
| Disclosed secondary details | Everything in J-A's pane. How candidates are picked stays under How memory review works. |
| Failure states | Reviews are off: the action is replaced by the consent switch and its destination sentence (P8). The model is not configured: the action is disabled and the reason is shown. The daily limit is used up, or another check holds the lock: the report says which, and no call is made. Every pair with its current neighbours was already compared: "Nothing new to compare". The memory is archived or belongs to someone else: the view says it cannot be found and shows no action. |
| Loading budget | The narrowed list reads the indexed `memory_review_sources(user_id, memory_id, …)` and keeps the thirty-row window. The pane's line is one indexed count. The check is at most two model calls of thirty seconds each. The button shows "Checking…" at once. Existing rows keep their order, and a new suggestion appears at the top (P4, P11). |
| Evidence boundary | A D1 test with an injected drafter shows that the check uses only this memory as its starting memory, skips the due retry and keeps pair coverage. Browser tests show the line, the narrowed list and the reviews-off and unconfigured states. No provider call is made in tests. |

## J-C. Turn it on

The person opens Review for the first time. Nothing is set up.

| Contract | This journey |
| --- | --- |
| User job | Understand what will happen to their memories, where the text goes and what it costs, then decide. |
| Default view | With reviews off, the page shows a setup panel in place of the status line. It says, in two sentences, that Valise sends up to four memories at a time to the named model each night, adds the summaries that only add, and asks about the rest, and that it sends up to sixteen memories at a time, cut to their opening, to write each one's lesson in a line (2026-11-08). It gives the most a day can cost. The primary switch is "Tidy my memories every night" and names the model; "Allow model reviews" beside it turns on checks by hand only (2026-11-04). The model picker and limits are one disclosure away. An empty list says what it will hold. |
| Primary action | Turn on Tidy my memories every night. The first run starts within a minute. Until 2026-11-04 nightly drafts needed a manual check first and a second switch; the owner's request for a working overnight journey removed that step. |
| Disclosed secondary details | Under Advanced: model choice with each model's most a single check can reserve, and its own Save because changing it revokes consent; memories checked by hand a day (1–100, default 25) and each night (1–200, default 50) in one form with one Save, which writes only the values that changed, and a sentence naming the two cost caps an admin set, read-only; candidate ranking with its destination sentence and its own switch, off by default (ADR README, open question "Candidate ranking on by default"). |
| Failure states | No key is configured for the chosen model: the reason is shown and the check is disabled. Changing the model turns reviews and nightly checks off, as before, and the panel returns. A stale consent form is refused with a reload instruction. |
| Loading budget | The settings, today's budget and the grouped counts. No provider call. |
| Evidence boundary | Browser tests at 1280px, 390px and 320px, with scripting on and off. Consent semantics are unchanged and covered by the existing D1 and UI tests. |

## J-D. An admin caps what review may cost

Added 2026-11-04 with the review limits (ADR-0012). The person in J-0 to J-C
chooses how many memories get checked. What a day may cost is the operator's
decision, so it moved out of the person's Advanced section to an admin control.
The admin is the owner or an address `VALISE_ADMIN_EMAILS` lists (`isAdmin()`).

| Contract | This journey |
| --- | --- |
| User job | Keep one account's model and ranking spend under a daily amount, raise it for an account that needs more checks, without reading anyone's memories. |
| Default populated view | `/workbench?tab=costs`, the Review costs tab. One line says the defaults ($0.50 review, $0.20 ranking), the bounds ($0.001 to $5.00) and that reservations count failures. Then one card per account, oldest first: its name, a pill saying "default" or "set by an admin", today's reservations against each cap ("review $0.0123 of $0.5000, ranking $0.0040 of $0.2000"), and the two caps as fields. |
| Primary action | Change a cap and Save caps. The card says Saved. Setting both back to the defaults removes the row, so the account follows a later change of default. |
| Disclosed secondary details | None. The account sees its caps read-only under its own Advanced, beside its counts. |
| Failure states | Outside $0.001 to $5.00 or more than six decimals: the field refuses it, and a posted value is refused in words with nothing written. Caps changed by another admin since the page loaded: refused with a reload instruction. A non-admin gets 404 on the tab and on the post, as for every admin page. |
| Loading budget | One query: accounts left-joined to their caps and today's two budget rows, at most 200 accounts. Only the Review costs tab runs it. |
| Evidence boundary | Playwright: the owner sets and resets caps, the account reads them, a member gets 404 on read and write. D1 tests: a cap set here stops review with "cost limit" and ranking with `ranking-cost-limit` in the same SQL statements that reserve each call. Neither shows a real provider's charges. |

## J-E. What my agents learned this week

Proposed 2026-11-08. Built so far: housekeeping without same-project
filler, nightly lesson lines with a coverage count on the status line, the
weekly reflection over lesson lines, principle cards with Adopt and Not a
rule, and Reflect now (ADR-0012 amendments of 2026-11-08). Not built:
transcript evidence, upkeep of adopted principles and the before-and-after
correction count. J-0 to J-D keep the store tidy: they find
memories that say the same thing and merge, summarise or flag them. That
shrinks the store and changes nothing about the next session. On 2026-11-05,
10 of the 19 review groups production had ever drafted were `noop`, and 6 of
those 10 had the same three same-project memories filling the slots. The
model was right each time: the memories were unrelated.

The owner's ask, 2026-11-08: future-oriented memories and principles, not
memories that relate to the same file. The memories that make a principle
share a mechanism, not a topic. Five observations are one lesson. The
first three are memories; the last two were never saved as memories and
live only in AGENTS.md and the agent harness's own warnings, which is part of
why transcripts matter below:

- a full verify takes a machine-wide lock because parallel runs pushed an
  8-core Mac past a load of 40;
- parallel Playwright runs in one worktree rewrite each other's `build/`;
- five branches generated migrations from the same main and collided on
  `0022`;
- the Workers build for #277 finished after #278's and put production back a
  commit;
- the git stash stack is shared by every worktree and session.

They name five different files, so keyword search from any one of them does
not find the others, and neither does an anchor-and-neighbours review. The
rule they share: anything parallel agents share needs a lock, isolation or an
explicit order, so a new script is designed for N agents, not one.

### The ladder

| Level | What it is | Made by |
| --- | --- | --- |
| Memory | One claim from one session: `insight`, `fact`, `decision`, ... | Capture, as now |
| Lesson | One line per memory: its mechanism with project nouns, paths, products and people removed | The nightly pass, once per memory revision |
| Pattern | One lesson recurring in at least three memories from at least two sessions and two distinct files or areas | The weekly reflection, by the model |
| Principle | A rule with applies-when, mechanism, evidence, exceptions and what would change | Proposed by the model, adopted by the person |
| Changed behaviour | An edit to AGENTS.md, a skill or a hook, or a to-do | Drafted from the adopted principle |

The lesson line is what makes cross-topic matching work under BM25
(ADR-0013). It follows the generalisation step TK-Boost (arXiv 2602.13521)
measured: corrective statements with table and column names removed scored
44.6 on Spider 2 SQLite against 41.6 for the same statements left specific.
"Concurrent workers sharing mutable state corrupt each other's output"
matches "builds run concurrently and the last to finish deploys" once
`Playwright` and `Workers` are gone from both.

A principle the model proposes is a card in `memory_principles`, not a
memory: model text enters the store only when a person adopts it, as review
proposals do. Adopting it writes a `decision` tagged `principle`, because a
person chose it, and the existing `decision` definition already requires
that. Evidence memories are linked to
it as `part-of`, counterexamples as `contradicts` (ADR-0012). No new link
kind and no new type.

### What a night and a week do

1. Housekeeping, nightly, unchanged in purpose: duplicates, conflicts and
   summaries as in J-0, without the same-project filler. A memory whose
   keyword neighbours all score below a floor is marked checked without a
   model call.
2. Lessons, nightly: the pass writes the lesson line for each memory that is
   new or revised since the last run. One model call covers about 40 short
   memories within the 24 KB input bound.
3. Reflection, weekly: one or two calls read the week's lesson lines, the
   lesson lines of adopted principles' evidence and the week's transcript
   correction pairs, and name at most five candidate mechanisms. For each,
   one search over all lesson lines brings in older memories, and one call
   drafts a principle only when the evidence rule in the ladder holds. As
   built: one cluster call over as many of the week's lines as fit 24 KB,
   then one draft call per mechanism, one call a minute, at most six a
   night. Older lines come in by keyword overlap with the mechanism's
   keywords, not a search query. Code, not the model, checks the evidence
   rule. A failed call ends the reflection; a spent count leaves it for the
   next night. The offline run below is why the model reads the lines rather
   than relying on search.
4. Upkeep of adopted principles, weekly: a new memory whose lesson matches
   an adopted principle is proposed as evidence for it or against it,
   ExpeL-style (Zhao et al., 2023). A principle with no new evidence for 90
   days is shown for a second look, never archived silently.

### Transcripts as evidence

ADR-0022 puts the agents' conversations in Valise as `transcript_turns`:
human turns, assistant text, tool calls and tool errors. Production held
1,118 sessions and 27,979 turns on 2026-11-08. Memories are what an agent
chose to save; transcripts show what happened whether anyone saved it. They
serve this journey three ways:

- Mistakes nobody saved. A `tool_error` followed by a human turn that
  corrects the agent is the raw material TK-Boost learns from. The weekly
  reflection reads the week's correction pairs alongside the lesson lines,
  so a mistake made in four sessions and saved in none can still become a
  pattern.
- Weight. A pattern also seen in transcripts carries a session count next
  to its memory count: "5 memories, seen in 23 sessions".
- Whether a principle worked. After adoption, the same correction should
  stop appearing. The principle card shows the count before and after, and
  that count is the success measure, not adoption alone.

Transcript text is searched only by `type: transcript` (ADR-0022) and is
read only with `transcripts:read`. A reflection that reads it runs under the
owner's own review consent and sends excerpts, never whole sessions, to the
review model.

### The journey

The person runs several agents over a week. On Monday they want to know
whether anything their agents learned should change how they work.

| Contract | This journey |
| --- | --- |
| User job | Learn what the agents learned this week, and turn the lessons that generalise into rules the next session follows. |
| Default populated view | `/memories?tab=review` opens on "This week's lessons": one to three cards. Each card shows the rule in one sentence, applies-when, the evidence as source chips ("5 memories in 3 projects, seen in 23 sessions"), and what would change ("Add to AGENTS.md › Rules", "Update the capture-this skill", "New to-do"). Below the cards, J-0's status line, reduced to one sentence about housekeeping. |
| Primary action | Adopt. The card becomes a `decision` memory decided by the person, its evidence linked `part-of`, and its "what would change" becomes a to-do in the owning project with the draft edit in the body. |
| Disclosed secondary details | Edit the rule's wording before adopting. Not a rule, with an optional reason, which the next reflection reads so it does not propose the same pattern again. Every evidence memory and transcript excerpt, with the lesson line that matched it. Counterexamples. Adopted principles with their evidence counts and the before-and-after correction count. |
| Failure states | No pattern meets the evidence rule: "14 new memories this week; nothing generalises yet", with the lesson lines one disclosure away. Reviews off, model unconfigured, limits or cost cap reached: as in J-0. A source changed since the draft: as in J-A. Transcripts not granted or not imported: the cards show memory evidence only and say so. |
| Loading budget | At most three cards, each with at most eight evidence chips. Opening a card loads its sources and at most five transcript excerpts of 1 KB each. Browsing never calls a provider. |
| Evidence boundary | Not built. The offline run below shows which patterns production memories form. It does not show that a person adopts them or that a principle changes later sessions; that needs the before-and-after correction count over real weeks. |

### Open in this journey

- Where lesson lines live. Decided 2026-11-08 (ADR-0012 amendment):
  `memory_lessons`, keyed by memory and revision, not projected into
  `search_docs` until the reflection reads them.
- Whether a person sees lesson lines at all, or only the patterns built from
  them. Forced by the first time a lesson line misstates its memory.
- Whether the reflection may read transcripts without a separate consent.
  Review consent today names memories going to the review model; transcript
  excerpts are a new destination for new text, so the default is a second
  switch until the owner decides otherwise.

### Offline evidence, 2026-11-08

All 223 live production memories were read with `scripts/prod-read.mjs` (one
SELECT, bodies cut at 1,200 characters). Four Sonnet subagents wrote a lesson
line, two to five mechanism keywords and a "do differently" line for each.
29 got no lesson because they are reference or taste data (a hostname, a
perfume, a fixture), which is the right answer for them.

Reading the 194 lesson lines (30 KB) turned up seven patterns that meet a
three-memory rule:

| Pattern | Memories | Projects | Precision@5, titles | Precision@5, lessons |
| --- | --- | --- | --- | --- |
| Agents spent sessions rewording descriptions and prompts that measured as noise | 16 | 2 | 0.41 | 0.68 |
| Two look-alike instances, surfaces or scopes share no state; establish which one you are on first | 13 | 5 | 0.20 | 0.38 |
| A success signal (exit 0, file size, no error, a green label) is not the outcome | 12 | 3 | 0.32 | 0.32 |
| A failure is a credential's scope; a broad credential hides a missing permission | 10 | 3 | 0.14 | 0.42 |
| Parallel agents sharing a machine, directory, number sequence or deploy queue | 9 | 1 | 0.49 | 0.47 |
| Measure the payoff on real data before optimising | 9 | 1 | 0.09 | 0.22 |
| Docs, constants and memories drift from the system they describe | 8 | 4 | 0.00 | 0.42 |

Precision@5 is the share of each member's five nearest BM25 neighbours (SQLite
FTS5, porter stemmer, terms ORed) that belong to the same pattern, searching
titles or lesson lines. The patterns were found by reading the lesson lines,
so the lesson column is biased in their favour; the title column is the
cleaner number, and it shows how little topic search sees of these patterns.

What this changes in the design above:

- Search over lesson lines is a candidate generator, not the clusterer. It
  lifted precision on five patterns and never above 0.68. A model reading the
  lesson lines found all seven. The weekly reflection therefore reads the
  week's lesson lines plus the lesson lines of adopted principles' evidence,
  and uses search only to bring in older memories. The whole store's lesson
  lines fit in two calls under the 24 KB bound today.
- "Two projects" is the wrong context rule. The parallel-agents and
  measure-first patterns sit entirely in `valise`, which holds 145 of the 223
  memories. The rule becomes three memories from at least two sessions and two
  distinct files or areas.
- The largest pattern is a cost: 16 memories record wording experiments that
  did not move the models. A principle adopted from it ("set the decision
  rule and the baseline variance before editing a description; stop after two
  reversions") is a change to how agents work, which a tidy-up pass cannot
  produce.
- "Docs, constants and memories drift" applies to Valise's own store. It
  argues for the 90-day second look on principles, and for the lesson pass to
  flag a memory whose pointers name files that no longer exist.

The memories and lesson lines stayed in the session scratchpad and are not
committed: they are the owner's production content.

## Not built: consolidating a cluster

A subject (ADR-0012, 2026-10-27) is the nearest thing Valise has to a cluster.
"Consolidate this subject" would compare its members with each other, not
each member with its keyword and project neighbours as a check does now. That
needs a different grouping rule and a different coverage rule: a subject of
twelve members has sixty-six pairs, and four sources fit in one model call.
Which members to group first is a product call, not something an experiment
can settle. What forces it: a person with a large subject asks for its summary
to be redrafted from its members. What keeps it open: J-B already covers one
member at a time, and Accept and organize as subject already adds to a
subject.
