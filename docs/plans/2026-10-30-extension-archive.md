# Chrome extension: console look, saved state, styled archive

To-do `todo:tdo_0a1e741f-cc80-41f1-8321-dfe7ce0e14d4`. Owner decision of
2026-10-30: the archive is a Library folder (HTML, one stylesheet, images,
fonts) rendered by a sandboxed archive viewer. Tool descriptions change
without an eval rerun; the owner waived it for this alpha feature.

## Design decisions

- The archive is one folder. The HTML is uploaded first and is the folder's
  representative (its singleton folder id is its asset id). Every resource is
  uploaded with `folder` naming the HTML asset, so it joins that folder. The
  source links only the HTML asset, as today.
- Resources are referenced by folder-relative file names: `page.css`,
  `img-001.png`, `font-001.woff2`. Names are unique within the folder by
  construction and match `^[a-z0-9][a-z0-9.-]{0,99}$`.
- The viewer serves folder members under one capability path, so relative
  URLs resolve to siblings without cookies:
  `/archives/<folder id>/<expires>/<signature>/<file name>`. The console
  route `/library/archive/<asset id>` checks the session and ownership, then
  303s to that path for the HTML asset's own file name.
- The popup asks Valise whether the page is saved through `save_source` with
  `check: true`. Same scope (`sources:write`), no write. A `sources:write`
  holder can already learn this by saving a bookmark at the URL (PR #246), so
  the check discloses nothing new. The extension's grant stays three scopes.

## Contract between server and extension

### `upload_asset` gains `folder`

`folder: "asset:ast_<uuid>"`, optional. The new file joins the folder that
asset is in. Refused before any row is written when the asset is not the
caller's, not ready, or its folder already holds 100 files. Response gains
`folder: "asset:ast_<uuid>"` (the folder id, as an asset ref of the folder's
id) whenever the file joined one.

### `save_source` gains `check`

`check: true` with `url` (required in this mode) and nothing else needed.
Writes nothing. Returns structured content:

```json
{ "saved": [ { "id": "source:src_…", "kind": "bookmark", "title": "…",
  "revision": 2, "updated_at": 1793366241, "archive_asset_id": "asset:ast_…" | null } ] }
```

Unarchived sources whose URL equals `url` exactly (after the same
normalization `save_source` applies), newest `updated_at` first, at most 10.
`archive_asset_id` is the newest available `text/html` asset linked to the
source's head revision. References (highlights) are included; the popup
filters by kind.

### Archive viewer

`GET /archives/<folder id>/<expires>/<signature>/<name>`:

- Signature: HMAC with `TOKEN_PEPPER` over `asset-archive:<folder id>:<expires>`,
  base64url, compared in constant time. TTL one hour. Expired, malformed or
  future-beyond-TTL: 403.
- The member is the ready, unexpired asset in that folder whose `file_name`
  equals `<name>`; the owner is the folder's user. Missing: 404.
- Served only for these types; anything else 404:
  `text/html`, `text/css`, `image/png|jpeg|gif|webp|avif|svg+xml|x-icon`,
  `font/woff2|woff|ttf|otf`.
- Headers on every response: `Content-Type` with `; charset=utf-8` for html
  and css, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cache-Control: private, no-store`, `Cross-Origin-Resource-Policy: same-origin`,
  and `Content-Security-Policy: sandbox; default-src 'none'; img-src <prefix> data:; style-src <prefix> 'unsafe-inline'; font-src <prefix> data:; base-uri 'none'; form-action 'none'`
  where `<prefix>` is `<origin>/archives/<folder id>/<expires>/<signature>/`.
  Fonts also get `Access-Control-Allow-Origin: *`, because the sandboxed
  document has an opaque origin and font loads are CORS requests.
- `GET /library/archive/<asset id>` (console session): 404 unless the asset
  is the user's, ready, unexpired and `text/html`; otherwise 303 to the
  capability URL for its folder and file name.
- The reader (`/library/read/<source id>`) and the Library document pane link
  "Open archived page" to `/library/archive/<asset id>`.

### Capture representation `inert-dom-v4`

`inert-dom-v3` plus:

- `class` and `id` survive on allowed elements; `style` survives with every
  `url()` rewritten as below; `width` and `height` survive on `img`.
- `img` keeps `src` set to its stored file name (from `currentSrc`), or loses
  `src` when the image could not be stored. `srcset` and `sizes` never survive.
- Head gets `<link rel="stylesheet" href="page.css">` when a stylesheet was kept.
- The in-document CSP becomes
  `default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; base-uri 'none'; form-action 'none'`.
- `page.css` is every readable stylesheet in document order (`<style>` and
  `<link rel=stylesheet>`, `@import` flattened, `media` wrapped in `@media`,
  disabled sheets skipped). A cross-origin sheet whose rules cannot be read is
  fetched with `mode: "cors", credentials: "omit"`; if that fails it is skipped.
  Every `url()` is resolved against its sheet's URL, fetched, stored as a
  resource and rewritten to its file name; an unstorable one becomes `url("")`.
  `data:` URLs under 64 KiB stay inline; larger ones are dropped.
- Resource fetches: same-origin with `credentials: "same-origin"`, cross-origin
  with `mode: "cors", credentials: "omit"`. Keep only the types the viewer
  serves. At most 98 resources and 40 MiB in total, 25 MiB each; beyond that
  a resource is skipped. Bytes cross back to the popup as base64.

`capturePage` becomes async and returns
`{ title, url, html, capturedAt, resources: [{ name, contentType, base64 }], skipped }`.

## Popup

Width 30rem. Follows `prefers-color-scheme` by toggling `.dark` on `<html>`
from a classic script, as the console's theme script does without a cookie.
From top to bottom:

1. The page: title and host.
2. Saved state, from the check: "Saved <date>" linking to the source in
   Library (P13), plus "Open archived page" when it has one; or "Not saved".
   The check failing shows nothing rather than a wrong state.
3. The article when one was found: byline facts and a three-line excerpt.
   No explanatory notes. Without one, one short line: "No article on this page".
4. Tags.
5. Primary "Archive full page" (article text included when found);
   ghost "Save article only" when an article was found. The archive checkbox
   and its stored preference go. When the page is already saved the primary
   reads "Archive again".
6. The selection block only when text is selected: the quote and
   "Save highlight".
7. Status line, then Open Library and Settings.
