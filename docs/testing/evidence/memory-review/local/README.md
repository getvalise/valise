# Memory review walkthrough, 2026-10-29

Local production build and isolated Playwright Worker, synthetic owner account.
`test/ui/memory-review.spec.ts` seeded 43 review groups and 86 source memories;
the default loads 30 compact rows, excluding the single no-change result. Long
source titles and OAuth-shaped provenance occur in the volume fixtures. No
provider call or production mutation occurs in this browser suite.

| Artifact | Observation |
| --- | --- |
| `review-default-1280.png` | Purpose and two secondary disclosures precede Run review; compact shared rows, not a card grid. Failure and ready states are distinct. |
| `review-default-390.png`, `review-default-320.png` | Same hierarchy, wrapped navigation and no horizontal overflow. |
| `review-primary-action.png` | Shared right-hand pane shows the human-edited draft, two attributed exact quotes, recorded selection methods and Accept/Dismiss. List stays beside it rather than underneath. |
| `review-native-320.png` | With scripting disabled, the full-screen pane retains the native-form human edit and source evidence. |

All five images were opened and inspected. Earlier screenshots exposed a
three-column card layout stretching neighboring rows when a proposal opened;
that layout was replaced with ItemList/ItemRow and the shared pane before these
artifacts were retained. Default screenshots explicitly start at scroll zero.

The focused suite passed 14/14 before retention. It exercises provider changes
and stale consent, USD bounds, source/draft staleness, original-response versus
human-edit inspection, acceptance, dismissal/reopening, keyboard/native forms
and source selection disclosure. A later assertion also checks that the list
row's right edge does not extend under the pane. The exact PR-head full gate
is recorded on the PR, not inferred from these images.

P1/P2/P3/P4/P5/P10/P11/P12/P13 and ADR-0012's October 29 amendment govern this
walkthrough. Data-integrity/runtime assertions, live synthetic GLM output and
production J2 acceptance are separate evidence. These are not model-generated
UI fixtures, a production walkthrough or proof of the full provider journey.
