# Consolidation journeys J-A, J-B and J-C

These are local synthetic browser and D1 checks for the journeys in
[memory consolidation journeys](../../../design/memory-consolidation.md). No
provider was configured and no model call was made. They do not prove that a
nightly cron ran or that a provider produced these drafts. That is J2
acceptance, `todo:tdo_dcd7f6e3-46b8-42d1-a4d9-fcfaf37e8b45`.

## Integrity

`test/d1/memory-review-progress.worker.test.ts`, "checks one memory now",
runs a check that starts from one named memory, using an injected drafter.
That memory is the starting memory, and the due retry is skipped. Only that
memory leaves the queue. A second check of the same memory sends nothing,
because its pairs are covered. A memory that does not exist makes no call.
The narrowed list and per-state counts return only groups that include the
memory, and nothing for another user.

## Browser usability

`test/ui/memory-review.spec.ts` seeds forty-five synthetic review groups into
an isolated local D1.

- J-A shows the waiting count, the model and the nightly state in the status
  region. The check button is visible and disabled without a provider key.
  The list holds thirty rows at 1280px, 390px and 320px with no sideways
  scroll. In the pane, Proposed new memory comes before Decision, and Decision
  before Source evidence. Revision metadata is collapsed. Dismissing keeps the
  row's index (P4, P5) and offers Next waiting suggestion, which opens a
  waiting row. Hide decided (n) removes every accepted and dismissed row, and
  Show decided (n) restores them.
- J-B follows "Memory review: in 1 suggestion" from a memory pane to
  `?memory=`, which narrows the list to that row. With reviews off there is
  no check, and the consent switch is shown (P8). Once allowed, Check this
  memory now is shown and disabled without a key. A native post redirects
  with `ran=0.0.0.other` and the page states the outcome in words. An unknown
  memory is refused with 409 and changes no budget or group.
- J-C keeps its consent, model-change revocation and legacy-model behaviour
  under the existing tests. The model picker now sits in Settings. Nightly
  drafts are disabled until a check with the selected model has finished. The
  server refusal for a crafted request is still tested.

Retained screenshots in `consolidation-2026-10-30/`:

- `consolidation-default-{1280,390,320}.png`: J-A default populated view.
- `consolidation-primary-{1280,390}.png`: J-A primary action focused in the
  pane and the phone sheet.
- `consolidation-memory-{1280,390}.png`: J-B narrowed view with reviews
  allowed.
- `setup-populated-390.png`: J-C setup panel above a populated list.
- `dev-setup-1200.png`: the same view walked on `npm run dev` with seeded
  data. A second capture, J-B reached from the memory pane with reviews off,
  was removed before publication because it showed personal seed content.

## Production boundary

Build, version and deployed smoke observations belong to the merged PR and
`todo:tdo_4f7ef6fb-7e75-49ca-be1f-95adba5b7ce9`. No production setting, opt-in
or memory was changed.
