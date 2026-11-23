# Library documents: folders, processing and reading

Contract: ADR-0015, amendment of 2026-10-29, “documents are folders”.
Queue: `todo:tdo_c2ba2deb-2ee9-40ae-b666-6adbad355165`.

## Default view and primary action

The Documents tab pages thirty folders, not thirty files. A one-file PDF
and a multi-file folder use the same row and pane. The row shows the folder
name, count and total bytes; processing status identifies the representative
file when a folder contains several files. A thumbnail occupies the row's
left edge at its full height, without changing geometry when it arrives.

Opening the row shows its filenames. Selecting one opens that file's
processing, current extracted text and download in one pane. Open in the
reader shows all retained text at the bookmark reader's 68ch measure, with
the extractor, version, date and partial-coverage notice. Viewing starts no
inference. Mobile processing uses the same bottom sheet as other item panes.
Add files and Move file each disclose a dialog; a new upload batch creates
one folder, including successful files when another file fails.

P1, P3, P4, P7, P10, P11, P13 and P15 govern these interactions.

## Browser walkthrough

`test/ui/library-documents.spec.ts` drives the real console routes and stores
these non-private fixtures: a generated PDF original with a synthetic current
processing output retained after a failed later attempt, and an HTML/text/CSS
folder. Both a row's Process file button and the pane's Process file action
are exercised. The text file is processed
through the real explicit Process action; local AI unavailability leaves
text readable with a suggestion-failure notice. The PDF output is a fixture,
not evidence that a provider extracted that PDF.

The walkthrough opens the folder, switches files, processes text, reads,
downloads unchanged bytes, adds a fourth file and moves a selected file into
another named folder. It checks one pane, URL restoration, horizontal bounds,
row-height thumbnail geometry, unsupported processing and unknown-reader 404.
Native multipart grouping and a native reader link run with scripting off.
The retained mobile processing view is the expanded bottom sheet.

| View | Desktop | Mobile |
|---|---|---|
| Populated default | [1280px](evidence/library-documents/default-1280.png) | [390px](evidence/library-documents/default-390.png) |
| Selected file after processing | [1280px](evidence/library-documents/pane-1280.png) | [390px](evidence/library-documents/pane-390.png) |
| Reader | [1280px](evidence/library-documents/reader-1280.png) | [320px](evidence/library-documents/reader-320.png) |
| Reader without scripting | — | [390px](evidence/library-documents/native-reader-390.png) |

The retained views were inspected for the default hierarchy, selected-file
context, readable content, separate reader links and a usable narrow-screen
pane. This is browser usability evidence with generated content, not a probe
of the owner's private Library or of provider extraction quality.

## Data integrity

`test/d1/asset-folders.worker.test.ts` covers singleton creation, explicit
grouping without changing originals or asset metadata, cross-owner refusal,
SQL owner guards, thirty-folder pages across 35 folders, a matching member
outside the first window, a full 100-file folder and refusal of its 101st
member. Portable round trips preserve names and membership in reverse import
order; older descriptors still create singletons.

`test/backup.test.mjs` includes a named member-owned group and an interrupted
upload in the same container. Both the CLI capture and scheduled Workflow
backup paths restore the authoritative folders/membership and original
checksums into fresh local D1/R2. Restore replaces the singleton defaults
generated while loading assets with the captured relations. It does not
restart inference or replay credentials.

Migration 0047 adds tables, indexes, inserted singleton relations and runtime
triggers. It rewrites no original asset row or R2 key. The migration audit
classifies it as additive; no by-hand migration is part of this release.

## Retrieval

The reader and pane select the owned current processing head, not the newest
attempt. A later failed attempt cannot hide a previous successful output.
The original download remains the same owned object. Existing processing
regressions cover extracted-text search, reindexing and immutable originals;
folder moves do not change those rows or projections. Folder names are
console organization, not an additional MCP search concept.

Local runtime and browser tests do not establish live conversion quality,
semantic ranking or ANN visibility. No tool description changed, so this
release does not claim a new tool-choice eval result.

## Release and production evidence

The PR records `npm run verify` against its exact head and the successful
Workers Build against the squash commit. Production smoke and deployment
observation are recorded separately on the PR and to-do after merging. The
local walkthrough alone is not production confirmation.
