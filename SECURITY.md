# Security

Valise holds people's memories, skills, files and OAuth grants, so a flaw in
auth, tenant isolation or token handling matters more than most bugs.

## Report a vulnerability

Use GitHub's private reporting: the **Security** tab of this repository, then
**Report a vulnerability**. Do not open a public issue or pull request for it.

Include the affected route or MCP tool, the steps to reproduce, and what an
attacker gains. Test against your own install
([self-host setup](docs/operations/self-hosting.md)) or a local
`npm run dev`, never against another person's data on `app.valise.run`.

Valise is maintained by one person in their spare time, so there is no
response deadline. A fix lands on `main`, which deploys the hosted instance; self-hosted installs pick it up when they merge
upstream into their fork.

## Supported versions

Only the current `main` is supported. There are no release branches.

## In scope

- the Worker under `workers/` and `app/`: OAuth, sessions, bearer tokens,
  tenant isolation, uploads, the MCP endpoint
- the clients under `clients/`
- the deploy, backup and restore scripts under `scripts/`

Third-party services Valise calls (Cloudflare, Resend, TypeSafe, Google) are
out of scope; report those to their owners.
