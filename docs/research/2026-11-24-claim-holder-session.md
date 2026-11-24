# Who holds a claim, and what happens when its lease lapses

To-do `todo:tdo_013c8301-4dd4-419f-b63d-9b6f9a6d74e7` began as "stop `fetch`
from returning a to-do's fencing token". The numbers below replaced that plan
before anything was built. ADR-0002's amendment of 2026-11-24 records what
shipped.

Code was read on `e343ae2` of the old private repository. Production numbers
come from `node scripts/prod-read.mjs` over `mcp_calls` and `todo_updates`,
which cover about 2026-10-25 to 2026-11-24.

## How holder identity worked

- The lease holder was `provenance.agent`. For OAuth that is the client id
  (`principalProvenance`, `app/auth/principal.ts`); for a bearer token it is
  the token's label. Every Claude Code session on a machine shares one OAuth
  grant, so they all had the same `agent`. The plugin's `x-valise-session`
  header is the only thing that tells them apart. It reached
  `mcp_calls.session`, but the coordinator never saw it.
- `requireCurrent` (`app/do/todo-coordinator.ts`) checked
  `leaseHolder === agent` as well as the token. A different client, such as
  ChatGPT or claude.ai, could not use a token it fetched from a Claude Code
  claim. Another session of the same client could: two parallel Claude Code
  sessions were separated by the token alone, and `fetch` handed the token to
  both.

## Token handoff between sessions

| successful token writes | n |
|---|---|
| from the session that claimed | 498 |
| with no session header | 83 |
| from another session | 1 |
| total | 582 |

115 of the 498 same-session writes had a `fetch` of that to-do between claim
and write. The logs cannot tell reading apart from recovering the token, so up
to 23% of writes may rely on `fetch` for it. Dropping the token from `fetch`
outright would have hit these, so the holder keeps it.

## Leases lapse under live agents

- 69 `lease expired` releases against about 478 claims: 14%.
- 194 of the 498 writes landed more than 30 minutes after their claim; 61
  writes passed `renew_ttl_seconds`.
- 18 writes were refused for `stale fencing token`. Every one followed an
  expiry of the caller's own lease, never a takeover. In 17 the same session
  re-claimed within about 10 seconds and carried on. In one
  (`todo:tdo_5e009a67`, session `ui-e2`) the session never re-claimed, and
  another session picked the work up 6 days later.
- After an expiry, the next claim came from a different session 16 times, at
  least 529 minutes later (about 46 hours on average). No case was found of a
  second session taking work while the first was still active.

Reviving the holder's own lease on its next write, when nobody re-claimed,
would have removed all 18 refusals.

## Session ids are mostly stable

6 of 9 long-running sessions kept one session id for one to two days. 3 show
two ids under one name (`10-25-review-11`, `valise-09`, `valise-4f`): a
resume, a fork, or a reused name. A session id is a good holder key for the
paths that take no token, but not one a write with a valid token should depend
on.

## Silence before expiry

For each `lease expired` release with a session, the gap between that
session's last Valise call and the expiry. 33 expiries have a session; the
other 36 have none (claude.ai, ChatGPT, or rows older than the column).

| silence before expiry | n | back within 1 h | back later | never back |
|---|---|---|---|---|
| < 10 min | 9 | 8 | 0 | 1 |
| 10-30 min | 3 | 2 | 1 | 0 |
| 1-4 h | 10 | 1 | 5 | 4 |
| > 4 h | 11 | 0 | 7 | 4 |

- 12 of 33 called Valise in the last 30 minutes of the lease. A notice on those
  calls would have reached all 12, and 10 came straight back to work.
- 21 of 33 were silent to Valise for an hour or more. No response field reaches
  them while they are silent. Revival covers the 13 of them that came back
  (the to-do's comment says 12; the table sums to 13); for the 8 that never
  did, expiry was the right outcome.

An expiring-claims notice on the holder's own calls is the follow-up; it
needs the holder session this change records.
