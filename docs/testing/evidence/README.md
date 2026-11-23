# Journey evidence

One directory per journey in [user-journeys.md](../user-journeys.md), and
under it one directory per origin: `local` for a run against a local build,
or the deployed host, such as `app.valise.run`. Each holds the screenshots a
run took, named `<step>-<width>.png`, and `run.json`: the runner commit, the
origin, every step with its outcome and detail, the synthetic fixture IDs it
created and what it cleaned up. A later run overwrites the files, so the
committed copy is the last run someone chose to keep.

The specs are `test/journeys/*.journey.ts`. They sign in as a non-admin member
through `/login`, mint bearer tokens on `/connections` and drive real MCP SDK
clients with them. They are not part of `npm run verify`.

```sh
# Local: builds the Worker, seeds two member tenants, starts one server.
npx playwright test -c test/journeys

# Deployed: needs a synthetic member's credentials. Member B is optional;
# steps that need a second tenant record that they did not run.
JOURNEY_ORIGIN=https://app.valise.run \
JOURNEY_A_EMAIL=… JOURNEY_A_PASSWORD=… \
npx playwright test -c test/journeys 'journeys/j3-tasks\.journey'
```

Run one journey per invocation, and match it by file, such as
`'journeys/j8-skills\.journey'`: the journeys share member A, and with it
one MCP rate limit, so a second journey in the same minute can be refused
with `rate_limited`. A bare `j8` also matches a worktree path.

A deployed run writes synthetic rows into the member's own tenant, in a
project named `journey-<journey>-<run>`, and revokes the bearer tokens it
minted. Run it only as an account the owner approved for synthetic content.
