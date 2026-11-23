# Article extraction

Does capture-time extraction (`clients/chrome-extension/extract.mjs`,
Defuddle 0.19 with a Readability 0.6 fallback) read real articles? `run.mjs`
opens 25 public pages in headless Chromium, injects the extractor as the
extension does (one bundled script, then one call), and scores six things
per page against truth read by hand off the rendered page.

- `articles.json` holds the URLs and the truth. The owner had an agent
  propose the pages from their Raindrop import and approved the list as
  proposed on 2026-11-01. Pages are fetched live; the owner chose not to
  store them in the repository, so a rerun scores whatever each site serves
  that day.
- `2026-11-01-run.json` is the run below. It keeps each check, the
  extractor's metadata and up to 200 characters of what came before the
  start or after the end, not the article text.

```sh
node evals/extraction/run.mjs --out evals/extraction/<date>-run.json
node evals/extraction/run.mjs --only 7,16 --dump /private/path/extraction
```

`--dump` writes each page's visible text and the extractor's output to a
directory outside the repository, for reading truth off a new page.

## What each check means

| Check | Passes when |
| --- | --- |
| detected | `detected` is true. All 25 pages are articles. |
| start | The truth's opening phrase is in the text, and nothing precedes it except a standfirst the page prints as part of the article (`lead`). |
| end | The truth's closing phrase is in the text, and at most 4 characters (a `↩`, a `∙`) follow it. Footnotes count as article. |
| authors | The same set of names. A job title or degree split off as a name fails. |
| published | The day matches within one, since an ISO value in UTC can land on the neighbouring day the page prints. A missing date fails a page that prints one. |
| site | One of the accepted names for the publication. A platform name or the author's name fails. |

The browser context sets `bypassCSP`: `chrome.scripting` injects past a page's
Content-Security-Policy and an inline script tag does not. Without it
blog.cloudflare.com refused the extractor outright.

## 2026-11-01

| Check | Pass, of 25 |
| --- | --- |
| detected | 25 |
| start | 23 |
| end | 20 |
| authors | 16 |
| published | 19 |
| site | 22 |

8 pages pass all six (1, 3, 4, 6, 9, 13, 15, 22). Two runs gave the same
scores.

Start misses keep page chrome above the article: Spotify's "Spotify
Technology brings our engineering tools under one roof. Learn more →" banner
(2), and Tasman's "News & Views" section label and "AdviceEngineering" tags (11).

End misses keep what follows the article:

- anyblockers.com (7) ships a hidden second version of the post, a
  "Caveman" rewrite the reader toggles to. Both versions are extracted: 5,133
  words from a page showing 2,766. The saved text repeats the article in a
  different voice.
- A newsletter box (ssp.sh, 8), DigitalOcean's "Thanks for learning…"
  sign-off (10), RudderStack's "Published: December 16, 2025" line (12), and
  MIT News's press-mentions section (16).

Author misses:

- Co-authors dropped, first name only: Substack's "Julien Hurault and Sung
  Won Chung" (5), Hamel Husain and Shreya Shankar (20), Xebia's two authors
  (25).
- `splitAuthors` splits on commas, so "Will Edwards, Staff Data Engineer" (2)
  and "Erin Gustafson, Ph.D." (18) each become two authors.
- None found where the page prints a byline: Tasman (11), Cloudflare's three
  authors (19).
- None found on two personal sites whose title is the author's name
  (wesleyac, 14; jero.zone, 23). The name still reaches Library as the
  site name, so a reader sees it.

Date misses: null where the page prints a date (2, 11, 14, 17, 21), and on
Xebia (25) the raw string `February 3, 2023 T09:00:00+05:30,
2023-02-03T16:26:42+00:00`, which `Date` cannot parse and Library stores as
given. jero.zone (23) passes only because this scorer parses its `October
21, 2024`; the extractor passes the string through unnormalised.

Site misses: "Substack" for a Substack publication (5), and the author's name
for MIT News (16) and Unravelled Development (24).

## What this says for the next Library work

- Complete bookmarks (`todo:tdo_ff8664d7`): the metadata, not the body, is
  where capture falls short. Authors (16/25) and dates (19/25) fail most. A
  comma split that cannot tell a title or degree from a second author, a
  single-author result where the page lists several, and a published value
  that is not normalised to a date are three fixes this set can rescore.
- Selecting the readable text (`todo:tdo_6006bf94`): every page was detected,
  so on articles the no-article path did not fire. The bounds were wrong on
  7 of 25 instead, mostly by keeping chrome after the end. Whether selection
  should also correct a detected article's bounds is a product decision this
  run does not make.
- Authors from book and PDF metadata (`todo:tdo_ed822157`): 3 of 25
  articles had more than one author dropped, so an author field that holds
  several names and edits as a list matches what pages carry.
