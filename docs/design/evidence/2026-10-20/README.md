# Console grouping captures

Baseline: `4d0cd4e`, using the same local seed and registry fixture as the
comparison. No production data or external registry request is in these images.

| Surface | Before | After |
|---|---|---|
| To-dos, desktop | [1280px](before-todos-1280.png) | [1280px](after-todos-1280.png) |
| To-dos, narrow | [390px](before-todos-390.png) | [390px](after-todos-390.png) |
| Add skill, desktop | [1280px](before-add-skill-1280.png) | [1280px](after-add-skill-1280.png) |
| Add skill, narrow | [390px](before-add-skill-390.png) | [390px](after-add-skill-390.png) |

Additional final checks covered Memories at desktop and Connections with a
populated session table at 390px; both screenshots were removed before
publication because they showed personal data.
The final capture fixture includes a real loopback MCP read with a long client
label so an empty session table cannot hide grid overflow.

`measurements.json` holds the page/header/filter/list geometry for all six
routes and the selected skill preview at both widths. The first to-do starts
at 415.5px rather than 616.125px on desktop, and 629.25px rather than
798.6875px on narrow. No captured page is wider than its viewport. The final
preview opens with scroll offset zero at both widths; the narrow baseline
starts below its first controls.

Reproduce the current captures with:

```sh
VALISE_SHOTS_DIR=.context/ui-review npm run shots:ui
```

The lever creates and removes its own database, hosts the skill registry
fixture on loopback, signs in with local-only test credentials, and captures
14 views. It fails on horizontal overflow or a dialog opening mid-content.
`VALISE_TEST_PORT` selects another port when one is occupied.

The shared blocks follow the visual rule and P3 (URLs), P10 (focus and target
access), P11 (plain forms). `test/ui/layout.spec.ts` checks composition and
behavior rather than accepting a screenshot as proof of keyboard or no-script
operation. The fixture's recommendation text is existing seeded copy, not a
new endorsement or curation change.
