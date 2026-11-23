# Console route boundaries

Routes own the page shell, list composition and URL state. Shared controls
stay in `app/components`: `Editable`, `ViaFetcher`, `useLanded`, filters,
dialogs, tags, file trees and page blocks are not feature-local copies.

| Surface | Rendering | Server orchestration |
|---|---|---|
| Skills | `app/routes/skills.tsx` composes `app/features/skills/`: import preview, editor/diff, detail/version history and bulk changes/reports | `app/console/skills.server.ts` owns loader and action; concepts still own writes and projections |
| Memories | `app/routes/memories.tsx` owns All memories / Review URL sections; `app/features/memories/list.tsx` composes `detail.tsx` for fields, revisions, links, files and archive; `review.tsx` owns draft settings and evidence cards | `app/console/memories.server.ts` owns memory loader/action; `app/console/memory-review.server.ts` owns review loader/action |
| Workbench | `app/routes/workbench.tsx` owns tabs and evals; `app/features/workbench/components.tsx` owns principles/specimens; `app/features/workbench/logs.tsx` owns logs, call pane, keyboard navigation and log URLs | Owner-only loader stays in the route |
| To-dos | `app/routes/todos.tsx` composes `app/features/todos/`: list controls/composer, card controller, row, docked detail pane and progress thread | `app/console/todos.server.ts` owns loader and action; coordinator transitions and content writes keep their existing boundaries |

Skills view types derive from the server loader through type-only imports.
Feature modules must not import a server module at runtime. No concept-store
or tenant-store boundary moves with a view extraction.

The to-do card owns the state/checklist fetchers, optimistic fields, sub-task
disclosure and attachment-drop queue above both views. `row.tsx` and
`detail.tsx` add no DOM wrappers. `progress-thread.tsx` owns history order and
the comment form's pending/error/draft lifecycle. `urls.ts` keeps the shared
URL builders and revalidation rule: open/edit/history changes do not reload
the list (P3, P4). Forms retain their shared controls and no-script paths
(P11); this extraction does not change their behavior or styling.

Relation integration uses those same boundaries: loader enrichment and
relation action dispatch in `todos.server.ts`, state refusal receipts in the
card controller, and `TodoRelationSection` after attachments in `detail.tsx`.
The route passes loaded relation options; the existing relation component owns
its forms and replies. The pane and orchestration stay out of the route.

The first tenant-store adoption binds memory orchestration inside
`app/console/memories.server.ts` through `ConsoleActor.store`. The route dispatches
its memory/review loaders and actions and composes the features; the memory adapter keeps
P11's fetcher receipts, archive error data and document-form redirects. Other
console server adapters retain their existing owner-scoped concept access
until `todo:tdo_122440ac-1cc0-4073-8ae8-bf543435943c` adopts them separately.

P1: review is an action on Memories, not another workspace noun. P3: the Review
section is `/memories?tab=review`, with its selected review, editor and list
depth in the query. P10: shared `SubNav` links remain named,
keyboard-reachable targets on narrow screens and without scripts.

P3: routes keep open/filter state in URLs. Transient pending state belongs to
the feature that submitted it. P4: a report goes after the working list, not
above the row it describes. P11: hydrated forms carry `ViaFetcher`; actions
return data through `afterSave` or a feature report. Document forms omit the
marker and keep their existing redirect/report behavior. SKILL.md publish
does not navigate to close the editor; the reader chooses Back to skill.

`test/ui/console.spec.ts` exercises these boundaries through the real routes,
including the workbench specimens/log pane and no-script mutations.
