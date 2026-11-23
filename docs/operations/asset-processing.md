# Asset processing

Finalization saves the immutable original before attempting durable processing
admission. Unsupported files, quota refusal, queue failure or extraction failure
cannot turn a completed upload into a failed upload. Console uploads start their
admitted job through `ctx.waitUntil`; the minute scheduler recovers queued or
interrupted jobs, including agent uploads. GET requests never start inference.

## Budgets and recovery

Each owner may have two pending requests and make 20 processing requests in
a rolling 24 hours. Admission and its quota receipt commit together; deleting an
original does not refund usage or remove an active provider cooldown. Old,
inactive receipts are removed in bounded pages. Receipts retain spent attempts
independently of cascading asset rows.
Each request permits three attempts only for interrupted lease recovery, not
unlimited retries of provider failures. Failed work offers an explicit retry.

Attempts have a 90-second token-fenced lease. The application waits at most 12
seconds for conversion and 10 for metadata inference, leaving headroom inside
HTTP `waitUntil`'s 30-second extension. Neither `Promise.race` nor an abort signal
proves that Workers AI stopped execution or billing. An unconfirmed binding call
retains an admission cooldown for at least 90 seconds after the local failure
instead of immediately freeing a slot;
late results are discarded. The UI reports the uncertainty and retry timestamp.
These are application admission limits, not a claim of at most two live provider
tasks: a provider can outlive the cooldown. Each admitted request can start at
most three attempts, each with at most one conversion and one metadata call.
No automatic retry follows an observed provider failure. Interrupted invocations
may recover only within that spent-attempt budget. The minute scheduler reserves
one tenant turn; it does not restart an upload. No Queue,
Workflow, filesystem service or new external provider is required.

## Format boundaries

| Format | Extracted content | Not covered |
|---|---|---|
| PDF | Workers AI `toMarkdown` page text | Scanned-page OCR, encrypted PDFs |
| PNG, JPEG, WebP, GIF | Generated image description | Verbatim OCR, animation beyond provider coverage |
| EPUB | Container-selected package, reading-order spine text | DRM, scripts, external resources |
| PPTX | Numeric slide order, text elements | Legacy PPT, chart/image interpretation, macros |
| XLSX | Workers AI `toMarkdown` cell text | Legacy XLS, macro formats, formula execution |
| TXT, MD | UTF-8 text | Other encodings |

Processing accepts files up to the 25 MiB upload limit. Uploads up to 8 MiB
queue automatically; larger files wait until the person starts them from the
processing pane, which shows an upper-bound cost estimate first. Retained text
is UTF-8 capped at 1 MiB, with visible partial coverage. ZIP readers allow
2048 entries, 64 MiB declared expansion, 4 MiB per entry and 12 MiB selected
text.

## Passages

Each output stores a passage index in `passages_json`: code point offsets into
its text, about 4000 characters each, labelled by page (PDF), slide (PPTX) or
chapter (EPUB). Pages pack together when short; slides and chapters never
merge. Printed page numbers are read from the page text when most pages agree
on their offset from the file position; otherwise the label says `PDF p.`.
Passages are rows `asset:<id>#<n>` in `search_docs`, written by
`assetSearchStatements()` beside every asset publication, edit, archive and
reindex. MCP `search` returns them under the asset's id with
`metadata.passage` (locator, first, last, citation). One bge-m3 vector per
passage is delivered through the existing ledger at four per minute, so a
130-passage book is semantically searchable after about half an hour and
lexically at once.

Costs at Workers AI list prices (2026-10-29): text conversion free, metadata
at most about $0.003 per file (64 KiB prefix, 900 output tokens with
glm-5.3-flash, `app/concepts/summary-model.ts`),
bge-m3 embeddings $0.012 per million tokens, about $0.001 for a 280 KB book.
Image description is billed by Workers AI and not estimated.
Only selected text inflates; nothing executes macros, formulas or document
scripts, expands external entities, extracts to disk or fetches embedded URLs.

Successful outputs are immutable. They name the owned asset/object, original
SHA-256, processor version, extractor and suggestion model. Output, current head,
shared FTS projection and vector delivery targets publish in one D1 batch.

## Upload and review

The upload result states whether processing was queued. Cards show queued,
running, failed or searchable status and keep the original download visible.
Status polls every two seconds, for at most two minutes per active observation;
background tabs, active editors and unrelated dialogs pause polling. The
processing status pane may keep observing its active request. Refresh remains a link
or form for no-script use and for work finishing outside that observation window.

Late results show a persistent “Suggestions ready” information affordance on the
file. “Review suggestions” opens the existing side pane; with scripting
off it opens `/library/:assetId/process`. It never steals focus automatically.
Title and summary are explicitly provisional; ghost project/tag labels identify
existing vocabulary versus new suggestions. Each field can be applied or
dismissed independently. Decisions persist separately from immutable outputs.
No generated metadata is silently applied. Apply checks the current output,
undismissed decision and rendered field value atomically, so an old tab cannot
overwrite a newer human edit. Processing itself never edits metadata.

A known saved MIME type is sufficient even when a long filename has lost its
extension. Generic MIME types fall back to the filename extension. Admission
and conversion use the same policy. The UI states unsupported type/size limits
before work and disables an ineligible processing action. Conversion can still
fail for damaged/encrypted content; MIME eligibility is not byte validation or
a promise of scanned-page OCR. Opening the pane, refreshing it or previewing an
original never starts inference. Enhanced details keep `/library` and its
filters/cursors; the direct processing route remains a link/form fallback.

Documents are flat folders, even when they contain one file (ADR-0015,
2026-10-29 amendment). A batch upload creates one folder; its pane lists the
original filenames, offers Add files and an explicit move to another folder.
Folders hold up to 100 files. Project and tags remain each file's categories;
sharing a project, tag or filename prefix does not group files. Filtering
selects folders with a matching member and leaves their other files visible
inside. The default list selects thirty folders before loading one
representative per folder; it never splits a group across file pages.

The folder pane and the direct processing route show the selected file's
current extracted text and Open in the reader. `/library/read-file/:assetId`
reads that same owned output, including a previous successful output after a
later attempt failed. Only one selected output is loaded; list rows never
carry extracted text. The reader links remote images rather than loading them,
labels the extractor/date/truncation and retains Download original. Nothing
about viewing a folder or reader starts processing. P1, P3, P4, P7, P10,
P11, P13 and P15 govern these controls.

Migration 0047 is additive: `asset_folders` and `asset_folder_files`, one
inserted singleton per existing asset and an asset-insert trigger for every
writer. Owned membership is unique per asset and capped at 100 by triggers.
Moves change membership only; empty folders are removed after a move or the
last original's deletion. R2 keys, original checksums and source/history links
do not change. Both tables are authoritative recovery data. Restore replaces
the singleton defaults generated by asset inserts with the captured folders
and memberships. Portable library v1 adds an optional `folder` descriptor per
asset; older manifests still import as singleton folders. Folder names are
console organization, not another MCP search concept or a nested tree.

## Shared retrieval

Passages carry the extracted text; outputs from before passages keep their
first 64 Ki characters on the asset row. Key concepts join the asset row.
Semantic delivery uses the existing bge-m3 model and Vectorize index, with a
disjoint `a:<tenant namespace>` partition from `tenantVectorNamespace`. Its
delivery ledger retains deletion targets, token-fenced retries and dirty epochs.
Four chunks per minute rotate among tenant turns; the memory fair scheduler is
unchanged. Vector delivery failures retain a 90-second lease/cooldown in addition
to their retry backoff; a local deadline does not prove provider cancellation.
Mutation acknowledgement is not proof of ANN visibility.

Search prefilters owned keys, hydrates current owned output and validates
account admission, checksum stamps, publication, expiry and filters before
joining the shared reranker. Provider failure or scopes above 256 assets fall
back to lexical search. There is no independent FTS or semantic index.

## Research and evidence boundaries

Read-only architecture research used the local tools repository's Mia modules:
`mia/src/mia/knowledge/pdf_ingestion.py`, `pdf_worker.py`, `pdf_inventory.py`,
`epub.py`, `enrichment.py` and `mia/pyproject.toml`. Relevant mechanisms were
checksum-bound originals, durable leases/checkpoints, format-specific extraction
and independently validated enrichment. Mia's Python/PyMuPDF, local filesystem,
normalization and multi-pass model cleanup stack is not copied into a Worker.
This implementation does not claim Mia's page-level cleanup or whole-book
summaries. Its metadata model sees a bounded 12 KiB prefix and owned vocabulary,
and suggests a title, summary, tags, project and three to seven key concepts.

The canonical conversation-history script was searched for EPUB, Mia, PDF and
pipeline symbols. No substantive Mia processing conversation was found in the
available indexed history; code, not an inferred past decision, settled the
runtime choice. No private document, secret or transcript is part of this change.

The reused unmerged candidate is `fcd0be282fd53f56f43e310c4599bd2b0cf167a1`.
Its synthetic five-format live extraction/checksum and delayed rank-one ANN
results are smoke evidence only. They do not establish broad relevance, fresh
ingestion visibility, public MCP/Jev behavior or the integrated upload/review UI.
Its older full gate does not verify this integration. Current-head runtime,
browser, tool-description eval and full verification remain required before push.

## Recovery table contract

Processing history is not a disposable extraction cache. The exact generated
output is evidence for a person's apply/dismiss decision; rerunning a model
cannot reproduce that evidence. A full installation recovery must preserve it.

| Table | Policy | Restore transformation |
|---|---|---|
| `asset_processing` | Include every owned attempt, generation, processor version, state/error and timestamp as provenance/history. | Clear `lease_token` and set `lease_until = 0`. Keep spent `attempts`. Preserve settled ready/failed states. Change queued/running to failed with `error_code = 'restored_interrupted'` and `finished_at = NULL`; do not restart inference automatically. |
| `asset_processing_outputs` | Include every immutable output, including text, suggestions JSON, original object/checksum, processor/extractor/model, error and timestamp. | No rewrite or regeneration. Validate foreign keys and owned asset/object/checksum correspondence. |
| `asset_processing_heads` | Include the selected current-output pointer. A failed later attempt need not have displaced it. | Preserve exactly; do not infer a head from the maximum attempt generation. |
| `asset_suggestion_decisions` | Include every accepted/dismissed field/value decision and its owner, output ID and creation time. | Preserve exactly. Never clear dismissals or replay acceptance as a mutation against asset metadata. Accepted metadata is already in `assets`. |
| `asset_processing_admissions` | Include quota receipts and spent attempt counts, including receipts for deleted originals. | Preserve identity, owner, `created_at` and `attempts`; clear `lease_token`, set `lease_until = 0`. Do not extend usage windows or refund recent admissions. |
| `asset_drain_state` | Omit scheduler cursors and leases. | Empty on the fresh installation. |
| `asset_vector_pending` | Omit external-index deliveries, acknowledgements, leases and retry cursors only when restoring to a fresh index/deployment identity. | Empty; explicitly rebuild from retained current outputs. Its old deletion targets are not a reason to attach the old index. Reusing that index would require a separate tombstone reconciliation and is not a supported recovery path. |

The authoritative insertion order after `assets`/`objects` is attempts, outputs,
heads, decisions; admissions are independent and must not acquire a cascading FK.
Restore authoritative data only into new unpublished resources as the backup
workflow requires; source credentials and live leases are never replayed.
Old provider work must remain bound to the old
installation, not be allowed to publish into the recovered D1.

`scripts/recovery.mjs` registers the five authoritative tables in `TABLES` and
the two operational tables in `OMITTED`. `restoredRow()` applies the lease and
interrupted-state transformations above. Ownership, original identity and
remaining receipt/attempt consistency are validated before projection rebuild;
inconsistent history fails recovery rather than being dropped. The manifest's
explicit table policy and exact migration hashes remain part of verification.
`test/backup.test.mjs` includes both owners, historical/current outputs, accepted
and dismissed decisions, interrupted attempts and a deleted-original usage
receipt in the scratch and real Wrangler fresh-install drills. It compares
authoritative rows under these transformations, original checksums and isolated
lexical extracted retrieval. The extended drills must pass at the release head;
their source is not evidence that they have run.

`recoverySql()` must reindex after restoring outputs/heads; it should recover
lexical derived-text search without making provider calls. `VALISE_RERANK=off`
or lexical mode alone is not an inference pause: minute maintenance will drain
configured vector resources. Keep `VALISE_VECTOR_NAMESPACE` empty and do not
attach the old index while checking recovery. After lexical/tenant/original
checks, an operator explicitly enqueues current outputs, provisions/selects the
fresh index and base identity, and enables bounded embedding delivery. Keep public search
lexical until a bounded visibility/ranking check passes. Acknowledgements do not
establish visibility, and an empty index must not be described as rebuilt.

## Provider-free recovery enqueue

Keep the recovery config in `off`/lexical mode with an empty
`VALISE_VECTOR_NAMESPACE` and no Vectorize binding, then run against the new
restored resources, using the same exact-release snapshot and checkout:

```sh
node scripts/backup.mjs enqueue-assets /secure/valise-backups/snapshot-… \
  --config wrangler.recovery.jsonc --remote --fresh my-recovered-valise \
  --namespace recovered-assets-unique-base
```

For the local drill substitute `--local`. The command checks source-resource
exclusion, explicit Worker confirmation, paused vector settings, a different
base identity and exact checkout/target migrations. It refuses hybrid or any
attached index. It never provisions, queries or mutates an external index.

The command bundles the actual `backfillAssetVectors()` from
`app/search/asset-vectors.ts`, reads at most 50 current owned outputs per page
through Wrangler D1 and writes the same `assetVectorStatements()` as normal
publication. Each output names a ready, unexpired, unarchived asset and matching
owned original checksum. Historical/superseded outputs remain in recovery but
are not queued. It computes fresh stamps and fills `asset_vector_pending`;
repeating it is idempotent. Partial enqueue failures may be rerun from the start.
No original, extracted text, suggestion, decision or attempt record is rewritten.
There is no R2 extraction, `toMarkdown`, metadata generation, embedding or ANN
call in enqueue. Its report says `delivered: false, visibilityVerified: false`.

Through a reviewed recovery config change and Workers Builds, explicitly attach
a **fresh** 1024-dimensional cosine index with its `docKey` string metadata index
and AI binding, set the same new base identity, and retain `VALISE_RERANK=off`.
Normal minute maintenance then embeds the retained extracted chunks through the
existing four-chunk tenant-fair ledger. This is paid embedding, not re-extraction
or metadata inference. The fresh index/base is shared with memory delivery;
enabling those bindings also enables the existing memory maintenance budget of
20 attempts per minute. This command does not replace memory backfill.
Old processing attempts remain failed/settled, and old
acknowledgements are never restored. Only after bounded fresh ANN/current-head,
tenant isolation and public hybrid/reranker checks may another reviewed change
select hybrid. Enqueue completion or zero pending cannot authorize that step.

The real Wrangler drill invokes this exact command implementation against its
fresh local destination and repeats it, asserts two owner-specific current-output
jobs with no acknowledgements, and rechecks all five authoritative tables plus
original bytes. Runtime tests additionally assert that paused delivery stays
lexical with no inference/query calls. These are executable acceptance checks;
provider visibility and ranking still require separate bounded live proof.

The version-1 per-user portable library export currently covers originals and
accepted metadata, not the processing history or dismissal decisions. It must
not be advertised as full decision/history recovery. Installation recovery and
any richer portable export need the explicit policies above.

Migration 0039 remains unpublished. Its snapshot/journal predecessor must be
regenerated/reconciled against migrations 0037 and 0038 at the assigned test turn;
neither preceding schema nor released migration history is rewritten here.

## Bounded live acceptance probe

`scripts/asset-processing-probe.mjs` uploads five generated, non-private originals
through the real console: PDF, EPUB, PPTX, XLSX and PNG. It asserts automatic
extraction without clicking Process, exact retrieval, unchanged original hashes,
unchanged generated tags and an explicitly accepted real title suggestion.
EPUB/PPTX exercise local parsing; PDF/XLSX/image conversion and metadata use
Workers AI. The browser fixture tests separately control delayed completion and
stale fields without pretending their synthetic metadata is provider evidence.

Run only against loopback with an isolated `VALISE_STATE`, an index named
`valise-rollout-eval-*` and a base identity named `rollout-eval-*`. Create the
disposable 1024-dimensional cosine index and its string `docKey` metadata index
before insertion. Vite's existing `vectorEvalConfig` keeps D1/R2 local and binds
only AI and that disposable index remotely. A private `.wrangler/.dev.vars`
beside the generated configuration may supply the existing Jev credential;
never copy it into the report or source. Select `VALISE_RERANK=hybrid` and
`VALISE_ASSET_REQUIRE_HYBRID=1` when proving public Jev retrieval.

The probe admits five files once, drains at most four four-chunk batches, then
observes ANN at most 24 times at ten-second intervals. It records empty queries
and elapsed visibility separately from mutation acknowledgement and finally
checks all five paraphrases. Failed provider delivery stops the run. There is
no automatic paid re-extraction loop. Each run can use three conversion calls,
five metadata calls, at most sixteen delivery attempts and 29 direct semantic
queries, plus the public search calls. These are call budgets, not measured
provider billing. Tool-choice eval spending is recorded separately by OpenRouter.

```sh
VALISE_DEV_ORIGIN=http://localhost:4214 \
VALISE_VECTOR_EVAL_INDEX=valise-rollout-eval-asset1024 \
VALISE_VECTOR_EVAL_NAMESPACE=rollout-eval-asset1024 \
VALISE_ASSET_PROBE_OUTPUT=/private/path/asset-proof.json \
VALISE_ASSET_REQUIRE_HYBRID=1 node scripts/asset-processing-probe.mjs
```

The report always survives a failure. `complete` without `publicHybridRequired`
establishes only the direct ANN/checksum/extraction smoke, not public hybrid or
Jev acceptance. Remove only the named disposable index after recording results;
retain failed reports and the isolated local store for diagnosis.

## Bookmark summaries and backfill

`maintainSourceEnrichment()` runs each minute beside file processing. It
takes the two newest sources still owed an attempt, fetches a page only for a
source with no captured article (robots.txt first, paywalls kept out), asks
glm-5.3-flash for a summary and key concepts from a 32 KiB prefix, splits the
article into passages and publishes all of it in one batch with a
`source_enrichments` row. That row records tokens and cost at list price
($0.15 and $0.50 per million input and output tokens) and is the ledger
the per-owner budget reads: `VALISE_SOURCE_DAILY_USD`, default $0.25 a
rolling day, `0` to stop. A tick admits a source only when 5319
micro-dollars of budget remain, the 32 KiB prefix at one token per byte.
Measured on 11 public pages: about $0.0012 a page, 2 to 16 seconds a call
(`evals/summary-model/README.md`). The backfill is resumable by construction: the
table says what is done, failures wait a day and stop after three, and a
lease in `asset_drain_state` (`source-enrichment-v1`) keeps ticks from
overlapping. The Library shows the spend, the budget and what is waiting.
`POST /__dev/source-enrichment` runs one tick on loopback.

## Bookmark passage vectors

`maintainSourceVectors()` runs each minute beside the file drain and embeds
bookmark passages from `source_vector_pending` into `s:<tenant namespace>`:
four a minute in fair tenant turns, the same rules as file passages. It also
enqueues two current enrichments a minute that have no ledger rows, which is
how bookmarks enriched before migration 0054 fill. Its lease is the
`s:<VALISE_VECTOR_NAMESPACE>` row of `asset_drain_state`. Each tick logs
`source_vector_drain`. `POST /__dev/source-vectors` runs one tick on loopback
and `GET /__dev/source-vector-candidates?q=…&user=…` shows what hybrid search
would hydrate. Progress in production:

```sql
SELECT COUNT(*) AS passages, SUM(mutation_id IS NOT NULL) AS delivered,
       SUM(error_code IS NOT NULL) AS failing
  FROM source_vector_pending;
```

