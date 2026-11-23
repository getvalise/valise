# Architecture decision records

One file per decision: `NNNN-short-title.md`, numbered in order of acceptance.

Format:

```markdown
# NNNN. Title

Date: YYYY-MM-DD
Status: accepted | superseded by NNNN

## Context
What forced the decision.

## Decision
What we chose, stated plainly.

## Consequences
What we gain, what we give up, what becomes harder.
```

Product-level decisions from the initial grilling (2026-10-12) live in `docs/research/2026-10-12-landscape-and-prior-art.md` under "Settled decisions". ADRs start where design starts: anything that shapes the schema, the protocol surface, or the deployment model gets a record.

The number is read off this directory, so two parallel sessions can take the same one: 0008 was written twice on 2026-10-17 and the second became 0009. ADR-0010 kept that race rather than solving it, because one allocation every few weeks is cheap to catch here. Before writing `NNNN-`, `git fetch` and list the directory; if a collision reaches `main` twice more, the allocation moves to a to-do.

## Storage and tenant decisions

| Record | Boundary |
| --- | --- |
| [0001](0001-data-model.md) | Authoritative concept tables and atomic shared search publication. |
| [0002](0002-claiming-semantics.md) | Per-user coordinator, leases and durable fencing floors. |
| [0016](0016-multi-user-accounts-and-invites.md) | Credential-selected tenant, owned rows and invite-gated accounts. |
| [0017](0017-tenant-boundary-and-pooled-d1-shards.md) | D1 now; tenant-scoped access and measured pooled shards, with routing, move and recovery boundaries. |
| [0019](0019-scheduled-backups-in-cloudflare.md) | Daily backup Workflow into a locked R2 bucket in the same account; alerts once per incident. |
| [0022](0022-transcripts-concept-and-cli-grant.md) | Transcripts as a concept, distilled turns in D1 and R2; written by a Valise CLI holding a scoped per-machine OAuth grant. |

## Console decisions

| Record | Boundary |
| --- | --- |
| [0014](0014-static-tailwind-and-console-blocks.md) | One static Tailwind stylesheet linked by the console and the OAuth page; shared page blocks. |
| [0020](0020-shadcn-components-and-the-console-frame.md) | shadcn/ui and Preflight; one frame and one list pattern for every console page. |

## Project decisions

| Record | Boundary |
| --- | --- |
| [0021](0021-agpl-server-apache-clients.md) | AGPL-3.0-only server, Apache-2.0 clients, unlicensed name, no CLA. |

## Open questions

Decisions we owe but have not had to make. Each names what forces it and what keeps it open in the meantime, so a slice shipped today cannot quietly answer it.

- Per-user endpoint addressing was decided in ADR-0016 on 2026-10-21: one `/mcp` for every user, the tenant named by the credential. The candidates were a path, `valise.run/u/{user}/mcp`, and a subdomain, `{user}.valise.run`; both carry a second copy of the tenant the server would have to check against the token.
- **Retiring `/config/hooks`, `/config/brief` and `/config/recall`.** Forced by: a release where no client holding a bearer calls them, which the call log can show, or a bug in one that would cost more to fix than to remove. Kept open by: the Claude Code plugin stopped calling them on 2026-11-04 (ADR-0004), but a Codex install, a hand-run hook script or another client with a `config:read` token may still, and the endpoints cost nothing while they answer.
- **Free-tier limits and the paid tier.** Forced by: the first stranger signing up, so open sign-up (phase 2 of `docs/plans/2026-10-21-multi-user.md`). Kept open by: the invite gate, which admits nobody by default, and `users.plan`, which is `free` on every row. Since 2026-10-30 one thing reads it: a bookmark's file allowance in `app/concepts/attachment-limits.ts`, where the account owner gets 25 MiB per bookmark and every plan without its own row gets the `free` row, 2 MiB (ADR-0015). A paid tier is one more row keyed by its plan name; what it costs, who may set `plan`, and whether storage is also capped per account rather than per bookmark are still unanswered.
- Tenant identity and sharing between users. Forced by: two users who need shared ownership, membership changes or workspace billing. Kept open by: tenant data belonging to the authenticated `user_id` today. A user is the actor; a future workspace is an ownership boundary requiring its own membership and migration decision. Project tags and group invites do not grant sharing. ADR-0017 keeps this explicit.
- Physical D1 sharding. Direction decided in ADR-0017: measured pools of tenants, keeping each tenant's concepts and projection together. Initial shard count, allocation policy, routing transport, capability lookup and capacity budgets are forced by measured contention, forecast storage exhaustion within move/recovery lead time, or an isolation/recovery requirement. Kept open by: one `DB` binding, no representative multi-tenant capacity baseline and no rehearsed tenant move. The record implements no automatic sharding.
- Upload transport and retention were decided in ADR-0015 on 2026-10-20: bounded HTTP transfers initiated through MCP, durable-by-default assets with explicit expiry, and reference-protected cleanup. Implemented on 2026-10-21; ADR-0015's amendments record the transport, limits, cleanup and export. ADR-0011 still describes to-do and memory attachments.
- **Where curated skill suggestions live.** Forced by: a second curator, someone other than the owner who should be able to add or reword a suggestion without a pull request, or per-user suggestions once there is more than one user. The candidates are the file `app/concepts/curated-skills.ts`, where one person curates, the git history is the review, and a deploy ships it, and a `curated_skills` table edited from the console. Kept open by: the console reads suggestions only through `CURATED_SKILLS` and `curatedMatches`, and "added" is derived from `skills.source` rather than stored. Moving to a table means replacing one import with a query, and no migration has to carry curation state.
- **Ranking a project rollup above the memories it summarises.** Forced by: a broad project question where `search` returns the rollup below its own sources, seen in the logs or in a case. Kept open by: a rollup is an ordinary memory tagged `rollup`, so `search` with `tags: ["rollup"]` and `project` already narrows to it, and the startup brief names it by id. A boost needs a ranking input the projection does not carry. ADR-0009.
- **A create-only to-do scope for the Chrome extension.** Forced by: a second client that should add to-dos without claiming, updating or completing them, or an extension token found misused against claims. Kept open by: `create_todo` is the only to-do tool the extension calls, and its grant names `todos:write` in one place, `CHROME_EXTENSION_OPTIONAL_SCOPES` in `app/auth/chrome-extension.ts`, so a narrower scope replaces one entry and the extension's requested list. ADR-0004, amendment of 2026-11-01.
- **Vectors for the similar-memories check on save.** Forced by: the check-on-save line missing a memory that restates an existing one in other words. That query is the new memory's text, so no model rewrites it the way models rewrite a missed search, and it is the one place a paraphrase has no rescue. ADR-0013 measured a paraphrase at 14 of 25 in the top five with `bge-m3` against 4 with FTS, on short questions rather than whole memories. Kept open by: the projection already holds the title and body a vector would be computed from, and `evals/retrieval/vectors.mjs` reruns the comparison on any store, so the check can ship on FTS and be measured before anything is embedded.
- **The iOS Shortcut install link.** Connections' Add Shortcut button points at one iCloud share link, `IOS_SHORTCUT_LINK` in `app/concepts/ios-shortcuts.ts`, set to the owner's shared Valise Capture Shortcut, the link shared on 2026-11-03 in place of the one from 2026-11-02. Forced by: a link that stops opening the Add Shortcut screen (the Shortcut deleted or unshared, an edit not reaching the old link, Apple changing links), or a self-hoster whose Shortcut must not depend on the owner's iCloud account. Kept open by: the Shortcut names no origin, because the pasted capture URL carries it, so one link serves every instance; and `docs/operations/ios-capture.md` rebuilds it by hand. The candidate to move to is a signed `.shortcut` file under `clients/` (`shortcuts sign --mode anyone`, macOS only) served by the Worker, not yet installed on a phone. ADR-0015, amendment of 2026-11-02.
- **Encrypting transcripts with keys Valise holds.** Transcript text is in plaintext in four places: `transcript_turns.text` in D1, the session's JSON lines mirror in R2 (`transcripts/<user>/…`), the `search_docs` projection and its FTS index, and backups of all three. Cloudflare encrypts D1 and R2 at rest with keys it manages, so the exposure is to whoever can read the database or bucket (dashboard, API token, `wrangler d1 export`, a downloaded backup), not to the disk. The candidate is per-user AES-GCM keys wrapped by a Worker secret over the turn text and the mirror, decrypted in the Worker for the console, `fetch` and analysis. Its price: FTS cannot index ciphertext, so transcript search narrows to title and metadata, and DuckDB reads through a decrypting export instead of the mirror. A key kept on the device would stop Valise from reading transcripts at all, which defeats why they are stored. Forced by: the owner's first real `valise install`, after which every held session would need re-encrypting, or a second user's transcripts. Kept open by: the owner's choice on 2026-11-06 to leave it open, and Cloudflare's at-rest encryption covering disks and backups meanwhile. ADR-0022.
- **Candidate ranking on by default.** The owner asked on 2026-11-03 for Workers AI + Jev candidate ranking to be on with no separate switch (`todo:tdo_cd737945-5186-40f6-a539-eb009c9083eb`). ADR-0012 (2026-10-30) makes ranking a separate opt-in because it sends memory text to TypeSafe, a destination model-review consent does not name, and existing users stay on the lexical path until they opt in. Search already sends memory bodies to TypeSafe for this workspace, by the owner's decision of 2026-10-19, so the open part is whether one "Allow model reviews" consent may name both destinations, for this workspace or for every user. Forced by: the owner's answer, or ranking passing on production with the specific failure codes of 2026-11-03 so that a default-on switch does not make every check stop. Kept open by: the switch is one click under Advanced, off by default; turning it on is the existing permission form.
