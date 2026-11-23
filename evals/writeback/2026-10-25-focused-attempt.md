# Provider-free focused attempt: readiness timeout

The single authorized 4391 run did not reach MCP or fixture execution.
Runtime head: `ae3919eefd7c25817d1f079b190b575de750a600`, containing released
main `9487c2fb6879739f46c5d2cc66ba683c6f4f1b64` through merge `93648f3`.

The report clock records 2026-10-24T22:04:11.445Z through
2026-10-24T22:08:11.943Z (240.498 seconds including cleanup).
Local migrations completed and Vite advertised `http://localhost:4391/`.
The driver polled `http://127.0.0.1:4391/health` until its 240-second watchdog
aborted. The driver discarded readiness errors, so this evidence does not
identify their cause. A localhost/IPv4 binding mismatch is a hypothesis,
not a confirmed diagnosis. The Worker source does implement `/health`.

One batch was attempted, zero scripted fixture episodes reached MCP, zero
MCP request IDs or durable IDs exist, and tool-surface hashing was not reached.
The raw report's `scriptedEpisodes: 1` is the planned episode count, not a
completed episode. Model requests: 0. Provider inference requests: 0. Spend: $0.
Duplicate-write rejection, foreign-claim preservation, projection readback and
executor behavior remain unproven against the runtime.

Fixture hash: `591120c8026d37ed597e10c78f136214de6b9705120e19f1c69da543e63d764b`.
Source hash: `ea5c0a1a08d402e9874d3aa0eb01d8a3eff059941b772cb73fcb115311d73d0b`.

Retained evidence:

- Report: `/private/var/folders/75/p5ymw8gs2nl_ww1fkqkvytlc0000gn/T/opencode/j4-focused-ae3919e.json`
- Report SHA256: `edf02abdc1c8a824b120258a5957af3bc4dc57f0176db67bdc988ed436e05c5b`
- Server log: `$HOME/.local/share/opencode/shell/fc2b02d7667980185273701bfb5b3abf32cff1cd/sh_16ff15cf0001HCEp8OY1nitsYy.out`
- Log SHA256: `7b07acb0c70f920c92eb1e5476fe81e257189793a0ca74cf9ad97df0cd899c07`

The supervisor removed its named `valise-playwright-19DeWm` state directory;
the driver removed its named `j4-focused-LdQG5D` executor directory. A subsequent
`lsof -nP -iTCP:4391 -sTCP:LISTEN` and `ps -p 19364,19547` returned no entries.
4391 was explicitly released to the coordinator immediately afterward.
No second runtime batch was started. The grant did not authorize a full gate,
push, PR or release. The J4 parent remains open.

## Offline follow-up

The installed Vite source (`dist/node/chunks/node.js`, `resolveHostname`)
defaults an unspecified host to `localhost`. The supervisor supplied no
`--host`. A provider-free local DNS lookup after shutdown returned `::1`
before `127.0.0.1`. This establishes an address-family mismatch risk in the
driver, but cannot recover the failed connection errors from the old run.

The source now passes `--host 127.0.0.1` to the supervised dev command only,
matching both driver endpoints, and retains every readiness status/error/cause.
It distinguishes planned, started and completed fixture episodes and attempts
to retain the supervisor's state receipt even when readiness fails. These
changes have syntax/format evidence only; no second runtime was executed.

## Confirmed cause

On 2026-10-25 the same supervisor on port 4622 answered
`http://localhost:4622/health` while `http://127.0.0.1:4622/health` refused the
connection. Vite bound `localhost` to `::1` only, so the IPv4 driver could
never reach it. `run.mjs --serve` now polls and calls `localhost`, and the
focused driver it replaced is removed. The first dry run through it reached
MCP and passed all seven cases.
