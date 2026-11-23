# Library acceptance

## Tested code and commands

The redesign checkpoint `a39670416c271e6df9b974f286621694999eefbd`
was integrated with merged but unreleased main
`b64c8d9317fc3d84b25c6a8f75cdb30c532349b6` at
`425c9984cfa90a1ca1beda7ee01fe798ea95f67a`.

At `425c998`:

```sh
npm run lint
npm run typecheck
npx vitest run --config vitest.clients.config.ts test/clients/library-presentation.test.ts test/clients/asset-processing-ui.test.ts
npm run test:d1 -- test/d1/library-loading.worker.test.ts test/d1/asset-processing.worker.test.ts test/d1/sources.worker.test.ts
VALISE_TEST_PORT=4349 npx playwright test test/ui/library-ux.spec.ts test/ui/library-loading.spec.ts test/ui/library.spec.ts test/ui/asset-processing.spec.ts test/ui/recording-library.spec.ts test/ui/chrome-capture.spec.ts test/ui/chrome-extension-loaded.spec.ts --reporter=line
```

Lint and types passed; client tests passed 5/5; D1 passed 56/56.
The browser run passed 16 and failed 5. A real processing-status bug let
format preflight hide an existing queued state. The fix and three static
regressions were committed at `cca22463a22d3b348bc9b64e66f290dd016b266e`.
Typecheck and the expanded client tests passed 8/8 before that commit.

The same browser command at committed `cca2246` passed 19 and failed 3 in
1.7 minutes. There was no retry option or assertion waiver. D1 was not rerun
at this head. The 895-source browser journeys passed with scripting on and
off. The database assertions bound the default to 30 files, 30 sources, no
attachment choices before disclosure, fewer than 20 reads and a serialized
loader result under 100,000 characters. The HTML browser budget is 1 MB.

## Actual screenshot review

Artifacts are local, synthetic and retained below:

```text
/private/var/folders/75/p5ymw8gs2nl_ww1fkqkvytlc0000gn/T/opencode/library-acceptance-425c998/
/private/var/folders/75/p5ymw8gs2nl_ww1fkqkvytlc0000gn/T/opencode/library-acceptance-cca2246/
```

Each directory preserves screenshots and failed-test traces. The latter
directory includes `sha256.json` for its 36 captured files. Logs sit alongside
these directories as `library-ux-d1-425c998.log`,
`library-ux-browser-425c998.log` and `library-ux-browser-cca2246.log`.
The D1 log SHA-256 is
`ccde270c691cb9039ddb1b1b85755038147e22eb3e00b172d744db295b876351`;
the second browser log SHA-256 is
`8dce15e081e395b45187c91e68b79d07a9cc6530a3c1ef655aa42f0d351ec3e7`.

Images opened and inspected from the second run:

- `library-reading-1280.png`, `library-reading-390.png`: the populated
  Library, closed creation controls, concise saved-page notes, no main-card
  import receipt or internal record ids. Mobile stacks the filters and cards.
- `library-reference-group-390.png`: two explicitly tagged reference images
  together, separate titles and originals, readable controls.
- `library-processing-pane-1280.png`, `library-processing-pane-390.png`:
  desktop reading beside the pane, full-width phone pane, supported synthetic
  extensionless PDF, no inference started by opening it. P1, P3, P10, P11.
- `library-notes-saved-390.png`: the changed personal note and contextual
  attachment/retention actions. The disclosed view repeats the note above its
  full editable rendering; default-view cleanliness does not settle that detail.
- `library-processing-noscript-320.png`: direct processing route, explanation
  before a disabled action and a visible original download. P10, P11.
- `library-review-noscript-320.png`: wrapped native suggestion controls and
  persisted decisions, but an already-reviewed alert after reload. A successful
  decision test is not a clean refresh journey; document POST replay needs review.
- `library-bookmark-noscript-390.png`: uploaded original and newly saved
  bookmark with scripting disabled. The full-page image establishes structure,
  not fine-grained typography for every row.
- Failed-history and failed-suggestion screenshots: retained as failure evidence,
  not accepted primary-action walkthroughs.
- All eight `todos`, `memories`, `skills` and `workbench` images at 1280/390:
  rejected. They show the login page, not those routes. A generic heading
  assertion passed after premature navigation interrupted sign-in. No cross-route
  visual acceptance is claimed from them.

The first run's default desktop/mobile, mobile processing pane, loaded-extension
preview and long-title 320px images were also inspected. The long-title image
was cropped offline for readable inspection; it wraps within the card but is
not a claim that arbitrary filenames make good reading titles.

## Failures and remaining boundary

The three `cca2246` failures have trace-level explanations:

1. After reloading the URL-backed review pane on a phone, the test tries to
   reopen its link behind that already-open pane. The trace records intercepted
   pointer events, not a slow provider. Stale-field rejection passed before this.
2. The history test's broad substring selector clicks the attachment-help
   paragraph containing “earlier saved versions”, not a history summary. The
   old note remains hidden. The assertion is not evidence of successful history.
3. The linked-file test asks a collapsed saved-page card for its attachment.
   The citation assertion must be made after opening its contextual details.

Source corrections narrow these assertions without removing the user jobs.
The cross-route test must await successful sign-in and assert the exact route
and heading before capture. These post-run corrections have not been rerun.
Unlink/history completion, a complete mobile review, cross-route visuals and
the no-script refresh issue remain acceptance work, not waived failures.

Port 4349 was released after the second run; `lsof -nP -iTCP:4349
-sTCP:LISTEN` returned no listener. No new batch starts without coordination.
The UI recovery owner has the next runtime priority. No full verification,
production build, push, PR, merge, deployment, private-content provider probe,
model change or reprocessing of existing outputs occurred under this grant.
The full current-head release gate remains separately authorized work after
focused acceptance succeeds. This record does not confirm any production change.

## Completion on 2026-10-25

The branch was rebased onto `main` after #186 to #189. The same seven browser
specs then ran on port 4601 with no retries and no sleeps.

The first run passed 21 of 22. The one failure was the citation test: it
opened the file's details, which closes the saved page's details, then asked
the closed saved page for its Archive button. Only one item's details are open
at a time by design, so the test now reopens the saved page before archiving.

That run's page snapshot also showed a real defect. After "Save bookmark" the
form kept its title, notes and attached document, so a second click would save
a duplicate. The form now empties after a successful save, and the test asserts
both fields are empty.

Three other fixes came out of the screenshot review:

- Review decisions submitted without scripting now redirect back to the
  processing page. Reloading reads the page instead of posting the last
  decision again, so the "already reviewed" alert no longer appears. The
  no-script test asserts the URL after the decision and that no alert shows
  after reload. Scripted decisions send `via=fetcher` and still get data back.
- Open details no longer repeat the summary's notes excerpt, description or
  tag labels above their editable versions.
- A processed file whose type or size now falls outside the limits said both
  "Extracted content is searchable" and "Text extraction is not available".
  The second line now says reprocessing is unavailable and the extracted text
  stays searchable.

A later run under a load average above 30 timed out in sign-in and polling
steps. With load unchanged, the affected specs passed 7 of 7 on rerun; the
release gate is the full `npm run verify` recorded on the pull request.

Screenshots inspected from these runs: all eight cross-route images now show
To-dos, Memories, Skills and Workbench, not the sign-in page. The no-script
review image shows persisted decisions with no alert. The disclosed saved page
shows its notes once.
