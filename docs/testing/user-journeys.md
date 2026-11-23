# User journeys and end-to-end acceptance

Valise's live queue owns work, state, claims and blockers. This is the acceptance
contract and test catalog, not a second backlog. Fetch a journey's live parent
for its children and current evidence. Parent edges organize work; they do not
make a prerequisite, clear a manual blocker or complete children automatically.

## Journey owners

| Journey | User outcome | Live acceptance parent |
| --- | --- | --- |
| J1 | Keep what I read, find it by author or idea, and let agents quote it back when it matters | [Library](https://app.valise.run/todos?open=todo%3Atdo_18708028-3235-4712-94f5-c3f02eece146) |
| J2 | Improve memories without surrendering consent, evidence or judgment | [Memory review](https://app.valise.run/todos?open=todo%3Atdo_dcd7f6e3-46b8-42d1-a4d9-fcfaf37e8b45) |
| J3 | Manage daily work with people and agents looking at the same task | [Tasks](https://app.valise.run/todos?open=todo%3Atdo_c7bb26a5-a3b3-453e-a847-a004864e06c3) |
| J4 | Agent A leaves useful context; fresh Agent B resumes the actual work | [Existing resumption milestone](https://app.valise.run/todos?open=todo%3Atdo_125a5a13-e461-4ef6-b121-117496a5387d) |
| J5 | Connect a client or independently install and operate Valise | [Existing publication/self-host milestone](https://app.valise.run/todos?open=todo%3Atdo_48a78889-238f-40d2-b77d-e2be4f3f6cc0) |
| J6 | Invite another person into a private case and retain fair service under load | [Tenant safety and capacity](https://app.valise.run/todos?open=todo%3Atdo_6335028d-5672-41e3-aafe-3f90f9ea8933) |
| J7 | Recover the installation, originals and decisions after loss | [Existing independent-backup activation](https://app.valise.run/todos?open=todo%3Atdo_c4bb8bca-df45-4c2e-a64e-e37087907bc8) |
| J8 | Write, version and publish a skill, and use it from any client | [Skills](https://app.valise.run/todos?open=todo%3Atdo_f5cc0b76-b60a-48d9-a91f-12fb4b462119) |
| J9 | See what my agents did while I was away | [Activity trail](https://app.valise.run/todos?open=todo%3Atdo_598f64cd-b5c9-4177-bf71-3e88d7657273) |

Use one primary parent, preserving intermediate delivery groups. For example,
embedding/storage/backlog budgets and limiter instrumentation belong under the
existing workload-budget task `tdo_5b3f57f4`, itself under J6. Domain contracts,
summary selection, personal review and outcome evaluations belong under J4.
The crosscutting integration task `tdo_75c7b68d` belongs under J4 and links the
other journeys in comments; documentation `tdo_87dec2f1` belongs under it.
Attachment picking belongs to J1 but also supports J2/J3. Bounded console
cursors belong to J6 but support J1/J3/J5. Keep those secondary links in live
comments/refs rather than duplicating or repeatedly reparenting the work.
The recovery-drill release repair `tdo_f549fec4` belongs to J7 and links back
to integration; its owner, test reservation and deployment gate stay intact.

## What counts as evidence

A journey is accepted only when its integrated, version-appropriate path has
been exercised through the actual browser and MCP/client surfaces, its visible
and durable outcomes checked, and findings recorded on the live parent. Feature
delivery can finish without closing its journey acceptance parent.

Record these fields with every acceptance run:

| Field | Required evidence |
| --- | --- |
| Identity | Date, exact source/server commit, tool/schema and fixture hashes where relevant, origin, Workers Build ID, deployed version and traffic allocation. Distinguish runner revision from server revision. |
| Person and client | Owner/member, fresh or established browser profile, client/version and actual hook delivery mode, scope names without secret values. |
| Conditions | Synthetic fixture IDs, corpus sizes, starting state, selected model/backend, provider availability, consent flags, explicit clock/window and concurrency. |
| Actions and outcome | Browser route/control sequence and MCP calls, authoritative returned IDs/rows, revisions, checksum/search observations, screenshots and sanitized request/error evidence. |
| Cost and limits | Calls, turns, tokens, reservations versus billed usage, latency and observation deadlines, SQL/rows/payload measurements. State unknowns rather than inventing an SLA. |
| End state | Cleanup of named fixtures/resources and credentials, remaining failures, exact live task IDs for findings and narrowly stated proof boundary. |

`npm run verify` is the push/merge gate, including Playwright, not a synonym for
all journey acceptance. Unit/schema tests, model rubrics, mocked provider
responses, tool-choice scores, screenshots and health/CSS/MCP smoke each prove
their own layer only. Test source in this catalog is not a claim it ran here.
`UNTESTED` below means the integrated evidence is still required, even when
individual components have passed. Historical evidence stays tied to its head.

The catalog and `UNTESTED` observations below inventory source `b64c8d9` on
2026-10-24. Later release/run evidence belongs on the live journey parents;
add precise evidence-file references here when available, without turning the
catalog into a continuously updated release board or erasing failed runs.

Source and production can differ. At this contract's 2026-10-24 inventory,
Memories UI PR #186 was merged at `b64c8d9`, but its Workers Build failed;
the last confirmed production release was Library PR #185, `ed80454`.
Initial Build detail/log access returned 403. Subsequently the integration owner
reported the actual Build log's recovery drill hitting its 180-second timeout.
The failed Build remains historical evidence, not a passing late result.

At 2026-10-24T21:57:46Z, repair [PR #187](https://github.com/getvalise/valise/pull/187)
had merged as `9487c2fb6879739f46c5d2cc66ba683c6f4f1b64` after the exact
`99b0ac7` local gate (1,126 tests) and same-head build. The integration owner
confirmed successful Workers Build `eba672b3-01e6-4c32-b40d-2c4baa718879` and
deployment `983284ac-39d2-40e9-987c-f4d62b0610a8`, created at
21:57:39.805707Z, serving version `70e36c1c-71cb-48ac-b1f5-39e6ef319b29` at
100% traffic. Origin smoke passed; protected review, legacy inbox and Library
routes returned their expected authentication redirects. UI #186 was included
in that deployed release. This closes the recovery-build repair and UI delivery,
not J2/J7 full acceptance: signed-in deployed review/OAuth behavior, chosen-model
integration, independent backup activation and fresh-deployment restore still
need their own evidence. Haiku replacement and Library redesign source work
were not deployed evidence at that timestamp.

Do not infer a feature is live from a merge, a local green suite or an old
successful Build. Confirm the exact Build and deployed version after release;
never repair the gap with a laptop deploy or by weakening a gate.

## Execution environments

Ordinary runtime/browser checks use isolated local D1/R2/KV/coordinators, no
production credentials, synthetic non-private content and remote bindings off.
Each Playwright worker starts `wrangler dev` on the production build with its
own free port and state directory under `.wrangler/ui-test/`
(`test/ui/fixtures/server.ts`), so concurrent runs in other worktrees need no
port or slot. Check `.dev.vars` before running: the suite loads it over fallback
secrets. Keep credentials, raw private SQL, signed URLs and profile data out of
reports. Retain failure artifacts privately; redact before publication.

```sh
npm run verify
# Focused checks do not replace that exact-head full gate:
npx playwright test test/ui/library-loading.spec.ts test/ui/memory-review.spec.ts test/ui/todo-relations.spec.ts
```

This document does not authorize paid inference, remote synthetic load, invitations/email,
production mutations, private-document processing or new Cloudflare resources.
Obtain a bounded run grant first. For release acceptance use a dedicated
approved disposable deployment and real credentials, not loopback impersonation
headers or development fixture endpoints. Observe the owner's populated
production view read-only only when authorized; local realism and actual
user-profile usability are separate checks. Tear down only the named resources
created by the run after retaining evidence; never clean broad shared paths.

## J1. Keep, find and reuse what I read

Goal: the Library is the owner's archive of what they read and trust. It knows
what they have not read yet, finds an idea by author or concept down to the
page, and lets agents quote it back when it helps the work at hand. It is an
archive first: books are never read inside Valise. A saved article can be read
at its source or, from the text kept at capture, in the Library's reader view.

This journey is written from the owner's answers on 2026-10-25. Their saves are
roughly 40% articles, 30% reference PDFs, books and presentations (a share that
keeps growing), 10% other bookmarks such as repositories and tools, 5%
recordings and podcasts, and 5% images and other references such as design
material. They use it for two jobs:

- Reference works as lenses. "Use the business model canvas to analyze this
  company", "use Smil's work to assess this article", "use Wardley mapping for
  this idea", "what does the Oxford Handbook have on this concept".
- Articles to keep up, for current projects, and as an archive in case the page
  disappears or a subscription ends.

A bookmark manager such as Raindrop stays in use for now. Valise should be able
to replace it later.

Start with an authenticated console and two clients for the same tenant, a
loaded MV3 extension, an iPhone, a few hundred imported bookmarks, a public-domain
book, a presentation, an article with highlights, and an unread article on the
same topic as an open to-do.

1. Capture with one action. On desktop, one click in the extension saves the
   page and its readable text. The popup then offers a note, suggested tags,
   kept and project, each optional. Right-clicking a selection adds a highlight
   to that page's item. On the iPhone, the share sheet saves a URL. Agents save
   when asked, or on their own when an article has been discussed at length and
   is not in the Library yet. A file dropped in `/library` (book, PDF,
   presentation) is saved the same way. New captures are unread.
2. Processing runs within a visible cost budget. Each item gets a summary, key
   concepts and an author. Long works are indexed by passage, keeping the page,
   chapter or slide. Bookmarked articles keep a text snapshot, so they survive
   link rot. Originals never change.
3. Read at the source, then mark it. An item is unread, read or kept. Reading
   never promotes to kept. Rating, a highlight or a note marks interest.
4. Find by title, author or idea. "What did Smil say about energy density"
   returns the passage and its page. An author view gives the gist of their
   work, the owner's highlights and how often they return to it. Browsing the
   kept items, and the unread queue, are views of their own.
5. Agents use it lightly. A fresh agent working on a to-do may bring up at
   most one related kept item that hasn't been used for a while, with a quote
   and a citation, and nothing when nothing fits. Answers cite the passage they
   used. Using an item in a conversation counts as use.
6. Relevance follows use. Nothing expires. Unused items rank lower over time;
   highlighted, noted, rated and discussed items rank higher, and so do their
   authors.
7. Related files stay together. A set of icons or reference images is one
   group that expands in place, with each original kept.

Visible outcome: one-action capture everywhere the owner reads; an unread queue
separate from what they kept; idea and author search that lands on a page; and
agent answers that cite the owner's own sources without forcing them in.
Originals are unchanged, and archive, delete and unlink each say what they do.
Nothing is sent to a provider just because someone browses the Library.
Processing cost is visible and stays within the owner's budget. P1/P2/P3,
P7/P9/P10/P11 and the Library retrospectives
(`docs/retros/2026-10-24-library.md`, `2026-10-24-library-acceptance.md`)
settle interaction acceptance.

Release state on 2026-10-25: the reading-first redesign and MIME-only PDF fix
shipped in #193. Steps 1–7 above mostly do not exist yet. Each gap is a child
of the J1 parent:

| Gap | To-do |
| --- | --- |
| Unread, read and kept states; rating | `tdo_fc88ccff` |
| Whole books by passage with page numbers (today: 8 MiB in, 64 KiB of text kept) | `tdo_1e9bd9ad` |
| Summary, key concepts, article snapshots, concept search over bookmarks | `tdo_ed8d9196` |
| Author field and author view | `tdo_b2dff1ba` |
| Save on first click, suggestions after; right-click highlights | `tdo_0cf48894` |
| Relevance from use, with decay | `tdo_1295c2ad` |
| Light agent surfacing and agent save rules | `tdo_d00b4ae2` |
| iPhone share sheet | `tdo_2e915ed9` |
| Explicit groups | `tdo_47612d15` |
| Ongoing Raindrop import | `tdo_4d64cdd2` |
| Extension OAuth connect | `tdo_2baf06c2` |

Recordings and podcasts are saved as bookmarks for now; transcripts are not in
scope until the owner asks.

Failure/permission/staleness: deny host consent, invalid/revoked/narrow bearer,
foreign asset/source IDs, unsupported/corrupt/oversize documents, failed PUT or
finalize, quota refusal, timeout and uncertain source creation. A lost source
response requires checking persistence before another save, not blind replay.
Refuse stale suggestion application after a human edit; preserve the original
and explain retry/cooldown without saying provider cancellation was proved.
Test keyboard, 390/320px, reduced motion and no-script native upload, filters,
preview links and review forms. The Chrome extension itself requires scripting;
the console fallback, not a fictitious scriptless extension, is the floor.

Existing catalog: `test/ui/chrome-extension-loaded.spec.ts` drives the actual
loaded extension locally, connects it through Chrome's OAuth window and the
Valise consent page, and disconnects it again, but grants the host
programmatically, not by clicking the native host-permission dialog. `chrome-capture.spec.ts` and
`chrome-capture-security.spec.ts` check DOM capture/redaction/inert delivery;
`library.spec.ts`, `asset-thumbnail.spec.ts` and `asset-processing.spec.ts` cover browser upload,
previews, failures, pending/suggestion/stale/no-script behavior.
`library-loading.spec.ts` checks 895 sources, 30-row windows, rare filters,
older-page saves/reloads and HTML below 1 MB. Supporting runtime suites are
`test/d1/library-loading.worker.test.ts`, `asset-processing.worker.test.ts`,
`test/mcp/chrome-capture.worker.test.ts`, `assets.worker.test.ts`,
`sources.worker.test.ts` and `library.worker.test.ts`. These are separate paths,
not a single full capture-to-processing-to-fresh-client proof.

`test/ui/library-ux.spec.ts` covers the #193 reading-first layout.
`test/ui/capture-journey.spec.ts` covers the capture journey below.

UNTESTED acceptance: everything in steps 1–7 that the children above own; the
integrated journey at the released head; native Chrome consent; the MIME-only
PDF repair on a deployed origin; and the populated owner-profile walkthrough.
The Chrome acceptance task has a later production-success comment; reconcile
its exact scope and artifacts with its remaining blocker rather than repeating
the stale blocker or closing it here.

Fixtures/cost/cleanup: use the existing local processing/review fixtures for
deterministic failure/stale checks; these do not call the provider. Any actual
five-format/hybrid proof follows [asset-processing probe limits](../operations/asset-processing.md#bounded-live-acceptance-probe):
disposable index/namespace, five uploads once, bounded delivery/observation,
recorded usage and explicit cleanup. Keep original fixtures and failed reports;
revoke only the run's capture token and remove its profile/resources. Portable
export/import checks follow [library export](../operations/library-export.md),
not installation recovery.

### J1 capture: see the article, save it, read it

Goal: on desktop, the owner knows what the extension will keep before saving,
can keep the article without the page archive, and reads it later in Library.
The interaction contract is ADR-0015's amendment "a reader view, and the
article shown before it is saved"; `docs/operations/chrome-capture.md` has the
mechanism.

Start with a connected extension (0.6.0 or later) and a long public article.

1. Open the article and open the extension. The popup says "Article found",
   with the byline, site, date, word count and a three-line excerpt. The
   article's paragraphs are tinted on the page; the page's HTML is unchanged.
   Save article is in view without scrolling.
2. Add a tag and choose Save article. The popup confirms the article and the
   full page. Closing the popup removes the tint.
3. On another article, clear "Also keep the full page as an archive" and save.
   The popup says no copy of the page was kept. The choice holds the next time
   the popup opens.
4. In Library, the card shows the byline and "Read the article". The reader
   shows site, title, byline, date and word count, Original page and, for the
   first save only, Archived copy, then the article at a reading measure with
   images as links. At 320px nothing scrolls sideways.

Failure states: not connected shows only the sign-in prompt. A paywall teaser
or a tiny page says "No article found — the full page will be saved" and
offers Save page with no archive choice. The Chrome Web Store, an error page
and Chrome's own pages say nothing can be saved and show no Save. A reader id
that is unknown or another person's is 404. A saved page with no article
opens a reader that says there is nothing to read and links the archive.

Evidence: `test/ui/capture-journey.spec.ts` runs steps 1–4 and the failure
states on the loaded extension against the local Worker, with routed fixture
pages and the popup at its real size, and the reader at 1280 and 320px. On
2026-10-29 the shipped `extract.js` found the article on the Wikipedia DuckDB
page (1,252 of 1,532 words) and on a 6,685-word blog post, tinting 50 and 225
paragraphs in about 45 ms. UNTESTED: the Web Store refusal, which Playwright
cannot open, and a production save from the owner's Chrome; both are steps 8
to 10 of the manual check in `chrome-capture.md`. Selecting readable text by
hand when nothing is detected is `tdo_6006bf94`; the no-article state is where
that control will sit.

## J2. Improve memories

Goal: obtain useful consolidation without losing attribution, true qualifiers,
contradictions or human control. Start with synthetic compatible/conflicting
pairs and insufficient-context fragments, a second tenant's tempting matches,
immutable revisions, reviews off and overnight off. Record the actual deployed
model and rate policy; a selected Haiku candidate on a branch is not the live
default or an instruction to enable transmission.

1. Save the source memories through MCP and inspect them in `/memories`.
2. Open `/memories?tab=review`; its URL must retain the selected
   review/editor/depth. Read the provider/data-transfer and budget statement.
   Explicitly enable reviews, select an available provider, then run one bounded
   manual pass only with the approved spend and synthetic content.
3. Inspect exact quotes, source revisions and attribution. Edit the draft,
   accept a compatible summary and verify originals remain unchanged/searchable.
   Separately attest retained truth before supersession. Approving contradiction
   confirms the relation without selecting a winner.
4. Dismiss/reopen another proposal in place. Fetch/search the accepted memory
   from a fresh client and inspect its human-approved provenance and links.
5. Turn reviews off. Overnight requires its separate opt-in and prior manual
   pass; demonstrate eligibility/authorization rather than assuming a cron ran.

Visible outcome: suggestions are drafts until judgment; model confidence,
frequency and recency confer no authority. A changed source/draft or duplicate
acceptance cannot publish a stale/extra memory. Refusal retains the human draft.
An unavailable provider stops before transmission/reservation; no silent
cross-provider fallback. Existing in-flight authorized transmission cannot be
recalled by the off switch. Failure reservations remain spent as documented.

Failure/permission/staleness: missing key/provider, malformed/invented evidence,
timeout, daily call/cost limit, admission withdrawal, concurrent lease takeover,
stale source/link/draft and double approval. Foreign tenant snapshots and
cross-origin actions must fail. Test keyboard/320px/native forms, preserved
filter/open URL and pending feedback (P1/P2/P3/P10/P11/P12).

Existing catalog: `test/ui/memory-review.spec.ts` edits/accepts/dismisses/reopens
seeded evidence cards, checks separate supersession judgment, stale refusal,
legacy saved models and no-script 320px. It deliberately never presses
Run bounded review; fixtures are not provider-generated evidence.
`test/d1/memory-review.worker.test.ts` checks admission, budgets, evidence,
batch rollback, retry/lease races and nightly bounds with injected drafting.
`test/mcp/memories.worker.test.ts` covers memory operations, and
`test/backup.test.mjs` checks consent resets on recovery. The synthetic live
Llama probe in [memory inbox operations](../operations/memory-inbox.md) is
adapter/schema evidence, not browser consent-to-provider-to-approval acceptance.
Separate model comparison reports measure their own rubric, not this journey.

At 2026-10-24T22:20:21Z, the authorized local actual-adapter run at candidate
`5676edd688a2599aff09b8fde90a0f96610a07a6` failed semantic acceptance. With
`anthropic/claude-haiku-5.5` and prompt `memory-review-1`, compatible attributed
apple/pear facts became a `contradiction`, although the explanation said they
did not directly contradict each other. All three responses passed strict
schema/evidence validation; valid structure did not establish a useful proposal.
Three requests reserved 3,015 micro-USD ($0.003015); billed usage/cost are unknown.
No relabelling, substitute proposal, relaxed assertion or quality retry followed.
Actual proposal-card review/edit/accept, accepted-memory fresh-client retrieval
and post-approval original/history invariance were not reached. Both opt-ins
ended off and the owned server/private temporary configuration/state were
cleaned up. Evidence-only commit `48b74f1` contains
`evals/memory-review/2026-10-24-journey/report.md` on the model branch, not the
catalog's inventoried main. This is a failure of that candidate/prompt/run,
not a general Haiku-versus-Llama comparison or a shipped-default claim; it
does not authorize further inference or establish J2 acceptance. Prompt
`memory-review-2` addresses this failure class; see
[the October 29 eval notes](../../evals/memory-review/README.md#october-29-prompt-fix-compatible-claims-are-not-contradictions).

UNTESTED acceptance: actual chosen-provider request → review UI → human edit →
accepted fresh-client retrieval on the integrated deployed version, plus its
provider-failure and permission boundaries. UI #186's deployment gap was
resolved by #187 as recorded above; that release does not establish the combined
chosen-model journey. No private-memory benchmark or new paid run is implied here.

Fixtures/cost/cleanup: use `test/ui/fixtures/memory-review.mjs` in the private
supervisor state, preserving exact source stamps; remove via its teardown.
For an approved provider run record model/prompt version, actual tokens/latency,
reservation and billed cost separately, stop at the authorized cap, disable
both opt-ins afterwards and retain only sanitized synthetic artifacts.

## J3. Manage tasks

Goal: choose and finish daily work without losing place, ownership or blockers.
Start with a populated project list, parent/children, a finished parent with
unfinished children, independent prerequisites, a manual blocker and a task
with partial progress. Use two isolated client sessions for the same tenant.

1. Create with `/todos` shorthand, filter by project/tags/state and open the
   task's `?open=todo:…` link. Edit one field, comment and attach evidence.
2. Add a parent and a prerequisite through the typed relation picker. Inspect
   the different effects: parents organize; prerequisites gate claiming.
3. Race two `claim_todo` calls on a synthetic ready task. Exactly one wins;
   update with its token and inspect holder, lease and append-only progress.
4. Complete a prerequisite. The separate manual blocker persists until an
   explicit authorized resolution; child/parent completion never cascades.
   Expire/take over a lease and reject the previous token.
5. Complete/reopen with the circle, retain position and filter/pane URL, and
   fetch the actual history/change from another client. Metadata tag editing
   must not claim work, clear blockers or replace unrelated tags.

Failure/permission/staleness: foreign task/object/relation IDs, wrong scopes,
cycles, unfinished prerequisites, stale tokens, concurrent graph edits and
unknown write outcomes. Reconcile uncertainty before replaying a relation.
Refused comment keeps its draft; saving paints pending before delayed response.
Check scroll/row geometry, focus, keyboard and native forms (P2–P12). Current
phone full-screen fallback is not the requested two-height sheet; requested
j/k behavior must not trigger in an editor and needs its own released evidence.

Existing catalog: `test/ui/console.spec.ts` includes UI edit→MCP fetch,
claim/override/progress, stable geometry, comments, attachments, no-script
editing and shorthand. `todo-relations.spec.ts` covers relation forms both
scripted and native; `todos.spec.ts`, `layout.spec.ts` and `infinite-list.spec.ts`
cover controls, off-page details and filtering. Runtime suites
`test/mcp/claiming.worker.test.ts`, `todo-relations.worker.test.ts`,
`todo-transition-races.worker.test.ts`, `todo-tenant.worker.test.ts` and
`todo-freshness.worker.test.ts` cover coordinator/data-plane boundaries.

`test/journeys/j3-tasks.journey.ts` runs the whole journey as a non-admin
member with bearer-token MCP clients, a `todos:read` token and a second
tenant, against a local build or a deployed origin; evidence is under
[evidence/j3](evidence/j3/). Its first local run, on 2026-10-29, found a
reopened to-do still reading "Completed" in its status line, and a fetch
reporting a claimed to-do as blocked with no holder for about 1.4 s after the
claim, until the coordinator's mirror alarm lands.

Deployed run, 2026-10-29, on production version `046c6b31-07fd-4c62-9411-6c7add448430` (main `4688af5`), as the synthetic member
`brootmia`, with bearer tokens scoped to `todos:read`, `todos:write` and
`search:read` and revoked afterwards: every step passed, including the reopen
status fix; the claim mirror lag measured 1.3 s. Tenant denial did not run
there: production had no second synthetic tenant. Evidence is under
[evidence/j3/app.valise.run](evidence/j3/app.valise.run/).

Second-tenant run, 2026-11-01, on production version
`c8151eb5-ff5b-4bbe-acbf-1454997aa1b3` (main `9eaf656`), as `brootmia` with
`brootmia+2` as tenant B: every step passed, and tenant B's fetch, claim and
console open of A's to-do were all refused. The first attempt on that version
timed out after 5 s with the console's file attach still "Attaching", its
request unanswered; the rerun a minute later passed but took 1.8 minutes
against 43 s for the same spec on the version before. The spec had to follow
the console redesign first: "New to-do" replaced "Add to-do", and relations
are added in a modal.

UNTESTED acceptance: combined day-to-day workflow at the integrated deployed
head, including newly requested sheet/j/k/tag behavior only when present,
actual phone input/focus and two real clients. Historical successful claim
races do not certify subsequently changed relation/tag paths. Blocker prominence
must preserve P4's no-reorder-under-hand rule; evaluate the user outcome, not
just whether a warning element exists.

Fixtures/cost/cleanup: create only named synthetic tasks in an isolated store,
never claim another agent's work for testing. Explicit short leases and clock
inputs bound race tests; preserve operation receipts/errors. No paid model is
needed. Remove only owned test fixtures after retaining their evidence.

## J4. Agent A writes back; fresh Agent B resumes

Goal: the person does not reconstruct context. Start with two genuinely fresh
client sessions, a concrete allowed unfinished step, conflicting/latest
decisions, blocked work, unrelated active claims and a realistic skill catalog.
Agent B gets the user's goal, not Agent A's transcript or hidden expected answer.

1. Agent A solves part of the work and encounters a reusable finding/limitation.
   Save an appropriately typed/scoped memory, distinguishing agent inference
   from user decision. Update the existing task with refs and the concrete next
   step; do not duplicate matching memory/task or write ephemeral chatter.
2. Verify IDs, authoritative text/revisions, projection visibility and actual
   persistence after an interrupted or uncertain write. A prose promise to save
   does not count. A foreign claim remains untouched.
3. End A. Start B in another actual client; record whether SessionStart/Stop
   hooks were delivered, disabled, absent or merely injected by an evaluator.
   B uses `get_brief`, paginated `list_todos`, `list_ready` and `fetch` as needed.
4. B recovers the saved step, current decision, partial progress and blocker,
   claims only ready work and executes the allowed step. A deployment blocker
   remains blocked. Record execution evidence, not a generic resume suggestion.
5. Include no-write/no-recall controls and exact completion `[since, until)`
   boundaries across pages, independent of `updated_at`. Personal review should
   show outcomes/decisions, not mistake raw tool-call volume for productivity.

Failure/permission/staleness: missing hook/cached brief, stale decision,
truncated orientation, invented cursor, lost write receipt, expired claim and
scope/tenant denial. Do not repair an invented opaque cursor by accepting it.
Check both hooked and hookless real clients; the browser review fallback must
retain keyboard/native access and stable links. Plain-language outcome review
uses only the authorized post-2026-11-01 window and keeps private transcript
excerpts outside the repo.

Existing catalog: `evals/outcomes/run.mjs` and its README describe fresh-agent
read-only episodes, real MCP reads, matched fixtures and deterministic scoring.
`2026-10-24-current-main.md` records 19/30 versus 17/30 on one model: no
demonstrated improvement, not a reliable regression estimate. The scorer refuses
writes; it cannot prove selective writeback or execution. Reminder injection
does not prove real hook lifecycle. Supporting tests are
`test/evals/outcomes.test.ts`, `test/mcp/startup-brief.worker.test.ts`,
`test/mcp/todo-freshness.worker.test.ts`,
`test/mcp/capture-guidance.worker.test.ts` and
`test/clients/hook-script.test.ts`. Hook-script tests are not real-client
lifecycle proof.

Real-client evidence, loopback identity only:
writeback report `2026-10-29-real-client` (raw eval runs stay local, not
published) ran A and a fresh B as
separate Claude Code sessions with the plugin's hooks fired by the client. A
fresh Sonnet B completed the saved step in 3 of 4 hooked chains and 0 of 4
hookless; Haiku 0 of 12. The Stop nudge never came due in a one-prompt session.

UNTESTED acceptance: write-capable A→fresh B execution on deployed OAuth,
matched multi-model hooked/hookless outcomes at useful repeat counts, the Stop
nudge in a real multi-turn session and personal-review outcomes.
The existing three follow-ups under the milestone own diagnosis, multi-model
read-only validation and closed-loop writeback separately; do not merge their
scores or expand the read-only scorer to manufacture success.

Fixtures/cost/cleanup: use `evals/outcomes/README.md`'s empty loopback store,
distinct revision/port, seven tasks, conflicting decisions, completion-window
boundaries and 64 skills; preserve fixture/runner/tool hashes and failures.
Write-capable scenarios use `evals/writeback/`, with its own fixture per
project and a provider-free `--dry-run`; see `evals/writeback/README.md`.
Agree model/repeats/turn/call/total cost limits before paid runs. A soft dollar
stop can overshoot by one episode. No new paid evaluation is authorized by this
catalog. Retain sanitized artifacts, revoke test connections and retire only
the run's named store after diagnosis.

## J5. Connect, onboard, self-host

Goal: a person gets useful shared context from a client, or independently forks,
deploys and operates their own case. Start either with an admitted hosted
account and clean client profile, or a second person's authorized clean
Cloudflare account/fork, unused app name and actual Workers subdomain.

1. Hosted: sign in at `/login`, inspect `/connections`, add the canonical `/mcp`
   connector and complete real OAuth consent. In `/skills`, preview and import
   one chosen skill; discover/get its body from the client. Do not silently
   install suggested skills or count a built-in as a user-added first skill.
2. Independent install: follow [self-hosting](../operations/self-hosting.md),
   provision installation-specific D1/R2/KV, resume after an interrupted create,
   select lexical first without an inference key, configure private secrets and
   initialize only the new database.
3. Full verify in the fork, then Workers Builds from its `main`; confirm Build,
   deployment, smoke and OAuth metadata all name the new origin/resources.
   Configure actual Claude/Codex/web client overrides; do not assume a plugin
   interpolates an environment variable it does not support.
4. Save a synthetic memory through one real client and retrieve it from another.
   If Clef/Jev is explicitly selected, prove that backend actually reranked,
   not silent lexical fallback. Upgrade through the normal migration gate.
   J7 supplies recovery acceptance; public visibility needs owner approval/audit.

Failure/permission/staleness: denied consent, invalid callback/resource,
expired/rotated/revoked credentials, insufficient scopes, duplicate/lost setup
response, missing/replaced resource, wrong account/subdomain and mismatched
compiled deployment target. Retry preserves identity, not replacement empty
resources. Check native consent/skill forms and narrow-screen/keyboard
instructions. An onboarding checklist must use honest tenant completion signals
and acknowledge undetectable connection state.

Existing catalog: `test/self-host.test.mjs` exercises configuration, resumable
interactive bootstrap and deployment-target guards with a fake Cloudflare API;
it does not perform an independent install. `test/ui/console.spec.ts` and
`skills.spec.ts` cover skill preview/publish→MCP and Connections;
`test/mcp/oauth.worker.test.ts`, `auth-lifecycle.worker.test.ts`,
`cached-schema.worker.test.ts` and `scopes.worker.test.ts` cover protocol
boundaries. `scripts/oauth-roundtrip.mjs` is a dev-server lever, not proof that
the person's real client authorized the deployed origin.

UNTESTED acceptance: second-person clean-account install, resumability and
backend access through actual deployment, tested client override paths,
onboarding outcome and upgrade/recovery without maintainer-private knowledge.
Existing setup code/deployment evidence does not close that blocked acceptance.

Fixtures/cost/cleanup: local fake-account tests are provider-free. Real setup
needs approved account/resource names, hosting-cost and optional inference
limits, private credential handling and a second tester. Retain installation
state to retry; never delete it to bypass mismatch guards. Remove only named
disposable deployments/resources and test client connections after evidence.

## J6. Share safely under load

Goal: invited people have separate private cases; one busy person does not make
another's work disappear or become public. This is not shared-document
collaboration. Start with owner/member browser profiles and distinct credentials,
same-name skills and overlapping search terms, plus noisy/quiet tenants in an
approved disposable deployment. The owner already confirmed new-user invite
success on completed `tdo_e3336332`; do not reopen or erase that history.

1. Owner creates a bounded invite/group link in `/people`; another real person
   redeems `/join/<code>` and completes their supported sign-in/verification.
   Verify their own identity, starter content and connected client.
2. Both create/find/read/update their own same-name skills, memories, tasks,
   sources and files. Guess the other's IDs through console, MCP resources,
   uploads/downloads and search. No text, existence-sensitive data or authority
   leaks. Revoking one's OAuth connection does not revoke the other's grant.
3. Mix bounded search/publish/memory edits/claims with skewed history/log/FTS
   volume and vector arrivals. Observe quiet-tenant completion, pagination,
   backlog age and retrieval with foreign-corpus distractors.
4. At request/storage/embedding/backlog limits, see explicit retry/usage
   feedback without losing authoritative content or starving other tenants.
   Deletion/repair stays possible; immutable history is not quota cleanup.
   Record p95/p99, SQL/rows/write amplification and growth before discussing
   sharding or throughput limits.

Failure/permission/staleness: expired/revoked invites, unverified/withdrawn
admission, narrow/foreign bearer, same-name collisions, cross-tenant child links,
stale leases/writes, provider outage and reconnect bursts. MCP rate-limit
responses must be protocol-valid with request IDs/retry information. Uncertain
null-ID write responses require inspecting persistence before replay, not an
assumed Worker root cause. Test member/owner direct routes, keyboard and
native invite/console forms; hiding an admin link is not authorization.

Existing catalog: `test/ui/people.spec.ts` covers invite links and no-script
group creation/withdrawal, not mailbox delivery or a complete second-person
profile. Runtime `test/mcp/users.worker.test.ts`, `people.worker.test.ts`,
`password-signup.worker.test.ts`, `google-login.worker.test.ts`,
`isolation.worker.test.ts`, `skill-name-isolation.worker.test.ts`,
`oauth-connection-isolation.worker.test.ts`, `tenant-store.worker.test.ts`,
`rate-limit.worker.test.ts` and `todo-tenant.worker.test.ts` cover boundaries.
`test/d1/tenant-activity-probe.worker.test.ts` measures real activity queries
with 20,000 foreign rows versus 60 member rows; `vector-delivery.worker.test.ts`
and `vector-candidates.worker.test.ts` test delivery/isolation components.
That SQL probe is not concurrent mixed-agent end-to-end capacity evidence.

`test/journeys/j6-tenants.journey.ts` runs steps 2 to 4 as two member
tenants with bearer-token MCP clients; evidence is under
[evidence/j6](evidence/j6/). It skips without a second tenant rather than use
the owner's. Its load step runs only against a local build unless
`JOURNEY_LOAD=1` names an approved disposable deployment. The first local run,
on 2026-10-29, refused tenant B on every guessed id of tenant A's to-do,
memory, source and file through fetch, claim, comment, edit, tag and
download, kept `search` and `skill://` per tenant, and stopped only B's calls
when B's token was revoked. Under 160 noisy calls at concurrency 8 against 20
quiet ones, all 20 quiet writes landed with no errors; 110 noisy calls were
refused as protocol-valid `rate_limited` JSON-RPC errors with their request
ids and `retryAfterSeconds: 60`. Local latencies (p95 noisy 123 ms, quiet
110 ms) describe one laptop under other load, not a deployment. Invitation
and sign-up were not exercised: staging and local builds have no email key.
On production, with one synthetic tenant only, the run on 2026-10-29 on
production version `046c6b31-07fd-4c62-9411-6c7add448430` (main `4688af5`) showed `/people` and `/workbench` refused to the member by
the server, ids that are not the member's answering as missing, and revoking
one bearer token leaving the member's other token working. The second tenant
and the load step wait on owner approval. Evidence is under
[evidence/j6/app.valise.run](evidence/j6/app.valise.run/).

UNTESTED acceptance: measured integrated mixed-agent capacity/fairness and
pending quota/cursor/store-adoption behavior at its actual released head.
Existing invite confirmation remains valid within its stated scope; capture
missing profile/load evidence without demanding duplicate history. No capacity
SLA, paid tier, shard allocator or production load test is implied.

Fixtures/cost/cleanup: deterministic two-tenant local fixtures first; then a
specifically authorized deployment with a measured corpus/concurrency/duration
and request/provider/storage caps. Keep private addresses/tokens and raw call
bodies out of reports. Revoke only test grants/invites; retain sanitized
metrics/failure traces before retiring named resources.

## J7. Back up and recover

Goal: recover original bytes, decisions and relationships without replaying live
credentials, leases or provider consent. Start with an independently encrypted,
access-controlled backup destination, scoped operator credentials, chosen alert
channel and a two-tenant synthetic installation including histories/bundles,
task relations/manual blockers, review drafts/decisions and processing outputs.

1. Follow [backup/recovery](../operations/backup-recovery.md): capture the exact
   release's authoritative D1 tables and every referenced original to the
   independent host, verify checksums and successful-snapshot retention.
2. Install the approved schedule and independent monitor. Exercise failed/stale
   capture and a dead scheduler; prove the selected channel actually receives
   the alert while the last complete snapshot survives.
3. Restore the matching release into fresh unpublished Worker/D1/R2/KV and
   coordinator namespaces. Preserve owner IDs and relation/history rows;
   invalidate live credentials/leases and interrupted execution. Rebuild
   lexical search from actual application projection code, without inference.
4. Deploy through the new installation's `main`/Workers Builds; smoke, sign in
   afresh and connect fresh clients. Inspect one original and history per
   tenant, checksums, task edges/blockers, new claim/fencing, accepted/dismissed
   decisions and tenant-filtered search. Reviews/overnight remain off.
5. Upgrade only after the baseline restore. Semantic recovery requires explicit
   provider-free enqueue, a fresh index/base and separately approved bounded
   delivery/visibility/ranking proof before hybrid; an empty pending ledger is
   not proof the index is visible.

Failure/permission/staleness: unknown tables, corrupt/missing original,
mismatched migration hashes, source-resource reuse, initialized destination,
partial restore, held lock, wrong credentials and old clients/tokens. Fail
closed; never overlay production or delete coordinator uncertainty markers.
Restored provider keys/model preference are not consent. Browser post-restore
access includes keyboard/native forms; the backup CLI has no scriptless-browser
equivalent. Measure recovery point/time rather than claiming an unmeasured SLA.

Existing catalog: `test/backup.test.mjs` executes real local Wrangler source →
capture → fresh D1/R2 restore, row/relationship/hash/FTS comparisons, corruption,
retention/lock/status refusals, review opt-in reset and processing-history
recovery/enqueue. `test/mcp/recovery-coordinator.worker.test.ts` checks new
coordinator floors, old-token refusal, prerequisites and tenant isolation.
These execute inside full verify, but are not remote scheduler/alert/deployed
fresh-client recovery evidence. `scripts/restore.sh` is SQL-only; portable
library export omits installation history/identity and is not this journey.

Subsequent repair #187 adds `test/recovery-drill.test.mjs` and
`test/build-stages.test.mjs`: bounded cancellation/process cleanup, fail-closed
batched read results and sequential gate enforcement. The real D1/R2 drill and
180-second budget remain. [Release-gate timing and cancellation](../operations/backup-recovery.md#release-gate-timing-and-cancellation)
records the measured local 66.25s → 36.64s improvement and its remote-performance
proof boundary; the successful deployment above is not a scheduled-backup drill.

On 2026-10-25 a remote capture of production was restored into fresh staging
resources: 30/30 tables matched captured row counts, 96/96 originals read back
with matching checksums, credentials/leases were absent and reviews off. Staging
was deployed from a laptop, not Workers Builds, and no fresh client connected.
See [staging](../operations/staging.md#restore-of-2026-10-25).

UNTESTED acceptance: operator-approved independent schedule, alert delivery
and fresh-client use of a restored deployment. Existing
recovery implementation `tdo_a5d77446` stays completed; activation parent
`tdo_c4bb8bca` already owns those remaining outcomes, so no duplicate recovery
implementation ticket is needed.

Fixtures/cost/cleanup: use the real local drill for provider-free coverage.
Remote capture/restore needs separate explicit operator authorization, bounded
storage/R2/D1 cost and exact fresh resource IDs. Keep snapshots private, retain
failed artifacts unpublished and preserve the original installation. Revoke
test credentials; remove only the approved disposable destination after proof.
Never activate restored review or embedding work as cleanup.

## J8. Author and use skills

Goal: a person writes a skill once, versions it, and every connected client
uses the current version without a reinstall. Start with a member, two bearer
tokens standing in for two clients, the Claude Code plugin's hook script, and
a second tenant.

1. Write a SKILL.md in `/skills?add=write`, preview it and add it. Nothing is
   added before the preview's own Add skill.
2. Publish version 2 over MCP with `publish_skill`, including a bundle file.
   `get_skill` returns v2; `get_skill` with `version: 1` still returns v1
   unchanged. The dialog shows both versions with v2 as head.
3. Open a suggested or skills.sh skill: the preview installs nothing.
4. A fresh client finds the skill with `list_skills` and `search`, reads the
   bundle file with `read_skill_file`, and sees it as a `skill_<name>` tool
   and as an MCP prompt.
5. `edit_hook` adds a SessionStart entry; a new MCP session's server
   instructions carry it. Removing it removes it from the next session.
6. Disable the skill in the console: `list_skills` drops it and `get_skill`
   refuses it. Delete it from the list. Another tenant publishing the same
   name gets its own skill and body.

Visible outcome: the console and every client agree on the head version; old
versions stay readable and unchanged; imports wait for a person.

Failure/permission/staleness: a disabled skill's `get_skill` refuses with "No
active skill exists". Same-name skills never cross tenants. Hook edits reach a client at its next MCP connection, not mid-session.

Existing catalog: `test/ui/skills.spec.ts` and the skills tests in
`test/ui/console.spec.ts` cover the list, dialog, versions, switches and the
Add skill routes; `test/mcp/skill-name-isolation.worker.test.ts` and
`test/clients/hook-script.test.ts` cover tenant names and the hook script.
`test/journeys/j8-skills.journey.ts` runs the journey as a member against a
local build or a deployed origin; evidence is under
[evidence/j8](evidence/j8/). Its first local run, on 2026-10-29, found every
curated suggestion ending in "Placeholder: the owner's reason goes here."
The deployed run on 2026-10-29, on production version `046c6b31-07fd-4c62-9411-6c7add448430` (main `4688af5`), as `brootmia` with
tokens scoped to skills and config only, passed every step but the
second-tenant one, which production could not host yet; evidence is under
[evidence/j8/app.valise.run](evidence/j8/app.valise.run/). The second-tenant
run on 2026-11-01, on production version `c8151eb5-ff5b-4bbe-acbf-1454997aa1b3`
(main `9eaf656`), with `brootmia+2` as tenant B, passed every step: B
published a skill of the same name and read back only its own body, and A's
read-only client still could not see B's. Curated suggestions now sit in the
Add skill dialog, not on `/skills`, and the spec checks them there.

UNTESTED acceptance: the deployed member walkthrough, a real Claude Code
session loading the skill through its own MCP connection, and an upstream
update of an imported skill.

Fixtures/cost/cleanup: one synthetic skill per run, deleted at the end (it
stays restorable under Show deleted); the run's hook entry is removed and its
bearer tokens revoked. No paid model.

## J9. See what my agents did

Goal: after time away, a member sees what changed in their own case and who
changed it, without reading raw tool calls. Start with a non-admin member, two
agents on separate bearer tokens, a to-do finished and one left blocked, a
saved memory and a published skill, all in one synthetic project, plus a
second tenant with its own writes.

1. Agents work while the person is away: create, claim, post progress,
   complete, block; save a memory; publish a skill.
2. The person opens `/activity`. The outcome line counts completed, created
   and blocked to-dos, saved memories and published skill versions for the
   window. Blocks below group consecutive changes by session and client,
   newest first, under UTC day headings.
3. Each line opens its item: a to-do or memory in its pane, a skill in its
   dialog.
4. Narrow by project and by day through the URL; an empty window says so.
5. The Workbench call log stays owner-only on the server, and another
   tenant's trail shows none of these writes.

Visible outcome: what got done comes first; call volume is never presented as
output. Every line links to the item it describes.

Failure/permission/staleness: a member requesting `/workbench` is refused by
the server, not just missing a nav link. Same-second writes keep their
lifecycle order. A deleted item keeps its lines. A malformed day falls back to
the default window. Test 320px and no-script (P3, P11).

Existing catalog: `test/mcp/trail.worker.test.ts` writes through real tool
calls as two users and checks tenant filtering, ordering, outcome counts,
links and windows. `test/ui/activity.spec.ts` checks the page, its links,
an empty day, 320px and no scripts. `test/journeys/j9-activity.journey.ts`
runs the journey as a member against a local build or a deployed origin;
evidence is under [evidence/j9](evidence/j9/). The interaction contract is in
ADR-0006, amendment of 2026-10-29. The deployed run on 2026-10-29, on
production version `046c6b31-07fd-4c62-9411-6c7add448430` (main `4688af5`), as `brootmia`, passed every step but the second-tenant
one; `/workbench?tab=logs` answered the member 404. It showed a block's time
as "12:48–12:48", now one time when a block falls in one minute. Evidence is
under [evidence/j9/app.valise.run](evidence/j9/app.valise.run/). The
second-tenant run on 2026-11-01, on production version
`c8151eb5-ff5b-4bbe-acbf-1454997aa1b3` (main `9eaf656`), with `brootmia+2` as
tenant B, passed every step: B's trail showed none of A's writes.

UNTESTED acceptance: the deployed member walkthrough, a real hooked client
writing under its own session name, and a populated tenant with more than 300
writes in a week.

Fixtures/cost/cleanup: synthetic project `journey-j9-<run>` in the member's
own tenant; revoke the run's bearer tokens. No paid model.
