# 0015. Valise-managed assets and knowledge sources

Date: 2026-10-20
Status: accepted
Amended: 2026-11-24 by ADR-0023, hook files as assets.

## Context

Agents need to hand files such as screenshots between machines and sessions. The same storage should support a durable personal library of documents, bookmarks, and other reference material. The user chose standard Valise-backed storage first, with document processing and semantic enrichment deferred.

This extends ADR-0001 with two searchable concepts and amends ADR-0003's tool surface, ADR-0004's scope map, and ADR-0011's storage lifecycle. Sharing means access through the owner's authenticated Valise clients; public links and collaboration between users are future work. Implemented on 2026-10-21 under `todo:tdo_62f57330-73b3-4722-ab41-375f3d16d364`; the Amendments section records the decisions the implementation had to make and what it left out.

ADR-0011 already supplies immutable owner-scoped objects, console attachments on to-dos and memories, and read-only MCP attachment resources. Build on `app/r2/objects.ts` and the existing `objects` table. Assets add searchable descriptive metadata and retention around those objects; they do not introduce a second byte store or change existing object IDs. Preserve existing attachment links and resource URIs. Existing objects become assets only through explicit registration; their bytes stay durable unless the owner explicitly selects a new retention policy.

## Decision

### Storage and concepts

Use the deployment's existing R2 bucket for original bytes and D1 for authoritative metadata. Public identifiers never encode bucket names or object keys. No BYO storage configuration or source synchronization is needed for the first release.

- Asset (`asset:<id>`): an immutable original file, with filename, MIME type, verified byte size and checksum inherited from its owned object, title, optional description, project, tags, provenance, and timestamps. Upload state is `pending`, `ready`, or `failed`. Only ready assets are discoverable. Assets are durable by default; an explicit expiry can be set for temporary handoffs.
- Source (`source:<id>`): a durable knowledge entry with kind (`bookmark`, `document`, `image`, or `reference`), title, optional original URL, user/agent-authored notes, project, tags, provenance, and timestamps. It references zero or more ready assets through a relation table. A source must have at least one URL, asset, or nonempty note. Bookmarks need no downloaded file. Updates create source revisions, preserving the notes, URL, and asset references for each revision.
- Derived content: future extracted text, OCR, chunks, thumbnails, or summaries, linked to an immutable asset or source revision and processing version. This is a conceptual boundary now, not an extraction service or an empty set of processing tables to implement. Supplied notes are authoritative content, not silently generated extraction.

Sources and assets are independent: uploading a screenshot need not create a knowledge entry, and creating a source around an existing asset preserves the asset ID. A source cannot reference an expiring asset until its expiry is explicitly cleared. To-dos and memories can carry stable asset/source IDs in their Markdown; typed attachment relations for those concepts can follow later.

### Upload and retrieval contract

1. Begin an upload with metadata and a declared size. Return a pending asset ID, a bounded upload destination, and its expiry.
2. Transfer bytes over HTTP from a UI, CLI, or HTTP-capable agent, outside the model's tool-response context. A browser/CLI upload is the fallback for clients unable to transfer local bytes.
3. Finalize by verifying the stored object and committing ready metadata plus the search projection atomically in D1. Enforce configured file/storage limits and verify byte size and checksum. Repeated finalization is idempotent. A finalized object's bytes cannot subsequently be overwritten using the upload credential; use a staging object and immutable final key where necessary.

R2 and D1 cannot commit together. Failed or interrupted transfers stay undiscoverable and are reconciled or removed by retryable cleanup. Pending uploads have a bounded lifetime. Finalization retries must not create duplicate assets or lose an already finalized object.

`fetch` returns metadata, notes, stable references, and explicit content availability; it does not inject binary bytes into a text response or claim file contents were indexed. A separate download operation returns a short-lived capability URL. Saved references always use stable IDs, never that URL. Every issuance checks current authorization and asset state; download capabilities expire after a bounded interval. The UI can preview supported images, while arbitrary files are downloadable as attachments rather than executable application content.

### Search and initial knowledge behavior

Both concepts publish into ADR-0001's shared BM25 projection. Assets index title, filename, description, and tags; sources index title, URL, notes, and tags. Existing project/type/tag filtering applies. Originals remain retrievable regardless of whether any text can be extracted from them.

There is no PDF parsing, OCR, automatic webpage fetching, chunking, embedding, or semantic classification in this slice. The UI and tool responses label coverage as metadata/notes only. Long notes remain fully retrievable even where the existing projection cap limits searchable text. Future full-document search must explicitly revisit that cap.

### MCP and authorization additions

| Tool | Scope | Contract |
|---|---|---|
| `begin_asset_upload` | `assets:write` | Create a pending upload and return its HTTP transfer instructions. |
| `finalize_asset_upload` | `assets:write` | Verify and publish an uploaded asset; safe to retry. |
| `update_asset` | `assets:write` | Edit descriptive metadata or retention, never original bytes; reject expiry on assets referenced by sources. |
| `get_asset_download` | `assets:read` | Resolve a ready, unexpired asset ID to a short-lived download URL. |
| `save_source` | `sources:write` | Create a source or append a revision with an expected revision for conflict detection. |

Add `assets:read`, `assets:write`, `sources:read`, and `sources:write` to the scope registry. Existing `search:read` remains a cross-concept grant to search and fetch authoritative text/metadata, including asset and source records. It does not grant binary downloads. `sources:read` supports source-specific reads outside the generic search pair. Linking an asset into a source additionally requires `assets:read`; a source reference does not grant access to the bytes. Consequently, the old "exactly one scope per tool" rule is amended where an operation accesses linked assets. Upload credentials are limited to the specific pending object.

Deletion stays UI-only. Source references, including retained revisions, and existing to-do/memory attachment links protect objects from expiry or deletion until those references are removed explicitly. Archiving removes records from search without deleting originals. Cleanup of expired unreferenced assets and abandoned uploads runs with the existing scheduled maintenance, with retries for partial R2/D1 failures; expired assets become inaccessible immediately even before physical cleanup. When implementing expiry, every delivery path, including existing console URLs and MCP resources, must enforce it; expiring objects cannot retain ADR-0011's year-long immutable cache policy. Short-lived download capabilities have a bounded revocation delay. Durable legacy attachment delivery remains supported.

### Portability and operations

Provide an export of original files and a documented manifest containing stable IDs, metadata, source revisions, URLs, notes, relationships, and provenance. An export must be sufficient to restore the library; metadata backups in the same bucket are not independent backups of original files. Derived search indexes are rebuilt after restore.

Keep provider-specific operations behind a small storage module, without building a multi-provider framework. BYO buckets, watched prefixes, external connectors, content processing, and richer retrieval remain later extensions.

## Consequences

Gained: one durable home for cross-agent working files and long-term reference material; searchable knowledge entries before an extraction pipeline exists; stable identities and exportable originals. Existing single-bucket infrastructure remains sufficient.

Costs: upload orchestration and orphan cleanup, storage limits, file delivery, source revision history, and additional scopes/tools. Search initially finds descriptions and notes rather than passages inside uploaded documents. Client-specific image/file consumption must be verified on real clients instead of assumed from successful URL delivery.

## Implementation acceptance

These are verification boundaries for the live to-do, not a second work queue (ADR-0010).

1. Asset/source tables, source revisions and relations, projection mappings, and scope registration. Verify both concepts participate in shared search and reindexing.
2. HTTP upload/download and asset tools. Verify retry-safe finalization, interrupted uploads, rejection of oversize transfers, immutable finalized bytes, and authorization on retrieval.
3. Source creation/editing, bookmark capture without fetching, and asset links. Verify revision conflicts and protection of referenced assets from expiry/deletion.
4. UI upload, asset previews/downloads, knowledge entry editing, and retention controls. Upload a screenshot from one machine and actually consume its bytes in a different authenticated agent/client.
5. Export/restore and scheduled cleanup. Verify a restored bookmark and PDF source retain notes, relationships, and byte-identical originals; verify expired asset access is denied before cleanup runs.

Dogfood checks: save a bookmark with notes and find it from another client; upload a PDF, find it by metadata, and download the unchanged original with a clear "contents not indexed" indication. No parsing or semantic pipeline is required for acceptance.

## Amendments

- 2026-11-24, hook files. ADR-0023 stores a runnable hook entry's files as
  assets with a new nullable `purpose` column set to `hook`. Such an asset
  has no search projection, is not listed in Library, is not reachable by an
  agent through `fetch` or `get_asset_download`, and does not expire while a
  hook version references it. The hook manifest hands out the same
  short-lived download capability, valid for 10 minutes. Assets with
  `purpose` null are unchanged.

- 2026-11-03, the bookmark pane reads summary first, and rates. Owner
  walkthrough of 2026-11-03 (`todo:tdo_aea11fc7-8463-49a6-af77-6dc341489dc3`,
  `todo:tdo_6c69bae9-1660-47b4-9533-6643fdd5fb96`,
  `todo:tdo_9f01f76f-92d5-41ec-be85-03a30b793ce9`,
  `todo:tdo_a9fb88c4-9e72-4e8c-8f93-086b64398762`): the summary "flows into
  this wall of text", suggested tags did not look like tags, "Add tags"
  popped over the chips, the rating lived only in the reader, and the
  reader's header sat apart from its article. This amends the summary,
  suggested-tag and rating contracts below.

  Interaction contract. User job: tell from the pane whether a saved page is
  worth reading, file it, and mark what it was worth. Default populated
  view, top to bottom: kind, title, byline, then the reader's stars ("Not
  rated" and three outline stars); the Summary section with the summary and
  key concepts; a closed "How this summary was made" disclosure holding the
  model, date, cost, tokens, passages and fetch result; then, under a
  hairline and a "Saved article" heading, the article's opening blocks (at
  least 400 visible characters, split between blocks, never inside a fence)
  and "Read more". A remainder under 200 characters is not hidden. A failed
  or skipped summary keeps its line visible, since that line is the content.
  Tags follow as chips with "+ Add tag" spelled out in the row; the
  combobox opens in that place and takes its own width, so no chip is
  covered (P4, P8). Suggested tags sit on the tags' left edge as ghost
  chips: the tag chip's box and type with a dashed outline and no fill, the
  words add it, the × inside dismisses it (P7, P15). "Add a project" shares
  that edge. Primary action: read the summary; then click a star, a
  suggestion or Read more. The stars post the reader's own `rate` intent to
  the Library route with the item's id; the same star clears (P12). Rows
  show a rated item's stars after the saved date, read-only, and nothing
  when unrated. Disclosed details: provenance, the rest of the article, and
  "Show less", which moves under the last paragraph once open where the
  browser lays out an open `details` as flex. Everything is a link, a form
  button or a native `details`, so it works with scripting off (P11).
  Failure states: a malformed rating answers 400; a rating for an id the
  user does not own answers 404. Loading budget: one ratings query per
  Library load for the listed bookmarks; nothing else is added. The reader
  pages drop the list's tabs and set their header in the article's 68ch
  column, so the Library title, the back link and the article share one
  left edge at every width. Files keep their rating in the file reader only;
  the documents pane and rows do not show it yet. Evidence boundary:
  `test/ui/library-pane.spec.ts` at 1280 and 390 px over synthetic articles
  and seeded model output, with scripting on and off; production articles
  have not been walked.

- 2026-11-02, the related item's bar, after production. Once the
  related-item amendment below deployed, a to-do fetch offered an unrelated
  Python feed-parsing passage with an empty title: the forced mention the
  owner rejected. MCP search for the same text scored an unrelated library
  code passage ("Cookbook: RAG Agent") 0.65 under Jev, while the relevant
  to-dos scored 0.70 to 0.94.
  - `RELATED_BAR` rises from 0.5 to 0.8. That is from this one observation;
    the owner's surfacing eval tunes it.
  - A pick is named by its source's or file's own title rather than the
    passage locator that search titles a passage hit with.
  - An item with no title is never offered.
  - `test/d1/related-library.worker.test.ts` now runs against saved sources
    and covers the 0.65 case and the untitled skip.

- 2026-11-02, grouping files the person already saved. Owner decision, on
  todo:tdo_47612d15: select several files in the Library and put them in
  one folder, and take one out into a new folder.
  - The Documents list gives each folder row a checkbox in its top-right
    corner. It sits above the row's link (P13) and has a 24px target (V6).
    The boxes post through the "Group folders" bar's form. With scripting,
    the bar appears once a box is ticked and counts the selection; without
    scripting it is always shown (P11), as on the Skills page.
  - "Group into one folder" puts every file of the selected folders into
    the selected folder holding the most files (the first on a tie), named
    by the optional "New folder name". Its tags gain the others' and their
    notes follow its own. Emptied folders are deleted by the membership
    trigger. Files, metadata, links, retention and extracted text are
    untouched.
  - Refusals are checked before the one write batch, so a refused group
    moves nothing. They are: fewer than two folders, a vanished or foreign
    file, more than 100 files together, more than 20 tags together, or notes
    together past 4,000 characters. The refusal shows in the bar.
  - The move dialog gains "Or move it to a new folder named", which takes
    one file out into a new named folder. A file already alone keeps its
    folder, which is renamed. This is console-only; MCP still moves files
    only into an existing file's folder (the 2026-11-02 folders-over-MCP
    entry).
  - Interaction contract. User job: gather files saved separately into
    one group, or separate one out. Default view: the Documents list with a
    box on each row, and no bar until a box is ticked. Primary action: tick
    two or more, optionally name, Group into one folder; the pane then opens
    on the resulting folder. Failure states: the bar names the refusal and
    nothing moves. Loading budget: one folder read and one count per
    selected row, then one batch. Evidence boundary:
    `test/d1/asset-folders.worker.test.ts` covers the merge, the target
    choice, combined tags and notes, the 100-file and single-folder
    refusals, a foreign owner and splitting out.
    `test/ui/library-folder-grouping.spec.ts` covers grouping with and
    without scripting, the refusal, the new-folder move, and 24px boxes and
    the bar at 1280 and 390 px.

- 2026-11-02, a folder's own tags and notes. Owner decision, on
  todo:tdo_47612d15 ("a group can be tagged, noted and kept as a whole"):
  folders get tags and notes of their own, beside each file's.
  - Migration 0057 adds `tags_json` (default `[]`) and `notes` (default
    empty) to `asset_folders`. It is additive; existing folders read as
    untagged and without notes.
  - The folder pane shows "Folder tags" (a chip set, P7; its controls read
    "Add folder tags" and "Add folder tag", so they are never mistaken for
    the file's own) and "Folder notes" (prose with a pen, empty reads "Add
    folder notes", P8) under the folder name. Each saves alone (P2), through a fetcher, or as a plain form
    post without scripting. Limits: 20 tags of 100 characters, and notes
    under 4,000 characters. Edits are owner-scoped, and a foreign or vanished
    folder is refused.
  - The Library's tag filter matches a folder that carries the tag or holds
    a file that does. Its text search also reads the folder's notes and tags.
  - Folders have no search projection, so MCP `search` does not index
    folder tags or notes. MCP `fetch` of any file reports them in
    `metadata.folder`. Writing them over MCP is not offered yet, which keeps
    the `update_asset` description as #299 left it.
  - Portable export carries them per entry, and import fills them from the
    first entry of a folder without overwriting what later entries bring.
    Older exports import with empty details.
  - Interaction contract. User job: say what a group of files is for, once,
    and find the group by it. Default view: the folder pane with its name,
    then folder tags and notes, then its files. Primary action: add a folder
    tag or notes in place. Disclosed details: none beyond the fields.
    Failure states: over-limit or vanished folders are refused with the
    reason, and nothing is written. Loading budget: the folder row already
    read for the pane, with no extra query. Evidence boundary:
    `test/d1/asset-folders.worker.test.ts` covers set, limits, owner, filter,
    search and the portable round trip; `test/ui/library-folder-details.spec.ts`
    covers adding a tag and notes, reload, the tag filter, MCP fetch, notes
    without scripting, and the pane at 1280 and 390 px.

- 2026-11-02, folders over MCP. Owner decision: extend `update_asset`
  rather than add a grouping tool (ADR-0003). `update_asset` takes `folder`,
  a ready file of the caller's, and moves this file into the folder that
  file is in, as `upload_asset`'s `folder` already addresses one. It also
  takes `folder_name`, which renames this file's folder after any move.
  `fetch` of an asset reports `metadata.folder` (name, count and up to 100
  files by id, title and file name), and the `update_asset` reply carries the
  same summary. Folder ids stay internal: a folder is addressed by any file
  in it.
  - The rules are the console's: owned, ready files only; at most 100 per
    folder; a folder emptied by a move is deleted by the existing trigger;
    and the original, its metadata, source and history links, retention and
    extracted text are untouched.
  - Every refusal (unknown, foreign or pending target; full folder) is
    found before the first write, so a refused call changes nothing,
    including metadata fields sent with it. Moving a file to the folder it
    is already in and renaming to the current name are no-op successes, so
    the same call can be retried.
  - Splitting a file out into a new folder is not offered here; it arrives
    with the Library's multi-select grouping (todo:tdo_47612d15).
  - Interaction contract (agent surface). User job: keep related files
    together and see what belongs with a file. Default view: `fetch` of any
    file names its folder and lists the files in it. Primary action:
    `update_asset` with `folder` and/or `folder_name`. Failure states: a
    refusal names the cause and "Nothing was changed". Loading budget: two
    owned reads (folder, at most 100 members) per fetch. Evidence boundary:
    `test/mcp/archives.worker.test.ts` covers move, empty-folder removal,
    rename, members in fetch, retry, and foreign, pending and full-folder
    refusals leaving metadata unchanged. Owner decision 2026-11-02: the
    description change and the `files-group-into-folder` eval case wait for
    the owner's later `npm run evals` run.

- 2026-11-02, one related library item, and when agents save. Owner,
  2026-10-25: surfacing "felt contrived and forced" before; it should be
  "there's a to-do on this new idea, there's also an article slightly
  related to it that hasn't been discussed for a while, maybe it can
  influence the answer a bit". Agents save "when asked, or only on their own
  when the article has been discussed extensively and it's not in the
  library yet".
  - `get_brief` and MCP `fetch` of a to-do may carry `related_library`: at
    most one source or file, with `id`, `title`, a one-line `reason` and a
    verbatim `quote` cut to 200 characters. `get_brief` takes the session's
    first claimed to-do, else its first ready one; a to-do fetch takes that
    to-do's title.
  - The item is the first of the five best reranked owned library hits that
    scores at least 0.5 (`RELATED_BAR`, unmeasured) and that the owner has
    not opened or fetched in the last 30 days, read from the use events of
    the 2026-11-01 amendment. Without a reranker, or when the rerank stage
    falls back to lexical order, nothing is offered, because BM25 has no
    calibrated bar.
  - Absence is the normal answer. A failure to choose never fails the brief
    or the fetch.
  - The `get_brief` and `fetch` descriptions tell the agent to use the item
    only if it changes the answer, citing it, and otherwise to ignore it.
    `search` says to cite a library passage that is used and not to pad with
    others. `save_source` says to save when asked, or unprompted only after
    extended discussion when search shows the page missing.
  - Owner decision 2026-11-02: build and merge now; the owner runs
    `npm run evals` later over a larger body of work. The three new cases
    (`library-save-discussed-missing`, `library-no-save-passing-mention`,
    `brief-related-unrelated-turn`) and the changed descriptions have no
    run yet, so ADR-0003's eval evidence for this change is owed.
  - Evidence boundary: `test/d1/related-library.worker.test.ts` covers the
    bar, the fallback, the 30-day skip, the reason and quote, non-library
    hits and provider failure, with the ranked search as a double. No real
    reranker score has been checked against the bar.

- 2026-11-01, use orders search. Owner, 2026-10-25: "keep forever, but
  time decay on relevance unless actively used", with highlights and notes as
  marks of an item worth more. Owner decisions on 2026-11-01: ratings are one
  to three stars; use reorders near-ties only; author and topic preference
  is a separate follow-up. Migration 0055 adds `library_use_events`, which is
  append-only and records `opened` from the console readers and `fetched`
  from MCP `fetch` of a `source:` or `asset:` id. Repeats within 30 minutes
  are one event, and a refused write never fails the page or the tool. It
  also adds `library_ratings`, one row per rated item, removed when cleared.
  Both are authoritative backup tables, and an explicit delete of the item
  removes its rows. Highlights (references saved from the same URL, as the
  author page finds them) and notes are read, not recorded. The use score is
  stars, plus 2 for any highlight, plus 1 for notes, plus each event at a
  weight that halves every 90 days and never reaches zero. It is computed
  for the hits of one search only. MCP `search` orders by relevance, then
  within a run of hits whose reranked scores are within 0.05 of the run's
  best, puts the more-used first. No hit moves above one that is 0.05 or
  more relevant. With FTS order alone, BM25 has no fixed scale, so use breaks
  exact ties only. A library hit that use counted carries `metadata.use.why`,
  for example "you rated this 3 of 3 stars" or "an agent fetched this 4
  times in the last 90 days". That optional field leaves cached output
  schemas valid, and no tool description changed (ADR-0003). Nothing is
  hidden, deleted or reordered in the console Library, which sorts by date
  rather than relevance. Rating is console-only for now: an MCP argument
  would change a tool description and needs an eval run.

  Interaction contract. User job: mark what was worth reading, so it comes
  first next time it nearly ties. Default view: the reader header, under the
  title and links, reads "Not rated" beside three outline stars. Primary
  action: click a star to rate one to three. Clicking the lit top star clears
  it, so the reversal is the same control (P7, P12). Each star is a form
  button that posts without scripting and through a fetcher with scripting,
  painting on the click (P11), with 24px targets (V6). Disclosed details:
  "Rated 2 of 3" beside the stars, and the agent-facing `why`. Failure
  states: a malformed rating answers 400 and changes nothing; a recording
  failure is logged and the page renders. Loading budget: one insert and one
  rating read per reader load, and three queries per search over that
  page's library hits. Evidence boundary: D1 and MCP tests cover recording,
  collapse, rating, delete, decay, reasons and the 0.05 rule; Playwright
  covers rating with and without scripting, persistence, search
  explanation, and the header at 1280 and 390 px. No production search has
  been reordered by real use yet.

- 2026-11-01, bookmark passages get vectors. The 2026-10-29 bookmark
  amendment left passages lexical; files had shown vectors earn their place
  on long text (12 of 20 to 18 of 20 on *On Liberty*). `app/search/source-vectors.ts`
  is the file pipeline's twin rather than a shared outbox, because a
  bookmark's passages index an article revision through an enrichment, not
  an immutable processing output. Migration 0054 adds
  `source_vector_pending`, keyed by namespace, enrichment and passage, and
  kept after the source is deleted so the drain can delete its vectors.
  `enrichSource` enqueues one row per passage in the batch that publishes
  the enrichment and dirties the previous enrichment's rows; archive,
  restore and delete dirty the source's rows in their own batch. The
  current enrichment is the newest ready one, the one
  `sourceSearchStatements` publishes passages from. Delivery is the file
  drain's rules: fair tenant turns, four passages a minute, 90-second
  leases, epoch-fenced acknowledgements, exponential retries, a daily
  repair, two unledgered enrichments enqueued a minute (which is how the
  existing backlog fills: about 5,760 passages a day). That adds up to
  5,760 bge-m3 calls a day beside the file drain's 5,760 and memory's.
  ADR-0017's per-owner memory backlog cap (PR #266) gates memory writes in
  the writer's batch; bookmark passages are enqueued by the budgeted
  enrichment cron, not by a write, and like files are bounded by the
  drain's fair tenant turns instead.
  Vectors go to `s:<tenant namespace>` in the same index, so bookmark
  vectors cannot take file or memory candidate slots, and carry the
  `docKey` of the source row. Hybrid search adds bookmark candidates when
  `source` is in the searched concepts, keyed as `source:<id>#<n>` so a
  semantic hit merges with the lexical passage row, hydrated from the
  current enrichment with owner, archive and every filter re-checked and
  the stamp recomputed. Up to 256 eligible bookmarks are prefiltered by key
  as files are; past that the query runs over the owner's own partition
  without a key filter and drops what fails the filters afterwards, rather
  than falling back to words alone, because the 895-bookmark import is the
  library this is for. A narrow project or tag filter over a wide library
  can therefore return fewer semantic candidates than exist. Rerank input
  bounds a bookmark passage like a file passage. `backup.mjs enqueue-assets`
  also enqueues current bookmark enrichments.

  Evidence boundary: `test/d1/source-vectors.worker.test.ts` exercises the
  ledger, delivery, archive/restore/delete, re-enrichment, backlog enqueue,
  two-owner isolation, the unscoped path past 256, and hybrid union with
  Workers AI, Vectorize and Jev as doubles. It is no evidence of ranking
  quality; the paraphrase eval on public pages and production visibility
  are recorded separately.

- 2026-11-02, the iPhone saves by posting to a capture URL. Owner decision,
  after the 2026-10-30 Shortcut asked for approval several times per save on
  a real phone (Safari's Paste callout, Shortcuts prompts) and the clipboard
  read failed in more than one way. This supersedes the 2026-10-30
  amendment's transport and its rejection of a credential in the Shortcut:
  the Shortcut no longer opens `/save` or uses the clipboard, and it holds a
  credential pasted once at install. What that amendment decided about the
  article itself stands: `pastedArticle()`, extractor `valise-paste-1`, the
  150-word floor, the ignored paywall marker, the 3 MiB cap, bookmark
  revision on the same URL, and the server-side fetch for a link-only save.
  `/save` stays for link-only saves from any signed-in browser.

  The Shortcut posts JSON (`url`, `title`, `text`, optional `tags` and
  `notes`) to `POST /capture` with Get Contents of URL, so nothing opens in
  Safari; iOS asks to allow the domain once. `text` is Get Article's Body,
  or page HTML, which `pastedArticle()` cuts. `/capture`
  (`workers/capture.ts`) is plain HTTP, not an MCP tool: its one caller is a
  Shortcut with no MCP session, as `/config/hooks` is a script's. It saves
  through `captureBookmark()` (`app/concepts/source-paste.ts`), which
  `/save`'s action now shares.

  One shared Shortcut, installed from one iCloud link
  (`IOS_SHORTCUT_LINK` in `app/concepts/ios-shortcuts.ts`). iOS imports only
  signed Shortcut files and signing runs on a Mac against Apple's service, so
  a Worker cannot hand each user a file already pointing at their account.
  The per-user part is the capture URL, asked once by the Shortcut's import
  question. A pairing bounce through Safari back into `shortcuts://` would
  avoid the paste but depends on undocumented Shortcuts behaviour and a place
  to keep a secret; it was not built.

  The credential is an ordinary bearer token, scope `sources:write` only,
  labelled iPhone Shortcut: hashed at rest, shown once, listed and revocable
  on Connections, and refused once its account is no longer admitted. The
  copied string is one URL, `<origin>/capture#<token>`, because the owner
  asked for a URL and a copy button. The token sits in the fragment, not the
  path or query. Workers Logs is on (`observability.enabled`), and its
  invocation logs record every request URL, so a path secret would be logged
  by Cloudflare whatever the Worker does; it would also land in Safari
  history if the URL were ever opened. No HTTP client sends a fragment, so
  the Shortcut posts to the pasted URL as it is and sends Get Details of
  URLs → Fragment as `Authorization: Bearer`. The secret then travels where
  every other bearer token does, in a header the Worker never logs, and
  `/capture` writes no `mcp_calls` row and logs nothing. A leaked capture URL
  can add or revise bookmarks in that one user's Library and nothing else:
  `/library/export` and `/mcp` answer 403 to it. `CAPTURE_LIMITER` holds it
  to 20 saves a minute per token, keyed by token id, so one leaked URL cannot
  exhaust another's allowance; a person saving by hand never reaches it.

  Interaction contract. User job: keep the page they are reading, and its
  article when the site needs their login, from the iPhone share sheet in
  one action, with no prompt per save. Default view: Connections' Connect a
  client card ends with iPhone share sheet, one sentence on what it does,
  and Create capture URL. Primary action: Create capture URL, then Copy,
  then Add Shortcut and paste once when it asks; after that, Share → Valise
  Capture is the whole save. Disclosed details: the URL is shown once, with
  what holding it allows and where to revoke it; the Shortcut's notification
  says whether the article was kept and its word count, or that Valise will
  fetch the page. Failure states: with no published Shortcut link the
  section says the Shortcut is not published yet instead of a dead button; a
  refused clipboard write says to select the URL by hand; the endpoint's
  `message` covers a revoked or incomplete URL (401), a wrong scope (403), a
  non-JSON body or non-http link (400), opening the URL in Safari (405), a
  body over 3 MiB (413) and the rate limit (429). Before hydration Create is
  a form button and the URL is select-all text, and Copy appears once
  hydrated (P11). Loading budget: the Connections loader is unchanged; a
  save is one token lookup, one limiter call and one `saveSource` batch.
  Evidence boundary: `test/mcp/capture.worker.test.ts` on a real D1 (article
  and HTML paths, link-only path, revision, a pasted article stopping the
  server fetch, 401, revoked, 403, the token refused by export and MCP, 400,
  405, 413, 429 from a stub and from the miniflare binding);
  `test/ui/capture.spec.ts` creating, copying, using and revoking a capture
  URL at 390 px and 1280 px, and creating one with scripting off, with
  Playwright's POST standing in for the Shortcut. Not verified: any step on
  an iPhone, that Shortcuts strips the fragment, that Get Details of URLs
  offers Fragment, that the domain prompt is once, and Get Article on a
  gated page. `docs/operations/ios-capture.md` marks each build step so.

- 2026-11-01, the bookmark with its article is the popup's default, and the
  full archive is the secondary action. Owner decision in the PR #257
  review. This supersedes the 2026-10-29 reader-view entry's "The archive
  stays on by default" paragraph: the archive is still the only copy that
  keeps what an extractor drops, but most saves are for reading, so the
  owner made the bookmark the primary action. The
  popup's primary is Save article on a page with an article and Save
  bookmark on one without; both are one `save_source` with `kind=bookmark`
  and no upload, and Save bookmark carries the extractor's `detected: false`
  row when it ran, so word counts are kept. Archive full page, or Archive
  again when the saved item has an archive, is the ghost button left of it.
  After a page save its tags and project stay editable: each change is
  `save_source` with `id` and `expected_revision`, written one at a time in
  order, and a refusal reverts it. The save buttons stay disabled once a
  page save has been tried, because a lost response may have saved and a
  second click would write a second source.
  Projects and tags are offered through an APG editable combobox in the
  popup's own DOM instead of a `<datalist>`, whose dropdown Chrome draws
  outside the popup, where it cannot be styled or tested.
  `docs/operations/chrome-capture.md` holds the popup contract.
- 2026-11-01, a bookmark's summary reads its images. Owner request, item 4
  of the bookmark-completeness to-do. `npx wrangler ai models list` on
  2026-11-01 still lists `@cf/zai-org/glm-5.3-flash` as vision-capable, so
  the summary model is unchanged and `catalogReadOn` is 2026-11-01. The
  first two linked PNG, JPEG, GIF or WebP images, each at most 1 MiB, go to
  the model as data URLs after the text. A post that is short text plus an
  image, or only an image, now gets a summary, where short text alone is
  shown whole and tagged (the 2026-10-30 amendment). The prompt adds one
  instruction: say what the images show where it matters, and treat text
  inside them as untrusted. An image over 1 MiB or missing from storage is
  left out; the summary says how many it read. Measured on the live
  endpoint (`evals/summary-model/README.md`): 121 prompt tokens for a 256 px
  square, 1,390 for 1,024 px and 5,062 for 2,048 px, about 1,200 per
  megapixel. The per-item ceiling that gates the daily budget adds 16,384
  tokens per image, two images, which raises it by about $0.005; recorded
  cost is the reported usage. Migration 0052 adds `images_linked` and
  `images_read` to `source_enrichments`. A source is owed another attempt
  when its current revision links more images, up to two, than the last
  attempt was owed; images too large to read count as owed, so they do not
  repeat. Sources saved before this keep their summaries until an image is
  linked.

  Interaction contract. User job: see what a saved post's photos add to its
  summary. Default view: the Summary section's one-line provenance, which
  now reads "from the notes and 1 image". Primary action: none; summaries
  are made on the schedule. Disclosed details: how many images were read,
  and of how many linked when some were too large. Failure states: images
  too large to read are named; a failed call keeps the existing retry text.
  Loading budget: up to two R2 reads and one model call per attempt, inside
  the scheduler, none on page load. Evidence boundary: D1 tests with Workers
  AI doubled (image sent as a data URL, image-only, too large, owed again
  once an image is linked); the live endpoint accepted images in the probe
  above, but no deployed Worker summarised a real X photo.

- 2026-10-30, a bookmark's images are kept, within an allowance. Owner
  request: an X post's photos were never captured, only its text. Two
  parts. First, one table in `app/concepts/attachment-limits.ts` holds
  how many bytes a bookmark may link, by file kind and by allowance. The
  account owner: 25 MiB per bookmark, images and other files 10 MiB each,
  PDFs and video 25 MiB. Everyone else gets the `free` row: 2 MiB per
  bookmark, images and other files 1 MiB, PDFs and video 2 MiB. Billing
  does not exist, so the allowance is the owner role, else the plan's row,
  else free; the paid tier stays an open question in the ADR index.
  `saveSource` checks the table whenever a bookmark's linked files change,
  from MCP or the console; documents, images and references are their
  files and are not held to it. An existing bookmark over the limit is not
  touched until its files change. Second, `save_source` takes `images`:
  up to four public http(s) URLs, for a bookmark only, needing
  `assets:write` beside `sources:write` (a second extra scope, as
  `asset_ids` needs `assets:read`). Valise fetches each as ValiseBot with
  the page fetcher's rules: robots.txt first, public host names, three
  redirects, eight seconds. It keeps PNG, JPEG, GIF and WebP only, each
  within the per-image limit and what the bookmark has left, and links it
  after the bookmark's files. An image whose bytes the owner already holds
  is linked rather than stored again, so a rerun capture changes nothing.
  Each refusal is per image and named in the reply; the save goes ahead.
  Images fetched for a save that is then refused are deleted. X's image
  host answers robots.txt with an empty Disallow, so its photos are
  fetchable. The extension still sends only its lead image's URL, as
  article metadata.

  Interaction contract. User job: see a saved post's photos with it.
  Default populated view: the bookmark's pane lists its files under
  Attached documents, each image with its thumbnail beside its title.
  Primary action: none in the console; a capturing client passes
  `images`. Disclosed details: each image's title names the host it came
  from. Failure states: per image, not a public URL, refused by
  robots.txt, not fetched, not an image type kept, larger than the bytes
  left, or empty; linking a file over the allowance from the console or
  MCP is refused naming the file, its size and the limit; images on a
  non-bookmark are refused. Loading budget: up to four image fetches of at
  most 10 MiB each, sequential, inside the `save_source` call; the pane
  adds no query, the thumbnail reuses the Documents view's loader.
  Evidence boundary: MCP tests with outbound fetch stubbed (kept, too
  large, not an image, robots refusal, rerun dedupe, missing
  `assets:write`, wrong kind), a member over the PDF limit refused and a
  document not, unit tests of the table, and a Playwright pane at 1280
  and 320 px. No real X image was fetched by a deployed Worker.

- 2026-10-30, saving from a phone's share sheet. Owner decision: the iPhone
  saves through an Apple Shortcut that opens `/save?url=…&title=…` in
  Safari, which already holds the console session, so setting it up is
  adding the Shortcut and nothing else. A bearer token pasted into the
  Shortcut was rejected as too fiddly to set up on a phone, a PWA share
  target because iOS Safari has none, and a native share extension
  because it needs App Store distribution. With `clipboard=1` the Shortcut
  first copies the article from the open page, Safari Reader text or the
  page HTML, and the Save tap reads the clipboard: Safari allows that read
  only inside a tap, then shows its own Paste callout. `pastedArticle()`
  (`app/concepts/source-paste.ts`) cuts HTML with the same HTMLRewriter
  pass as Valise's fetch, takes anything else as plain text, and keeps it
  as a `source_articles` row with extractor `valise-paste-1` when it has at
  least 150 words. A paywall marker is ignored here: the owner's browser
  showed them the text. Fewer words keep only the link, which leaves the
  page to the 2026-10-29 fetch. The body is capped at 3 MiB, like a fetch.
  Saves are bookmarks, so the same URL saved again revises it. Setup is in
  `docs/operations/ios-capture.md`.

  The same work found that `extractPage` returned no text for any page
  carrying a JSON-LD script: the script matched two selectors that both set
  an end-tag handler, an element keeps only the last, and the skip counter
  never fell back. Such pages were recorded as `not_article`. The handler is
  fixed; bookmarks already recorded that way are not fetched again, because
  a source is fetched only once.

  Interaction contract. User job: keep a link, and the article when it is
  gated, from the phone, without leaving what they were reading for long.
  Default view: the link, a title filled from the page, empty tags and
  note, and Save. Primary action: Save, one tap, plus Paste when the
  Shortcut copied an article. Disclosed details: the confirmation says
  whether the article came from the clipboard and its word count, or that
  Valise will fetch the page, with Read it and Open in Library. Failure
  states: no link or a non-http link says so instead of a form; a clipboard
  read Safari refuses or returns empty opens an Article text box to paste
  into by hand, and saving it empty keeps the link only; text under 150
  words saves the link and says why; over 3 MiB is
  refused with a message; signed out goes through sign-in and returns to
  the same `/save` URL. Loading budget: one source read on the
  confirmation. Evidence boundary: D1 tests over pasted text and HTML, a
  Playwright run of the page at 390 px and 1280 px with a stubbed
  clipboard; no run on an iPhone yet, so the Shortcut action names in the
  setup page are unverified on a device.
- 2026-10-30, bookmarks get suggested tags, which the person adds. Owner
  request. The enrichment call returns one to five tags beside the summary
  and concepts, and is shown up to 2 KiB of the owner's most used tags as
  `known_tags` so it reuses their spelling. A tag containing a colon is
  dropped, since `project:x` and its kind are reserved keys (ADR-0009).
  Suggestions are not writes, as with file processing suggestions and
  ADR-0012's links. They sit in `source_enrichments.suggested_tags_json`,
  and a dismissal in `dismissed_tags_json` on the same row; migration 0051
  adds both. A newer attempt, after a newer article, suggests afresh.
  Adding one is an ordinary tag edit, a new source revision, refused at 20
  tags. This amends "short saved text is read whole": text under 500
  characters is still never summarised, but it is sent once with
  instructions to return tags only, because the short X posts are the ones
  the owner wants filed. An enrichment row skipped before this change with
  no error code, on a source with notes, gets one more attempt. A new skip
  records `no_text` or `no_model` and is never retried, so nothing loops.
  The roughly 900 bookmarks summarised before today keep their summary and
  get no tags; redoing them would spend the budget again.

  Interaction contract. User job: file a bookmark under the right tags
  without typing them. Default populated view: under the bookmark's tags,
  a "Suggested" row of the suggestions it does not already have, each a
  button with a plus and the tag, beside a dismiss button. Primary action:
  one click adds the tag in place (P15); the row loses it and the tag set
  gains it. Secondary: dismiss, which is kept. Disclosed details: none;
  the model and cost are already in the summary line. Failure states: a
  stale revision is refused as any tag edit is; a 21st tag is refused
  with the limit; a dismissal of a tag not suggested, or of another
  user's bookmark, is a 404. Loading budget: one vocabulary query per
  enrichment attempt; nothing added to the pane's load. Evidence boundary:
  D1 tests with Workers AI as a double (tags-only call for a short post,
  vocabulary in the prompt, reserved and duplicate tags dropped, five at
  most, dismissal kept and tenant-bound, one retry of an old skip) and a
  Playwright pane at 1280 and 320 px over a seeded model output. Real tag
  quality is untested until the scheduler runs on production bookmarks.
  P9 and P15 apply. A dismissal has no undo in the pane; adding the tag
  by hand is the way back.
- 2026-10-30, an archived page is a folder, rendered by a sandboxed viewer.
  Owner decision, to-do `todo:tdo_0a1e741f-cc80-41f1-8321-dfe7ce0e14d4`. This
  replaces the 2026-10-23 Chrome capture rule that HTML is delivered only as
  an attachment, for archived pages and only through the viewer below;
  `/files/{id}`, downloads and the library export still answer HTML as an
  attachment. The extension uploads the page's HTML first, then each
  stylesheet, image and font with `upload_asset`'s new `folder` argument
  naming the HTML asset, so they join its folder (the 2026-10-29 folder
  entry). The page refers to them by folder-relative file names such as
  `page.css` and `img-001.png`. `upload_asset` refuses before writing any row
  when the named asset is not the caller's, not ready and unexpired, or its
  folder already holds 100 files, pending members included; the insert and
  the move share one batch, so the folder triggers' limit aborts both.
  `GET /archives/{folder}/{expires}/{signature}/{name}` serves one member:
  HMAC-SHA-256 with `TOKEN_PEPPER` over `asset-archive:{folder}:{expires}`,
  base64url, compared in constant time, one hour at most, else 403. The
  member is the ready, unexpired asset in that folder whose `file_name` is
  `{name}`, owned by the folder's user; a missing member or a type outside
  HTML, CSS, PNG, JPEG, GIF, WebP, AVIF, SVG, ICO, WOFF2, WOFF, TTF and OTF
  answers 404. Every response carries `Content-Security-Policy: sandbox;
  default-src 'none'` with `img-src`, `style-src` and `font-src` limited to
  the URL's own prefix (plus `data:` and inline styles), `base-uri 'none'`,
  `form-action 'none'`, `nosniff`, `Referrer-Policy: no-referrer` and
  `Cache-Control: private, no-store`. The sandbox gives the page an opaque
  origin and no scripts, so it cannot read the console's cookie or call its
  API. That same opaque origin is why the capability is a path prefix
  rather than a session: the page's subresource requests carry no
  first-party cookie, and relative URLs resolve to siblings under the same
  signature. It is also why fonts carry `Access-Control-Allow-Origin: *`,
  since a font load is a CORS request from origin `null`, and why
  `Cross-Origin-Resource-Policy` is `cross-origin` rather than the planned
  `same-origin`: Chrome blocks a no-cors image or stylesheet load from an
  opaque origin under `same-origin` (`ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`,
  probed on 2026-10-30), and the signed path already limits who can name the
  file. `GET /library/archive/{assetId}` checks the console session and that
  the asset is the user's, ready, unexpired and `text/html`, else 404, and
  answers 303 to the viewer URL for its folder and file name. The reader and
  the Library document pane link "Open archived page" there.
- 2026-10-30, `save_source` `check: true`. With `url`, it writes nothing and
  returns `{ saved: [...] }`: the caller's unarchived sources whose URL
  equals `url` exactly, any kind, newest `updated_at` first, at most 10,
  each with id, kind, title, revision, `updated_at` and `archive_asset_id`,
  the newest available `text/html` asset linked to the head revision or
  null. It uses `sources_user_url`. The scope stays `sources:write`, and the
  check discloses nothing new: a `sources:write` holder could already learn
  whether a bookmark exists at a URL by saving one there, which revises the
  saved bookmark rather than creating a second (the 2026-10-30 revision
  entry). The asset id it returns is an id, not bytes; reading those still
  needs `assets:read`. The check also returns `vocabulary: { projects,
  tags }` from `readVocabulary`, at most 50 of each, most used first, so the
  popup can offer the owner's own words (P9). That part does disclose
  something to a `sources:write` holder: the names of the caller's projects
  and tags across skills, memories, to-dos and the Library, at most 50 each.
  It discloses no item, count or content behind a name. A capture client
  that tags a save needs exactly that list to avoid a second spelling, and
  widening the extension's grant to a read scope for it would hand over far
  more. The Chrome extension asks the check for the popup's saved state and
  vocabulary, so its grant stays three scopes.
- 2026-10-30, a bookmark has a saved time and a published time. Owner
  request: X posts and articles carry when they were published, and
  Library should sort by either. The saved time is `sources.created_at`, as
  before. The published time is `sources.published_at` in Unix seconds, set
  from `save_source`'s `published` (an ISO 8601 date or datetime; null
  clears it; omitted keeps it), or on a save with an article from that
  article's `published` when it parses. Reads fall back to the newest
  article's `published` through SQLite `unixepoch`, so earlier extension
  captures sort by their date without a backfill `UPDATE`, which the deploy
  would refuse as non-additive. `source_revisions.published_at` records the
  value at each revision; the portable manifest carries it per revision,
  absent in older exports. A rerun capture that adds a date to an unchanged
  post is a new revision, so the 218 X posts can be dated by rerunning the
  recipe with `published`. Migration 0050 adds both columns; no index,
  because the published order is an expression over the article fallback.
  `save_source` no longer says Valise never fetches the URL, which stopped
  being true on 2026-10-29.

  Interaction contract. User job: find a bookmark by when it was written,
  not only by when it was saved. Default populated view: the newest-saved
  order, unchanged; each row's byline reads "Published 12 Oct 2026 · Saved
  30 Oct 2026", or only the saved date when none is known, with the full
  UTC time on hover. Primary action: the Bookmarks toolbar's sort menu,
  Newest saved or Newest published; the choice is `?sort=published` in the
  URL and survives search, filters, paging and opening a bookmark. Undated
  bookmarks follow every dated one, newest saved first among themselves.
  Disclosed details: none beyond the hover. Failure states: a `published`
  that does not parse is refused by `save_source` naming the field; an
  article date that does not parse is ignored; an unknown `?sort=` is the
  default order, never SQL. Loading budget: the same two queries per page;
  the published order adds one correlated article lookup per candidate row,
  measured on the 895-source fixture. Evidence boundary: D1 paging over 895
  sources with ties, article dates and undated rows; MCP save, rerun, keep,
  clear and refuse; a portable round trip; a Playwright walk of both orders
  at 1280 and 320 px. Production dates are untested until the X recipe is
  rerun with `published`. P3, P7 and P11 apply.
- 2026-10-30, short saved text is read whole. Owner feedback, after X
  posts saved with their text as notes read "Nothing to summarise yet" and
  "robots.txt asks not to be fetched" while the post sat in the notes. A
  bookmark's text is its detected article, else its reading notes, the
  notes minus a Raindrop import receipt (`app/concepts/source-text.ts`).
  Text under 500 characters is never sent to the model, whether article or
  notes; this replaces the 400-character notes floor, and an import
  receipt no longer counts toward it. The pane derives the short state from
  the current text, not from an enrichment row, so the 218 X posts read
  correctly with no rerun. Valise's fetcher still asks robots.txt first and
  still fetches a source with notes but no article; only the wording
  changes. A refusal beside saved text says the text is what was saved with
  the bookmark, not that Valise could not get it.

  Interaction contract. User job: read a short saved post or note without
  opening the original. Default populated view: the source's pane shows the
  text where it already lives, the notes or the article, and below it one
  muted line: shown whole rather than summarised, its character count, and
  what Valise's one fetch did. Primary action: none; reading. Disclosed
  details: unchanged for long text (summary, concepts, model, cost,
  passages, fetch result). Failure states: no text at all still says there
  is nothing to summarise; a failed summary of long text keeps its retry
  line. Loading budget: no added query; the text and article are already
  loaded for the open source. Evidence boundary: D1 tests with the fetch and
  Workers AI as doubles, and a Playwright pane at 1280 and 320 px over a
  synthetic post with a seeded robots refusal. No production source was
  opened. P13 applies.
- 2026-10-30, a bookmark saved again is a revision. Owner request, after a
  218-post X bookmark capture had no safe rerun: `saveSource` without an id,
  for `kind: bookmark` with a URL equal to an unarchived bookmark the user
  holds, appends a revision to the most recently updated match, omitted
  fields inheriting as with an explicit id. A save that differs in nothing
  (kind, title, URL, notes, project, tags, authors, linked assets, article
  text) returns the source unchanged with no revision. The URL match is
  exact; `?s=12` and a bare status URL are different bookmarks. Documents,
  images and references still always create, because the extension saves
  every highlight as a reference carrying its page URL and every document
  capture links a new snapshot. An archived bookmark is not revived.
  `sources_user_url` (migration 0049) indexes the lookup. Two first saves
  racing on one URL can still both create; nothing enforces uniqueness.
- 2026-10-29, documents are folders, at every file count. Owner decision:
  one PDF is a folder containing one file; an HTML page, screenshot and CSS
  are one folder containing three files. A folder is an owned, flat container,
  not a project, tag, source, nested tree or inferred filename grouping.
  Original asset/object ids, checksums, processing outputs and source links
  stay unchanged. Add `asset_folders` and `asset_folder_files`; each asset
  belongs to exactly one folder. An additive insert gives every existing
  asset its own folder, and an asset-insert trigger does the same for every
  upload/import path, including old code during deployment. Explicitly moving
  a file changes membership only. Folder names and membership survive backup
  and portable export/import. No original is moved in R2 and no existing
  table is rebuilt or rewritten by the migration.

  Interaction contract. User job: keep related originals together, see which
  files they contain, process a selected file and read its extracted text.
  Default populated view: at most thirty folders, newest-created first, each
  with its name, file count and a representative thumbnail filling the row's
  height. Even a singleton has the same folder row and opens the same pane.
  Primary action: open the folder, then select a file to see its text,
  processing state and download. Upload creates one folder for the selected
  batch; adding files to an existing folder uses a dialog. Secondary details:
  per-file metadata, retention, processing provenance, suggestions, and an
  explicit move-to-folder control. Processing links from rows, attachments
  and direct URLs reach the same owned file; no overlapping empty panes.
  Whenever a current extraction exists, its pane offers Open in the reader
  and a readable excerpt; the full reader uses the bookmark reader's 68ch
  measure, suppresses remote images and names extractor, date and truncation.
  Reading and opening a pane never start inference. Failure states: missing
  or foreign ids are unavailable/404; unsupported types explain metadata-only
  coverage; queue/processing refusals show beside the file; partial uploads
  retain successful files and name failures; empty extraction points at the
  unchanged original. A failed later attempt leaves the previous text readable.
  Loading budget: thirty folder heads with bounded file metadata, one current
  extraction (up to 1 MiB) only for the selected file, no per-row text loads;
  processing observation remains two-second polling capped at two minutes.
  Evidence boundary: generated non-private single-PDF and HTML/image/CSS
  folders at desktop and mobile widths, multi-page volume, failed/unsupported
  processing, scriptless navigation, tenant refusal, unchanged originals,
  retrieval and backup/portable round trips are separate checks. Local
  provider doubles do not establish live conversion quality, ANN visibility
  or production usability. P1, P3, P4, P7, P10, P11, P13 and P15 apply.

- 2026-10-29, summary model. GLM 5.3 Flash (`@cf/zai-org/glm-5.3-flash`)
  replaces Llama 3.3 70B for file metadata and bookmark summaries, which
  the entries below name. Llama hit its 500-token limit mid-JSON on 7 of 11
  public pages at the production prefix; GLM parsed every reply in the
  eval at about a quarter of Llama's cost per page. The model, its list
  prices and the catalog date are one record in
  `app/concepts/summary-model.ts`, read by the call, the stored model name,
  the pre-processing estimate and the bookmark budget. With a 1M-token
  context, bookmarks send a 32 KiB prefix instead of 8 KiB and files 64 KiB
  instead of 12 KiB; the per-item ceiling follows from the prefix at one
  token per byte, 5319 micro-dollars. Each `source_enrichments` row and each
  `asset_processing_outputs.suggestion_model` already names its model, so
  earlier Llama summaries are kept and labelled, not redone.
  `evals/summary-model/README.md` has the numbers.
- 2026-11-23, summary model. Cloudflare retired `@cf/zai-org/glm-5.3-flash`
  on 2026-11-20; every call since answers HTTP 410, error 5028, so no file
  or bookmark got a summary from then until this change. The owner chose
  DeepSeek V4.1 Flash 1017 (`@cf/deepseek-ai/deepseek-v4.1-flash-1017`),
  which the 2026-10-29 eval rated 11/11 valid and faithful at 2.2 s p50 and
  $0.00074 a bookmark, about twice GLM's cost. It runs with
  `reasoning_effort: "none"`. List prices are $0.30/$1.20, so the per-item
  bookmark ceiling doubles to 21183 micro-dollars and fewer items fit the
  same daily budget; actual charges stay per-token. GLM rows keep their
  model name and are not redone.
- 2026-10-29, bookmarks are fetched once, summarised and split, within a
  daily budget. This reverses "Valise never fetches the URL" for one case:
  a source that never had an article, such as a Raindrop import or a save
  from a client that does not extract. The minute scheduler fetches its
  page once (`app/concepts/source-fetch.ts`): public http(s) host names
  only, robots.txt asked first with longest-match rules for `ValiseBot`
  then `*`, at most three redirects and 3 MiB, no cookies or credentials.
  A page answering 401/402/403 or declaring `isAccessibleForFree: false`
  keeps nothing, so paywalled imports keep title and notes only, as the
  owner asked; what the extension captured while signed in stays the
  snapshot for those pages, and a source with any captured article,
  detected or not, is never fetched. The article is cut from the page with
  HTMLRewriter (article, else main, else body, minus navigation and
  scripts) and stored as an ordinary `source_articles` row with extractor
  `valise-fetch-1`; no page HTML is kept. Then llama-3.3-70b reads an 8 KiB
  prefix of the article, or of notes of 400 characters or more, for a 2 to
  3 sentence summary and 3 to 7 key concepts. Every attempt is an
  append-only `source_enrichments` row (migration 0045) with its tokens and
  cost at list price; a failed or unconfirmed call is charged its 3000
  micro-dollar ceiling. The same rows are the ledger: each tick takes the
  two newest sources still owed an attempt whose owner has 3000
  micro-dollars of the rolling-day budget left (`VALISE_SOURCE_DAILY_USD`,
  default $0.25; 0 stops it). Failures retry after a day, three times at
  most; a source is redone only when a newer article arrives, not on every
  edit. At about a tenth of a cent a page, the 895 imported bookmarks
  backfill over four to five days. Search gains the summary and concepts
  on the source row, and long articles move into `source:<id>#<n>` passage
  rows written by `sourceSearchStatements()` beside every source
  projection; MCP `search` cites them like file passages. Bookmark
  passages have no vectors yet: concept search across bookmarks is lexical
  over summaries, concepts and passages.

  Interaction contract. User job: see what a saved page argues without
  opening it, find it by idea, and know what that costs. Default view: the
  Library states today's spend against the budget, how many bookmarks are
  summarised and how many wait. Primary action: none; the work runs on its
  own inside the budget, and the owner reads. Disclosed details: a source's
  details show the summary, concepts, model, date, tokens and cost, the
  passage count, and whether Valise fetched, was refused by robots.txt or
  met a paywall. Failure states: summary failed with the retry rule and the
  counted cost; nothing to summarise; budget zero says summaries are off.
  Loading budget: one extra aggregate query per Library load and one row
  read for the open source. Evidence boundary: a loopback Worker with real
  page fetches and real Workers AI summarised 16 Wikipedia and Gutenberg
  pages, refused a paywalled page, skipped a page with no article, and
  found pages by paraphrased ideas through MCP `search`; production has not
  run it on real imports yet.

- 2026-10-29, authors as a lens. A source's byline is stored as written, in
  `authors_json`, and grouped into people at read time
  (`app/concepts/authors.ts`): case, accents and punctuation never split an
  author, and a spelling with an initial ("Luke W", "L. Wroblewski") joins
  the one longer name it abbreviates. An initial that fits two people stays
  on its own rather than guessing. No alias table is stored, so a grouping
  rule can change without a migration and no edit rewrites a byline.
  `/library/authors` lists authors by how many items name them;
  `/library/authors/<slug>` is one author. Interaction contract. User job:
  get the gist of an author and be reminded, with a quote, why they matter.
  Default view: the author's name, item and highlight counts with the first
  and last save dates, then their highlights as quotes, then the captured
  page descriptions as the gist, then the items. Primary action: open an
  item, which lands on its Library card with details open. Secondary
  details: other spellings of the name. Failure states: an unknown slug is a
  404; no highlights and no descriptions each say how to get them. Loading
  budget: three D1 reads (spellings, items, highlights), at most 200 items
  and 100 highlights. Evidence boundary: highlights are matched to an
  author by page URL, since a highlight is its own reference source with no
  stored link; a synthesized gist and key concepts wait for
  todo:tdo_ed8d9196's summaries. Search already matches author names,
  because the projection carries them; a `search` filter by author changes
  the tool schema, so it waits for an eval run (ADR-0003).
- 2026-10-29, article extraction at capture. The extension now runs
  Defuddle 0.19 against a clone of the live DOM, and Readability 0.6 when
  Defuddle finds under 150 words, before it builds the `inert-dom-v3`
  snapshot. Only the live DOM still has the page's `<meta>` tags and JSON-LD,
  which the sanitized snapshot drops, so extraction belongs in the page, not
  on the server. The snapshot stays the immutable archive original; it now
  drops `<noscript>` content, which held tag-manager iframes rather than
  article text. `save_source` gains `authors` (revisioned on `sources` and
  `source_revisions` as `authors_json`) and `article`, stored append-only in
  `source_articles` per revision: Markdown, plain text, word counts, the
  extractor, a `detected` flag, published date, site name, canonical URL,
  lead image, description and language. An article under 150 words, or under
  10% of the page's words, is stored with `detected` false and no text. The
  search projection of a source adds its authors and the newest detected
  article's text, inside the same 16 KiB body cap. Valise still never fetches
  a URL; a server-side fetch for bookmarks without a capture is
  todo:tdo_ed8d9196's to decide, and writes the same table.
  Interaction contract for the Library source card. User job: read what was
  saved and see who wrote it, without opening the original site. Default
  view: the card's byline (authors, site, published date) and one line saying
  "Article, 1,240 words" or "Article not detected; full page kept". Primary
  action: Notes and details, which opens `?details=source:…` and shows the
  article's Markdown under its metadata, with authors as an editable field.
  Disclosed secondary details: extractor, canonical URL, truncation. Failure
  states: no article row (a capture from before this change, or a non-capture
  save) shows nothing new; an undetected article says so and points at the
  archived page and the highlight action. Loading budget: list reads carry
  article metadata only, one query per page; the article text is read only
  for the one opened source. Evidence boundary: the extractor's output is
  shown as extracted; Valise does not correct or summarize it.
- 2026-10-29, a reader view, and the article shown before it is saved. The
  owner found the extracted article only inside Notes and details, and a
  popup button labelled "Save HTML to Library" that never said an article
  had been found. Three changes follow. `/library/read/<source id>` renders
  a source's newest article as a typeset page: site, title, byline, date and
  word count, then links to the original page and to the archived copy when
  one is attached. It reads one owned source and its article row; another
  user's id, or no id, answers 404. The extension (0.6.0) runs extraction
  when the popup opens rather than on Save, says what it found, and tints the
  article's paragraphs on the live page with the CSS Custom Highlight API
  until the popup closes; that API paints ranges without adding a node, so
  neither the page nor the snapshot changes. A checkbox, "Also keep the full
  page as an archive", lets a save keep the article alone. That save is one
  `save_source` with `kind=bookmark`, the article and no `asset_ids`: no
  upload and no HTML asset. No server change was needed, because a source
  never required an asset and the bookmark fetcher already skips a source
  with a captured article.

  The archive stays on by default. The extracted article is a reading of the
  page, not the page: an extractor can drop a table, a figure caption or a
  footnote, and when it does, the archive is the only copy that still has
  them. The page may also be gone by the time anyone notices. The archive
  costs about ten times the article's bytes in R2, which is cheap next to
  losing the original. Someone who saves mainly to read can switch it off
  once; the popup remembers the last choice in `chrome.storage.local`, so
  the default does not fight the habit. With no article found there is no
  choice: the page is the only thing to keep.

  Interaction contract for the capture popup. User job: keep what I am
  reading, and know what will be kept before I save. Default view when
  connected on an article: the page title and URL; "Article found" with the
  byline, site, date and word count; a three-line excerpt; "Tinted on the
  page while this popup is open"; tags; the archive checkbox, checked unless
  last unchecked; and the primary action, "Save article", visible without
  scrolling at the popup's 500px height. One line under it says what the
  save keeps. On a page with no article: "No article found — the full page
  will be saved", the page's word count and why, no checkbox, and "Save
  page". Primary action: Save article or Save page. Disclosed secondary
  details: the archive format (inert HTML, scripts, external resources and
  form fields omitted), selected-text highlight. Failure states: not
  connected shows only the sign-in prompt; a page Chrome forbids (the Web
  Store, an error page) and Chrome's own pages say nothing can be saved and
  show no capture controls; a paywall teaser or a tiny page is "No article
  found" and saves the page; extraction that throws saves the page and says
  it could not read the article; a paragraph that cannot be matched on the
  page leaves the tint off and says so, while the excerpt still shows where
  the article starts; a failed save keeps today's "check Library before
  retrying". Loading budget: one 800 KB script injection and one extraction
  on open. Extraction plus tint took 46 ms on the Wikipedia DuckDB page (50
  paragraphs tinted) and 43 ms on a 6,685-word blog post (225), not counting
  the injection; Save stays disabled until both finish. Evidence boundary: the tint is matched by
  paragraph text, so it marks what the extract contains, not the
  extractor's own DOM selection; text the page renders after the popup
  opens is not in the preview.

  Interaction contract for the reader view. User job: read a saved article
  as clean text, and get back to the original or the archive. Default view:
  the site as eyebrow, the title, "By A and B · 14 Sept 2026 · 418 words"
  with author links, "Original page · Archived copy", then the article at a
  68-character measure, images as links, and a footer naming the extractor,
  the date, truncation, and whether an archive exists. Primary action:
  reading; the Library card's "Read the article" and Notes and details'
  "Open in the reader" lead here. Secondary: back to the item in Library,
  author pages. Failure states: no article row, or one not detected, says
  there is nothing to read and points at the archive or the original; an
  article-only save has no archive link and says the text is the saved copy;
  an unknown or foreign id is 404. Loading budget: one source read and one
  article read. Evidence boundary: `test/ui/capture-journey.spec.ts` drives
  the loaded extension against routed fixture pages and the local Worker,
  at the popup's real size and at 1280 and 320px for the reader; the real
  pages (Wikipedia, a blog post) were checked by injecting the shipped
  `extract.js`, not through a production save.
- 2026-10-29, passages, page citations and key concepts. Long files are
  searched by passage, so an agent asked "what does Mill say about X" can
  quote the right page. Each processing output stores a passage index
  (`passages_json`, migration 0043, additive): code point offsets into the
  output's own text, about one printed page (4000 characters) each, with a
  label such as `p. 212`, `PDF p. 12`, `slide 4` or `ch. 3: Title`. PDF page
  markers come from Workers AI `toMarkdown`, which writes `### Page N` per
  file page (checked against a real PDF on 2026-10-29); the printed page
  number is read from the page's own text when most pages agree on its
  offset from the file position, and `PDF p.` marks a page that has none.
  EPUB and PPTX extraction now write `§ chapter`/`§ slide` markers and the
  EPUB `dc:creator`; plain text and Markdown are processed as UTF-8.
  Passages project as `asset:<id>#<n>` rows in `search_docs`, cut from the
  output text with `substr()` in the same batch as the output, so the batch
  never carries the text twice (ADR-0001). The asset row keeps metadata and
  concepts and drops the extracted text when passages exist: each word of
  the file is indexed once. A passage row's title is its locator and its
  tags are empty, so a title or tag query finds the asset once rather than
  once per page; the tag filter reads the asset. MCP `search` returns a
  passage hit with its asset's id, a title such as `On Liberty · p. 82`,
  and `metadata.passage` with locator, first and last page and a citation
  (`John Stuart Mill, On Liberty, p. 82`) taken from the document's own
  author metadata until the first-class author field exists. Vectors move
  from nine 8 KiB chunks of the text's start to one bge-m3 vector per
  passage, enqueued in one statement; a semantic hit keys as its passage.
  `evals/passages/` measured the shapes ADR-0013 asked about on 129
  passages of a public-domain book: top three for 12 of 20 questions with
  lexical search, 12 with model-rewritten terms, 17 with vectors and 18
  with rank fusion. On whole books vectors earn their place; memories were
  a different corpus. Limits rise to 25 MiB processed and 1 MiB retained.
  Files over 8 MiB are not queued at upload: the processing pane shows an
  upper-bound cost estimate (text conversion is free, the metadata call
  reads 12 KiB, embeddings cover at most the retained text) and the person
  starts it. The metadata model also suggests three to seven key concepts.
  They are derived from the content, like extracted text, so they search
  from the asset row without an accept step and never touch title, summary,
  tags or project; dismissing one records a decision and leaves the
  ranking in the same batch.

  Interaction contract. User job: find the page of a saved book or deck
  that discusses an idea, from an agent or the console. Default view: the
  processing pane of a processed file states its passage count and what
  each cites, then lists its key concepts with a Dismiss control each.
  Primary action: Process file, which for a file over 8 MiB is preceded by
  the estimate in the same status line. Secondary details: limits under
  "Supported files and limits", suggestions below. Failure states: the
  existing conversion, timeout and no-text messages; an unpriced image
  estimate says so. Loading budget: unchanged, one owner-scoped read per
  visible card. Evidence boundary: a live loopback run with real Workers AI
  conversion and metadata on the same book returned 12 of 20 at the right
  page in the top three through MCP `search` in lexical mode, matching the
  offline lexical count; the hybrid figures are offline (OpenRouter bge-m3,
  rank fusion), not production Jev. Bookmark article text is not fetched
  here; capture-time extraction is a separate to-do, and saved Markdown or
  text attached to a source is processed like any file.

- 2026-10-26, one upload tool. `begin_asset_upload` is now `upload_asset`, and `finalize_asset_upload` is gone from the MCP surface: `PUT /uploads/{id}` stores the verified bytes and runs the same `finalizeAssetUpload` in that request, answering 200 with the ready asset's id, state, size and SHA-256. A finalize that fails answers 503 `not_finalized` and leaves the asset pending with its credential intact, so the client sends the same PUT again. A successful PUT clears the credential, so a repeat answers 401 and says to fetch the id. The request now buffers the file twice, received and read back from staging, which the console upload already did; 50 MiB stays inside the 128 MB isolate. The upload result carries the coverage line finalize used to append. The Chrome extension makes one tool call and one PUT. ADR-0003's amendment of the same date holds the principle.
- 2026-10-25, extension OAuth. The 2026-10-23 Chrome capture entry's
  "Extension callbacks are not admitted to OAuth registration" no longer
  holds. ADR-0004's amendment of the same date admits the
  `chromiumapp.org` callback with a grant narrowed to the three capture
  scopes; the pasted bearer is now the Advanced fallback.

- 2026-10-24, reading-first Library. The primary objects are saved pages,
  highlights and documents, not storage tables. Default cards show a title,
  origin/type, concise excerpt and organization in one place. File titles and
  thumbnails open the preview; bookmark titles open the original page.
  Configuration, linking, retention, archive and permanent deletion are behind
  an item-specific details URL. The browse request retains at most 400 note
  characters per source; only the explicitly opened source includes full notes
  and mounts its Markdown/editors. SQL filtering still searches full notes.
  This is presentation and bounded loading, not source truncation. Full exports
  and authoritative reads retain every note. Import receipts and internal ids
  are not main-card content; the original JSON receipt remains downloadable.
  A known Raindrop record's notes editor preserves its separate receipt suffix.
  Generic authored notes/tags are not stripped as import bookkeeping.
  Reference images group only by their written project and reference tag; no
  new relation is inferred or stored. Attachment choices are read only when
  explicitly requested, in thirty-row windows, and exclude import receipts.
  Saved history is an explicit, owner-scoped read of at most ten versions.
  Unlink changes only the current connection; retained history still protects
  originals. The UI states that distinction rather than promising unlink will
  authorize permanent deletion. Archive remains reversible hiding.
- 2026-10-24, processing eligibility and context. A known MIME type admits an
  extensionless or truncated saved filename; generic MIME types retain the
  extension fallback. This fixes a real extensionless `application/pdf` being
  rejected despite its supported MIME and size. Admission and conversion use
  the same format policy; new outputs record `valise-extract-2`, while old
  outputs are not rewritten or automatically reprocessed. Eligibility is not proof that encrypted, damaged or
  scanned content is readable. The UI checks type and the existing 8 MiB limit
  before offering work and explains failures without raw provider messages.
  Processing details and suggestion review use the existing side pane, with
  `?processing=<assetId>` retaining context and the existing direct route as
  the no-script/modified-click fallback. Bounded observation can continue in
  that status pane but pauses for an editor or another dialog; viewing never
  starts inference. Existing quotas, token fences, original checksums and
  stale-field acceptance checks remain. The workflow/acceptance correction is
  `docs/retros/2026-10-24-library.md`, enforced as a review contract in
  `AGENTS.md` and the PR template, not as another product work queue.

- 2026-10-24, bounded Library reads. The 895-bookmark import exposed the
  console's unbounded source hydration: one head read, one link read and a
  read per linked asset for every source, before filtering or rendering.
  Library now selects at most 30 files, 30 sources and 30 durable linking
  choices per request, with independent creation-time/id keyset cursors.
  Project and all-tag predicates run in SQL before the limit. Source heads
  and current owned links load in two queries rather than per-card reads.
  Exports retain their full-list contract and use the same bulk link join;
  no source, revision, original or search projection is changed. Older/newest
  links work without scripting and page/filter URLs survive inline saves
  (P3, P4, P10, P11). Thumbnail laziness and browser hydration are independent:
  neither can bound a server loader. Runtime and browser regressions use
  895 linked sources; they do not claim a whole-library production browser
  measurement from an empty account.

- 2026-10-24, upload processing and review. Finalization admits bounded durable
  work after saving the original. Console uploads start it with `waitUntil`;
  minute maintenance recovers agent uploads and interrupted leases. Processing
  failure never rolls back upload. Each owner has two pending files and 20
  requests per rolling day; receipts survive original deletion. Three interrupted
  attempts exhaust a request. Late results offer a persistent review affordance
  and small accessible modal, with a native detail-route fallback. Individual
  apply/dismiss decisions persist without rewriting outputs. Apply atomically
  checks the current generation, decision and rendered field value. Project/tag
  filters are the library's category/collection browsing. The memory tenant
  scheduler stays unchanged; asset delivery uses separate fair tenant turns and
  `a:<tenant namespace>` from `tenantVectorNamespace` in the same Vectorize index.
  Migration 0039 is fresh and additive; candidate 0030 was never published and
  published migration history is untouched. Read-only Mia research and the
  capability/evidence boundaries are in `docs/operations/asset-processing.md`.
- 2026-10-24, recovery and uncertain providers. Attempts, immutable outputs,
  selected heads, apply/dismiss decisions and admission receipts are authoritative
  recovery data, not a disposable extraction cache. Restore preserves their
  ownership, provenance and spent attempts, invalidates live leases, and turns
  queued/running work into an explicit interrupted failure rather than restarting
  paid inference. Scheduler cursors and external vector acknowledgements are
  omitted only with a fresh index/base identity and explicit rebuild; lexical
  reindex needs no provider. The complete table/transformation contract is in
  `docs/operations/asset-processing.md`. Local provider deadlines bound waiting,
  not remote execution or billing. Unconfirmed calls keep a 90-second admission
  cooldown, including after original deletion. At most three attempts may be
  started per admitted request; late responses cannot publish through an obsolete
  token. The cooldown does not prove cancellation or cap live remote work at two.
  The operator's `backup.mjs enqueue-assets` step reuses the application current-
  output backfill/stamp/outbox code against the restored D1, with no extraction,
  metadata inference, embedding or index query. It requires exact migrations,
  different source identities, explicit Worker confirmation and a paused,
  index-free lexical/off configuration. Only subsequent reviewed configuration
  enables delivery to the shared fresh memory/asset index; neither restored
  acknowledgements nor enqueue completion can select hybrid or prove visibility.
- 2026-10-23, bounded content processing. Processing is an independent stage
  after upload; parsing or inference cannot roll back a successful upload.
  Migration `0039_asset_processing.sql` adds versioned
  attempts, immutable successful outputs and a current-output pointer. Each
  output names its asset, immutable object, original SHA-256, processor version,
  extractor, timestamp and suggestion model. Reprocessing adds an output; it
  never rewrites original bytes or an earlier output. Only the newest requested
  generation can move the head. A running request can be retried after 90
  seconds; fixed failure codes remain visible, without provider response text.
  Processing is authenticated and owner-scoped at `/library/:assetId/process`.
- 2026-10-23, multi-user processing. Following ADR-0016 and PR #149, every
  attempt, successful output, head and vector delivery target carries the
  authenticated owner's `user_id`; none defaults to `local`. Processing and
  metadata actions derive that owner from the console principal, while the
  minute supervisor retains the stamped owner on each job, including after
  the original has been deleted. Claim, hydration, repair and acknowledgement
  predicates include it. The vector stamp covers the owner too. Projection
  writes select the owned asset and publish `search_docs.user_id` atomically;
  exact search, candidate eligibility, derived fetches and generation prompts
  see only that owner's rows and vocabulary. A two-non-local-user regression
  exercises each boundary, including refused cross-owner suggestion acceptance
  and an invalidation that cannot dirty someone else's vector job. The shared
  `a:<tenant namespace>` index partition does not imply a shared library: every ANN
  query prefilters owner-scoped keys before D1 hydration. No by-hand uniqueness
  migration or remote migration is part of this slice.
- 2026-10-23, formats and limits. The application processes originals up to
  8 MiB, while upload/download retain their 25 MiB limit. Cloudflare's
  `AI.toMarkdown` handles PDF text, PNG/JPEG/WebP/GIF descriptions and XLSX cell
  text. Scanned-page PDF OCR is not claimed; image descriptions are generated,
  not verbatim OCR. The current supported-format list does not include EPUB or
  PowerPoint, so bounded local ZIP readers extract EPUB chapters in spine order
  and PPTX slides in numeric order. The reader rejects more than 512 entries,
  16 MiB declared total expansion, 2 MiB selected text expansion, entries over
  4 MiB and unsafe archive paths;
  only chapter/package or slide text entries inflate. No filesystem extraction,
  DTD/entity expansion, macro/formula execution or external-resource fetching
  occurs. Legacy PPT/XLS, macro-enabled formats, DRM, encrypted documents and
  slide images/charts are not supported. Remote conversion has a 12-second
  application deadline; metadata generation has a separate 10-second deadline.
  A late conversion result cannot publish after its request has failed.
- 2026-10-23, exact retrieval. Successful output text is UTF-8 capped at 64 KiB
  with a visible truncation flag. Assets alone append this text beyond the
  other concepts' 16 KiB projection cap; it remains one asset row in the shared
  `search_docs` corpus, never another FTS index. Output, head, projection and
  vector delivery targets commit in one D1 batch. Metadata edits and reindex
  preserve the same extracted head. Search and fetch state the coverage;
  generic `fetch` returns derived text with its provenance. The existing
  `content_indexed: false` literal on cached asset-tool outputs is retained:
  the entire original is not indexed. Generic fetch additionally reports
  `extracted_content_indexed` and the bounded extraction descriptor. Generated
  suggestions do not enter search until accepted. Reranking bounds asset text
  to an 8 KiB passage/prefix plus the lexical matched snippet, rather than
  sending complete extracted documents per candidate.
- 2026-10-23, semantic delivery. Reuse ADR-0013's bge-m3 model, the existing
  1024-dimensional Vectorize index, D1 delivery ledger and minute maintenance.
  Reserve `a:<tenant namespace>` alongside the existing head/history partitions;
  unrelated memory vectors cannot consume asset candidate slots. A successful
  output produces at most nine UTF-8-safe chunks (8 KiB each, plus a possible
  boundary remainder). Each immutable stamp
  covers model, namespace, original checksum, asset/output identity, chunk
  position and text. The asset ledger retains deletion targets after an asset
  is deleted, leases each chunk for 90 seconds, retries fixed errors with
  exponential backoff and repairs acknowledged targets daily. Head changes,
  archive/restore, retention changes and deletion dirty recorded namespaces in
  their authoritative batch; an epoch and lease token keep an in-flight
  acknowledgement from clearing newer work. Four chunks per
  minute add at most 5,760 attempts/day to memory delivery capacity; daily
  repairs are recurring inference, not free cleanup. Two missing output ledgers
  are rebuilt per minute, including after restore or namespace changes.
  Acceptance is not ANN visibility. Changes to title/project/tags do not need
  re-embedding: vectors contain immutable extracted text only; current metadata
  is hydrated from D1. Owner, publication, expiry, current output and every
  filter are validated before reranking, and chunk stamps are recomputed.
  Owner-scoped eligible keys are prefiltered in indexed groups of 32, capped at
  256 assets under the shared 2.5-second stage budget. Wider scopes or provider
  failures explicitly fall back to lexical search. Reprocessing/archive/delete
  rejects stale candidates immediately, before external cleanup catches up.
- 2026-10-23, provisional organization. Llama 3.3 70B FP8 suggests a title,
  short summary, up to eight tags and one optional project from the first
  12 KiB of extracted text. The model's documented 24,000-token context is not
  treated as a whole-book summarization promise. Generated JSON is validated,
  bounded and canonicalized against existing vocabulary. The console marks
  suggestions as unsaved ghost controls, distinguishing existing labels from
  new suggestions (P1, P2, P7, P9, P10, P11). Each click accepts only the chosen
  field in the authoritative/projection batch; a tag click adds that tag to the current set.
  Summary acceptance replaces the description only with an explicit click.
  Delayed inference never changes authoritative metadata. Project remains the
  single folder-like category and tags the overlapping collections; no new
  arbitrary folder tree or second classification system is introduced.
  `readVocabulary(DB, userId)` includes that owner's library labels, never
  another owner's assets or sources. Version-1 library export keeps originals
  and accepted metadata, not full decision/history recovery; installation backup
  must preserve exact outputs, provenance and apply/dismiss decisions under the
  recovery contract above.
- 2026-10-23, verification boundary. `test/d1/asset-processing.worker.test.ts`
  exercises real ZIP parsing, D1/R2, exact retrieval/reindex, immutable bytes,
  provisional acceptance, rollback, failures and shared semantic candidate
  delivery. AI conversion, generation, embeddings, ANN and Jev are external
  contract doubles. These checks do not establish live PDF/image/XLSX
  conversion, semantic ranking quality, ANN visibility or a browser review of
  the integrated library. Those remain acceptance work on
  `todo:tdo_0dd064ea-3ecb-441e-aa39-0b6ce06f0137`; local implementation is not a
  reason to complete it. Cloudflare API evidence retrieved on 2026-10-23:
  [supported formats](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/supported-formats/),
  [binding contract](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/usage/binding/),
  [conversion mechanism](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/how-it-works/),
  [Llama model and limits](https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/).
- 2026-10-24, Raindrop one-time import. A local CLI reads the owner's
  authorized API snapshot and prepares the existing portable library format;
  no connector, credential, background fetch or synchronization is added to
  the Worker. Bookmarks become sources with supplied notes/highlights and
  collection tags; a linked JSON snapshot preserves complete input metadata,
  and uploaded originals become assets. Account-scoped stable source ids and
  content-addressed asset ids make the existing skip-on-import rule retry-safe
  without overwriting later Valise edits. HTTP import batches hold ten sources
  to bound D1 subrequests. Remote pages and cached web copies are not crawled,
  and search retains its metadata/notes-only boundary. Commands and limitations
  are in `docs/operations/library-export.md`.

- 2026-10-24, selected-text capture. The Chrome extension saves a selection
  as a separate `reference` source, with the original page URL, chosen tags,
  the quote and up to 180 characters of nearby text on either side in notes.
  It requires no HTML upload or additional browser permission. Highlights
  share the page URL with an existing document when one exists; there is no
  typed source-to-source relation, source lookup, or revision of the document.
  Without an existing document the reference stands alone. This uses the
  existing `sources:write` authorization and append-only source revisions.

- 2026-10-23, deployment recovery. The portable per-user library directory and
  import endpoints remain unchanged. `scripts/backup.mjs` adds an operator-run
  off-instance recovery artifact: explicitly classified authoritative D1 rows,
  every `objects` original and every historical skill-bundle file, source config
  and migration hashes. It preserves tenant IDs, revision/relationship history
  and expiry rather than importing everything as one token's owner. A host cron
  supplies scheduling; successful captures alone advance retention, and a status
  command exposes failed, locked or stale runs. There is no new public endpoint,
  Worker binding, source-bucket backup prefix or production cron side effect.
  The operator must activate the independent schedule and alert delivery.
  Restore only targets new unpublished Worker/D1/R2/KV/DO resources. It drops
  sessions, grants, invite/verification/upload credentials and scheduler state,
  retains user identity/password hashes, and rebuilds FTS through the existing
  application reindex code before publication. Claimed D1 snapshots retain
  their state but have no holder, expiry zero and an advanced fencing floor;
  the fresh coordinator performs subsequent transitions. Fresh secrets and
  namespaces, not a historical counter, isolate clients holding tokens issued
  after the snapshot. This extends ADR-0002's loss/restore boundary without
  adding a second state-transition path. Exact migrations are restored before
  normal upgrade. `docs/operations/backup-recovery.md` records the exclusions,
  schedule, checks and local Wrangler fresh-install exercise; it does not claim
  that production backup or a provider disaster recovery drill has run.
- 2026-10-23, Chrome capture. The Manifest V3 client saves an `inert-dom-v2`
  main-frame HTML snapshot as a durable asset, linked from a document source
  carrying the original URL. Both records receive the selected tags. Scripts,
  external resources, form fields and editable content are omitted; this is a
  rendered DOM snapshot, not an original-response or pixel-perfect archive.
  Serialization rebuilds a fresh canonical document from safe HTML elements;
  raw-text content becomes escaped text rather than reparsable source markup.
  Upload uses begin, HTTP transfer, finalize and source linking. Extension
  callbacks are not admitted to OAuth registration: setup uses an explicitly
  supplied scoped console bearer, stored locally in trusted extension contexts
  rather than synced. Only an authenticated, scope-checked bearer may use an
  exactly formed Chrome extension Origin; Host checks and ordinary web Origin
  restrictions remain. HTML delivery is attachment-only and previews show
  escaped text, never an executing page. Snapshot contents are not indexed.
- 2026-10-23, browser thumbnails. Library cards render an ephemeral image,
  PDF page-one or EPUB raster-cover thumbnail from authenticated original
  bytes. Parsing is lazy, browser-only and bounded; document scripts, remote
  resources and SVG covers never execute. Failed, expired, encrypted or
  unsupported files keep a placeholder and their ordinary download control.
  These canvases and blob URLs are not stored derivatives or searchable
  extraction. No original, metadata or index changes when a preview renders.
- 2026-10-22, broad discovery. `search(include_library: true)` searches all
  five concepts in the shared corpus, so a broad topic or author question can
  find uploaded books and saved sources in one call. An explicit `type` still
  narrows to that kind. Omitted or false keeps the original three concepts,
  preserving cached clients' result enum; only a freshly discovered input
  schema offers the opt-in. Search guidance names the flag for broad questions
  and keeps the metadata/notes-only boundary. No file parsing or page fetching
  is added. The 2026-10-21 type-only exposure below remains the default, not the
  only route to library hits.
- 2026-10-21, projection table. `search_index` declares
  `CHECK(concept IN ('skill','memory','todo'))` in `0000_init.sql`, so no
  asset or source row could enter it. SQLite widens a CHECK only by rebuilding
  the table, which ADR-0008 makes a by-hand migration that stops every deploy
  behind it. Migration `0023_search_docs.sql` instead adds `search_docs`, the
  same six columns with no concept CHECK, its own FTS5 table
  `search_docs_fts`, triggers and `search_docs_vocab`, and copies every row
  across under its rowid. App code reads and writes `search_docs` only. The
  vocabulary is the `SearchConcept` type that every `ProjectionRow` carries.
  Three triggers forward any insert, update or delete that still reaches
  `search_index` into `search_docs`, which covers the seconds between the
  deploy's migration and its Worker swap; reindex reconciles anything else.
  `search_index`, its FTS table and its triggers stay until a later merge
  drops them with a `-- valise:by-hand` migration. A rebuild of the old table
  in place was rejected for the by-hand step; a second, per-concept FTS index
  for assets and sources was rejected because BM25 scores only compare inside
  one corpus (ADR-0001).
- 2026-10-21, upload transport. The bounded destination is the Worker's own
  `PUT /uploads/{assetId}?token=…`, not a presigned R2 URL: presigning needs
  S3 API credentials the deployment does not hold, and a new required secret
  fails every deploy until it is set. The credential is 32 random bytes,
  stored as an HMAC digest under `TOKEN_PEPPER`, valid for one pending asset
  for an hour (`UPLOAD_TTL_SECONDS`), and cleared at finalize. The PUT writes
  only `u/{userId}/uploads/{assetId}`. `Content-Length`, when sent, must equal
  the declared size before the body is read; a chunked body is read only up
  to that size. A declared `sha256` is checked before anything is stored.
- 2026-10-21, finalization. Each finalize copies the verified staged bytes to
  a fresh `obj_` key, then one batch inserts the `objects` row and flips the
  asset to `ready` only while it is still `pending`, plus its projection. A
  finalize that commits nothing, from a race or a failed batch, deletes the
  copy it wrote; the staging object goes only after a commit. So a retry
  never duplicates an asset or an object, and no referenced key is ever
  rewritten. A ready asset returns unchanged.
- 2026-10-21, limits. `MAX_ASSET_BYTES` is 25 MiB: upload and finalize each
  buffer the file once in a 128 MB isolate, and a scanned PDF outgrows
  ADR-0011's 10 MiB attachment cap. MCP resource reads of an asset keep the
  10 MiB cap and name `get_asset_download` above it. No per-user quota yet.
- 2026-10-21, downloads. `get_asset_download` returns
  `/downloads/{assetId}?expires=…&signature=…`, an HMAC under `TOKEN_PEPPER`
  over the asset id and expiry, valid 15 minutes (`DOWNLOAD_TTL_SECONDS`),
  which is also the revocation delay. The route rereads the asset's state on
  every request, so an expiry or deletion set after issue applies at once.
  `valise://asset/{assetId}` serves the same bytes as an MCP resource under
  `assets:read`, for clients that read resources but cannot make HTTP calls.
- 2026-10-21, expiry on existing paths. `readObject`, which `/files/{id}` and
  the to-do and memory attachment resources go through, answers missing for
  an object whose asset has expired, and `fileResponse` sends
  `private, no-store` instead of the year-long immutable policy for any
  object an asset will expire. `update_asset` refuses an expiry while a to-do
  or memory attachment links the object; `begin_asset_upload` takes
  `expires_in_seconds`, so a temporary handoff never needs a second call.
- 2026-10-21, search exposure. `search`'s structured result is a cached
  client contract (ADR-0003, 2026-10-21): a client that discovered it before
  this change validates `type` against skill, memory and todo, and rejects
  the whole result if one hit is an asset. So an unfiltered search still
  covers only those three, and asset hits arrive only for `type: "asset"`,
  which no stale schema can send. That is the opt-in contract the ADR-0003
  amendment asks for, at the cost of an unfiltered search not finding files.
  The projection carries no owner or expiry, so each asset hit is checked
  against its row before it is returned. A result holding an asset carries a
  second text block saying file contents are not indexed; `fetch` says the
  same in `metadata.coverage` with `content_indexed: false`.
- 2026-10-21, archive. `archived_at` takes an asset out of search and lists
  only. Its id still fetches and downloads, because sources and notes that
  cite it must keep resolving.
- 2026-10-21, source revisions. `sources` is the head and
  `source_revisions` holds every revision, the first included, as saved;
  `source_revision_assets` holds each revision's links in order. Both history
  tables are append-only. `save_source` without `id` creates revision 1;
  with `id` it needs `expected_revision`, keeps omitted fields from the head,
  and replaces the links only when `asset_ids` is sent. A stale expectation
  is refused with the current revision. Two saves racing from the same one
  both try to insert the same `(source_id, revision)`, and the UNIQUE index
  refuses the loser inside its batch, so neither overwrites the other.
  `kind` has no CHECK, for the same reason `search_docs.concept` has none.
- 2026-10-21, source search and notes. The projection body is the URL then
  the notes, capped at 16KB like every concept; `fetch` returns the notes
  whole, up to the 64 KiB input cap. Unfiltered `search` excludes sources for
  the cached-schema reason above; `type: "source"` finds them, and a result
  holding one says that neither linked files nor the page behind the URL are
  indexed. Nothing fetches the URL.
- 2026-10-21, link protection. Any `source_revision_assets` row, head or
  history, of an archived source too, protects its asset: `update_asset`
  refuses an expiry and the console's delete refuses the file while one
  exists.
  `save_source` refuses to link an asset that is not ready, not owned, or has
  an expiry. Linking needs `assets:read` beside `sources:write`, checked in
  the preflight with the same `insufficient_scope` challenge, so a token
  that cannot download a file cannot cite it. `sources:read` has no MCP tool:
  `search:read` covers search and fetch, and the scope gates the library
  export, which reads every revision.
- 2026-10-21, console. `/library` lists files and sources, with an
  Archived section (P5). Upload is a multipart form whose action runs the
  same begin, staged bytes and finalize as an agent, so the console has no
  second write path. Titles, descriptions, URLs and notes edit in place
  (P1, P2); a source field save posts the revision it was read at and is a
  new revision. Linked files are a set with "Remove {title}" and a picker
  that offers only durable files (P7). Retention is a select: keep, or delete
  after 1, 7 or 30 days. Preview reuses the attachment `FilePreview` over
  `/files/{objectId}`, which enforces expiry. The lede states that file and
  page contents are not indexed.
- 2026-10-21, deletion. Deleting a file is console-only and refused, naming
  each reference, while a source revision, a to-do or a memory attachment
  links it. It deletes the bytes first and the rows second, so a failure in
  between leaves a row whose bytes every path already answers as missing,
  never bytes no row names. Deleting a source removes its head, every
  revision and every link in one batch: the explicit removal that releases
  the files it protected. Source revisions are otherwise append-only.
- 2026-10-21, cleanup. The nightly cron runs `cleanupLibrary`: it deletes
  pending uploads past their credential's hour, with their staged bytes;
  expired assets nothing refers to, bytes first; staged bytes with no pending
  asset; and object keys no `objects` row names once a day old, which also
  sweeps ADR-0011's accepted orphans. Each row is its own attempt, errors are
  logged, and a rerun is idempotent, so a partial R2 or D1 failure retries
  the next night. At most 200 rows of each kind per run.
- 2026-10-21, export and import. `scripts/library.mjs` exports a directory of
  originals plus `manifest.json` and imports it back, through bearer-token
  endpoints under `/library/`: export needs `assets:read` and
  `sources:read`, import `assets:write`, `assets:read` and `sources:write`.
  Import keeps asset and source ids, timestamps, every revision, link and
  provenance, verifies each file's size and SHA-256, writes the projection in
  the same batch, and skips ids already present, so a rerun is safe. The
  format is documented in `docs/operations/library-export.md`.
- 2026-10-21, left out. Registering an existing to-do or memory attachment
  as an asset is not built: nothing needed it, and attachment bytes stay
  durable and reachable as before. MCP tools for archive and delete are not
  built, by ADR-0003's no-delete rule. There is no per-user quota.
