# 0014. Tailwind compiles one static stylesheet; shared blocks own page spacing

Date: 2026-10-20
Status: accepted; amended by 0020 (Preflight and shadcn/ui)

## Context

The owner requested Tailwind, reusable components and composed header,
application-shell and search blocks. The to-do page spaced every filter,
project row, composer and state control as an independent page section. The
Add skill dialog separated its selected result, rationale, metadata, files and
organization fields with unrelated margins and padding. Reducing one margin
would leave the competing layout rules in place.

The OAuth consent page is Worker-generated HTML, not React. It must keep the
same palette and `/valise.css` link as the console. Its stylesheet cannot
depend on loading a JavaScript bundle.

## Decision

`styles/valise.css` is the only authored sheet and palette. Tailwind's CLI
compiles it to the ignored `public/valise.css`; that static path is the asset
both clients link. Install, verification, standalone browser tests and build
compile it. `scripts/dev.mjs` supervises the compiler watch and React Router
dev server together. No CDN, runtime CSS generation, second sheet or Preflight.
The dependency lock retains existing package versions.

Existing component rules occupy Tailwind's components layer; utilities can
compose shared blocks without specificity overrides. The theme exposes the
existing palette through aliases and a quarter-rem spacing unit. The default
Tailwind color palette is not offered. Source scanning is limited to `app/`
and `workers/`, so test payloads and local evidence do not change shipped CSS.
Single-column block grids use `minmax(0, 1fr)`, not implicit auto tracks; dense
tables scroll inside their own band rather than widening every sibling.

`ApplicationShell` composes the heading, workspace navigation, optional page
sections and content grid on all six console routes. `ListControls` groups
filters and actions under one spacing rule. `SearchField` and `SearchBar` own
the named input and GET form; list forms explicitly target their pathname so
server and hydrated form actions agree. `DetailSection` keeps preview
metadata, rationale, bundle and organization fields in named groups. Existing
native dialog, combobox, form and keyboard behavior remains in its owners.

No shadcn/ui or Flowbite preset is introduced: the required interactive
primitives already exist and replacing their tested behavior or palette does
not solve the grouping problem. The workbench renders the shared blocks and
the design guide remains its source, under the visual rule and P3, P10, P11.

## Consequences

Styles require compilation on a clean checkout. The lifecycle scripts enforce
it, and a test checks the generated utilities, palette and console/OAuth links.
The generated asset is not a file to hand-edit or review as a second source.

`npm run shots:ui` reproduces desktop and narrow captures with an owned database
and local registry, including the selected skill's rationale and file tree.
Browser tests assert shared composition, spacing, narrow containment, stable
search URLs, no-script filtering and dialog/keyboard behavior. No production
data, MCP schema or storage policy changes are part of this decision.

## Amendment, 2026-10-29

ADR-0020 adopts shadcn/ui and loads Tailwind's Preflight. The sentences
"No CDN, runtime CSS generation, second sheet or Preflight" (Preflight only)
and "No shadcn/ui or Flowbite preset is introduced" no longer hold. The single
static stylesheet, its compile steps and the shared page blocks stand.
