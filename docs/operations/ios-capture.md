# iPhone share-sheet capture

An Apple Shortcut, Valise Capture, saves the page you are reading to Library
from Safari's share sheet. It posts the URL, the title and the article it read
from the open page to your capture URL with Get Contents of URL. Nothing opens
in Safari and the clipboard is not used. ADR-0015, amendment of 2026-11-02.

Every step below is unverified on a device. The action names are from the
Shortcuts app on iOS 18; correct this page when a device shows otherwise.

## Setup, once per iPhone

1. On Connections, under iPhone share sheet, tap Create capture URL, then
   Copy. The URL is shown once.
2. Tap Add Shortcut. When the Shortcut asks for your capture URL, paste what
   you just copied.
3. The first save asks to allow `app.valise.run`. Choose Always Allow.

The capture URL is a `sources:write` bearer token listed on Connections as
iPhone Shortcut. Revoke it there; the Shortcut then answers that the URL was
revoked, and a new one is pasted by adding the Shortcut again.

The published Shortcut is
<https://www.icloud.com/shortcuts/6a1718a7f7b045b29bec660b59ef6172>, shared
by the owner on 2026-11-03 in place of the 2026-11-02 link. Its actions
have not been compared with the steps below. The steps rebuild it if the
link stops working.

## Building the Shortcut

Unverified on a device, every step. The published Shortcut was read from its
iCloud record on 2026-11-15 and its first eight actions matched the steps of
2026-11-02; the steps below replace them so a share from any app works and
the answer opens the bookmark.

1. In Shortcuts, create a shortcut named `Save to Valise`.
2. Open its details (the info button), turn on Show in Share Sheet, and set
   Receive to URLs, Safari web pages, Text and Rich text. Apps other than
   Safari, and their in-app browsers, share a URL or text holding one, never
   a Safari web page.
3. Add Text. Leave it empty; it holds the capture URL. This is the import
   question's target (step 14).
4. Add Get Details of URLs on that Text, set to Fragment. This is the token.
5. Add Get URLs from Input on Shortcut Input, then Get Item from List, First
   Item. This is the link, whatever kind of thing was shared.
6. Add Get Type on Shortcut Input.
7. Add If, Type contains `Safari`. Inside it:
    - Get Details of Safari Web Page on Shortcut Input, set to Name, then Set
      Variable `Page Title` to it.
    - Get Article using Safari Reader on Shortcut Input, Get Details of
      Article set to Body, then Set Variable `Article Body` to it.

   Outside Safari there is no title or Reader article to read; Valise fetches
   the page itself.
8. Add Get Contents of URL on the Text from step 3, the whole capture URL.
   An HTTP client never sends the part after `#`, so the request goes to
   `/capture` and the token travels only in the header. Show More:
    - Method: POST.
    - Headers: `Authorization` = `Bearer ` followed by the Fragment variable
      from step 4.
    - Request Body: JSON, with Text fields `url` = Item from List,
      `title` = `Page Title`, `text` = `Article Body`.
9. Add Get Dictionary Value for `message` in Contents of URL.
10. Add Get Dictionary Value for `link` in Contents of URL.
11. Add If, that `link` has any value. Get Contents of URL does not fail on
    an error status, so a missing `link` is how the Shortcut tells a refusal
    from a save.
12. Inside it, Choose from Menu with prompt `message`, items `Open in Valise`
    and `Done`; under `Open in Valise`, Open URLs on `link`.
13. Under Otherwise, Show Notification with `message`.
14. In the shortcut's details, Setup → Import Questions → Add, choose the
    Text from step 3, and ask "Paste your capture URL from Valise
    Connections".
15. Share it: Share → Copy iCloud Link. For the upstream Shortcut, the
    link goes in `IOS_SHORTCUT_LINK` in `app/concepts/ios-shortcuts.ts`.
    A self-hosted install that publishes its own copy sets the
    `IOS_SHORTCUT_LINK` var to the link instead; `none` hides the button.

A Mac can build the same file without the editor: write the workflow plist
and run `shortcuts sign --mode anyone --input <plist> --output <file>`.
Opening the signed file imports it; the iCloud link still comes from a
device.

If Safari Reader returns nothing for a site, the Reader steps in step 7 can be replaced by
Run JavaScript on Web Page with `completion(document.documentElement.outerHTML);`,
sent as `text`; Valise cuts the article out of HTML the way it does for a
fetched page. That needs Allow Running Scripts, under Settings → Apps →
Shortcuts → Advanced, and Shortcuts asks per site before running it, so it is
not the default.

## The request

```
POST https://app.valise.run/capture
Authorization: Bearer vls_…
Content-Type: application/json

{"url": "https://…", "title": "…", "text": "…", "tags": "a, b", "notes": "…"}
```

`url` is required and must be http or https. `title`, `notes`, `tags` (an
array or a comma-separated string) and `text` (article text or page HTML) are
optional. Every answer is JSON with a `message` meant to be shown as it is:

| Status | When |
|---|---|
| 200 | Saved. `id`, `link` (the bookmark in Library, absolute), `title`, `article` (kept or not), `words`. |
| 400 | Not JSON, or no http(s) `url`. |
| 401 | The token is missing, unknown or revoked. |
| 403 | The token lacks `sources:write`. |
| 405 | Anything but POST, such as opening the capture URL in Safari. |
| 409 | The save was refused by `saveSource`. |
| 413 | The body is over 3 MiB plus 64 KiB. |
| 429 | Over 20 saves in a minute on this token. Retry after 60 s. |

A quick check from a laptop, with a token minted on Connections:

```sh
curl -sS https://app.valise.run/capture \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.org/"}'
```

## What gets saved

- A bookmark with the URL, title, tags and note. The same URL again revises
  that bookmark rather than adding a second one.
- The article when `text` has at least 150 words, with extractor
  `valise-paste-1`. Valise then never fetches that page.
- With fewer words, or none, the link only; Valise fetches the page itself
  within a few minutes, without your login, so a paywalled page keeps the
  link and title.

## Link-only saves from a browser

`/save?url=…&title=…` still saves a link from any signed-in browser, with an
Article text box to paste into by hand. The Shortcut no longer uses it.
