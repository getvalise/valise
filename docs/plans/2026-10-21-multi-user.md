# Multi-user: invites now, open sign-up later, then a paid tier

Date: 2026-10-21
Status: initial account code merged as e90edd0; additive security mitigation
prepared separately from operator-blocked per-user skill-name uniqueness.
Phase 1 acceptance is incomplete. Phases 2 and 3 are not started.

Source: `todo:tdo_e3336332-196e-4d92-9839-df640a93ad3b`. The decisions of
record are in ADR-0016; this document is the order of work and what each
phase has to prove.

## Phase 1. Invite-gated multi-user (ADR-0016)

Done means: the owner creates an invite on `/people`, sends the link, the friend
signs in with Google or activates password signup with email plus the original
password, and sees an empty case with the built-in skills; the
friend's agent connects over OAuth to `/mcp` and never sees the owner's rows;
the owner's console and agents behave as before.

1. Schema: `users`, `invites`, `user_id` on the three concept tables and the
   `search_docs` projection, defaults to `local`. Already merged; retain the
   applied filenames. Global skill-name uniqueness still limits provisioning.
2. Every read scoped, every write stamped. Proven by a vitest that writes
   under two users and reads through list, get, search, fetch and
   `list_ready` from each side.
3. Sign-up: `/join/<code>`, Google carrying the code in the signed state,
   `resolveSignIn`, built-in skills published for the new account. Password
   signup creates no session until a same-origin verification POST proves
   the seven-day token and original password. No Google auto-linking to
   pending password registrations. Log password successes and refusals.
4. `/people`: mint, list, withdraw invites; list accounts. Owner only.
5. By-hand migration: drop `skills_name_unique`, add the unique index on
   `(user_id, name)`, prepared as 0029 on the separate full repair branch after
   checking remote migration names. Excluded from the security hotfix.
   Declared `-- valise:by-hand`; do not apply it without explicit owner
   authorization. The owner coordinates
   `npm run db:migrate:prod` and the Workers Build retry.
   Until it runs, a member cannot publish a skill whose name the owner
   holds, and their built-in sync reports those as errors.
6. Keep applied `0028_member_password.sql` unchanged; reconcile its missing
   snapshot/journal/schema fields. Add verification expiry as 0031 (0030 is
   reserved for document processing). The security patch carries only this
   additive SQL, with snapshots retaining the global indexes. Prove activation,
   expiry, replay, cross-origin refusal and pre-hijack prevention against that
   schema. When owner built-ins collide, log failed best-effort provisioning,
   admit the verified member, and prove owner bodies/versions remain untouched
   and unshared. Same-name success tests require the separate index migration;
   greeting/navigation and console integration are separate work.
7. Operator prerequisites: verified Resend sender and EMAIL_API_KEY; correct
   production and Preview Base secrets; Google callback origins matching
   the actual preview alias and production host; inspect earlier pending
   accounts and revoke compromised credentials. Never use production bindings
   for preview. Production's owner allowlist is present as an ordinary variable,
   not a secret; preserve it on deploy. Confirm Workers Build/deployment and
   smoke checks after a security release, then real two-user isolation and
   successful built-in copies after the authorized full rollout. Do not close
   the queue items on a local commit. The additive security patch does not
   require or authorize the by-hand index migration.

Left for later, in order of how soon it bites:

- A per-user Vectorize namespace, so hybrid recall does not degrade as
  other users' vectors fill the top fifty. Needs a namespace per `user_id`
  in `vector_pending`, the stamp, and the backfill cursor.
- A member's display name and sign-out of all sessions, on a profile page.
- Account deletion: one R2 prefix, one `user_id` across the tables, one
  Durable Object. The prefix layout from ADR-0011 was chosen for it.
- Admin session-as-member for support, if a friend reports something the
  owner cannot reproduce.

## Phase 2. Open sign-up with a free tier

Forced by: the first stranger. Kept open by: the invite gate, which admits
nobody by default.

- Sign-up without an invite: `/join` with no code offers Google; a new
  verified email creates a `member` on the `free` plan. The allowlist and
  invites keep working; an invite can then carry a plan or a waived limit.
- Limits keyed on `users.plan`, enforced at the write paths, never at read.
  Candidate ceilings for `free`, to be set from the owner's own usage in the
  logs tab before launch: memories, skills, open to-dos, stored bytes
  (`objects.size` summed per user), bearer tokens, MCP calls per day (the
  edge rate limit is per deployment today and becomes per principal). A
  write past a ceiling fails with a message naming the limit and the plan
  that lifts it, over MCP as a tool error and in the console as a form
  error.
- Abuse: Google's verified email is the only identity; a disposable-domain
  list is a later decision. Sign-ups are `console_login` events with
  `joined` in the detail, so the logs tab shows the rate.
- Terms and a privacy page on `getvalise.dev`, linked from `/join`.

## Phase 3. Paid tier

Forced by: a free user hitting a ceiling and asking. Kept open by: the
`plan` column, which is `free` on every row and read by nothing yet.

- Stripe Checkout and a webhook Worker route that sets `users.plan`; the
  plan name is the only thing the rest of the code reads. A `plans` table
  is not needed until there are more than two.
- Limits lifted or raised by plan, same enforcement points as phase 2.
- A billing section on the profile page: current plan, portal link.
- Per-user endpoint addressing stays closed (ADR-0016): a paid user gets
  more, not a different URL.
