# Working in this repo

Valise is one Cloudflare Worker serving skills, memories, and to-dos to any MCP
client. Read this before touching anything.

## Where the truth lives

| Question | File |
|---|---|
| What is v1 supposed to do? | `docs/specs/2026-10-12-valise-v1-spec.md` |
| Why is it shaped this way? | `docs/adr/` |
| Why does the console look and behave like this? | `docs/design/principles.md` |
| What decisions do we still owe? | `docs/adr/README.md`, "Open questions" |
| What can I pick up right now? | the running instance — `list_ready` over MCP, or `/todos` |
| What did v1 cost, slice by slice? | `docs/plans/2026-10-12-valise-v1-implementation.md` |
| Do the tool descriptions work? | `evals/README.md` |

Valise is the queue, and it is the only one. A to-do in the running instance is
what an agent claims, with a lease and a fencing token, so two sessions cannot
take the same work. It answers what is claimable now and who holds it. This
repo tracks its own work in its own product on purpose; a Valise that cannot
hold Valise's to-dos is a product problem, not a process shortcut. A second
list is the thing to avoid. Do not open one. ADR-0010.

Anything another session could pick up, or that has to survive this one, is a
to-do: `project` is `valise`, and a `doc`, `file` or `issue` ref says where the
work is. A typo fix needs no ceremony.

The v1 plan is a record, not a checklist. Its boxes are frozen at the state
they had when ADR-0010 landed, because they are the evidence trail for what
each slice touched and what proved it. Read it for history. Never tick a box in
it, and never add one.

## The loop

1. `git fetch origin main` before starting work. Create a new branch or worktree
   from the fetched `origin/main`; on an existing branch, check whether it is
   behind and bring it current before editing. A local `main` or an old worktree
   is not evidence of the remote's state. Check again before opening the PR.
2. `list_ready` and claim what you are taking, so a parallel session cannot
   take it too. If you work in a worktree, add a `worktree` ref with its
   absolute path in the same session, so the queue says where the edits are.
3. Read what the to-do points at, start to finish, before editing.
4. Build it. `update_todo` as the evidence appears, so the queue says where the
   work actually is rather than that someone took it.
5. While working, run `npm run verify:ci` plus only the Playwright specs your
   change touches (`npx playwright test test/ui/<spec>.spec.ts`).
6. Open the PR ready, never draft. Then rebase onto `origin/main`, run the full
   `npm run verify` once on that head, and record the result on the PR. Merge
   it yourself with `gh pr merge --squash --delete-branch`. If `main` moved
   while the gate ran, rebase again and merge without running it again,
   unless the rebase conflicted or the new commits change files your PR
   changes: then the code you would merge is new, so run the gate once more.
   Then observe production, step 7. Owner decision of 2026-11-08: other
   sessions merge about as often as a full verify takes (six minutes), so
   requiring the branch to be current when the gate finishes never ended.
   GitHub's `CI` check runs `npm run verify:ci` only, never Playwright, so it
   does not replace this gate. No `--auto`: no branch protection enforces the
   gate.
7. Observe production. Confirm the Workers Build for the merge commit
   succeeded, that the live version's `main@<sha>` contains your merge (a
   later merge's build may be the one that deploys it), and that
   `./scripts/smoke.sh https://app.valise.run` passes. If the merged `main`
   breaks something your gate did not see, fix it forward or revert in a new
   PR.
8. Complete the to-do once the PR has merged and production serves it, not
   when the branch is pushed. A to-do closed on a push leaves the queue lying
   while the work is still in review.
9. Remove your worktree with `git worktree remove <path>` once the PR has
   merged. The branch ref can stay.

A merge to `main` is a production deploy. If one turns out wrong, revert it
with `git revert` in a new PR rather than rewriting `main`.

`.github/workflows/ci.yml` runs `npm run verify:ci` on every pull request and
on `main`. It was off from 2026-10-20 until the move to the public
`getvalise/valise` repository on 2026-11-23, while Actions billing on the
earlier private repository was unavailable; a public repository runs Actions
without it. A red check is a real failure: record it as a blocker. Branch
protection is not configured, so the pre-merge gate is the recorded local
`npm run verify`, including Playwright, which CI does not run.

Cloudflare Workers Builds deploys, and that is where the enforcement actually
lives. It watches `main` and runs:

```
build:   npm run verify:ci && npm run build
deploy:  ./scripts/deploy.sh
```

A failing `verify:ci` fails the build, so a broken `main` leaves production
stale rather than breaking it. `verify:ci` is `verify` minus `test:ui`, because
the browser install needs root in the build container. Its name does not mean
GitHub Actions is required. Keep `verify:ci` a strict subset, so a green local
`verify` never hides a red build. After merging, confirm the Workers Build and
deployment succeeded; a merge alone is not evidence that production is current.

Builds run concurrently, one per merge, and the last to finish deploys. On
2026-11-01 the build for #277 finished after the one for #278 and put
production back a commit. `scripts/deploy.sh` asks `scripts/deploy-head.mjs`
first: a build whose `WORKERS_CI_COMMIT_SHA` is no longer the branch head
(`git ls-remote origin refs/heads/main`) skips migrations and the deploy and
succeeds with `deploy: superseded, nothing deployed`, leaving the newer
build to deploy. A build that cannot read the branch head fails with `branch
head unreachable` and migrates and deploys nothing; production stays on the
commit it serves until a build can read it. Both are the owner's decisions of
2026-11-03, ADR-0008.

Every deploy records its commit as the version message, `main@<sha>`. To
confirm production serves a merge, read the live version and compare:

```sh
npx wrangler deployments status --json            # versions[].version_id at 100%
npx wrangler versions view <version_id> --json    # annotations["workers/message"]
git rev-parse origin/main                         # the sha that message should name
```

A live version with no `main@` message predates the check or was deployed by
hand.

Production is whatever is on `main`. Never deploy from a laptop; a hand-run
`wrangler deploy` is how production last drifted four hours behind the tree.

Staging is a separate Worker, `valise-staging`, restored from a production
backup and configured by `wrangler.staging.jsonc`. It deploys from the
`staging` branch and holds real data. `docs/operations/staging.md`.

Agents may read production and may not write to it. `scripts/prod-read.mjs`
runs one `SELECT` or `WITH` statement on the production D1 and refuses
anything else before wrangler runs; `.claude/settings.json` allows it, so it
needs no prompt. A raw `wrangler d1 execute --remote --command` runs every
statement in its string, so it stays behind a prompt.

`scripts/smoke.sh` checks a deployed origin rather than a build: health, the
stylesheet, and that MCP answers 401 rather than 404. It takes an origin
argument, so it also works for poking production by hand.

`scripts/deploy.sh` applies pending migrations before it deploys, so a merge
carries its schema with it. Only additive ones: a migration that drops,
renames, or rewrites declares itself with a `-- valise:by-hand` line naming
what it does, and then the build stops rather than applying it, leaving
production on the code it already serves until a person runs
`npm run db:migrate:prod`. `npm run db:audit` classifies every file the same
way offline and runs inside `verify`, so an undeclared drop fails the pull
request rather than the deploy. Dropping a column stays a decision; adding one
stopped being an errand. ADR-0008.

## Worktrees

Where worktrees live is up to whoever runs them; the repo does not pick a
directory. Set `VALISE_WORKTREE_ROOT` to the one you keep them in, and
`npm run worktrees` flags any worktree elsewhere as `OUTSIDE ROOT`.

`npm run worktrees` lists every worktree of the repo: branch, dirty files,
commits ahead of and behind `origin/main`, PR state, last commit age, and
the `OUTSIDE ROOT` flag when a root is set. `npm run worktrees -- --size`
adds `du`, which is slow. Run `git fetch origin` first; the counts use the local ref.

`node scripts/worktrees.mjs prune --dry-run` names what prune would remove: a
clean worktree whose PR merged or closed, or whose branch has had no commit for
7 days and has no open PR. It never removes the main checkout, a worktree with
uncommitted or untracked files, one some process has as its working directory
(`lsof`), or anything when `gh` or `lsof` cannot answer. Branch refs stay
unless `--delete-merged-branches` is passed, which deletes only branches whose
PR merged.

## Commands

```sh
npm install                      # also regenerates worker-configuration.d.ts
npm run db:migrate               # apply drizzle/ into the local D1
npm run db:audit                 # which migrations the deploy may apply alone
npm run dev                      # .dev.vars, migrations, seed, then :5173 or the next free port
npm run dev -- --tailnet         # also serve it on this machine's Tailscale name
npm run seed                     # one skill, one memory, one to-do
node scripts/reindex.mjs --all   # rebuild the projection and the FTS index
npm run test:d1                  # schema and projection tests on a real D1
npm run verify                   # everything above that gates a push
npm run verify:ci                # the same minus test:ui, what the build runs
./scripts/smoke.sh [origin]      # check a deployed origin, not a build
node scripts/prod-read.mjs "SELECT ..."   # one read-only query on production D1
npm run evals                    # tool-choice evals across models
npm run shots                    # screenshot every console route
npm run shots:extension          # screenshot the extension popup and an archive
npm run oauth:roundtrip          # one consent, then a call per scope family
npm run worktrees                # every worktree: dirt, PR, age, location
node scripts/worktrees.mjs prune --dry-run   # what prune would remove
```

`npm run verify` needs nothing running. It takes a machine-wide lock first,
`~/.valise/verify.lock` (`VALISE_VERIFY_LOCK_DIR` moves it), so only one full
verify runs at a time across every worktree; a second one prints who holds the
lock and waits. Parallel full runs pushed an 8-core Mac past a load of 40 and
timed out UI specs on load they made themselves. A holder whose process is
gone is cleared by the next caller. `verify:ci` takes no lock, so agents run it
side by side and the Workers Build is unaffected. A full verify took 5.7
minutes on 2026-11-05 at a load of 7 to 10: `verify:ci` 3.7, Playwright 2.0
(266 tests). `verify:ci` runs lint, typecheck and the migration audit at
once, then the d1 and mcp suites at once, then the clients suite on its own:
its recovery drills have a 360 s limit to allow for slow local Wrangler commands
on the two-vCPU build machine. Each Wrangler command still has its own 300 s
limit. The Playwright suite builds the
Worker once, then gives each worker its own `wrangler dev` on that build, with
a free port and its own store under `.wrangler/ui-test/`. A fixture that
needs rows the console cannot make writes that worker's D1 file in-process
through `test/ui/fixtures/local-d1.mjs`; a `wrangler d1 execute` per step cost
about 2 s and a fresh workerd each. Workers default to
half the cores; `VALISE_TEST_WORKERS` overrides that. There are no test ports
to hand out, and `VALISE_TEST_PORT` only pins them by hand. Every page a test
opens is already signed in; a test that needs the sign-in form uses
`test.use({ storageState: signedOut })` from `test/ui/fixtures/session.ts`.

The levers past `verify` need `npm run dev` running in another terminal.
`evals` also needs `OPENROUTER_API_KEY`, or the `claude` CLI logged in for
`--harness claude`.

## Rules the schema cannot enforce

Each of these is a review blocker, because nothing in the database will catch
it for you.

- **A user-facing feature needs an interaction contract, not just a schema.**
  Before implementing its screen, record the user job, default populated view,
  primary action, disclosed secondary details, failure states, bounded loading
  budget and evidence boundary in the owning ADR or design doc. Test those
  jobs with realistic volume and metadata variants, not only the current DOM.
  Before a ready PR, walk through representative non-private content at desktop
  and mobile widths; retain the default-view and primary-action evidence.
  Report data integrity, retrieval, browser usability and production observation
  separately. A green suite is necessary, not proof that the assembled product
  makes sense. `docs/retros/2026-10-24-library.md` is the concrete failure this
  rule prevents; no private-content provider probe is implied by a walkthrough.

- **Every write that changes searchable content pairs with its projection
  statement in one `db.batch`.** Use `projectionStatement()` from
  `app/search/write.ts`. A write path that updates an authoritative row without
  it leaves the ranking stale and silently wrong. ADR-0001.
- **To-do state transitions go through the coordinator Durable Object.** Treat
  any `UPDATE todos SET state` outside `app/do/` as a bug. ADR-0002.
- **Two migrations have a hand-written tail.** drizzle-kit generates
  ordinary tables only. `drizzle/0000_init.sql` holds the retired
  `search_index` projection's `search_fts`, triggers and vocabulary;
  `drizzle/0023_search_docs.sql` holds the live `search_docs_fts`, its three
  triggers, `search_docs_vocab`, and the triggers that forward stray writes
  to `search_index` into `search_docs`. Both sit below a marker comment, and
  regenerating either file drops them. Later migrations are new files; neither
  is edited again. App code reads and writes `search_docs` only (ADR-0015,
  amendment of 2026-10-21).
- **`skill_versions` and `memory_revisions` are append-only.** Rows are never
  updated and never deleted.
- **Every MCP path records its call.** A new transport, or an early return
  added before `dispatch` in `workers/mcp.ts`, has to go through
  `observeCall()` from `app/mcp/observe.ts`. A path that skips it answers
  correctly and leaves no row, so the logs tab under-reports and nothing fails.
  ADR-0006.
- **Backups name the authoritative tables.** D1 cannot export an FTS5 virtual
  table, so an unflagged `d1 export` fails by design. A new table goes into
  `TABLES` or `OMITTED` in `scripts/recovery-policy.mjs`, or the daily backup
  Workflow and `scripts/backup.mjs` both refuse to run. Recovery is
  `scripts/backup.mjs` and `docs/operations/backup-recovery.md`: independent
  original bytes, fresh namespaces, credential/lease invalidation and an
  application-code search rebuild. `scripts/restore.sh` is SQL-only. ADR-0019.
- **Choose a Workers AI model from `npx wrangler ai models list`, never by
  copying an existing constant.** `app/concepts/summary-model.ts` records
  the date its choice was read.
- **Tool descriptions are a product surface.** A description is the only
  discovery mechanism a client without SEP-2640 has, so a change to one is
  recorded as an amendment to ADR-0003 saying what changed and why. It does
  not need `npm run evals` to merge: evals cost paid API calls and hours, and
  run only when the owner asks or to investigate a tool-choice regression that
  `mcp_calls` shows. Owner decision of 2026-11-15.
- **Group tools by what the user wants to do, not by API call.** A model
  picks worse as the tool list grows, and every definition costs tokens on
  every turn. Steps of one protocol stay behind one tool or an HTTP exchange,
  as `upload_asset` does with its PUT. A new tool needs a user intent no
  existing tool or argument serves. ADR-0003.
- **`styles/valise.css` is the only stylesheet source.** Tailwind compiles it
  to the generated `public/valise.css`, still the single static `/valise.css`
  asset linked by the console and plain-HTML OAuth page. Do not edit the output
  or add a bundled second stylesheet. Components are shadcn/ui, copied into
  `app/components/ui/` and themed by the roles in the source (ADR-0020); add one
  with the shadcn CLI, never a second component library. Lists use the shared
  parts in `app/components/item-list.tsx` and `list-toolbar.tsx`; page
  hierarchy uses `app/components/ui.tsx`. Colours live only in the source
  tokens; `/workbench` is where a token change is reviewed.
- **The design language is Swiss over luggage, and it has rules.**
  `docs/design/principles.md` is the whole of it: the visual language in one
  section, the interaction half in fifteen numbered principles, each with the
  source that settles it and whether the console currently holds it. Read it
  before changing anything a person looks at, and cite the number in review.
  `/workbench?tab=components` renders that file above the specimens and tags
  each specimen with the principle it carries, so the file and the page cannot
  drift.

## Writing

Documents here state the mechanism, the number, or the command. No throat
clearing, no wrap-up paragraphs, no bold inline-header lists. An ADR that gets
amended records the amendment in the ADR, not in a commit message. A decision
not yet forced goes under "Open questions" with what forces it and what keeps it
open, so work shipped today cannot answer it by accident.
