# Valise

One MCP endpoint that carries your skills, memories, and to-dos between models and agents.

People who work with several models at once (Claude on the phone, ChatGPT on the web, a handful of coding agents in parallel on the desktop) end up with each one keeping its own skills, its own memory and its own task list on its own machine. Valise is the case you carry between them: one authenticated endpoint on your own Cloudflare account that every client connects to over MCP.

## What it holds

- **To-dos.** Tickets any agent can claim atomically, with a lease and a fencing token, then update with progress and close. Parent and dependency links decide what is ready. A client's own task list keeps the small steps; Valise holds the work that has to survive a session or be visible to another agent.
- **Skills.** One version of record, served three ways: as SEP-2640 `skill://` resources for clients that speak the extension, as one MCP tool per skill for clients that do not, and through `list_skills` and `get_skill`. Skills can be imported from a Git repository and follow it upstream.
- **Memories.** Typed (decision, insight, fact, preference, reference, episode), grouped into subjects, written by agents through capture tools and reviewed by you in the console.
- **Library.** Original files and saved sources (bookmarks, PDFs, books, page snapshots from the Chrome extension) with their extracted text.
- **Transcripts.** Conversations from Claude Code, Codex and OpenCode, sent by the `valise` CLI.
- **One search** across all of it: BM25 over a single projection, exposed as the `search` and `fetch` pair ChatGPT expects and as typed tools everywhere else.

The browser console at `/` manages all of the above, plus tokens, OAuth grants, people and invites.

## Run your own

Valise runs on Cloudflare Workers with D1, R2, KV, Durable Objects and Workflows. [Self-host setup](docs/operations/self-hosting.md) walks a fork from an empty Cloudflare account to a deployed instance: `scripts/first-deploy.sh` asks for an app name, creates the D1, R2 and KV resources and writes `wrangler.self-host.jsonc`. Reranking is optional: lexical search needs no inference key, `clef` reranks on Workers AI, and `jev` uses a TypeSafe key.

Deploy from your fork's `main` through Cloudflare Workers Builds rather than from a laptop. Migrations that only add things apply on deploy; anything that drops or rewrites waits for a person ([ADR-0008](docs/adr/0008-migrations-in-the-deploy.md)).

### Sign in with Google

An administrator password always works. Google sign-in turns on once `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` hold real values, and it is the only way invited members sign in. `VALISE_ADMIN_EMAILS` lists the admins: the first listed address reaches the owner's account, and each other one gets its own account with the same admin pages. Anyone else needs an invite from `/people` ([ADR-0016](docs/adr/0016-multi-user-accounts-and-invites.md)).

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project, configure the consent screen (audience **External**; `openid` and `email` need no verification), and create an OAuth client of type **Web application** with the redirect URIs `https://<your-host>/auth/google/callback` and `http://localhost:5173/auth/google/callback`.
2. Store the values as Worker secrets, several admin emails separated by commas:

   ```sh
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put VALISE_ADMIN_EMAILS
   ```

3. For local development, put the same three values in `.dev.vars`. Set `GOOGLE_CLIENT_ID` to `none` to keep Google sign-in off.

### Backups

A daily Workflow inside the Worker writes authoritative D1 rows and R2 originals to a separate R2 bucket ([ADR-0019](docs/adr/0019-scheduled-backups-in-cloudflare.md)). `scripts/backup.mjs` captures and restores the same set from outside Cloudflare:

```sh
node scripts/backup.mjs capture /secure/valise-backups --config wrangler.self-host.jsonc --remote --keep 14
node scripts/backup.mjs status /secure/valise-backups --max-age-hours 26
```

[Backup and recovery](docs/operations/backup-recovery.md) covers restore, the search rebuild and the local restore drill. The library has its own export with originals: [library export](docs/operations/library-export.md).

## Connect a client

Every client connects to `https://<your-host>/mcp`. The endpoint does dynamic client registration with S256 PKCE, and one consent grants every scope.

```sh
claude mcp add --transport http valise https://<your-host>/mcp
codex mcp add valise --url https://<your-host>/mcp --oauth-client-registration CIMD
```

In Claude web, add the URL as a custom connector; it then syncs to mobile. In ChatGPT web, open **Plugins**, choose **Add custom MCP server**, enter the same URL and complete the consent screen. ChatGPT cannot reach `localhost`.

- [`clients/valise/`](clients/valise/README.md) is one plugin for Claude Code and Codex: the connector plus hooks that nudge memory capture and recall.
- [`clients/valise-cli/`](clients/valise-cli/README.md) is the `valise` command: it signs in over a loopback OAuth client and sends local Claude Code, Codex and OpenCode sessions as transcripts ([ADR-0022](docs/adr/0022-transcripts-concept-and-cli-grant.md)).
- [`clients/chrome-extension/`](docs/operations/chrome-capture.md) saves the active tab into the Library as an HTML snapshot and a linked source, with an OAuth grant limited to that.

## Develop locally

Node 22 or later. No Cloudflare account is needed.

```sh
npm install
npm run dev        # console and MCP on http://localhost:5173
npm run verify     # lint, typecheck, migration audit, D1, MCP and client suites, Playwright
```

The first `npm run dev` writes `.dev.vars`, applies the local migrations and seeds one skill, one memory and one to-do. Sign in at `http://localhost:5173/login` with `VALISE_ADMIN_PASSWORD` from `.dev.vars`. `/workbench` shows every UI primitive in every state next to the design principle it keeps.

Call the local MCP endpoint directly with the probe, which uses loopback-only headers instead of OAuth:

```sh
VALISE_MCP_URL=http://localhost:5173/mcp node scripts/mcp-probe.mjs tools/list
VALISE_MCP_URL=http://localhost:5173/mcp node scripts/mcp-probe.mjs search '{"query":"duckdb"}'
VALISE_MCP_URL=http://localhost:5173/mcp node scripts/mcp-probe.mjs create_todo '{"title":"Verify an MCP client","project":"valise"}'
VALISE_MCP_URL=http://localhost:5173/mcp node scripts/claim-race.mjs 8
```

To try the real OAuth flow, point a client at the dev server in a separate test configuration:

```sh
claude mcp add --transport http valise-local http://127.0.0.1:5173/mcp
codex mcp add valise-local --url http://127.0.0.1:5173/mcp
```

## Where things are written down

| Question | Where |
|---|---|
| What is v1 supposed to do? | [`docs/specs/2026-10-12-valise-v1-spec.md`](docs/specs/2026-10-12-valise-v1-spec.md) |
| Why is it shaped this way? | [`docs/adr/`](docs/adr/README.md) |
| Why does the console look like this? | [`docs/design/principles.md`](docs/design/principles.md) |
| How is it operated? | [`docs/operations/`](docs/operations/) |
| What do the end-to-end journeys prove? | [`docs/testing/user-journeys.md`](docs/testing/user-journeys.md) |
| Do the tool descriptions work? | [`evals/README.md`](evals/README.md) |
| What does review block on? | [`AGENTS.md`](AGENTS.md), "Rules the schema cannot enforce" |

## Contributing and security

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup and the checks a pull request needs. Report vulnerabilities privately as [SECURITY.md](SECURITY.md) describes, not in a public issue.

## License

The server, everything outside `clients/`, is [AGPL-3.0-only](LICENSE). Run it at home, inside a company, or anywhere else, and change it as you like. If you run a modified version that other people use over a network, you have to offer those people the source of your version. Each package under `clients/` carries its own Apache-2.0 `LICENSE`, so it can ship inside other tools without that obligation. [ADR-0021](docs/adr/0021-agpl-server-apache-clients.md) records why.

### Name and trademark

The licenses cover the code, not the name. Fork Valise, self-host it and say it is built on Valise. If you offer a fork as a hosted service or a product, give it a different name and logo, so nobody mistakes it for this project or for `app.valise.run`. An unmodified self-hosted install for yourself, your household or your own organization can keep the name.
