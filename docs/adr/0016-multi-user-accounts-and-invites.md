# 0016. Multi-user: one endpoint, owned rows, invite-gated sign-up

Date: 2026-10-21
Status: accepted

## Context

Valise had one user. The administrator password and every allowlisted Google
account signed in as `local`; `skills`, `memories`, `todos` and
`search_index` carried no owner column; only sessions, tokens, objects, hook
config and the logs knew a `user_id`. The owner asked for friends to be able to
sign up and test, gated by an invite, with an open free tier and a paid tier
to follow (`todo:tdo_e3336332-196e-4d92-9839-df640a93ad3b`). That forces two
decisions this record settles and one it only prepares: how a second user's
data is kept apart, how a second user gets in, and what "open sign-up with a
free tier" will need. The per-user endpoint question `docs/adr/README.md` had
kept open since v1 is forced by the same change.

## Decision

- **One endpoint, tenant from the credential.** `/mcp` stays the only MCP
  endpoint and the console stays on the same origin. An OAuth grant and a
  bearer token already carry a `userId` in their props (ADR-0004), so the
  principal names the tenant and no path or subdomain has to. A path per
  user was rejected because it puts a second copy of the tenant in the
  request that the server would then have to check against the first; a
  subdomain per user was rejected because it needs a certificate, a DNS
  rule and an OAuth resource per user for an isolation the row filter
  already gives. The open question is closed.
- **Owned rows, filtered everywhere.** `skills`, `memories`, `todos` and
  `search_index` gain `user_id TEXT NOT NULL DEFAULT 'local'`, so every row
  written before this record belongs to the owner without a backfill. Every
  read of those tables carries `user_id = ?` for the principal; every insert
  stamps it from the principal's provenance. Child tables (versions,
  revisions, links, updates, comments, attachments) have no owner column and
  are reached only through a parent lookup that is already scoped. A search
  is one more column predicate on `search_index`, never a per-concept join.
  The to-do coordinator was one Durable Object per user from ADR-0002; the
  column makes D1 agree with it.
- **`local` is the owner.** A `users` table holds one row per account:
  `user_id`, `email`, `display_name`, `role` (`owner` | `member`), `plan`,
  `invite_id`, timestamps. The migration inserts `local` as the owner. The
  administrator password still signs in as `local`, and so does any address
  in `VALISE_ADMIN_EMAILS`, whose first Google sign-in records the owner's
  email. New users are `usr_` plus a UUIDv7.
- **Sign-up is an invite redeemed by Google.** An `invites` row is a
  128-bit code, a label, an optional email, an expiry (fourteen days unless
  the owner says otherwise), and the redemption. The owner mints one on
  `/people` and sends the `/join/<code>` link by any channel; Valise sends
  no mail. The link offers Google only. The callback resolves the verified
  email in this order: owner allowlist, existing account, the link's invite,
  an open invite bound to that email, refusal. Redemption and account
  creation are one `db.batch` where the invite row's own state is the lock,
  so two sign-ins racing one link produce one account. A refusal is a
  `console_login_failed` event naming the reason. A new member's case gets
  the built-in skills published behind the sign-in response.
- **Roles, not scopes.** `owner` sees `/people`; a `member` gets a 404
  there. MCP scopes are unchanged: they say what a client may do inside one
  user's case, and the case is the principal's.
- **Google is enabled by its client, not by the allowlist.** With no
  allowlist and no invites a deployment admits nobody, which is the safety
  the allowlist requirement used to provide.
- **Skill names become unique per user, by hand.** `skills_name_unique`
  is global, and ADR-0008 makes dropping an index a by-hand migration. Until
  that migration runs, two users cannot hold a skill of the same name, and a
  member's built-in sync reports an error for a name the owner already
  holds. It ships as its own migration, declared `-- valise:by-hand`, so the
  additive half of this record deploys on merge.
- **Vectors stay in one namespace for now.** Hybrid search hydrates every
  vector hint against `memories` with the principal's `user_id`, so another
  user's head is a hint that hydrates to nothing. The index is not filtered
  by user, so a user's recall can drop once other users' vectors crowd the
  top fifty. A per-user namespace is in the plan, not in this record.

## Consequences

Gained: a friend can be invited, sign in, and work in a case that is theirs
alone, over the same endpoint and plugin the owner uses. Every write already
carried a principal, so the console and the MCP transport needed no new
identity plumbing, only the column and the predicate. Given up: `search`,
the startup brief, vocabularies, facets and usage counts are per user, so
nothing is shared between accounts, including skills; sharing is a later
record. Inherited: free and paid tiers need limits enforced at the write
paths and a `plan` column to key them on; the column exists, the limits do
not. `docs/plans/2026-10-21-multi-user.md` carries that plan.

## Amendments

### 2026-10-23: tenant-scoped ANN candidates

The deployment-wide top50 in the original decision prevented content leakage
through D1 hydration but allowed foreign vectors to crowd out a tenant's recall.
Search now selects a deterministic deployment+authenticated-user namespace
before ANN topK, retaining D1 ownership, publication and generation checks.
History is in a disjoint tenant history namespace and is never searched.
Namespaces require no new metadata index; project/docKey indexes are unchanged.

Vector IDs keep their deployment-based stamps. Same-ID upserts relocate existing
head/history vectors; deletes work across old and new layouts. Delivery gets
the owner from memories rather than guessing ownership of pre-tenancy snapshots.
A `tenant-v1:<deployment>` checkpoint re-enqueues settled rows once, independent
of the old completed scan. Existing epochs, leases, retries and daily repair
remain in force. There is no shared-namespace fallback during catch-up or rollback.
`docs/operations/vector-rebuild.md` names release and rollback validation.

Two namespaces per tenant impose a finite per-index tenant budget: the current
limits page specifies 50,000 namespaces on Workers Paid and 1,000 on Free.
This is isolation for the invited-user phase, not unlimited scale or completion
of deployment-wide drain capacity work.

### 2026-10-23: additive account-security mitigation after the initial merge

The live projection is `search_docs` (ADR-0015), not the retired
`search_index`; migration 0027 adds its owner column. Existing migration
filenames stay immutable: read-only inventory on 2026-10-23 found production
had applied `0027_multi_user.sql` and `0028_member_password.sql`, while the
isolated preview database had only through 0027. Initial account code landed
on main as `e90edd0` on 2026-10-23; the security mitigation must not wait for
the still-unauthorized skill-index replacement. Schema presence alone does
not prove which Worker version is serving it.

Password sign-up is also invite-gated. A same-origin POST consumes the invite
and creates a pending account, without issuing a session. The verification
email carries a 128-bit token with a seven-day server-side expiry. GET only
shows a form, so a mail scanner cannot consume it. Activation is a same-origin
POST requiring both the token and the original signup password. A link alone
must not activate a password somebody else chose for the recipient's email.
Consumption is conditional on the unchanged password hash, unverified state
and expiry; a replay fails. Existing tokens without an expiry fail closed.

Password login, existing browser sessions, authenticated MCP and plain bearer
HTTP endpoints refuse unverified members. Google cannot automatically link a
verified identity to a pending password registration: that returns
`email-unverified` instead. The recipient must finish the original signup or
ask the owner to resolve it. Automatically merging the two would retain an
attacker's password. Owner administrator-password access remains available.

Activation and Google signup attempt built-in provisioning behind `waitUntil`.
The existing global `skills_name_unique` index is retained: when the owner
already holds a built-in name, a member's publish fails. Provisioning records
a structured `builtin_provision_failed` Worker log with the user and failed
skill names, never passwords, tokens, bodies or raw database errors. Failure
does not undo verified admission and never falls back to the owner's copies.
Tests retain the global index and prove activation and subsequent login work,
the member cannot fetch owner built-ins, and owner rows and versions do not
change. This is degraded provisioning, not completed multi-user rollout.
Password login and verification record successes and refusals in the auth
log. Missing email configuration does not consume the invite; delivery failure
leaves a pending, inaccessible account and names the failure to the recipient.
Email delivery is Resend under `EMAIL_API_KEY`, from the `EMAIL_FROM` var,
which defaults to `noreply@valise.run`; the owner must configure the sender and
secret in each environment. (Amended 2026-11-02: `EMAIL_FROM` added so a
self-hosted install can send from its own domain.)

The security patch includes only additive `0031_verification_expiry.sql` and
reconciles the missing 0028 password metadata. Its snapshot retains the global
skill indexes. There is no new by-hand migration in this patch and no schema
dependency on per-user names. 0030 remains reserved for document processing.
`0029_skill_names_per_user.sql` stays on the separate full repair branch,
declared `valise:by-hand`, pending explicit owner authorization. It supersedes
PR156's unapplied `0028_skill_names_per_user.sql`; never apply both.

Security mitigation can be released independently through the ordinary
additive-migration build path after exact-head verification. A green local
suite is not a deployment: confirm Workers Build, deployment and smoke checks
after an authorized release. Full multi-user acceptance still requires the
owner-authorized index replacement, working email delivery and two-user
checks. Greeting and console integration remain separate from this hotfix.
Production `VALISE_ADMIN_EMAILS` is configured as an ordinary variable; its
absence from the Wrangler secret list is not evidence of a missing setting.
Preserve the allowlist and canonical APP/MCP origins on the next deployment.

Open: secure resend/recovery and pending-account cleanup. First delivery
failure or an expired link forces owner intervention today; an unattended
recovery flow stays open until that burden warrants its own verified design.
Before admitting friends, inspect any accounts and credentials created by the
earlier preview/signup implementation and revoke compromised grants rather
than treating a schema migration as an identity audit.

### 2026-10-23: reusable group invite links

The owner can choose a one-person or group link on `/people`. Existing links
remain single-use. Group links default to fourteen days, require a finite
expiry of 1–365 days, and cannot bind one email. Possession lets anyone create
their own member account; it grants no access to the owner's or other members'
data. Google verification and password/email verification are unchanged.

Additive migration `0032_group_invites.sql` adds `invites.reusable`, defaulting
to false, and an index on `users.invite_id`. Each redemption updates the invite
and conditionally inserts the account in one `db.batch`. The write rechecks
expiry, withdrawal and single-use state, not just the earlier lookup. For a
group link, `redeemed_at` and `redeemed_by` identify the latest registration;
`users.invite_id` retains every registration. The owner sees its account count,
including pending verification, and can withdraw it after use. Withdrawal or
expiry stops new registrations, not existing account access or verification.
Group labels never become every member's display name.

The invite type is a native select (P7); creation, expiry and withdrawal remain
ordinary same-origin forms without scripting (P10, P11). No new permissions,
MCP tools, tier limits or recovery flow are introduced. This does not resolve
the separate skill-index migration and multi-user rollout checks above.

### 2026-10-23: tenant boundary and storage scaling

[ADR-0017](0017-tenant-boundary-and-pooled-d1-shards.md) retains the shared D1
database now and selects measured pooled tenant shards as its scaling direction.
Each tenant's concepts, children, object metadata, projection and outbox stay
together; control-plane identity and routing remain distinct responsibilities.
It defines primary consistency for authorization and leases, authoritative
routing, fenced moves, fleet migrations and tenant-selective recovery before
any physical split. It does not implement automatic sharding or authorize the
pending by-hand skill-name index replacement.

The earlier shared-vector-namespace allowance is superseded as the target
contract: scope candidates to the tenant before top-K, then retain owned D1
hydration and generation checks. ADR-0017 records the baseline code findings;
the repair's implementation and rollout evidence remain separate from this
decision. A tenant is still the authenticated user today. Whether ownership
moves to workspaces with multiple members remains open, not implied by the
word tenant, a project tag or a reusable invite.

### 2026-10-23: owner-authorized per-user skill-name migration

The owner explicitly authorized manual production application after
verification. The migration is now `0035_skill_names_per_user.sql`: create
the unique `(user_id, name)` index first, then drop global
`skills_name_unique` and the redundant nonunique `skills_user_name` index.
It carries the ADR-0008 by-hand marker. This supersedes the unapplied 0029
filename on the earlier full-repair branch and PR156's unapplied 0028 variant;
neither earlier variant is to be applied as well. Numbers 0033 and 0034 are
reserved for built-in provisioning and activity indexes, respectively.

Read-only production inventory on 2026-10-23 found migrations through 0032
and the global index still present. Authorization is not evidence of
application or deployment. Record verification, manual migration outcome,
Workers Build/deployment and two-user same-name checks before calling the
rollout complete.

### 2026-10-23: bounded, versioned built-in provisioning

HTTP requests never enumerate accounts to upgrade built-ins. Signup and email
activation attempt only their admitted account behind `waitUntil`. The existing
minute cron advances a durable `users.user_id` keyset cursor by at most five
accounts, then processes that page. It advances before processing: a failed
tenant or interrupted invocation cannot pin every later account. An empty page
resets the cursor. For N accounts, a traversal takes `ceil(N / 5) + 1` ticks;
new accounts behind the cursor and interrupted pages are reached next traversal.

Additive migration `0033_builtin_skill_sync.sql` stores the cursor and one
provisioning state per tenant. A SHA-256 of the bundled bodies, metadata and sync
policy identifies the release. A completed release skips skill reads and writes.
A new release clears completion before work. A 120-second token-fenced lease
guards publication and completion; interrupted leases expire. Errors leave no
completed marker, record failed skill names, log `builtin_provision_failed`, and
defer that release's next attempt for 300 seconds. The sweep continues after
individual failures; it logs its bounded report as `builtin_sweep`. Pending,
unverified members are not provisioned. No queue or new cron binding is required.

Built-in publication appends the immutable version, moves the head and writes
its projection in one guarded D1 batch. A user edit committed after the sync's
read makes its conditional version insert a no-op and retries the tenant.
Authored content, registry sources, deleted skills, attached files and managed
heads changed since the last sync are held. A held skill is a successful policy
decision for that release, not an error; its content is never overwritten.
Unmanaged identical bodies may be attributed without a new version. Disabled
skills can upgrade while remaining absent from search. Project and tags retain
the current tenant's values, including changes concurrent with the upgrade.

The global skill-name index, if still present, causes retryable provisioning
errors without changing the owner's copy. Replacing it remains the separate
operator migration. With per-user uniqueness, the same code creates independent
copies. Inspect `builtin_skill_sync` (`completed_version`, `target_version`,
`lease_expires_at`, `retry_after`, `last_error`) and `builtin_skill_sweep` for
progress. These tables are resumable derived state: restoring without them
restarts the sweep and rechecks authoritative skill heads without duplicating
unchanged versions. The loopback `/__dev/sync-builtins?user=<id>` repairs exactly
one account; omitting `user` selects `local`.

### 2026-10-29: a member sets or changes a password on /account

A member who joined with Google had no way to sign in through `/login`.
`/account`, reached from the name in the workspace strap, lets a signed-in,
verified member set a password, or change it with the current one. It reuses
`hashPassword` from `app/lib/password.server.ts` and the eight-character
minimum `/join` applies. It sends no verification email: `/join` verifies
because nobody has proved the mailbox yet, and here Google or an earlier
verification already has, and the browser session proves the account.

Saving a password ends every other browser session of that member, in the
same `db.batch` as the update; the browser that saved it stays signed in. A
password change is what someone does after they suspect a stolen session, and
a change that leaves that session alive does not help them. MCP OAuth grants
and plain tokens are not ended: they are not browser sessions, and
`/connections` already revokes them one at a time. The update is conditional
on the stored hash the action verified, so two concurrent changes cannot both
win.

The owner gets a line saying the administrator password is set in the
deployment, and no form: `/login` routes the owner's email to the
administrator password, so a stored owner password would never be read.
No `auth_events` kind is added, because the kind column's CHECK constraint
would need a table rewrite; a password change is not in the auth log.

Interaction contract. The job is to make `/login` work for this account. The
default view is one card with the password fields and a primary "Set password"
or "Change password" button, and a line that names the side effect on other
browsers. A mismatch, a short password, a wrong current password and a lost
race each answer in an alert without saving. It is one same-origin form and
works without scripting (P11). `test/ui/account.spec.ts` runs the whole job
at 1280px and 320px; `test/ui/layout.spec.ts` checks the page fits. Members
for those tests come from the loopback `/__dev/member` lever, shaped as Google
sign-in leaves one.

### 2026-10-29: the owner issues a one-time password reset for a member

A member with a password they do not know cannot replace it: `/account` asks
for the current one, and Valise sends no recovery mail. A friend who forgets
a password has no way back in. The owner hit the same wall with the synthetic
acceptance member on 2026-10-29, before finding the password they had saved
was not the one set. The owner's door on `/people` already hands out
invite links by any channel; a reset link is the same move for an account
that exists.

The owner presses "Create password reset link" on a verified member's card on
`/people`. The link is `/reset-password/<token>`, a 256-bit random token shown
once. Only its SHA-256 is stored, in `password_resets`, with the member, the
issuer, the time and an expiry one hour out. Issuing a new link for the same
member withdraws the older one in the same `db.batch`. The insert is
conditional on the target being a verified member with an email, so no link
is ever made for the owner, a pending account or an unknown id; a member who
posts to `/people` gets its 404.

The member opens the link signed out. GET only reads, so a link previewer
cannot spend it. Saving is a same-origin POST, and one `db.batch` sets the
password hash, marks the link used and deletes every browser session of that
member. D1 runs a batch as one transaction, so of two submissions of the same
link only the first finds it open. Unlike `/account`, nobody keeps a session
and the page signs nobody in: the person holding the link might be a browser
signed in as someone else, and `/login` with the new password is the proof the
job needed. MCP grants and tokens stay, as on `/account`; `/connections`
revokes those. The page sets `referrer: no-referrer`, so the token stays out
of Referer headers.

Rejected: letting a session that signed in with Google in the last few minutes
set a password without the current one. It needs a sign-in method and time on
every session, which `sessions` does not carry, and it helps only members who
still control their Google account. The owner's link works for a password
member too, and closes part of the recovery question the first amendment of
2026-10-23 left open, without mail.

Logging. The `password_resets` row is the record: who issued it, when, and
when it was used, replaced or expired. `/people` shows the newest link's state
per member. A refused redemption is a `console_login_failed` auth event and a
successful one is `console_logout`, since it ends the member's sessions, each
with a `password reset:` detail; no `auth_events` kind is added, for the CHECK
constraint reason in the amendment above. Workers logs carry
`password_reset_issued` and `password_reset_used`. `password_resets` is in
`OMITTED` for backups, with sessions and invites: a restore never carries a
live reset link. Additive migration `0046_password_resets.sql`.

Interaction contract. The owner's job is to get a member back in without
knowing their password. Default view: each verified member's card on
`/people` ends with a quiet "Create password reset link" button and, once
one exists, a line naming the newest link's state and time. Primary action:
pressing it reveals the link in the same card with when it stops working, that
it works once, and that it is not shown again; the button then reads "Replace
reset link". The member's job is to set a new password: one card with the
email it is for, two password fields and "Set password". A short password and
a mismatch answer in an alert without spending the link. A used, replaced or
expired link shows only an alert telling them to ask the owner for a new one.
Both pages are plain same-origin forms that work without scripting (P11).
Evidence: `test/mcp/password-reset.worker.test.ts` covers issue, hash-only
storage, expiry, reuse, replacement, a link changing only its own member,
refusal for the owner, a pending member, an unknown id and a member caller,
and a cross-origin post. `test/ui/password-reset.spec.ts` runs the owner and
member halves at 1280px and 320px, checks neither page scrolls sideways,
signs in on `/login` with the new password, and opens the link a second time.

### 2026-11-04: separate admins

The original decision mapped every address in `VALISE_ADMIN_EMAILS` to the
owner, `local`. A household or team self-host read the list as several
admins and got several logins into one case. Now only the address the owner
row records signs in as the owner. If the row records none yet, the first
listed address to sign in adopts it, as before. Every other listed address
gets its own account on its first Google sign-in, with no invite needed.

Behaviour change: an install that listed two of the owner's own addresses
now splits them. The address the owner row recorded still reaches `local`;
the other gets a new, empty account with admin pages. To keep one account,
list one address. Nothing moves data between accounts.

Admin is not a stored role. `users_role_check` allows only `owner` and
`member`, and widening it means rebuilding the table, a by-hand migration
(ADR-0008). An admin's row is a verified `member` row. `isAdmin(env, user)`
in `app/concepts/users.ts` answers for the owner always, and for any other
account while the list names its verified address. Removing an address takes
the admin pages away at the next request and leaves the account and its
data. An admin gets the owner's pages: `/people` with invites and password
resets, and `/workbench` (`requireConsoleAdmin`), plus the sidebar group,
labelled "Admin" for an admin and "Owner" for the owner. `/people` marks each
admin. Data stays per account: an admin reads and writes only their own
rows. Refused sign-ins and unattributed MCP calls still show only on the
owner's logs (`app/concepts/activity.ts`). They are deployment-wide noise
rather than an admin's own activity, and widening them would need the admin
check inside the tenant store.

The attachment allowance still keys on `role = 'owner'`
(`app/concepts/attachment-limits.ts`). It moves to `isAdmin` together with
the member-allowance setting.

Evidence: `test/mcp/users.worker.test.ts` covers the owner's address reaching
`local`, a second address getting its own verified account without an
invite and reaching it again, first-address adoption, and `isAdmin` for listed,
unlisted, unverified and owner accounts. `test/mcp/people.worker.test.ts` has
a second admin create an invite and see both admins marked; members still get
404. `test/clients/account-identity.test.ts` renders the sidebar for owner,
admin and member. `test/ui/people.spec.ts` signs in a listed address that is
not the owner's, finds the Admin group, creates an invite on `/people` and
opens `/workbench`, and checks that a member has neither.
