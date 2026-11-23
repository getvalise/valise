# Chrome HTML capture

`clients/chrome-extension` is an unpacked Manifest V3 extension. When the popup
opens it finds the article on the active tab, tints it on the page, and asks
Valise whether the page is already saved. Save article, or Save bookmark on a
page with no article, keeps the page on a `bookmark` source with the article
and no archive. Archive full page keeps the page as a Library folder: an inert
HTML file, the stylesheet it used, and its images and fonts, linked to a
`document` source that also carries the article. Save highlight keeps
selected text as a `reference` source. Captures receive the chosen tags and,
optionally, one project, and a page save's tags and project stay editable in
the popup after it. Library reads a saved article at `/library/read/<source id>` and
opens an archive at `/library/archive/<asset id>`. The default endpoint is
`https://app.valise.run/mcp`.

## Install

From the repository root:

```sh
npm ci
npm run css:build
npm run build --prefix clients/chrome-extension
```

Open `chrome://extensions`, enable Developer mode, choose Load unpacked, and
select `clients/chrome-extension/dist`. Pin Valise capture if desired. The
extension has no package manifest of its own. Its build bundles `extract.mjs`
with the root's `esbuild`, `defuddle` and `@mozilla/readability` into
`dist/extract.js`, and copies the console's generated stylesheet; it neither
fetches code or styles from a server nor defines another theme. After a code change, rebuild and click Reload on the
extension's card. Rebuilding does not reset connection settings.

## Connect and revoke

1. Open the extension. Until it is connected, the popup shows only a sign-in
   prompt and its Connect to Valise button; there are no capture controls.
   Choose Connect to Valise. The extension holds site access to
   `app.valise.run` from install, so Chrome asks nothing for it.
2. The popup opens Settings in a tab, and a Chrome sign-in window opens on the
   Valise consent page. Sign in if asked. The page names the extension id and
   exactly four scopes: `todos:write`, `assets:read`, `assets:write` and
   `sources:write`.
   Check the id against `chrome://extensions`, then choose Allow. The window
   and the Settings tab close, and Chrome returns to the page you were on.
   Open the extension again; the popup is ready to save. Connect to Valise in
   Settings does the same without the popup and stays on Settings, showing
   "Connected to <host>" with the endpoint URL.
3. Open an HTTP(S) page and select text if you want a highlight. Open the
   extension. It shows the article it found and tints it on the page, and
   says "Saved <date>" or "Not saved". Pick or type a project if you want
   one. Add individual tags with Add tag or Enter, or pick one of your own
   from the tag field's list, then choose Save article (Save bookmark on a
   page with no article), Archive full page, or Save highlight. Keep the
   popup open until it confirms the save. Tags and the project can still be
   changed after a page save; each change is saved to that source. Open Library
   and the saved-state links use your normal console session; they never
   carry a token.
4. To disconnect, choose Disconnect. It revokes the grant in Valise, then
   forgets the tokens and the endpoint's site access. The connection also
   appears in Valise → Connections as `Valise capture`, with its four scopes
   and its `chromiumapp.org` callback, and Revoke OAuth connection there ends
   it too. Uninstalling removes only the local copy; revoke the connection in
   Connections as well. Captured files stay in Library either way.

The popup hands the sign-in to a Settings tab because the sign-in window
takes focus, and Chrome closes a popup that loses focus, ending its script
before the token arrives. Chrome's site-access prompt takes focus the same
way, so the popup never asks for site access. In 0.5.0 it did: the first
Connect closed the popup at the prompt, nothing after the request ran, and
only a second click, with the grant already there, opened sign-in. The
default host is therefore a required `host_permissions` entry. For a
self-hosted endpoint whose grant is missing, the Settings tab the popup opens
says which host it needs and waits for Connect to Valise there; Chrome
accepts a permission request only during a user gesture, and a tab that loses
focus to the prompt keeps running. Opening, activating and closing tabs uses
`chrome.tabs` calls that need no `tabs` permission.

Connect registers the extension with `/register`, sends PKCE S256 and a random
`state` to `/authorize` through `chrome.identity.launchWebAuthFlow`, and
exchanges the code at `/token`. The callback is
`https://<extension-id>.chromiumapp.org/`; Chrome delivers it only to the
installed extension with that id. The server admits that callback only as a
client's sole redirect URI. It grants such a client the three capture scopes
whatever it asked for, plus `todos:write` only when it asked for that, and
nothing else. The extension asks for all four. It accepts a grant that holds
the three capture scopes and nothing outside the four, keeps the granted list
with its tokens, and refuses and revokes any other grant. A grant without
`todos:write`, from a Valise older than this or kept from extension 0.7.0,
still saves bookmarks, archives and highlights; only adding a to-do asks for a
reconnect. Each Connect registers a new
client and revokes the previous grant, so a stored client id never outlives
the server's 90-day registration TTL. ADR-0004 records the decision.

The access token lasts an hour and the refresh token 30 days. A 401 makes the
extension exchange the refresh token once, keep the rotated pair and retry the
call; a 401 means the call never ran, so the retry cannot duplicate a save. If
Valise refuses the refresh with 400 or 401, because the grant was revoked or
expired, the extension drops the tokens and keeps only the endpoint. The popup
then shows the same sign-in prompt as a fresh install, and Connect to Valise
signs in to that endpoint again. A refresh that cannot reach Valise keeps the
tokens and reports the failure.

Tokens live only in `chrome.storage.local`, restricted to trusted extension
contexts with `setAccessLevel`. They are never put in Chrome sync, the captured
page, logs, file metadata, URLs, or source notes, and Settings never hydrates
one into the DOM. This is profile-local storage, not an encrypted vault: anyone
who can read the profile can recover them. Lock the workstation, and disconnect
or revoke the connection if the profile or extension is compromised. An
insufficient-scope 403 means the grant or token lacks one of the four scopes;
for `todos:write` the popup offers Reconnect to Valise. Other 403 responses
require checking the endpoint and Origin policy.
`search:read` and `sources:read` are not needed for capture. Binary access is
needed because `save_source` checks `assets:read` when linking an asset.

### Settings

Settings is a tab, 36rem wide, with body text at the console's size. It leads
with the connection, read from `chrome.storage.local`. Connected: a check in
`--ok`, "Connected to <host>", the full endpoint URL in mono below it, and how,
"Signed in through Valise" for an OAuth connection or "Pasted token", then
Disconnect. Not connected: a dashed circle and "Not connected", then Connect
to Valise. The status line under the button reports a sign-in in progress, a
saved token, and what Disconnect did. Advanced holds the endpoint, the pasted
token, and one paragraph of security facts: tokens stay in this profile's
local storage and are never synced, the connection's scopes, and revoking it
in Connections.

### Advanced: self-hosted endpoint and pasted console token

Settings → Advanced holds the endpoint field, which defaults to
`https://app.valise.run/mcp` and is used by both Connect to Valise and Save
token. Change it only for a Valise you host yourself; the popup's Connect
then signs in to the endpoint last used.

Settings keeps a pasted console bearer as a fallback, under Advanced, for a
Valise where the Chrome sign-in window cannot complete. Create a dedicated
token in Connections with `assets:write`, `assets:read` and `sources:write`,
plus `todos:write` to add to-dos, and paste it without a `Bearer ` prefix.
The extension cannot read a pasted token's scopes, so the to-do form is
always offered and a token without `todos:write` gets the server's refusal. A pasted token does
not refresh. Disconnect forgets it locally only; revoke it in Connections.
Saving one in place of an OAuth connection revokes that connection. The
fallback costs one form and the existing bearer code path, and it keeps the
Worker tests and headless setups that cannot open an auth window working.

Changing the endpoint requires Connect or a pasted token again, so tokens are
never silently forwarded to a newly configured host. The previous host grant
is removed after a successful change. HTTPS is required except for
`http://localhost:<port>/mcp` or `http://127.0.0.1:<port>/mcp` in local
development. The endpoint must end at `/mcp`, without credentials, query or
fragment. Local development connects to the local Worker's own consent page,
never production.

### Popup interaction contract

- User job: save the current page or a selection to Library, and get connected
  first when the extension is not.
- Default view when not connected: the sign-in prompt, naming the host Chrome
  will ask about, with Connect to Valise as its only primary action and
  Settings in the header as its only other control. Not connected means no
  stored credential: a fresh install, a Disconnect, or a grant Valise refused
  to refresh. Removed
  site access shows the same prompt with that reason.
- Default view when connected, top to bottom, 30rem wide, following the
  system light or dark setting:
  1. A header row with the Save as switch on the left and two icon-only
     controls on the right, Open Library (a link, lucide `library`) and
     Settings (a button, lucide `settings`), each named by `aria-label` and
     `title`. The switch, Bookmark | To-do, is a segmented pair of radio
     buttons, drawn as the console's Tabs list, with Bookmark chosen on
     every open. It stands where the eyebrow "Valise · Capture" stands on
     the sign-in prompt and on a page that cannot be saved. Items 2 to 10
     are the Bookmark side; the To-do side is under "To-do from the page".
  2. The page's title and host.
  3. The saved state, one of three. "Saved <date>" with a check, linking to
     the reader, plus Open archived page when the newest save has an
     archive; "Not saved" with a dashed circle; or "Could not check with
     <host> whether this page is saved" with `circle-alert` when the check
     failed, naming the endpoint's host.
  4. The article's byline facts and a three-line excerpt, or "No article on
     this page".
  5. Project, one optional field offering the owner's projects. A name not
     offered creates the project.
  6. Tags, as chips with a named remove, a Tag field offering the owner's tags
     not yet chosen, and Add tag. Picking an offered tag adds it as a chip
     and clears the field; Enter or Add tag adds typed text, creating the tag
     on a miss.
  7. Note, a labelled textarea for why the page was saved, one line tall
     and growing with its text to about five lines, then scrolling. It is
     closed until the Note button in the save row opens it and focuses it,
     and stays open until the popup closes. On a page whose newest saved
     item, the one "Saved <date>" links to, has a note, it starts open on
     that note; otherwise it opens empty, with the placeholder "Why you
     saved it".
  8. The selected text and Save highlight, only when text is selected.
  9. The save row. On its left, while Note is closed, the ghost Note
     (lucide `notebook-pen`, titled "Add a note"). Right-aligned, the
     primary is Save article (lucide
     `file-text`) when there is an article and Save bookmark (lucide
     `bookmark`) when there is none. Left of it, the ghost Archive full page
     (lucide `archive`), which reads Archive again when the saved item has
     an archive.
  10. The status line, empty unless a save, a label change or a note change
     is in progress, done or failed.
  Project and Tag are `combobox.mjs`, the APG editable combobox with list
  autocomplete: the input is `role="combobox"` with `aria-expanded`,
  `aria-controls` and `aria-activedescendant`, over a `ul role="listbox"`
  in the popup below the field, styled as the console's `.combobox-list`.
  Focus shows up to eight offered values; typing filters them by
  case-insensitive substring. Down and Up move, Enter picks the active
  option or adds the typed text, Escape closes the list or, when it is
  closed, clears the field, and a click picks an option. With nothing to
  offer, no list appears. A native `<datalist>` is not used: Chrome's
  dropdown for it is not part of the popup's DOM, so it can be neither
  styled nor tested there.
  Every button carries its lucide icon at 1rem before the label (V7). The
  project and tags go on all three saves and on the archive's HTML file, not
  on its stylesheet, images or fonts. The vocabulary comes with the saved
  state from `save_source` `check: true`, at most 50 projects and 50 tags,
  most used first (P9). ADR-0015 holds the full contract for this view, the
  reader and the archive viewer.
- Saves and labels: Save article sends the article on a `bookmark` source.
  Save bookmark sends title, URL, tags and project, plus the extractor's
  `detected: false` article row when it ran, so word counts are kept; when
  it did not run, no article. A save disables the save buttons while it
  runs. Once a page save has been tried, Save article or Save bookmark and
  Archive full page stay disabled, whether it succeeded or failed, because
  `save_source` is not idempotent and a lost response may have saved; Save
  highlight is unaffected. Tags and project stay editable: adding or removing a tag,
  or changing the project on blur or Enter, writes `save_source { id,
  expected_revision, tags, project }` to the saved source, one write at a
  time and in order, each with the revision the last returned. The status
  says "Tags saved." or "Project saved."; a refusal, such as a stale
  revision, shows the error and reverts the chip or field.
- Note: Save article, Save bookmark and Archive full page send the note as
  the source's `notes`. Save highlight does not; a highlight's notes are its
  quote and context. A save sends the note when the field holds one or the
  page's saved note was not empty, so a cleared note clears it and an empty
  field on an unannotated page sends nothing. Because a bookmark saved
  again at its URL is revised, not duplicated, the prefill is what keeps a
  second save from replacing a note the owner cannot see. After a page
  save, the note stays editable: on blur, or on Cmd+Enter or Ctrl+Enter,
  a changed note writes `save_source { id, expected_revision, notes, tags,
  project }` in the same queue as the labels, and the status says "Note
  saved.". A label write sends no `notes`, so it never rewrites the note.
  Closing the popup before the field loses focus drops an unwritten edit.
  Before a page save, as with labels, a note edit only changes what the
  save will carry.
- Why Note is behind a button: Chrome caps a popup at 600px, and the
  headless popup the specs open gets 498px. An always-open one-line Note
  added 75px and pushed Save article to 549px on the capture journey's
  article, failing its check that Save is in view without scrolling; with
  a selection it passed the 600px fold too. Behind the button the default
  view keeps its height: `npm run shots:extension`'s article measured
  526px closed and 601px with Note open, the status line included, on
  2026-11-16. Owner decision of 2026-11-16, over keeping the field always
  open and measuring against 600px.
- Failure states: a self-hosted endpoint without site access leaves Settings
  open, naming the host, until Connect there grants it; site access denied
  there is an error on Settings; a sign-in window closed or denied leaves
  Settings open with its error; a grant
  that ends during a save returns the popup to the sign-in prompt and says to
  check Library before retrying; a rejected pasted token stays an error on the
  capture view, because Advanced is where it is replaced.
- Loading: the popup reads local storage and the active tab before showing
  either view, so it never shows capture controls it would then withdraw.
  The save buttons, the Note button and Note stay disabled while the
  article is found and the saved state is checked; the two run at once.
  Note waits for the check because the check fills it. Enabled controls
  are the readiness signal (P13); the popup prints no "ready" text. For tests and scripts,
  `#capture` carries `aria-busy="true"` until both have finished, then
  `aria-busy="false"`. A check that fails says so rather than showing a
  wrong state, and offers no projects or tags.
- Evidence boundary: the loaded-extension Playwright spec covers Note
  closed on an unannotated page with its button on the save row's line,
  the button opening it focused, the note riding with Archive full page, a
  note edit after the save ("Note saved."), the next popup on that page
  starting open on the edited note, and the note on the page's source in
  Library but not on the highlight. It also covers the not-connected popup, the one-click Connect from the popup, the ended-grant
  return to sign-in and removed site access. Chrome's native site-access
  dialog is checked by hand. `npm run shots:extension`, against `npm run
  dev`, screenshots the popup not saved and saved in both themes and the
  archived page in the viewer; `docs/testing/2026-10-31-extension-popup.md`
  holds a run.

### To-do from the page

- User job: remember to do something on this page later, such as book an
  appointment, as a to-do that links back to it.
- Default view: the popup opens on Bookmark. Choosing To-do in the Save as
  switch hides the page header, its title, host and saved state, since the
  Title field carries the title and the to-do links the page, and replaces
  the article preview, the selection and the save row with, top to bottom:
  Title, a text field prefilled with the page's title and
  editable; Description, a textarea for what to do, with the placeholder
  "What to do, for example book an appointment"; the same Project and Tags
  controls as Bookmark; and the save row with one primary, Add to-do (lucide
  `list-todo`). Project is required, because `create_todo` requires it, and
  its label says so.
- Why a switch, and why in the header: screenshots on 2026-11-01 compared
  three layouts at the popup's real size
  (`docs/testing/2026-11-01-extension-todo.md`). A third button, Add to-do,
  in the save row wrapped the row and pushed Save article out of view. The
  switch under the page header added 48px and did the same. In the header
  row, in the eyebrow's place, the Bookmark side keeps its height and its
  primary in view.
- Primary action: Add to-do sends one `create_todo` with the title (the
  page's host when cleared), the project, the tags, the description as its
  body when there is one, and the page URL as a `url` ref. A URL longer than
  a ref holds, 500 characters, goes on the body's last line as `Page: <url>`
  instead. Add to-do with no project writes nothing: it says "Choose a
  project for the to-do." and focuses Project.
- After it: "To-do added" with a check, linking the to-do's title to it in
  the console (`/todos?open=<id>`), replaces the save row; the status says
  "Added the to-do."; Title, Description, Project, Tags and the switch are
  disabled. There is no label editing after the add, unlike a bookmark: a
  to-do's tags change through `edit_todo_tags`, which this grant does not
  hold.
- Disclosed details: none beyond the form. The to-do's state, lease and
  updates are the console's, behind the link.
- The switch locks once a page save or a to-do add has been tried, so the
  shared Project and Tags never revise one item while the screen shows the
  other. Reopen the popup to do the other. Save highlight does not lock it.
- Failure states: a connection without `todos:write`, an OAuth grant from
  0.7.0 or from a Valise that did not grant it, shows on the To-do side, in
  place of the form, "Adding to-dos needs one more permission. Reconnect to
  Valise to allow it." and Reconnect to Valise as the primary, which opens
  Settings and signs in again as Connect does; the new grant replaces the
  old one. The Bookmark side keeps working on the old grant. A pasted token
  is offered the form, since its scopes cannot be read; the server's
  insufficient-scope 403 for `todos:write` turns the To-do side into the
  same reconnect notice. A `create_todo` that fails or loses its response
  shows the error and keeps Add to-do disabled, because `create_todo` is not
  idempotent and a lost response may have created it; the status says to
  check To-dos.
- Loading: the To-do side needs only what the popup already loads, the
  vocabulary from `save_source` `check: true`. Add to-do stays disabled
  until that check has finished, like the save buttons. One `create_todo`
  per add, no other call.
- Evidence boundary: `test/mcp/oauth.worker.test.ts` shows an extension
  asking for the 0.7.0 scopes still gets exactly those three, and one asking
  for `todos:write` gets four and can `create_todo` from its Origin. The
  loaded-extension spec connects with four scopes, adds a to-do and finds it
  in the console with its `url` ref, and shows the reconnect notice for a
  stored connection without `todos:write`. Light and dark screenshots of the
  To-do side come from `npm run shots:extension`. A real 0.7.0 install
  upgraded in the owner's Chrome is a manual check.

## Permissions and transport

Required permissions are `activeTab`, `identity`, `scripting`, and `storage`,
and one host permission, `https://app.valise.run/*`, for the default endpoint.
`identity` is for `launchWebAuthFlow` only; the extension reads no Google
account or profile identity. There is no
`tabs`, `cookies`, `history`, background watcher, registered content script,
message listener reachable from web pages or other extensions, or grant for
any site you browse. The preview's port listener accepts only this
extension's own popup, which Chrome guarantees for `runtime.onConnect`. The Valise host
grant lets the extension's own pages call Valise; it injects nothing into
`app.valise.run`. Clicking the
action supplies active-tab access; Save injects only `capturePage` in the main
frame's isolated world. The function receives no token or endpoint.

`optional_host_permissions` declares HTTPS destinations plus HTTP loopback so
a user can configure their own Valise host. That declaration grants no access
by itself. Settings requests only `<configured-scheme>://<configured-host>/*`,
never the wildcard declaration or the captured site's host. Changing the
endpoint or disconnecting removes a self-hosted host's grant; it leaves
`app.valise.run`, because Chrome refuses to remove a required permission.
Chrome's own site-access control can still withhold it, and the popup then
shows the removed-access prompt. Chrome match
patterns cannot restrict a permission to a TCP port or an API path: the
runtime grant covers that host, while the client sends credentials only to
the exact configured `/mcp` URL. Removing site access returns the popup to
the sign-in prompt until Connect grants it again.

Chrome sends `Origin: chrome-extension://<id>` even after endpoint site access
is granted. The OAuth provider validates the supplied token before calling
the MCP handler; it does not authenticate browser cookies as MCP credentials.
After scope preflight, the handler permits an extension Origin for a
console-bearer principal with the exact raw pattern `chrome-extension://[a-p]{32}`,
and for an OAuth grant only when the Origin is exactly
`chrome-extension://<id>` for the extension id that grant was consented to.
Other OAuth grants and the loopback `x-valise-*` test transport do not receive
that exception. Credentials, ports, trailing slashes, paths, queries, fragments,
uppercase/invalid IDs and unrelated web Origins do not qualify.

The installed SDK checks Origin hostnames rather than exact origins. For an
already-validated extension request only, the handler skips that redundant
Origin-hostname comparison. Its Host/DNS-rebinding check still runs unchanged.
Other non-HTTP(S) schemes are rejected explicitly so an origin such as
`chrome-extension://localhost` cannot borrow the endpoint's allowed hostname.
There is no extension-hostname allowlist, global wildcard exception, additional
CORS grant or client-side Origin override. The Origin is not an authentication
credential: the scoped token remains required on every MCP call.

When the popup opens:

```text
extract.js, then valisePreviewArticle() → article text + page metadata + tint
insertCSS (the ::highlight colour), then tabs.connect → port held until the popup closes
```

When the popup opens it also asks Valise what is saved at the page's URL.
The check writes nothing and needs no scope beyond `sources:write`:

```text
save_source (check=true, url) → saved: [{ id, kind, updated_at, archive_asset_id }]
```

The popup ignores `reference` sources (highlights) and shows the newest of the
rest. If the extension's grant has ended, this first call finds it, and the
popup opens on the sign-in prompt.

Archive full page uploads the HTML first, then every resource into the HTML's
folder, then the source:

```text
capturePage → HTML + resources (page.css, img-NNN.*, font-NNN.*) as base64
upload_asset (file_name, text/html, size, SHA-256, title, tags, description)
HTTP PUT to returned same-origin /uploads/<asset-id>?token=… → ready asset, matching size + SHA-256
for each resource, four at a time:
  upload_asset (file_name, content_type, size, SHA-256, folder=asset:<html id>)
  HTTP PUT, verified the same way
save_source (kind=document, title, URL, tags, asset_ids=[asset:<html id>], authors, article)
```

The HTML is the folder's representative: its singleton folder id is its asset
id, and naming it as `folder` puts each resource in that folder. The source
links only the HTML. Resources carry no title, description or tags. A
resource whose upload is refused, interrupted or does not verify is counted
and the save goes on; the status line reports how many files the archive kept
and how many it could not, including those the capture skipped. A failure of
the HTML upload stops the save before any source is written.

Save article and Save bookmark are one call, with no capture and no upload:

```text
save_source (kind=bookmark, title, URL, tags, project, authors, article)
```

A tag or project change after a page save is one call on that source:

```text
save_source (id, expected_revision, tags, project) → { id, revision }
```

## Article extraction

Most of a saved page is navigation, forms and related links. The article is
usually a tenth of it. The popup therefore injects `extract.js` into the
page's isolated world when it opens and calls `valisePreviewArticle()`, so
the person sees what Save will keep before choosing it. It runs Defuddle 0.19 on a clone of the live DOM, with its
third-party fetches off, and falls back to Readability 0.6 when Defuddle
finds under 150 words. Both run on clones because both modify the document
they are given. Neither fetches anything. Extraction needs the live DOM:
author, published date, site name and lead image come from `<meta>` tags and
JSON-LD, which the snapshot strips.

An article is detected when its prose, the words outside links, comes to at
least 150 words and at least 10% of the page's words. Otherwise the source
gets an article row with `detected` false, its word counts and no text, and
the popup shows "No article on this page" and its primary is Save bookmark.
A detected article is sent as Markdown and plain text, cut at 200,000
characters each, with authors, published date, site name, canonical URL, lead
image, description, language and word counts. The popup confirms an archive
as, for example, "Saved article (418 words, by Mara Lindqvist and Tomas
Oyelaran) and archived the page with 12 files. 2 could not be kept.", a Save
article as "Saved article (418 words, by …).", and a Save bookmark as "Saved
the bookmark." If injection or extraction throws, the popup shows "No article
on this page" and the bookmark or the archive still saves.

The tint uses the CSS Custom Highlight API. `previewArticle` matches each
paragraph of the extracted text to a block on the live page by its first 60
letters and digits, so a footnote marker or a curly quote does not break the
match, and registers those ranges as the `valise-article` highlight. The
popup adds one `::highlight(valise-article)` rule with `insertCSS`. A
highlight paints ranges without adding a node: the page's DOM, and so the
snapshot taken from it, stay as they were. The injected script listens for
one port, `valise-preview`, from the popup; when the popup closes the port
disconnects and the highlight is deleted. If no port arrives within five
seconds, it is deleted anyway. The rule itself stays on the page until it
reloads, and paints nothing without the highlight.

The source stores the article append-only in `source_articles`, one row per
revision that carried one, and its authors in `authors_json`. Search indexes
the authors and the newest detected article's plain text with the notes,
inside the source's 16 KiB projection. `fetch` on the source returns the
notes followed by the article's Markdown. In Library the card shows the
byline, word count and "Read the article", which opens the reader view at
`/library/read/<source id>`; Notes and details shows the article too. Both
render images as links, so reading never loads anything from the original
site. ADR-0015's
amendment of 2026-10-29 records the decision.

Saving a selection uses no upload:

```text
captureSelection → quote + nearby text context + page title and URL
save_source (kind=reference, title, URL, notes=quote and context, tags)
```

The selection is a separate durable reference with the same page URL, not a
typed child relation to another source. Its notes preserve the selected quote
and up to 180 characters of text before and after the selection where available,
so the quote can be found again if the page changes. The current source model
has no source-to-source relation. The extension does not search for or revise
an existing source when saving a highlight. As with HTML capture, URL fragments
are removed; query parameters remain. Review selected/private text before
saving. The highlight is listed in Library with its URL, notes, and tags.

The PUT carries only its single-upload capability, never an access token.
It must use the endpoint's origin and the returned asset's upload path. All
requests omit cookies and refuse redirects. MCP accepts JSON or SSE envelopes.
Files are durable: the extension never sets an expiry. Linking the source
therefore succeeds without weakening source revision/asset retention rules.
It writes no generated capture commentary into user-authored source notes;
the asset description records the representation version, time and original URL.

## Snapshot representation and delivery

`inert-dom-v4` is a UTF-8, doctype-prefixed HTML representation of the current
main-frame DOM, including dynamically rendered text, with the stylesheet,
images and fonts it uses stored beside it in the same Library folder. It is
not a bookmark, a server-side refetch, the original HTTP response, a
pixel-perfect archive, or extracted/indexed text. The HTML file is the
original immutable asset for this capture. Valise verifies the SHA-256 and
byte count of every file before publication. Each file is at most 25 MiB; the
extension refuses a larger HTML file before beginning an upload.

The capture reads the DOM without modifying the live page and builds a fresh
HTML document. Its canonical head starts with UTF-8 metadata and this CSP,
followed by the escaped title and, when a stylesheet was kept, `<link
rel="stylesheet" href="page.css">`:

```text
default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; base-uri 'none'; form-action 'none'
```

Source head/body positions cannot move captured content ahead of it. The body
is rebuilt using a strict semantic HTML-element allowlist and new text nodes,
never by serializing a pruned source tree. Unknown HTML wrappers contribute
only sanitized children; foreign namespaces are dropped. Raw-text `xmp`,
`plaintext`, `noembed` and `noframes` become `<pre>` with escaped literal
text, so closing-tag text cannot turn into executable markup on reparse.
`noscript` is dropped with its content: it holds tag-manager iframes and
"enable JavaScript" notices. Structural safety does not depend on the
generated CSP.

Scripts, frames, embedded objects, SVG/MathML, templates, source metadata,
explicitly hidden nodes and comments are omitted. Inputs, textareas, selects,
buttons, options, datalists, outputs and editable regions become `[Form field
omitted]`, dropping default/current values, hidden tokens, checked state and
selections. The attribute allowlist is `lang`, `dir`, `alt`, table spans,
`class`, `id`, `style` with its `url()`s rewritten, `width` and `height` on
`img`, and resolved credential-free HTTP(S) anchor URLs. `class`, `id` and
`style` on `<html>` and `<body>` are kept too, because page-wide selectors
hang off them. Event handlers, `srcset`, `sizes`, `srcdoc`, form actions,
`data-*` and executable link schemes do not survive.

Resources are named within the folder: `page.css`, `img-001.png`,
`font-001.woff2`, unique by construction and matching
`^[a-z0-9][a-z0-9.-]{0,99}$`.

- `page.css` is every enabled stylesheet in document order, `<style>`,
  `<link rel=stylesheet>` and adopted sheets, with `@import` flattened in
  place and a sheet's `media` wrapped in `@media`. A cross-origin sheet whose
  rules cannot be read is fetched again with `mode: "cors", credentials:
  "omit"`; if that fails it is skipped.
- Every `url()` in a sheet or `style` attribute is resolved against its own
  sheet's URL, fetched, stored and rewritten to its file name. One that cannot
  be stored becomes `url("")`, so the archive names no outside origin.
  `data:` URLs under 64 KiB stay inline; larger ones become `url("")`.
- An `img` keeps `src` set to the stored file of its `currentSrc`, or loses
  `src` when the image could not be stored.
- Same-origin fetches use `credentials: "same-origin"`; cross-origin ones use
  `mode: "cors", credentials: "omit"`, so a cross-origin resource without CORS
  headers is not kept. Only the types the viewer serves are kept: PNG, JPEG,
  GIF, WebP, AVIF, SVG, ICO, WOFF2, WOFF, TTF and OTF. A font served as
  `application/octet-stream` is kept by its file extension.
- At most 98 resources and 40 MiB in total, 25 MiB each, so the folder stays
  within 100 files. Past that a resource is skipped and counted.

Bytes cross from the page to the popup as base64. `capturePage` returns
`{ title, url, html, capturedAt, resources: [{ name, contentType, base64 }], skipped }`.

Older captures (`inert-dom-v1` to `v3`) are immutable and are not rewritten:
adversarial raw-text elements combined with a moved head could make a
downloaded v1 file execute before its CSP. Valise's attachment delivery
protections still apply to those originals.

Page and link URL fragments are removed because they commonly carry OAuth
tokens. Query parameters remain, including on the resource URLs the capture
fetches. Private text, query-string secrets and CSS-hidden text without an
explicit `hidden`/`aria-hidden` attribute can still be captured, and
same-origin images are fetched with the page's cookies, so a signed-in page's
private images are kept. Review the page and URL before saving; form
redaction is not a general secret detector. Shadow DOM, subframes, canvas
pixels and inline SVG are not archived. Protected Chrome pages and the Web
Store cannot be injected into. No additional permission is requested to
bypass that.

The extension never inserts captured HTML into its own UI. The archive viewer
renders it. `/library/archive/<asset id>` checks the console session and
ownership, then answers 303 to a capability path for the HTML file,
`/archives/<folder id>/<expires>/<signature>/<file name>`, valid for an hour.
Its siblings resolve as relative URLs under the same path, so `page.css` and
the images load without cookies. Every response carries
`Content-Security-Policy: sandbox` with sources limited to that path,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and
`Cache-Control: private, no-store`; the plan and ADR-0015 give the full
header set. The sandbox gives the document an opaque origin and runs no
script. `/files/<object-id>` and capability downloads still return the HTML
as an `application/octet-stream` attachment, and the Library's text preview
renders it as a string in `<pre>`. The CSP inside a snapshot is defense in
depth, not a substitute for the server headers.

## Failure and acceptance checks

The popup must remain open during saving. Closing it or losing the connection
can interrupt the sequence. An unfinished upload stays undiscoverable and is
handled by existing pending-upload cleanup. After finalization, the original
already appears in Library even if source creation fails. A lost source
response can mean it was committed: check Library before another capture.
There is no automatic replay or deduplication, since `save_source` creation
does not accept an idempotency key. The popup locks its save after one attempt
to prevent double submission; check Library, then reopen it for a new attempt.

Library lists the finalized original and linked document source. Both cards
display their stored tags. The source links the original; the original offers
text preview and download of the snapshot. The HTML file itself is not
indexed; the article extracted from it at capture is, on the source.

```sh
npm test --prefix clients/chrome-extension
npx vitest run --config vitest.mcp.config.ts test/mcp/oauth.worker.test.ts
npx vitest run --config vitest.clients.config.ts test/clients/chrome-capture.test.ts
npx vitest run --config vitest.mcp.config.ts test/mcp/chrome-capture.worker.test.ts
npx playwright test test/ui/chrome-capture.spec.ts test/ui/chrome-capture-security.spec.ts
npx playwright test test/ui/article-capture.spec.ts
npx playwright test test/ui/chrome-extension-loaded.spec.ts
npx playwright test test/ui/capture-journey.spec.ts
```

`test/oauth.test.mjs` runs Connect, refresh and Disconnect against stubbed
`chrome.identity`, permissions and storage: host permission before any request,
PKCE S256, `state` checks, refusal of a grant wider than capture, one refresh
and retry on 401, a reconnect message when refresh is refused, and revocation
on Disconnect and reconnect. `test/mcp/oauth.worker.test.ts` covers the
server: which `chromiumapp.org` callbacks registration admits, the narrowed
consent page and grant, the extension Origin bound to its own id, revocation
from Connections and from `/token`.

The isolated Node suite covers tags, exact bytes/checksum, JSON/SSE handling,
the complete upload/link ordering, permission denial, local-only credentials,
endpoint validation, 401/403, transfer/finalization failure, unexpected upload
destinations, selection source persistence, and uncertain source creation. Its wrapper participates in
`npm run test:clients` without changing root dependencies.

The Worker tests use the extension client with real scoped console tokens,
D1/R2, the MCP endpoint, Library's own list queries and protected downloads.
They check both tag sets, source/asset links, publication, byte equality and
attachment headers even for an intentionally malicious HTML upload. The
adapter uses `redirect: manual` because workerd does not implement the browser's
`redirect: error`; the production extension refuses redirects.

The extension-Origin acceptance case runs the full upload/link flow, not just
a no-Origin API call. Rejection cases cover real OAuth grants, missing/invalid/
revoked bearers, browser session cookies, loopback-header impersonation,
malformed extension Origins, unrelated web Origins and foreign Host headers.
No acceptance cases are skipped.

The Playwright check captures a real DOM with edited form values and dynamic
content and verifies redaction without mutating the page. It also selects text
in Chromium and verifies the durable reference appears in Library with its URL,
notes, and tags. It signs into the
console, creates a real capture-scoped bearer through Connections, saves through
the extension client with an extension Origin header, then opens/downloads the
original in Library without executing it. Its HTTP adapter uses no loopback
`x-valise-*` bypass; it is not an installed extension. Neither it nor the
Node/Worker tests establish interactive Chrome installation, a Chrome
host-permission dialog, or a production capture.
Manually perform Install and Connect above and check a real tagged capture
after integration; do not infer that proof from API tests. The checklist under
"Manual verification" is the owner's part.

`capture-journey.spec.ts` is J1's capture journey on the loaded extension,
built into its own directory so parallel workers do not share a build. It
checks the not-connected popup; on an article, the preview, "Not saved", the
tint on the page with the page's HTML unchanged, Save article as the primary
in view at the popup's real size with Archive full page left of it; Save
article writing a bookmark with no archive link and both save buttons
disabled after; a tag added through the combobox by keyboard, sent with
`expected_revision` 1 and answered with revision 2, then a project write on
that revision; the tint gone after the popup closes; "Saved <date>" when the
popup opens on the saved page, the Tag list opening on focus and offering the
earlier tag, picked by a click; an archive save on a second article and its
archive link with Archive again; Save bookmark as the primary on a paywall
teaser and a tiny page, which saves as "Saved the bookmark."; the refusal on
an error page and on `chrome://version`; the archived article's reader at 1280
and 320px with no horizontal scroll; Open archived page in the viewer; the
bookmark found by the tag and project added after its save, and its reader's
footer saying no archive was kept; and 404 for unknown ids. A second test archives a page with
a same-origin stylesheet whose `url()` background is an image, plus an
`<img>`, and checks that the folder holds `page.css` and both images and that
the viewer renders the background and the image. Pages are routed
fixtures. Playwright cannot open the Chrome Web Store, so that refusal is a
manual check.

`chrome-extension-loaded.spec.ts` additionally builds and installs the actual
unpacked MV3 extension in a fresh persistent Chromium profile. It first opens
the popup on a fresh install and checks that it shows only the sign-in prompt
for `app.valise.run`. It then stores the local endpoint without tokens, the
state an ended grant leaves, and chooses Connect to Valise in the popup. The
Settings tab opens a real `launchWebAuthFlow` window on the local consent
page; the test checks the extension id and four scopes there, approves,
checks that the Settings tab closed itself, and checks the grant in
Connections. It invokes the browser action through CDP, drives the
real Settings and popup controls, and uses the native browser transport.
The HTML original, linked document and selected-text reference must all appear
in Library with their tags; the preview must preserve article text and omit
form values. It also checks no selection; that a grant revoked in Connections
returns the popup to sign-in when it next opens; Connect to Valise from Settings;
Settings' connection block naming the host, the endpoint and "Signed in
through Valise"; that Disconnect removes the grant from Connections; a
rejected pasted token, shown as "Pasted token", after which the page
save buttons stay disabled;
removed host access returning the popup to sign-in; and forgetting the local
connection. It does not mock Chrome APIs,
fetch, MCP or uploads. The article alone is a deterministic routed fixture.

Install the full browser with `npx playwright install chromium`; the test uses
`channel: chromium`, not the extension-less headless shell. Its debug port is
picked free for each run. The exact endpoint
host is granted through Chromium's extension-management API, then activated by
a `chrome.permissions.request` from an extension page, which Chrome answers
without a prompt once the host is granted; the management call alone leaves it
inactive for an extension with a required host. Permission enforcement is
real, but the native consent dialog still needs manual acceptance.
Screenshots cover save results and errors, not credentials. Automatic traces
and failure screenshots are disabled for this test because setup handles a
one-time secret. This test uses the local Worker, not production.

On 2026-10-24 the loaded popup reproduced `begin_asset_upload could not be
reached` with no network request. The default client had assigned native
`Window.fetch` to an instance property and invoked it with that instance as
its receiver; Chrome threw `Illegal invocation`. The default transport now
calls `fetch` through an arrow function. Injected Node/Worker HTTP adapters had
hidden this browser-only failure. Rebuild and reload the extension to pick up
the fix; changing the endpoint or token cannot fix the old build.

The Chromium security cases reparse standalone snapshots containing raw-text
closing-tag/script/image payloads, attribute/title breakouts, invalid table
nesting and a head moved behind the body. They assert no execution, no external
requests, and preserved article/literal content with and without the generated
CSP, covering structural safety independently of policy enforcement.

The extension follows P7's set-shaped tag add/remove controls and named remove
buttons, P8's visible empty-value add, P9's offered projects and tags through
the APG combobox, and P11's immediate pending state. The vocabulary comes
with `save_source` `check: true`, so the grant needs no read scope. The
packaged console stylesheet carries the visual language without introducing
a second palette.

## Manual verification

Automated runs grant the endpoint host programmatically and use a fresh
profile. These steps are for the owner's own Chrome, after a release.

1. Rebuild (`npm run build --prefix clients/chrome-extension`) and choose
   Reload on the extension's card, without disconnecting first. The card
   shows version 0.9.0.
2. The upgrade. Open the extension on a normal web page. Save article or
   Save bookmark is enabled and saves on the 0.7.0 grant. Choose To-do in
   the switch at the top: the popup says adding to-dos needs one more
   permission and offers Reconnect to Valise. Choose it; the consent page
   lists `todos:write`, `assets:read`, `assets:write` and `sources:write`.
   Allow. Open the extension again, choose To-do, type a description such
   as "Book an appointment", pick a project, and choose Add to-do. The
   popup says "To-do added" and links the to-do; the link opens it in the
   console with the page's URL under its pointers. Valise → Connections
   lists one `Valise capture`, with the four scopes.
3. In Settings, choose Disconnect, then revoke any pasted token in Valise →
   Connections.
4. Open the extension on a normal web page. The popup shows only the sign-in
   prompt naming `app.valise.run` and a Connect to Valise button: no tags, no
   Save buttons, no Open Library link.
5. Choose Connect to Valise. No Chrome site-access dialog appears; Settings
   opens at once with the sign-in window. If Reload showed a prompt for the
   new host permission, accept it first.
6. In the sign-in window, check that the page names the id shown on
   `chrome://extensions` and lists only `todos:write`, `assets:read`,
   `assets:write` and `sources:write`. Choose Allow. The window and the Settings tab close and
   Chrome returns to the page.
7. Open the extension. The popup shows the page with Save article or Save
   bookmark enabled, and Archive full page beside it.
8. In Valise → Connections, `Valise capture` is listed with those four
   scopes and the `chromiumapp.org` callback.
9. Open a long public article, such as a Wikipedia page. Before saving, the
   popup shows the byline, word count and excerpt and "Not saved", and the
   article's paragraphs are tinted on the page. Close the popup; the tint
   goes. Open it again, choose Archive full page with tags and a project,
   and save a selected-text highlight. Both appear in Library with their
   tags and project. Reopen the popup: focusing Tag or Project lists what
   you just used. Choose
   the "Saved <date>" link: the reader shows the article. Choose Open
   archived page: the page renders with its own fonts, colours and images,
   and nothing loads from the original site. Switch the system to dark
   mode; the popup follows.
10. On a second article, choose Save article. The popup shows "Saved
   <date>" with no Open archived page link. Add a tag and change the
   project; the popup says "Tags saved." and "Project saved.", and Library
   shows both on the article. Choose Note, type a note and click outside
   it; the popup says "Note saved.". Close and reopen the popup: Note is
   open on that note.
   Reopen the popup on the first article: it says "Saved <date>" and
   offers Archive again.
11. Open the Chrome Web Store. The popup says Chrome does not let extensions
    read the page and offers no Save.
12. Optional: wait more than an hour, then save again. The save succeeds
   without reconnecting, because the extension refreshed its token.
13. Revoke `Valise capture` in Connections, then try a save. The popup
    returns to the sign-in prompt. Choose Connect to Valise to sign in again.
14. In Settings, choose Disconnect. Settings reports that Valise revoked the
    connection, Connections no longer lists `Valise capture`, and the popup
    shows the sign-in prompt.
