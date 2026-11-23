# Console design principles

The console is five routes over the three concepts an MCP client already sees.
This file is its design language: the visual half in one section, the
interaction half in fifteen principles.

`/workbench?tab=components` renders this file above the specimens and tags each
specimen with the principle it carries, so a primitive and the rule behind it
are read in one place. Edit this file and the workbench changes; there is no
second copy.

Each principle is a rule, what it rejects, and the source that settles it. The
closing line of each is its status.

- **Held** — the console does this, and a selector or a test says so.
- **Owed** — it does not. The fix is a box in the plan, named there.

## The visual language

A Swiss grid in a luggage maker's materials: warm sand ground, cream surfaces,
dark brown leather, royal purple, and stitching. Components are shadcn/ui
(new-york, Radix) themed through one set of roles; ADR-0020. The geometric
display face is the masthead's and the page title's; everything else is the
grotesque. Reach for a hairline before a border and a border before a filled
panel; a tag is the named filled exception.

`styles/valise.css` is the only stylesheet source and palette. It loads
Tailwind's Preflight and theme, declares the shadcn roles for light (`:root`)
and dark (`.dark`), and keeps the older component rules reading those roles
through their original names (`--ink`, `--paper`, `--trunk`, `--brass`).
Tailwind compiles it to `public/valise.css`, which the console and the
plain-HTML OAuth page both link. A colour written outside the roles is a bug.
`npm run dev` watches the source; do not edit the generated file. shadcn parts
live in `app/components/ui/` and carry `data-slot`; legacy element rules are
written `:where(:not([data-slot]))` so they never style a shadcn part and never
gain specificity.

Spacing follows Tailwind's quarter-rem unit (`--space-unit`): three units
between controls in a group, four within a section, six between page sections.
At the 15px root these resolve to 11.25px, 15px and 22.5px. A field and the
button that commits it are two controls: `FieldRow` sets them three units apart,
and a form without a layout of its own stacks its fields on the same gap.
`test/ui/forms.spec.ts` measures every console form for a button closer than
three units under a field.

### The console's frame

Three columns: the sidebar, the content, and a detail pane on the right.

- The sidebar (`app/components/app-sidebar.tsx`) is an icon rail that opens
  over the page on hover or keyboard focus and can be pinned (cookie
  `sidebar_state`, ⌘B). Opening it moves nothing: not the page, not its own
  icons. `test/ui/sidebar.spec.ts`.
- Every item list has the same parts, in the same order: the page header
  (title and lede), the toolbar (`app/components/list-toolbar.tsx`: search, a
  faceted filter per column, Reset, the list's own view controls on the right),
  then one bordered list (`app/components/item-list.tsx`). Its first row is the
  create control (`AddRow`); every other row is an item. A memory row is
  `stacked`: its title is a sentence, so it wraps whole, and its facts take
  one line under the text, type first and date last, so each sits in the
  same place on every row. A left rule coloured by type (`--primary`
  decision, `--ok` insight, `--warn` reference, `--saddle` fact,
  `--strong-rule` the rest) tells them apart before the word does.
  `test/ui/memory-list.spec.ts`.
- A row opens its item in the right-hand pane (`Modal size="pane"`), never in a
  centred modal. A centred modal is for creating or editing: Add skill, Upload,
  Add bookmark, the SKILL.md editor. One pane at a time. A pane that holds
  several kinds of detail shows one at a time under section tabs
  (`SectionTabs` in `app/components/ui.tsx`), the third level below the strap
  and the SubNav: links to `?section=`, the open one underlined in ink, empty
  sections left out. Disclosures stay for what folds inside one stream, such
  as a run of tool calls.
- Below 48rem the sidebar sits behind a menu button and the pane is a bottom
  sheet with a drawer handle.

### The first-run checklist

The job is getting a new account from an empty console to an agent that uses
it. `OnboardingChecklist` (`app/components/onboarding-checklist.tsx`) sits
above the list controls on `/todos` and `/skills`, one bordered card titled
"Get started", with two steps and three starter skills.

- Connect an MCP client. Ticks on the account's first recorded MCP call, from
  any client. An OAuth grant or a token alone does not tick it: until a client
  calls, nothing shows it reached the server, so the step says it ticks on the
  first call. The action is "Open Connections".
- Add your first skill. Ticks on a live skill whose source is not `builtin:`.
  Built-ins are published for every account and are not theirs.
- Starter skills: grill-me, conversation-history and tdd, owner-chosen on
  2026-11-23 (`STARTER_SOURCES` in `app/concepts/onboarding.ts`);
  conversation-history ships in this repo under `skills/`. Each is a
  curated suggestion, and its link opens the same Add skill preview, where
  publishing is the person's own step. Nothing is installed for them. One
  already added reads "added".

Hide is the secondary action: a form posting to `/onboarding` that records
`users.onboarding_dismissed_at`, so the card stays hidden for the account on
every browser. With scripting it goes on the click's frame through a fetcher;
without, the post lands back on the page it came from (P11). Account → "Show
it again" clears it. The card also stops showing once both steps are done.
It adds one control-plane row read and two reads on `user_id`-led indexes to each
load and has no loading state of its own; a failed read fails the page like
any other loader read. `test/ui/onboarding.spec.ts` walks a fresh member at
1280 and 390 with scripting on and off; `test/d1/onboarding.worker.test.ts`
covers each signal.

### Material rules

Approved by the owner on 2026-10-29 in review sessions on the redesign branch.
They replace the Purple Monogram rules. P1–P13 still apply.

V1. Purple is a fill, never a tint. Royal purple (`--primary`) fills primary
buttons, switches that are on, checkboxes and the mark. Under the pointer a
primary button turns near-black brown (`--primary-hover`), not a paler purple.
Text that used to be purple (section labels, claimed and completed state, the
masthead word) is `--brand-ink`: purple on the light ground, sand on the dark,
because dark purple text does not read on dark brown. No lilac anywhere.

V2. No grey. Every neutral is a brown or a sand: text, muted text, rules,
inputs, the dark theme's ground, scrims. Light is warm sand (`--background`)
with cream surfaces (`--card`) and a deeper sand for the pane
(`--pane-ground`); nothing is white. Dark keeps Tokyo Night's steps of contrast
on a dark brown ground, with Tokyo Night's signal colours. A colour audit of
the console's routes in both themes finds no computed colour under 0.012 oklch
chroma.

V3. Two accents, two jobs. Hover, selection and the active sidebar item use
sand (`--accent`). Tags are dark saddle leather with sand text
(`--saddle`), the second accent beside purple, in every size (V8). A
project is not a tag:
`ProjectChip` is a folder icon and the name, no box, ahead of the tags, so the
shape tells them apart before the text does.

V4. A stitch marks the seams of the frame, nowhere else. The saddle stitch is
one short slanted thread with a slight arc, repeated as whole stitches (CSS
`background-repeat: space`, never cut at an edge), mirrored top to bottom and
side to side. It runs around the add row and down the pane's left edge on
desktop. No dotted lines: a rule is a solid hairline, a ghost button has a
solid hairline border, a file drop is a sand well, and small create controls
(add tag) are dashed.

V5. Brand once. The mark is a solid case with two strap channels, a square
handle and a V drawn to Futura Bold's geometry, cut through the body. The
geometric display face sets the masthead and page titles; item titles and prose
use the grotesque. A faint V-and-suitcase pattern sits on the sidebar only.

V6. Legibility precedes patina. Small text needs WCAG AA 4.5:1 against its
actual surface; control outlines and focus indicators need 3:1
([SC 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html),
[SC 1.4.11](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)).
Decorative stitches, the pattern and disabled controls are exempt. A switch or
checkbox keeps a 24px target.

V7. Draw only the nouns. A Valise glyph replaces a lucide one only where it
draws something Valise has and lucide does not: the case, a claim as a buckled
or parted latch, a lease as a strap's holes, a memory as a travel sticker, a
luggage tag. Search, close, edit, copy and file stay lucide
([Icon Usability](https://www.nngroup.com/articles/icon-usability/)). They
share lucide's 24-unit box and 1.5px line; the mark is solid. Reference images
are drawn from, never traced or shipped.

V8. A tag's size belongs to the place it sits in, not to the feature that
draws it. Added by the owner on 2026-11-08, after tags on the to-do list sat
in 24px slots and stood taller than the same tags on `/memories`. Every tag,
read-only (`.tag`) or removable (`.chip`), reads the `--tag-*` tokens in
`styles/valise.css`, and a context sets them. Both sizes are V3's saddle chip
at 12px mono; the owner tried a hairline outline for list rows the same day
and kept the fill, with `/library`'s tags as the reference. Standard, the
default, is for detail panes, modals, editors and the workbench. Compact is
for list rows (`.item-list`, `.todo-list`, `.activity-trail`, `.card-list`,
or `data-tag-size="compact"`): a shorter line, smaller gaps and a 20px add
slot, so a row's tags sit close under its title. A pane opened inside a row
is standard again. The add control ("+") is the last chip and unfolds to
"+ Add tags" in line on hover or focus, so the tags before it stay where they
are (P4) and nothing is drawn over them. A new place that shows tags picks
one of the two sizes and never styles its own.

V9. Links in a list carry no underline. Owner, 2026-11-08. In a row a link is
a title, a tag or a project; the pointer already says it opens, and an
underline on each is noise. The open row is marked by its wash, the project
filter in force by the toolbar. Links in running text and in a pane keep their
underline, and keyboard focus keeps its ring.

`test/ui/theme.spec.ts` holds the evidence for V1–V7: roles, the absence of
grey, tag and project shapes, the stitch, typography, contrast and target
sizes, in both themes.

## P1. The object is the interface

You act on a to-do where the to-do is. There is no edit screen, no record
form, and no menu that collects verbs away from the noun they apply to.

Nielsen's noun-verb reading of direct manipulation is the argument: the user
"first accesses the object of interest and then modifies it by operating upon
it", which lets the system "only show valid commands" and so "eliminates an
entire category of syntax errors"
([Noncommand User Interfaces](https://www.nngroup.com/articles/noncommand/),
1993). The same article makes object visibility a requirement rather than a
preference: direct manipulation "almost by definition requires that the
objects that are to be directly manipulated are made explicit to the user and
represented visibly on the screen".

**Held.** `.editable`, `.check-circle`, `.task-box`. A to-do's title is its
own editor's link, `.todo-title-edit`, so a click on the text opens the field
the pen opens.

## P2. One field, one commit

A pen opens one field. The form that opens posts that field and nothing else,
so a value you did not look at cannot go back out stale.

This is what replaced the "Edit content" disclosure, which posted a title, a
body, a project, a tag list and a pointer list on every save. It is also why a
record-wide editor is not coming back: the cost of the old shape was silent,
and silent write amplification is the worst kind.

**Held.** `Editable`'s `hidden` prop carries the intent, the record, and the
one field name.

## P3. What is open has a URL

Which memory, to-do, or skill is open is `?open=<id>`. Which call is open on
the logs tab is `?call=<id>`, and which case on the evals tab is
`?case=<id>`. Which filters are applied are query parameters
already. Which field is being edited has a URL too, `?edit=<id>.<field>`, but
once the page has hydrated a click opens the field as component state rather
than navigating to it.

The parameter buys three things. The pen is an ordinary link, so it works
before hydration and with scripting off. It is in the tab order on its own. And
a filtered list keeps its filters through an edit, because the href carries
them. A memory became linkable as a side effect, and the logs pane links every
`memory:`, `todo:` and `skill:` id it shows.

A field mid-edit is the exception because a navigation costs a render of every
row that reads the location, and it used to cost the list's loader as well. On
a forty-row `/todos` in a dev build, click to editor took 87ms through
`?edit=` and takes 5ms as a state flip (`scripts/console-timing.mjs`). An
editor is also the least sendable thing on the page. So the pen keeps its
`?edit=` href for the no-script path and for a link that opens a field, and a
hydrated click flips state instead. Closing a field the URL opened drops
`?edit=` with `replace`, and `shouldRevalidate` skips that change.

The rule generalises: if a person could want to send it to someone, or return
to it after a reload, it is a URL and not a `useState`. If it is only the
no-script path to a transient state, it is an href the click intercepts.

**Held.** `useEditMode`, `EditLink`, `editKey`, `openField` and `editTarget`
in `app/components/editable.tsx`; `logsHref` and `itemHref` in
`app/features/workbench/logs.tsx`. Unfolding a to-do on `/todos` writes `?open=` with
`replace`, and `shouldRevalidate` skips the loader for it, so the list does not
re-read or scroll under the reader (P4). `test/ui/console.spec.ts` opens and
cancels a title with no `/todos.data` request, and edits one with scripting
off through `?edit=` and the redirect. `create_todo` and `fetch` return the
same page as `url`, from `itemPath` in `app/concepts/item-path.ts`, so a model
can answer with a link.

## P4. Nothing moves that you did not move

A mutation must not change the position of the thing it acted on, and must not
change the scroll offset. The sort key of a working list is a property the
person chose, never the timestamp the mutation just wrote.

No to-do app of consequence sorts a working list by last-modified. Todoist
projects show tasks "in the order in which they were added", and Today sorts
date, then priority, then deadline, then manual, then creation time
([default sorting order](https://www.todoist.com/help/articles/default-sorting-order-in-todoist-mqmgerY7)).
GitHub's issues list clears to "Newest", meaning newest *created*
([filtering and searching](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests)).
Linear defaults to manual on boards
([display options](https://linear.app/docs/display-options)). TickTick added a
modified-time sort in September 2025 and left the default on date order
([group and sort](https://help.ticktick.com/articles/7056594711640801280)).
Superlist states the guarantee outright: "Completed tasks will retain their
current position in your list"
([create tasks and subtasks](https://help.superlist.com/en/articles/23853-create-tasks-and-subtasks)).
TickTick says the same for nesting: sorting "will not break the hierarchical
structure of the tasks, but will only compare and sort tasks within the same
level"
([multilevel tasks](https://help.ticktick.com/articles/7055782219767349248)).

Apple states the rule in its strongest form, by deferring the reorder entirely:
on iCloud.com a completed subtask "appears below the active subtasks **the next
time you open the list**"
([mark a reminder completed](https://support.apple.com/guide/icloud/mark-a-reminder-as-completed-or-not-completed-mmc0cd753a/icloud)).
The sort is correct; it is just not applied under the reader's hand.

The scroll half is a stack fact, not a taste. React Router resets scroll to the
top when a navigation completes, and `preventScrollReset` on a `<Form>` is the
documented opt-out
([Form](https://reactrouter.com/api/components/Form)). A POST-redirect-GET that
edits the fortieth row of a list dumps the reader at the first one unless that
prop is set, or unless the write goes through a fetcher and never navigates.

**Held** on `/todos`. `listTodos` orders by `created_at DESC, rowid DESC`,
which no write touches, and every form and link on the page sets
`preventScrollReset`. Before, ticking a sub-task on the eighth card moved it to
first and the window from 1268px to 0. `test/ui/console.spec.ts` now ticks a
sub-task and completes the seventh row of ten and asserts its index and its
offset from the top of the viewport are unchanged. Not `window.scrollY`: the
first completion inserts "Show done (1)" above the list, and the browser's
scroll anchoring raises `scrollY` by that height to hold the row in place. An
open to-do is a pane docked on the right edge (`Modal size="pane"`), opened
with `show()` so the list beside it stays live and the next row opens in its
place. It sits beside the list, not over it: the page gives up the pane's
width, so no row runs under the pane, which is Fluent's inline drawer, "to view
and interact with main content and drawer content at the same time"
([drawer usage](https://fluent2.microsoft.design/components/web/react/core/drawer/usage)).
The narrower rows rewrap, which moved the opened row 28px when the page was
first padded, so `holdRow` in `app/components/modal.tsx` measures the row
before the pane opens or closes and scrolls by what it moved. Opening, closing
and switching rows leave the clicked row at the same viewport offset to the
pixel. Its left edge is the resize grip between the two, drawn as a column
of stitches with nothing extra on hover, an APG window splitter with both bounds
([window splitter](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/)),
between 22rem and 70% of the window, kept per browser in localStorage. A
script in the document head sets that width on the root before the first
paint (`PANE_WIDTH_SCRIPT` in `app/components/modal.tsx`), because the grip's
own effect runs only after hydration and a reload otherwise painted the
default width and moved the divider a frame later. `test/ui/console.spec.ts` opens one, opens the next
from the list behind it, drags and keys the grip, and reloads. Below 48rem the
pane is a bottom sheet at half or full height. Its drawer handle is a button
as well as a drag handle, and focusing a field takes it to full height. Holding a row
tapped in the lower half would leave it under the sheet, so opening scrolls by
the overlap and no further: the row ends on the sheet's edge, and a row already
above it does not move. With scripting off the pane still covers the page.
With the pane open, j and k open the next and previous row in the displayed
order with `replace`, never while a field, editor or unsent comment holds a
draft. `test/ui/todo-journey.spec.ts` checks both sheet heights at 320px and
390px, the scriptless fallback, and the keys.

## P5. A completion changes a row, it does not remove one

Completing is a state change. Either the row stays where it is and reads as
done, or it leaves for a named place with a control on the same screen that
brings it back. Relocating it silently is neither.

The products split on which of the two, and both halves are documented.
Trello's card "does not move or vanish" — the check circle turns green, and
archiving stays a separate manual step
([mark a card as complete](https://support.atlassian.com/trello/docs/mark-a-card-as-complete/)).
Superlist keeps the position and offers a synced, per-list "Hide completed"
toggle
([sort and filter](https://help.superlist.com/en/articles/78871-sort-tasks-in-lists-and-hide-completed-tasks)).
Todoist does make the row disappear — "The task disappears from the list" — but
pairs it with a Display setting that returns completed tasks "at the bottom of
a section's or parent task's active task list", and with uncompleting by
clicking the same circle again
([introduction to tasks](https://www.todoist.com/help/articles/introduction-to-tasks-080OAXric),
[view completed tasks](https://www.todoist.com/help/articles/view-completed-tasks-in-todoist-J19h2s)).
Linear moves it to the bottom, "followed by completed and canceled issues",
and auto-archives much later
([display options](https://linear.app/docs/display-options)). Apple Reminders
hides the row and keeps the count at the top of the list, with Show to reveal
it and Shift-Command-H bound to the toggle
([mark reminders complete](https://support.apple.com/guide/reminders/mark-reminders-complete-or-incomplete-remndbeda47c/mac)).

What none of them do is move it somewhere unannounced and leave the reader to
find it.

**Held.** A completed to-do keeps its row and reads as done, struck through
with the pill. Before, the card went from fourth to thirty-seventh of
thirty-eight, 7296px into a 7924px document.

`/todos` opens without done rows, the owner's call on 2026-11-03: with 307
done to-dos the working list was mostly finished work. "Show done (n)" above
the list (`?done=show`) brings them in, and the same control reads "Hide done
(n)" to take them out again; filters and Clear carry the choice. That is the
named place and the control on the same screen, as Apple Reminders keeps the
count with Show. A row completed while done rows are hidden still stays where
it was, read as done, until the list reopens: `useSections` holds the rows
this page posted as done (`completing`), so the circle that reopens it is
under the pointer (P12). With scripting off the completion is a document post,
and the row leaves for the count beside Show done. `test/ui/todo-pane.spec.ts`.

Blocked rows lead `/todos`. The job is finding the work that waits on a
person: `list_ready` leaves blocked to-dos out, so an agent will not reopen
one, and a blocker buried among forty rows is one nobody clears. By default
the list opens with every blocked row matching its filters first, under a
header naming the count and why they are there, the alert's strap down their
left edge and a wash of `--danger`; the rest follow, newest first. The row says
"blocked" once: it carries no state pill, and its line under the preview,
"Blocked on …" with Unblock beside it, stands in for the status line while
the blocker is the newest entry. The primary
action is Unblock on the row, beside what it is blocked on; the blocker's
history and Block itself are in the pane. There Block and Unblock sit under
the status line at the top, in one place, so the control that reverses
either is where the click was (P12). Block's field covers the lines below it
rather than pushing them (P6). Before, on 2026-11-03, Unblock sat under the
whole history, out of sight on a to-do with a long thread. `listTodos` orders blocked first, so
a thirty-row window holds them before anything else and no extra query or
loading state is added. A row keeps the section it was first shown in until
the list is reopened (`useSections` in `app/features/todos/sections.tsx`):
Block in the pane or Unblock on the row repaints the state in place, as P4 and
P12 require, and a refused write leaves the row as it was. Unblocking can sort
a row past the loaded window; it stays from its last copy, read as pending,
until the list is reopened. A row blocked by an
agent while the page is open appears at the top only on the next load.
The section holds; the colour does not. The strap and the wash follow the
row's state (`.is-blocked`), not its section (`.in-blocked`), so an unblocked
row loses the red on the click's own frame where it stands, and a row blocked
from its pane turns red where it stands. Once nothing in the list is blocked
the header stays, so the rows under it do not move, but leaves the alert's
red and reads "None blocked now", saying the rows sort back in on the next
load. Before, on 2026-11-03, an unblocked row and a "0 blocked" header kept
the full red wash until a reload. `test/ui/todo-blocked.spec.ts`.

## P6. The editor stands in the value's box

Opening an editor must not reflow what is below it. The editor occupies the
space the value occupied; if it needs more, that space was reserved before the
click.

web.dev's reserve-space guidance is the mechanism, including the direction
people forget: "removing the space set aside for elements can cause just as
much CLS as inserting content"
([optimize CLS](https://web.dev/articles/optimize-cls)). The metric will not
catch this for us. Shifts within 500ms of a click or keypress carry
`hadRecentInput` and are excluded from CLS
([CLS](https://web.dev/articles/cls)), so the field data stays clean while the
page jumps. The only standard that applies is the qualitative one on the same
page: a shift is acceptable when it "occurs close enough to the interaction
that the relationship is clear to the user". A row forty cards away moving is
not that.

The Save and Cancel pair stays. Removing it is the obvious reading of "the
page moves", and it is the wrong one. NN/g removed the Save button from a
settings form and measured no reduction in interaction cost, because "most
users assume nothing is really changed until a Save or Apply button is
pressed"; their verdict is that "taking away the Save button reduces users'
control over the interface"
([Don't Prioritize Efficiency Over Expectations](https://www.nngroup.com/articles/efficiency-vs-expectations/),
2015). Atlassian ships the same pair on its inline edit and defends it on
accessibility grounds, not aesthetics: hide the action buttons only where they
obstruct content, and otherwise "keep action buttons for accessibility
purposes"
([inline edit](https://atlassian.design/components/inline-edit/examples)).
Commit-on-blur leaves a keyboard or screen-reader user with no labelled target
to commit with.

So the fix is the geometry, not the buttons.

**Held.** `Editable` keeps the value in the flow, hidden and inert, and lays
the form over its box. A prose field fills that box, with a 10rem floor. Where
the editor needs more than the value had, it covers the lines below it and
does not push them. Reserving that floor under every value was rejected,
because it would put the empty space back on every row the one-column list
just took it out of. Before, at 1280×900, opening the title editor grew the
first card 65px and pushed the document 64px; tags 64px, body 89px, pointers
103px. `test/ui/console.spec.ts` opens each pen on a row and asserts the row's
height and the next row's position move by at most 1px.

## P7. The affordance has the shape of the data

A set gets add and remove. An enum gets a picker. A sentence gets a text field.
Prose gets a pen and a textarea. The pen is for prose, and a comma-separated
string is not a set.

Nobody edits tags as text. Todoist's label picker has a "Type a label" field
that creates on a miss, and the quick-add grammar is `#` project, `%` label,
`+` assignee, `p1`–`p4`, `!` reminder, `{}` deadline
([quick add](https://www.todoist.com/help/articles/use-task-quick-add-in-todoist-va4Lhpzz),
[labels](https://www.todoist.com/help/articles/introduction-to-labels-dSo2eE)).
TickTick uses `#` to "quickly create a new tag or choose from existing tags"
([tags](https://help.ticktick.com/articles/7055782255804809216)). Superlist uses
`#` for labels and `@` for people
([keyboard shortcuts](https://help.superlist.com/en/articles/10059-superlist-keyboard-shortcuts-navigate-and-create-tasks-faster)).
Linear and GitHub both bind `L` to a label picker
([Linear labels](https://linear.app/docs/labels),
[GitHub shortcuts](https://docs.github.com/en/get-started/accessibility/keyboard-shortcuts)).
Trello removes one by clicking the active label in the popover
([labels](https://support.atlassian.com/trello/docs/adding-labels-to-cards/)).
Asana is the plainest on removal: "hover over the tag's name and click the **X**
icon"
([tags](https://help.asana.com/s/article/tags?language=en_US)).

The remove contract is worth copying exactly once. Material 3 is the only
system of eight that writes both halves down. The trailing icon is "required
for input chips" and "must be used to remove the chip"; its interaction target
is 48×48dp; the accessible name is "Remove {chip content}", not a bare
"Remove"; and the chip and its icon are one focusable element when remove is
the only action, two when the chip is also selectable
([chips guidelines](https://m3.material.io/components/chips/guidelines),
[chips accessibility](https://m3.material.io/components/chips/accessibility)).
Carbon's `DismissibleTag` defaults to `aria-label="Dismiss"` with no tag text,
and Atlassian's `removeButtonLabel` example is a bare "Remove"; both are worse
contracts and should not be the model.

Backspace is a two-step delete, not a one-step one. The only documented
behaviour in any of these systems selects the whole chip on the first press and
deletes on the second
([chips guidelines](https://m3.material.io/components/chips/guidelines)). The
"backspace eats the last tag" convention is in the wild and in no spec.

WAI-ARIA has no tag, token, or chip pattern at all — the
[pattern index](https://www.w3.org/WAI/ARIA/apg/patterns/) does not contain the
word. A tag field is composed from combobox plus listbox. So is ours.

**Held.** Tags are a chip row with a named remove and a `+` over `Combobox`
in all three places, `TagInput` in `app/components/tag-input.tsx`, and a
memory's `type` is picked from a list. A to-do's pointers are a row per
pointer with a remove named "Remove pointer {value}"; one is added through
"Add pointer", a modal holding `RefInput` (`app/components/refs-input.tsx`):
a kind `Combobox` and the value (P15). Before, they were `kind value` lines
in a textarea, and a coined kind was silently rewritten to `file`. The filter
bar's tags are a set too, `TagFilter` in `app/components/tag-filter.tsx`: the
same chips inside the box, a repeated `?tag=` each, and a row must carry every
one. Backspace in the empty box selects the last chip, and a second press
removes it.

A to-do named in prose has the shape of a to-do, not of its id. Agents paste
`todo:tdo_…` into bodies, comments and blockers because that is what every MCP
tool returns, and a UUID tells a person nothing. Jira and Confluence draw a
pasted issue key as a link carrying the issue's title and status, and that is
the model. Owner's request of 2026-11-08; the contract:

- Job: see which to-do a body points at, and open it, without copying an id.
- Default view: in Markdown (a body, a sub-task, an update) each id in text,
  or alone in inline code, is a one-line card: the to-do icon, the title, the
  state; done is struck through. A paragraph keeps its line height. In plain
  text (the row preview, the status line, a blocker) the id reads as the
  title, because a row is already a link and cannot hold another (P13).
- Primary action: the card is a link to `/todos?open=…`, the pane in place.
- Disclosed: the full title and state in the tooltip; a long title truncates.
- Failure: an id the reader does not own, or a deleted to-do, is still a card,
  "To-do 1a2b3c4d", and still links; nothing is dropped from the text.
- Loading budget: `/todos` titles every id its loaded bodies, updates and
  blockers name in its loader, one query capped at 100
  (`app/concepts/todo-mentions.ts`), because its row previews need them.
  Everywhere else (a memory's or skill's pane, a to-do opened outside the
  loaded list) `MentionTitles` asks `/todos/mentions` for the ids its page
  did not title, once, after the Markdown is on screen; a page that never
  opens a pane pays nothing. Until the titles land a card names its short id
  at the same height.
- Width: a card never widens its pane. `.prose` has no minimum width, so a
  grid or flex parent narrows the paragraph and the title truncates.
- Evidence: `test/ui/todos.spec.ts`, "a to-do id in a body is a card", "a
  to-do card with a long title fits the pane", and "a memory pane fetches the
  titles".

## P8. An empty value is the control that fills it

"Add a description", "Add tags", "Add a pointer" are the control. They are not
labels sitting beside a control that only appears on hover.

NN/g's third empty-state guideline is to "use empty states to provide direct
pathways for key tasks", with an actionable button in the empty container
([Designing Empty States](https://www.nngroup.com/articles/empty-state-interface-design/),
2021). shadcn's `Empty` component puts the create button inside the empty state
in every documented example
([empty](https://ui.shadcn.com/docs/components/empty)). None of the eight
systems surveyed documents a placeholder row that is itself the create
control, so the nearest written contract to borrow is GOV.UK's task list: "The
whole task row is linked so that users can select anywhere within it"
([task list](https://design-system.service.gov.uk/components/task-list/)),
applied to a row that submits rather than navigates.

Lists use an empty item as their create control: the list's first row,
`AddRow` in `app/components/item-list.tsx`, a stitched row with a plus and the
action named on it ("New to-do", "Add skill", "Add bookmark", "Upload
documents"). The label is always visible. On `/todos` the row turns into the
composer in place. `Editable`'s `addItem` uses an empty card for the extra
hook card in each event grid, and sub-task rows and set-add controls keep the
smaller dashed shape of their data. `test/ui/add-item.spec.ts` checks the rows,
their geometry under hover and focus, and the hook grid.

**Held** on `/todos`. `Editable`'s `empty` prop replaces the value and its
pen with one always-visible link, "Add tags", "Add a description" or "Add a
project", which opens the same editor the pen would; "Add pointer" and "Add
relation" are the same line and open a modal (P15).
`.add-value` is 24px tall and never hidden by hover. Before, `Refs` rendered
`<p className="muted">Add a pointer</p>` beside a hover-only pen, which was
the whole of the "I can edit references but not add them" report.
`test/ui/console.spec.ts` checks each phrase is a visible 24px link under a
fine pointer and that "Add pointer" opens its modal. On the memory
modal an empty tag list is "Add tags" too. **Owed** there for the project,
which still reads "—".

## P9. A vocabulary the endpoint knows is a vocabulary the field offers

Every closed-ish set the MCP surface teaches an agent is offered to the person
typing, as a filtering list with create-on-miss.

We already compute vocabularies. `app/concepts/memory-types.ts` holds
`MEMORY_TYPES` (six) and `app/concepts/todo-contracts.ts` holds `TODO_REF_KINDS`
(five), both documented in the tool descriptions so
an agent writes the right word. `listMemoryTypes` already reads the distinct
types out of D1 with counts, and `/memories` already renders them as a select.
Projects and tags are one `json_each` query away. The agent gets steered; the
person retypes from memory.

Apple goes further than offering the vocabulary: Reminders suggests tags as you
type, drawing them from the Notes app as well as from Reminders, and suggests a
title that "matches a previously completed reminder from the list"
([tag reminders](https://support.apple.com/guide/reminders/tag-reminders-remn45640f4f/mac),
[change settings](https://support.apple.com/guide/reminders/change-reminders-settings-remn4a9a4fe6/mac)).
A console whose whole job is remembering has no excuse for asking twice.

The contract to implement against is the APG editable combobox with list
autocomplete, which is specified down to the key
([combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/),
[autocomplete-list example](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/examples/combobox-autocomplete-list/)).
Two rows get missed: Escape clears the textbox when the list is already closed,
and Left, Right, Home and End return visual focus to the textbox and move the
caret rather than walking the list. `app/components/combobox.tsx` implements
both, and `test/ui/console.spec.ts` walks the four caret keys.

**Held.** Offered, with create-on-miss: `MEMORY_TYPES` plus any drifted type
on a memory's type, and the projects and tags written across all three
concepts (`readVocabulary` in `app/concepts/vocabulary.ts`) on the filter bar,
every tag editor, a memory's and a to-do's project, and the skill publish
form. A pointer's kind offers `TODO_REF_KINDS` with what each one means. The
to-do composer suggests keys, facet values and tags for the word at the caret.
`test/ui/console.spec.ts` picks an offered value in each.

A to-do is offered the same way wherever one is picked. `TodoPicker` in
`app/components/todo-picker.tsx` is a `Combobox` over `/todos/suggest`: the
rows on screen before anything is typed, then every to-do whose title or id
holds the text, open work first, each with its project, state and id. It asks
the server 200ms after the last keystroke, the delay Algolia measures as the
point past which typing feels late
([debouncing](https://www.algolia.com/doc/ui-libraries/autocomplete/guides/debouncing-sources.md)),
and says the count politely (WCAG 4.1.3). Without scripting it is a text box
that takes a pasted `todo:` id. A to-do's relations are one list and one
"Add relation" control opening a modal with the type and then the to-do, the
order Jira and GitHub's Relationships use
([link issues](https://support.atlassian.com/jira-software-cloud/docs/link-issues/),
[issue dependencies](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies)).
The types are `TODO_RELATION_TYPES` in `app/concepts/todo-relations.ts`, so a
new one is an entry there and not a new section. `test/ui/todo-relations.spec.ts`
adds and removes each kind with scripting on and off.

## P10. Reach before polish

Hit areas are at least 24 CSS pixels. Nothing load-bearing hides behind hover.

The numbers, exactly: WCAG 2.2 SC 2.5.8 Target Size (Minimum) is 24×24 CSS
pixels and is **level AA**
([understanding 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)).
SC 2.5.5 Target Size (Enhanced) is 44×44 and is **level AAA**
([understanding 2.5.5](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html)).
AA is the one we meet. A smaller mark still passes through the spacing
exception, which is a measurable test rather than a judgement: a 24px-diameter
circle centred on each undersized target must not intersect another target or
another such circle. That is what sets how tightly checklist rows can stack.

On hover, NN/g is flat. "Don't rely on hover to reveal text labels: not only
does it increase the interaction cost, but it also fails to translate well on
touch devices"
([Icon Usability](https://www.nngroup.com/articles/icon-usability/), 2014), and
"never make users rely on scrubbing the screen with the mouse to determine if a
text is clickable"
([Beyond Blue Links](https://www.nngroup.com/articles/clickable-elements/),
2015). Wroblewski's 2005 case for hover-revealed row actions lists no downside
([Inline Contextual Actions](https://www.lukew.com/ff/246/inline-contextual-actions))
and is superseded in substance by his own touch work
([Responsive Navigation](https://www.lukew.com/ff/entry.asp?1649=), 2012),
though he never retracted it. Read NN/g as current.

The pen is the edge case we accepted: it is always in the markup and in the tab
order, hidden only by opacity so SC 1.4.13 holds, and the hiding is gated
behind `@media (hover: hover) and (pointer: fine)` so a touch screen shows it
outright. That is defensible for a secondary action beside a visible value. It
is not defensible as the only way to add something that is not there yet, which
is P8.

**Held.** `test/ui/console.spec.ts` measures the pen's computed opacity in a
fine-pointer and a coarse-pointer context and asserts every hit area is at
least 24×24 in both. `.check-circle::after` and `.task-box::after` carry the
24px area around marks of 18px and 14px, taking no layout space.

## P11. Progressive enhancement has a second half

Every control is a link or a form button, and works with scripting off. That is
the floor, not the ceiling. The enhanced path is a fetcher that mutates without
navigating, with the next frame painted before the round trip returns.

The three object lists reveal thirty rows at a time. `InfiniteList` observes
the named Load more link, appending a larger prefix without resetting scroll;
without scripting or an observer the link does the same job. `?page=` records
the revealed depth, not a separate page. A mutation re-reads that prefix, so
there are no stale cached pages or duplicate rows to reconcile. Loading pauses
while a dialog, editor URL or mutation is open. Search narrows loaded rows on
the keystroke, then queries the whole store after 250ms; a pending message
never mistakes an unloaded match for an empty result. The query remains in the
URL, and the search input keeps focus. `test/ui/infinite-list.spec.ts` covers
automatic and no-script loading, unloaded details, filters, and live search.

Library uses fixed thirty-row keyset pages, not a growing prefix. Files,
sources and durable file-link choices have independent older/newest links;
SQL applies project/all-tag filters before selecting each window. An edit
preserves the current cursor and creation-time ordering. This also bounds
the server work and rendered cards when a library contains hundreds of
bookmarks: lazy thumbnails alone do not. `test/ui/library-loading.spec.ts`
checks 895 linked sources with scripting on and off, filtered matches outside
the first window, reloads and inline saves on an older page.

The first half is why the console is built the way it is. The second half was
never written, and P4 and P6 are the bill. A full-document POST-redirect-GET
re-runs the list query, re-sorts it, and throws away the scroll offset, so a
decision made for robustness reads as the page losing its place.

INP is the metric that sees this. Good is 200ms or less at the 75th percentile,
over click, tap and keypress only, and "the next frame that the browser will
paint is the earliest opportunity" to show that the interaction registered
([INP](https://web.dev/articles/inp)). On a POST-redirect-GET, INP is measuring
the server round trip unless something paints first.

So: keep the `<Form>`, keep the server action, and add `useFetcher` plus a
pending state above it. The no-script path is unchanged, which is the test of
whether an enhancement is one.

A fetcher save answers with data, not a redirect. The form carries
`via=fetcher` once hydrated, and `afterSave` in `app/console/forms.server.ts`
returns data for it and the redirect for a document post. A redirect would turn
the fetcher into a navigation, dropping `?open=` and running the loader as a
page load.

The optimistic value comes from the submit handler, not from
`fetcher.formData`. React Router renders fetcher state in a transition, and on
a forty-row list in a dev build each state change re-renders every row for
longer than the gap to the next one, so the submitting render never committed
and the old title stayed up for the whole round trip. `usePendingValue` reads
a store the handler writes, which paints on the click's own frame, and
`useLanded` clears it when a new `fetcher.data` has arrived and the fetcher is
idle again.

**Held** for the floor — every mutation on `/todos` and `/memories` is a form
button or a link, and the Playwright suite exercises them, one case with
scripting off. **Held** on `/todos` for the ceiling — every field save, the
circle, Block, Unblock and Add sub-task post through `useFetcher`. Title, body,
project and the row's state paint before the server answers; tags and pointers
are parsed on the server, so their editor holds with "Saving" until the write
lands. Every form sets `preventScrollReset`. **Held** on `/memories` and
`/skills` for field saves, which hold with "Saving". The Skills list and detail
also use a reversible fetcher switch for enabling; a pending switch paints its
requested state without navigating. Memory archive, the Skills bulk change
bar, detail settings, delete/restore, and SKILL.md review/publish also post
through fetchers. Bulk responses carry their full changed/skipped report; the
report follows the working rows so inserting it cannot push them down. The
SKILL.md editor keeps a refused draft and its open/filter URL. Publishing
leaves the editor open with the new version number and a Back to skill link;
only that explicit link navigates. Pending labels paint from submit handlers,
before a delayed response. `test/ui/console.spec.ts` covers the held requests,
bulk row position, preserved URLs, review refusals and document submissions
for review/publish, archive and bulk changes with scripting off.
The to-do pane's checklist and comment also carry `ViaFetcher`, with
`afterSave` responses. A comment clears only after a successful save; a
validation refusal leaves its draft and an inline error. Browser checks cover
both controls with scripting on and off, retaining the pane/filter URL on the
enhanced path. The comment box follows the pen's pattern: its Comment button
shows below the box once the box has focus or holds a draft, Enter sends and
Shift+Enter starts a line. The reveal is CSS (`:focus-within`, a non-empty
box), so with scripting off the button is still the next tab stop and the
form's submit. Before, on 2026-11-03, the button sat beside an empty box at
all times. `test/ui/todo-pane.spec.ts`.

## P12. Reversal beats confirmation, and the reversal is the same control

A destructive-looking action should be undoable rather than guarded. The undo
is the control that did it, in the place it did it, not a timed banner
somewhere else.

Raskin's rule is the starting point — "never use a warning when you mean undo",
because habituation defeats the warning and "we'll probably click 'Okay' this
time too, even if we don't mean to"
([Never Use a Warning When You Mean Undo](https://alistapart.com/article/neveruseawarning/),
2007). NN/g's criteria for when a confirmation is still right are severity,
irreversibility, and frequency, with the warning that "if you cry wolf too many
times, people will stop paying attention"
([Confirmation Dialogs](https://www.nngroup.com/articles/confirmation-dialog/),
2018).

The undo toast is the obvious implementation and we are not building it. A
toast with an Undo button in it is, by Roselli's definition, not a toast: toast
roles "`alert`, `log`, `status`" are not "a fit for rich content nor
interactive children", focus must not move to it, and auto-dismissal after a
few seconds "violates WCAG SC 2.2.1 Timing Adjustable" at level A
([Defining "Toast" Messages](https://adrianroselli.com/2020/01/defining-toast-messages.html)).
Gmail's undo-send is the shape that complies, and it complies by letting the
user pick 5, 10, 20 or 30 seconds in advance
([Gmail help](https://support.google.com/mail/answer/2819488)). That is a lot of
machinery for a console with one user.

The cheaper and better answer is the one Todoist, Trello and Superlist all
reach for: make the action idempotent and reversible by the same control.
Clicking the circle again reopens the to-do. That already works. It stops being
an undo the moment the card moves out of sight, which is P4 and P5 again.

**Held** in the model — `override` is idempotent and reversible, and the
circle toggles both ways. **Held** in the view — the row stays where it was
clicked (P4, P5), so the circle that reopens it is still under the pointer.

## P13. Show, don't tell

The thing is the control. A row opens its item; there is no "Details" or
"View" button beside it. A label names an action only where the object cannot
be clicked to do it.

A button that says "Details" next to a row that could open on a click is a
second, smaller door to the same room. It costs a word on every row and makes
the reader find it. GOV.UK states the rule for task lists: "The whole task row
is linked so that users can select anywhere within it"
([task list](https://design-system.service.gov.uk/components/task-list/)).

**Held.** `ItemRow` stretches its title link over the row
(`.item-title::after`); to-do and library rows do the same, and their own
controls (checkbox, tags, switch, sub-task toggle, Unblock, links) sit above
that cover so each is still its own target. `test/ui/console.spec.ts` opens a
to-do from its summary line, and the library tests open an item from its
title, host line and excerpt.

## P14. History is one line and a table on request

A record's past versions take one line in its pane: how many saved versions
there are and when the last was saved, and the line is the link. It opens a
modal with a table, newest first: version, saved, by, what changed. Selecting
a row shows that version below the table, in the console's own type. Reading
a version changes nothing.

The pane is for the record as it is now. Stacked disclosures of earlier
versions, each with its own heading style, push the current record down and
make the reader open them one by one to compare. A table puts the versions
side by side and answers the questions people bring to a history, which
change came when and from whom, before any text is read. GitHub's file
history works the same way: the list of commits first, a commit's content on
selection.

**Held.** `VersionHistory` in `app/components/version-history.tsx`; memory
revisions and library source versions use it. The modal's URL is the page's
(`?history=` on the library, `?edit=<id>.history` on memories), so it
survives a reload (P3).

## P15. One value adds in place; anything more opens a modal

Adding a single value (a tag, a project, a sub-task line, a description)
happens where the value will sit: an add control that becomes one field and
commits it (P2, P6, P8). Adding something that needs more than one field, a
choice from a searched set, or an explanation (a relation, a link, a pointer
with its kind, an attachment, a comment with files) is one add control that
opens a centred modal holding the form. The pane shows what is there, never
the empty form for what could be.

Every add control in a pane has one shape: a "+ Add …" line in the pane's
text column, the same size and indent, whether it opens a field or a modal.
Every button that commits uses one size. A recovery form that only matters in
a failure state (reconciling an interrupted relation write, ADR-0018) appears
only when that state is present.

**Held** on the to-do, memory and library panes: relations, links, pointers,
file attachments and library attachments open a modal; tags, project,
sub-tasks and description add in place. A to-do or memory shows its files and
one "Add files" line; the picker and drop well live in the modal
(`app/components/attachment-files.tsx`, `?edit=<id>.files`). Files dropped on
the open to-do still attach without opening it. Once hydrated, choosing files
in the modal uploads them at once, as a drop does: the pick is the one commit
(P2), success closes the modal, and a refusal keeps it open with the reason.
The Attach button is the no-script form's submit and shows only there (P11).
**Held** on Subjects: the list comes first, and Create subject is its add row,
opening a modal (`?create=subject`) with name, kind and description. A
subject's details are text that open one editor each in place (P6), not a
form per field. Under them, the summary reads as text with one "Add a
summary" or "Replace summary" line, which opens one modal
(`?edit=summary`) holding both choices: write a new summary, or use an
existing memory. Supporting memories are an item list whose add row opens
the search-and-add modal (`?add=memory`); each row carries one small Remove.
`test/ui/memory-subjects.spec.ts` runs both modals at 1280 and 390 wide and
with scripting off.

## What this rejects

Collected, so a review can cite one line.

- A record-wide edit form. P2.
- Sorting a working list by `updated_at`. P4.
- A mutation that navigates when it could fetch. P4, P11.
- A navigation or a loader call to open or close an editor. P3, P11.
- A completed item that relocates without saying where. P5.
- An editor that pushes down what is below the value it replaced. P6.
- Removing Save and Cancel to stop the page moving. P6.
- A set edited as a comma-separated string. P7.
- An enum edited as free text. P7, P9.
- `aria-label="Remove"` where `Remove {tag}` was available. P7.
- A hover-only pen as the only way to create something. P8, P10.
- A vocabulary the tool description teaches an agent but the field does not
  offer a person. P9.
- A hit area under 24px that fails the spacing test. P10.
- An auto-dismissing toast with a button in it. P12.
- A detail pane that covers the list it was opened from. P4.
- A submit button under a field at the label's gap instead of in a `FieldRow`.
- A "Details" button on a row that could open on a click. P13.
- A centred modal for reading an item. P4, the console's frame.
- Grey, lilac or a dotted line. V2, V1, V4.
- Earlier versions as stacked disclosures in the pane. P14.
- A form for an optional, occasional relation (a link, an attachment) laid out in the pane before it is asked for. P8, P13.

## Sources

Standards and specs.

- [WCAG 2.2 SC 2.5.8 Target Size (Minimum), AA, 24×24](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
- [WCAG 2.2 SC 2.5.5 Target Size (Enhanced), AAA, 44×44](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html)
- [WAI-ARIA APG combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/) and its [editable-with-list-autocomplete example](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/examples/combobox-autocomplete-list/)
- [WAI-ARIA APG listbox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/), [checkbox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/checkbox/), [pattern index](https://www.w3.org/WAI/ARIA/apg/patterns/)
- [CLS, and the 500ms `hadRecentInput` exclusion](https://web.dev/articles/cls) · [optimize CLS](https://web.dev/articles/optimize-cls) · [INP](https://web.dev/articles/inp)
- [React Router `Form` and `preventScrollReset`](https://reactrouter.com/api/components/Form)

Research and critique.

- NN/g: [Noncommand User Interfaces](https://www.nngroup.com/articles/noncommand/) · [Data Tables](https://www.nngroup.com/articles/data-tables/) · [Modes in User Interfaces](https://www.nngroup.com/articles/modes/) · [Confirmation Dialogs](https://www.nngroup.com/articles/confirmation-dialog/) · [Don't Prioritize Efficiency Over Expectations](https://www.nngroup.com/articles/efficiency-vs-expectations/) · [Icon Usability](https://www.nngroup.com/articles/icon-usability/) · [Beyond Blue Links](https://www.nngroup.com/articles/clickable-elements/) · [Designing Empty States](https://www.nngroup.com/articles/empty-state-interface-design/) · [Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/)
- Wroblewski: [Inline Contextual Actions](https://www.lukew.com/ff/246/inline-contextual-actions) (2005, superseded) · [Web Application Form Layout](https://www.lukew.com/ff/144/web-application-form-layout) · [Responsive Navigation](https://www.lukew.com/ff/entry.asp?1649=)
- [Raskin, Never Use a Warning When You Mean Undo](https://alistapart.com/article/neveruseawarning/)
- [Roselli, Defining "Toast" Messages](https://adrianroselli.com/2020/01/defining-toast-messages.html)

Design systems.

- [Material 3 chips guidelines](https://m3.material.io/components/chips/guidelines) · [chips accessibility](https://m3.material.io/components/chips/accessibility) · [checkbox accessibility](https://m3.material.io/components/checkbox/accessibility) · [icon buttons accessibility](https://m3.material.io/components/icon-buttons/accessibility)
- [Atlassian inline edit](https://atlassian.design/components/inline-edit/examples) · [tag](https://atlassian.design/components/tag/usage) · [empty state](https://atlassian.design/components/empty-state/usage)
- [Carbon tag](https://carbondesignsystem.com/components/tag/usage/) · [empty states pattern](https://carbondesignsystem.com/patterns/empty-states-pattern/)
- [GOV.UK task list](https://design-system.service.gov.uk/components/task-list/) · [tag](https://design-system.service.gov.uk/components/tag/)
- [shadcn/ui combobox](https://ui.shadcn.com/docs/components/combobox) · [empty](https://ui.shadcn.com/docs/components/empty)
- [Radix Primitives](https://www.radix-ui.com/primitives/docs/overview/introduction) ships no combobox, no chip, no multi-select. [Flowbite](https://flowbite.com/docs/components/badge/) ships dismissible badges and no tag input.

Products, for what they actually document.

- Todoist: [introduction to tasks](https://www.todoist.com/help/articles/introduction-to-tasks-080OAXric) · [view completed tasks](https://www.todoist.com/help/articles/view-completed-tasks-in-todoist-J19h2s) · [default sorting order](https://www.todoist.com/help/articles/default-sorting-order-in-todoist-mqmgerY7) · [quick add](https://www.todoist.com/help/articles/use-task-quick-add-in-todoist-va4Lhpzz) · [labels](https://www.todoist.com/help/articles/introduction-to-labels-dSo2eE)
- Superlist: [create tasks and subtasks](https://help.superlist.com/en/articles/23853-create-tasks-and-subtasks) · [sort and hide completed](https://help.superlist.com/en/articles/78871-sort-tasks-in-lists-and-hide-completed-tasks)
- Trello: [mark a card as complete](https://support.atlassian.com/trello/docs/mark-a-card-as-complete/) · [labels](https://support.atlassian.com/trello/docs/adding-labels-to-cards/) · [checklists](https://support.atlassian.com/trello/docs/adding-checklists-to-cards/) · [undo](https://support.atlassian.com/trello/docs/undoing-an-action-in-trello/)
- Linear: [display options](https://linear.app/docs/display-options) · [parent and sub-issues](https://linear.app/docs/parent-and-sub-issues) · [labels](https://linear.app/docs/labels) · [undo](https://linear.app/changelog/undo-actions)
- TickTick: [multilevel tasks](https://help.ticktick.com/articles/7055782219767349248) · [group and sort](https://help.ticktick.com/articles/7056594711640801280) · [tags](https://help.ticktick.com/articles/7055782255804809216)
- GitHub: [filtering and searching](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests) · [adding sub-issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues) · [keyboard shortcuts](https://docs.github.com/en/get-started/accessibility/keyboard-shortcuts)
- Notion: [keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts) · [database properties](https://www.notion.com/help/database-properties) · [views, filters and sorts](https://www.notion.com/help/views-filters-and-sorts)
- Asana: [tags](https://help.asana.com/s/article/tags?language=en_US) · [subtasks](https://help.asana.com/s/article/subtasks?language=en_US) · [list view](https://help.asana.com/s/article/list-view?language=en_US)
- Apple Reminders: [mark complete or incomplete](https://support.apple.com/guide/reminders/mark-reminders-complete-or-incomplete-remndbeda47c/mac) · [sort reminders in lists](https://support.apple.com/guide/reminders/sort-reminders-in-lists-remn922d0b42/mac) · [tag reminders](https://support.apple.com/guide/reminders/tag-reminders-remn45640f4f/mac) · [completed on iCloud.com](https://support.apple.com/guide/icloud/mark-a-reminder-as-completed-or-not-completed-mmc0cd753a/icloud)
