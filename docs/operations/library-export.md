# Library export and import

A library export is a directory that restores every asset and source on its
own: the original files and a manifest with their stable ids, metadata,
source revisions, links and provenance. ADR-0015.

```sh
export VALISE_LIBRARY_TOKEN=vls_…   # Connections → New bearer token
node scripts/library.mjs export https://app.valise.run ./library-2026-10-21
node scripts/library.mjs import http://localhost:5173 ./library-2026-10-21
```

Export needs a token with `assets:read` and `sources:read`. Import needs
`assets:write`, `assets:read` and `sources:write`. The token's user owns
everything imported; nothing in the export can name another user.

## Layout

```
manifest.json
files/<asset id>/<file name>
```

One export byte-directory per asset, so two files with one name never collide.
These paths are not the Library's logical folders; the manifest carries those
relationships. The script
checks each file's SHA-256 against the manifest on export, and the server
checks it again on import.

## manifest.json

| Field | Meaning |
|---|---|
| `format`, `version` | `"valise-library"`, `1`. |
| `exported_at` | Unix seconds. |
| `assets[]` | Every ready, unexpired asset, archived ones included. |
| `sources[]` | Every source, archived ones included, with all revisions. |

Each asset: `id` (`asset:ast_…`), `title`, `description`, `file_name`,
`content_type`, `size`, `sha256`, `project`, `tags`, `expires_at`,
`archived_at`, `created_at`, `updated_at`, `finalized_at`, `provenance`
(`agent`, `client`, `session`) and `file`, the path of its bytes inside the
export.

Since 2026-10-29, an asset also carries `folder: { id, title, created_at }`.
Files in one logical folder share that descriptor; a singleton has it too.
`title: null` uses its representative file's title, preferring the original
naming file while it is still present. Folder ids use
the naming asset's stable id, without the `asset:` prefix, but remain valid
after that file is moved or deleted. Import accepts members in any order,
preserves ownership and membership, and refuses a folder owned by another
user or a 101st member. Older v1 entries without `folder` import as singletons.
An id already present remains skipped, including its later folder moves.
If a deleted legacy asset's id still names a folder containing other files,
an entry without `folder` is refused rather than implicitly joining that
container. Export current folder metadata before retrying that import.

Each source: `id` (`source:src_…`), `revision` (the head), `archived_at`,
`created_at`, `updated_at`, `provenance` of its creation, and `revisions[]`,
oldest first, each with `revision`, `kind`, `title`, `url`, `notes` (whole,
never truncated), `project`, `tags`, `assets` (asset ids, in order),
`provenance` and `created_at`. The head's fields are its last revision's.

R2 keys and bucket names never appear. Object ids are internal and are
reassigned on import; asset and source ids are kept.

## Import

`PUT /library/import/assets/{asset id}` takes the file as its body and the
manifest entry, base64url JSON, in `x-valise-asset`. `POST
/library/import/sources` takes `{ "sources": [...] }`. Assets go first, since
a revision that links an asset the library does not hold is refused. An id
the library already holds is skipped, so a rerun after a partial failure is
safe. Imports write the search projection in the same batch as the rows, so
no reindex is needed; `node scripts/reindex.mjs --all` still rebuilds it.
The CLI sends sources in batches of ten to bound each Worker's D1 work. A
retry skips ids that a previous partial request already committed.

## Raindrop.io

```sh
# .env: RAINDROP_TEST_TOKEN and VALISE_LIBRARY_TOKEN. Never commit either.
node --env-file=.env scripts/raindrop.mjs export /private/path/raindrop-library
node --env-file=.env scripts/library.mjs import https://app.valise.run /private/path/raindrop-library
```

Create the Valise token in the destination account's Connections page with
`assets:write`, `assets:read`, `sources:write`, and `sources:read` for a
post-import export/count check. A browser signed into a different account is
not an import destination. The Raindrop token is read only by the local CLI;
it is not sent to Valise, uploaded-file hosts, or redirected downloads.

`raindrop.mjs export` reads the documented Raindrop API: the account id,
root/nested collections and every page of `/raindrops/0` (all except Trash).
It refuses inconsistent counts or duplicate ids rather than claiming a
partial snapshot is complete. Reads retry HTTP 429/5xx with bounded backoff.
API pagination is not transactional: avoid editing the collection during
export; equal-count concurrent edits cannot be fully detected.

Each bookmark becomes a source in project `raindrop`. Original tags remain;
`raindrop` and a `collection:<parent / child>` tag identify the import and
hierarchy. Notes preserve the supplied description, Markdown note, highlight
quotes and annotations, collection, original id/type and timestamps. Source
creation/update dates retain Raindrop's dates. Titles and URLs are not used
to merge distinct bookmarks. Non-web URLs and notes exceeding 64 KiB stop
preparation for explicit review rather than being silently dropped.

Every source links a durable JSON snapshot asset retaining all returned
bookmark and collection fields. Raindrop-uploaded originals up to 25 MiB
become additional immutable, checksummed assets. Legacy file links resolve
through the documented `/raindrop/{id}/cache` API; only the resulting
Raindrop upload-host download is followed, without the API token. A failed
original download stops preparation but leaves `snapshot.json` for retry:

```sh
node --env-file=.env scripts/raindrop.mjs prepare /private/path/raindrop-library/snapshot.json /private/path/raindrop-library
```

An export directory is private data: it is created with mode 0700, its files
with 0600, and it belongs outside the repository. The CLI emits counts, not
tokens or provider error bodies. Never point it at an existing public/shared
directory; creation modes do not tighten pre-existing directory permissions.

Source ids derive from the Raindrop account and bookmark ids. Asset ids are
content-addressed within that account. The existing library import skips
already-present ids, so retries cannot duplicate a bookmark or overwrite a
source edited in Valise. This is a one-time import, not synchronization:
re-exporting changed bookmarks does not update existing Valise sources.

Search with `type: "source", project: "raindrop"`, or use
`include_library: true` for discovery alongside memories and skills. Search
covers supplied titles, URLs, tags, notes and highlights only; the projection
retains at most 16 KiB of notes, while authoritative fetch retains the whole
source. The CLI never crawls bookmark pages or downloads cached web pages.
Remote PDF links remain bookmarks unless the file was uploaded to Raindrop.
Topic synthesis must cite the imported sources and distinguish quotes,
descriptions and hypotheses from claims about an unread page or PDF.

API references: [pagination](https://developer.raindrop.io/v1/raindrops/multiple),
[fields](https://developer.raindrop.io/v1/raindrops),
[permanent-copy lookup](https://developer.raindrop.io/v1/raindrops/single).

## What this is not

This is a per-user portable library, not deployment disaster recovery. It does
not export skills/bundles, memories, to-dos, user/configuration records or
attachments that were never registered as assets. Import assigns ownership to
the importing token's user; it does not preserve a multi-tenant installation.

The [operator backup/recovery workflow](backup-recovery.md) captures D1 content
and all referenced R2 originals, including historical skill bundles and legacy
attachments, to an independent host. It restores owner identities into fresh
resources without replaying sessions, grants or live coordinator leases.
