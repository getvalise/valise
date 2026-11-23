# 0011. Per-user object storage on R2, linked from each concept

Date: 2026-10-18
Status: accepted

Amended: 2026-10-20 by ADR-0015, accepting the next storage extension: standalone searchable assets, revisioned knowledge sources, HTTP uploads, short-lived downloads, and explicit retention. Implemented 2026-10-21; `/files/{objectId}` and attachment resources now refuse an object whose asset has expired. Existing object IDs, attachment links, and MCP resource reads remain supported.

## Context

A to-do needs a screenshot, a memory a diagram, and the next concept will want
files too. Before this, the only bytes in R2 were skill bundles, written by
`app/r2/bundles.ts` under `u/{userId}/skills/{skillId}/{version}/{path}` and
named by a skill version's `files_json`. There was no way to store a file that
belongs to anything else, and nothing in D1 that said who owns an object. The
to-do asked for one utility that every concept can use and that keeps working
once there is more than one user.

ADR-0001 constrains the shape: concepts never reference each other, and a
migration never crosses a concept boundary. ADR-0008 constrains the rollout: a
merge carries its schema, so the change has to be additive and must not need a
step a person runs by hand.

## Decision

`app/r2/objects.ts` owns every stored file. A concept links to it and never
writes the storage row itself.

- Files share the `BUNDLES` binding (`valise-bundles`). A second bucket is a `wrangler r2 bucket create` that no merge can carry, and the key
  prefix already separates users. The binding's name is now narrower than its
  contents; renaming it is a one-line wrangler change when it matters.
- The key is `u/{userId}/objects/{objectId}`, beside
  `u/{userId}/skills/`. Everything one user stored is one prefix, so a
  per-user export, quota count, or account deletion is one `list` over it. The
  object id is `obj_` plus a random UUID. The file name is never part of the
  key, so no upload can choose where it lands.
- Each file has one `objects` row: `object_id`, `user_id`, `r2_key`,
  `name`, `content_type`, `size`, `sha256`, `created_at`. The row is the
  authority on ownership; a request never supplies an R2 key. Objects are
  immutable: a changed file is a new object.
- Each concept owns a link table on its own
  side: `todo_attachments(todo_id, object_id, created_at)` now, and a
  `memory_attachments` of the same shape when memories take files. `objects`
  is storage, not a concept, so it never learns which concepts point at it and
  stays out of the search projection.
- The bytes go to R2 first, then the `objects` row and the
  link row in one `db.batch`. A failed batch leaves an R2 object no row names.
  That costs storage, never correctness, and a sweep can find such objects by
  diffing a user's prefix against `objects`.
- Files are served only by `/files/{objectId}`, behind the console
  session, with `WHERE object_id = ? AND user_id = ?`. Another user's id
  answers 404, the same as a missing one. There is no public bucket and no
  presigned URL.
- PNG, JPEG, GIF, WebP and AVIF are served inline under their
  own type. Everything else, SVG included because it can carry script, is
  `application/octet-stream` with `Content-Disposition: attachment`. Every
  response sets `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: default-src 'none'; sandbox`, so an uploaded page
  cannot run on the console's origin. `Cache-Control` is
  `private, max-age=31536000, immutable`, because an object never changes.
- A file is at most 10 MiB, `MAX_OBJECT_BYTES`. The console action buffers
  the whole file in a 128 MB isolate, and screenshots and PDFs fit well under
  it. A request whose `Content-Length` is over the limit is refused before the
  body is read. An empty file is refused too. There is no per-user quota yet.

## Consequences

A new concept gets files with one link table and two calls, `putObject` and
`insertObject`, with no change to storage. The R2 layout is ready for a second
user, because ownership is a row and a prefix rather than a convention in the
caller.

Given up: an unreferenced object can exist after a failed batch, and nothing
deletes objects yet. Detaching a file and deleting its bytes are separate
decisions, and neither is in this slice.

Two questions stay open in `docs/adr/README.md`: whether and how MCP clients
upload files, and how a file is removed and its bytes deleted, which brings a
per-user quota with it.

## Amendment, 2026-10-19: memory links

`memory_attachments(memory_id, object_id, created_at)` is the memory-owned
link table. The memory modal uses the same owner storage, multipart picker,
preview and `/files/{objectId}` path as a to-do. Missing or archived memories
refuse uploads before R2 is written. Identical uploads remain distinct objects;
the SHA-256 is an integrity field, not a deduplication key.

## Amendment, 2026-10-19: reversible detachment

Remove deletes only the concept's link row, guarded by the object's owner.
Restore inserts that link only for an existing target and an owned object;
archived memories refuse restoration. Both operations are idempotent and leave
every other link alone. The file's row stays in the open dialog with Restore
until the dialog closes or the page reloads (P12). A document form post returns
the removed row for the same reversal without scripting.

`objects` and R2 bytes are retained, including when no links remain. Existing
owner-only `/files/{objectId}` links, including Markdown links, still work.
Detachment is not revocation or erasure. A retention lifetime, quota and orphan
sweep stay open; this amendment selects no byte-deletion policy.

## Amendment, 2026-10-19: read-only files over MCP

`fetch` adds `metadata.files` for to-dos and memories: each file has `id`,
`name`, `type`, `size` and `uri`. Only the principal's owned files are listed.
The URI is `valise://todo/{todoId}/files/{objectId}` or its `memory` equivalent.
`resources/read` requires `todos:read` or `memories:read`, respectively, not
`skills:read` or `search:read`. The URI is canonicalized by the same parser at
scope preflight and resource dispatch. Reading also requires the concept link
and the object-owner row; archived memories and detached links answer missing.
A missing object and another user's object return the same resource error.

UTF-8 text types return text; binary files and invalid UTF-8 return base64 blobs
through the standard MCP resource representation. Reads retain the 10 MiB
object cap. They pass through the existing MCP observation wrapper, including
scope failures, so no second auth or logging path is opened. Browser-only
URLs were rejected as the sole agent read path because MCP credentials do not
grant a console session. `/files/{objectId}` keeps its console behavior.

There is no upload tool, upload URL, new scope, or tool-description change.
Clients without resource reads can list the files but cannot read their bytes.
Upload transport stays open until a concrete agent attachment need forces it;
base64 arguments and short-lived upload URLs retain the trade-off recorded in
the index. No irreversible byte-lifetime policy is implied by a resource read.
