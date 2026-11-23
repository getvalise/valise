# Contributing

Pull requests are welcome. By opening one you agree that your contribution is
licensed under the same terms as the files it changes: [AGPL-3.0-only](LICENSE)
for the server, Apache-2.0 for packages under `clients/`. There is no
contributor license agreement and no sign-off line; you keep the copyright in
what you write.

## Before you start

Open an issue for anything larger than a fix, so the approach is settled before
you write it. The maintainer tracks planned work in a private Valise instance
([ADR-0010](docs/adr/0010-valise-is-the-only-queue.md)); you do not need access to
it. A `todo:tdo_…` id or an `app.valise.run/todos` link in the docs points
into that queue; the surrounding text says what the work was.

Read [AGENTS.md](AGENTS.md) before changing code. Its "Rules the schema cannot
enforce" section lists what review blocks on, and it applies to people as much
as to agents. Anything a person looks at follows
[the design principles](docs/design/principles.md); cite the principle number
in the pull request.

## Set up

Node 22 or later. No Cloudflare account is needed for local work.

```sh
npm install
npm run dev                      # console and MCP on http://localhost:5173
```

The first `npm run dev` on a machine writes `~/.valise/dev.vars` from
`.dev.vars.example`. Every worktree without a `.dev.vars` gets a copy of that
file, so every branch takes the same sign-in: the admin password is
`valise-local-dev-password` until you edit it there. Each start applies the
local migrations, and a new store gets the seed from `npm run seed`: one skill,
one memory and one to-do. Extend `app/search/seed.ts` when a page needs more to
show. The dev server takes 5173, or the next free port.

`npm run dev -- --tailnet` also serves the dev server on this machine's
Tailscale name, `https://<machine>.<tailnet>.ts.net:<port>`, so a phone or
another laptop on the tailnet can open the branch. Ctrl-C removes the route.
The `/__dev/*` routes stay loopback-only.

## Check your change

```sh
npm run verify
```

This runs lint, typecheck, the migration audit, the D1, MCP and client test
suites, and the Playwright browser suite. It takes a few minutes and needs
nothing running. Install Playwright's browser once with
`npx playwright install chromium`.

A pull request that changes a tool description records the change as an
amendment to [ADR-0003](docs/adr/0003-mcp-tool-surface.md). It does not need
`npm run evals`, which calls paid model APIs; the owner asks for a run when a
measurement is wanted.

## Open the pull request

Fill in the template. Record the commit you ran `npm run verify` on and its
result. A schema change is a new file under `drizzle/`; a migration that drops,
renames or rewrites data declares itself with a `-- valise:by-hand` line
([ADR-0008](docs/adr/0008-migrations-in-the-deploy.md)).

A merge to `main` deploys the hosted instance at `app.valise.run`, so the
maintainer merges.
