# 0020. shadcn/ui components, Preflight, and one frame for every list

Date: 2026-10-29
Status: accepted

## Context

By late October the console had grown one component at a time over a
5,038-line hand-written stylesheet with about 740 rules. The owner reported
that it read as inconsistent: tables on memories and skills, cards on the
library, a modal on memories and skills but a docked pane on to-dos, three
different filter bars, dotted controls that did not read as controls, and a
skills page whose bulk actions, add control and suggestions sat in unrelated
places. ADR-0014 had ruled out shadcn/ui and Flowbite on the grounds that the
interactive primitives already existed and the problem was grouping. The
grouping fixes landed, and the inconsistency stayed, because each primitive
still drew itself.

The owner asked for a component library with its own theme, a sidebar with
icons that collapses to a rail and opens on hover, a content column, and a
right-hand pane for item details (and later chat). An earlier Cloudflare app by the
owner already runs shadcn/ui on the same stack (React Router 8,
Tailwind 4, lucide, Cloudflare Workers), and its theme was the reference. Only
shadcn ships the chat components (`MessageScroller`, `Message`, `Bubble`) the
pane will later host. Flowbite's React package keeps its own theme objects and
has no chat layer.

## Decision

shadcn/ui (new-york style, Radix primitives) is the console's component
library. Components are copied into `app/components/ui/` by the shadcn CLI and
edited there when Valise needs a different behaviour (the sidebar's hover rail,
a popover that portals into a modal dialog). No second component library.

`styles/valise.css` stays the only stylesheet source, and now loads Tailwind's
Preflight. It declares the shadcn roles for light and dark; the older component
rules read those roles through their original names, so every route took both
themes at once. Legacy element rules are scoped `:where(:not([data-slot]))`
so they never style a shadcn part and never gain specificity.

Every console page uses one frame: sidebar, content, right-hand pane. Every
item list uses the same parts: header, toolbar (`list-toolbar.tsx`), one
bordered list (`item-list.tsx`) whose first row is the create control, rows
that open in the pane, centred modals only for creating and editing. Pickers
over sets too large to send with the page (documents, memory link targets) are
server-searched and paged (`async-picker.tsx` over a resource route).

The look is recorded as rules V1–V7 and the frame in
`docs/design/principles.md`; P13 ("show, don't tell") joins the interaction
principles.

This supersedes ADR-0014's sentences "No CDN, runtime CSS generation, second
sheet or Preflight" (Preflight only; the rest stands) and "No shadcn/ui or
Flowbite preset is introduced". ADR-0014's single static stylesheet, shared
page blocks and compile steps stand.

## Consequences

The console has one look and one way to open, filter and create in every list,
and new screens start from parts that already hold P3, P4 and P11. Dark mode
came with the roles.

Preflight changed defaults the legacy rules relied on: `svg` is a block,
`margin` is zero on every element (a modal dialog no longer centres itself),
and the shadcn sidebar's in-flow spacer became the browser's scroll anchor.
Each has a rule in the stylesheet; Valise memory
`mem_03422e23-2cd6-4490-b9ac-fe566b91697a` lists them. More may surface on
pages not yet walked.

Upgrading a shadcn component means re-running the CLI and re-applying local
edits; the edited files are `sidebar.tsx`, `popover.tsx` and
`input-group.tsx` (the last only because this repo compiles without the DOM
lib). About 5,000 lines of legacy CSS remain; they now read theme roles and
are retired page by page as each moves to shadcn parts.
