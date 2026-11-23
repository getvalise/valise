# Actual-adapter memory journey: incomplete

Model/default release and its full gate are blocked on an owner/product decision
about this failed compatible-proposal acceptance. Production remains `9487c2f`
without the branch's Haiku default. This specific failure is a release blocker;
one case does not establish that Haiku is generally worse than another model.

Runner/server: `5676edd688a2599aff09b8fde90a0f96610a07a6`.
Origin: `http://localhost:4241`, fresh synthetic local D1/R2/KV/coordinators,
remote AI and Vectorize removed. Model: `anthropic/claude-haiku-5.5` through
the actual Worker adapter; prompt: `memory-review-1`. No production user,
private corpus, production consent or remote resource provisioning was used.

```sh
node scripts/memory-review-journey.mjs --allow-four-paid-synthetic-calls 4241 <new-private-evidence-directory>
```

The sole authorized execution returned exit 1 after 31.46 seconds on
2026-10-24 at 22:20:21 UTC. Two manual passes dispatched three provider requests:

| Pass | Calls | Proposals / no-ops / failed | Wall time | Stop |
| --- | ---: | --- | ---: | --- |
| 1 | 2 | 1 / 1 / 0 | 5,214 ms | Expected two-call pass limit |
| 2 | 1 | 1 / 0 / 0 | 2,611 ms | None |

All three responses passed the application's strict schema/evidence validation.
Their conservative D1 reservations total 3,015 micro-USD ($0.003015), not an
invoice. Billed tokens, individual provider latency and billed cost are unknown.
Three of the owner's four additional request slots were used. The remaining
slot did not authorize another execution, and no further request was made.

## Semantic failure

The compatible source pair said, with fictional grower Ada's attribution and
the same date, that only ripe apples stay cool and never frozen, and that pears
stay dry during transport. Haiku returned `kind: "contradiction"`, titled
“Conflicting claims about pear and apple storage from the same grower”. Its own
explanation said:

> These do not directly contradict each other, since they concern different
> fruits and different properties (dryness in transport versus temperature).

The asserted kind is a false conflict. The journey's requirement for a usable
compatible summary/consolidation failed; the runner did not relabel the output,
seed a substitute proposal, relax the assertion or retry for a green result.
The genuinely conflicting blue-crate pair returned a contradiction without
choosing a winner. The insufficient-context fragments returned a no-op.

[`responses.json`](responses.json) retains all three decoded model outputs
without changing their text or kind. [`sources.json`](sources.json) retains the
synthetic source IDs, revision generations, attribution and claim text copied
from the actual snapshots. These are observed artifacts, not passing fixtures
or a seeded replacement. Full stamps/fingerprints and receipts remain in the
private original report. The copied proposal objects were compared with that
report, and the retained bytes were scanned for the operator key.

Exact proposal JSON SHA-256:

| Fixture | Kind | SHA-256 |
| --- | --- | --- |
| Compatible | contradiction, wrong | `e687c4b70b901372443155104066340df5bed73aa0f62de47c8658d8520e483a` |
| Conflicting | contradiction | `6f889369bdb0bb58480942e31000ae32ea3d5638087c0735787b9e0cdc1ed2c0` |
| Insufficient | noop | `dc6592eb9adb4a4502abacc29c7340633c2696c6e0a3b876bbd50b3bfc8a4083` |

## Earlier harness failures

| Head | Observed result | Evidence boundary |
| --- | --- | --- |
| `52f812a` | 70 D1 tests and four backup regressions passed, including the real local 30-table D1/R2 drill in 35.98 seconds with its unchanged 180-second timeout. Browser setup then failed: login returned invalid credentials, settings returned 503 for missing session secret. | The run's `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false` suppressed required synthetic process-env secrets. Zero browser passes, one failure, 16 not run; no provider requests. Not a model failure. |
| `8aa1ebb` | Provider-free browser-only rerun passed 17/17 with both inherited OpenRouter key names removed and the default dotenv loader. | Seeded evidence cards only. Successful in-memory screenshot attachments were not retained by the list reporter; no visual acceptance was claimed. No inference. |
| `18dfc6e` | The first authorized actual-adapter runner stopped after 15.0 seconds before any manual pass: Node Fetch's boolean `Response.ok` was incorrectly called as a method. | Authenticated browser setup succeeded, but no actual adapter call or reservation occurred. Both opt-ins ended off and only the owned state/key/config were removed. `5676edd` corrected the assertion under a separate fresh grant. |

The initial actual-run failure report remains at
`/private/var/folders/75/p5ymw8gs2nl_ww1fkqkvytlc0000gn/T/opencode/haiku-j2-18dfc6e-s2pb3p_h/journey/report.json`,
SHA-256 `57941047f936b95c16fde42b33a95ce37117dcfe656c2e0df54ced4778df89da`.
The provider-free failure and successful browser logs remain in
`haiku-focus-52f812a-wuf35m9m` and `haiku-browser-8aa1ebb-ohhx0ymj` beneath the
same private `T/opencode` directory, with diagnosis/cleanup/hash manifests.
These earlier failures are not erased by the later real provider result.

## Proof boundary and cleanup

Authenticated browser consent, selected-provider availability, persisted bounded
settings, real manual dispatch, strict response/evidence validation, accounting
and off/cleanup were exercised. Actual proposal-card quote inspection, human
edit/accept, accepted-memory fresh-client retrieval, original-row/history
invariance after approval and native 320px contradiction approval were not
reached. This is neither a completed local journey nor deployed OAuth proof.

`consent-off.png` was actually viewed: the authenticated Memories Review page,
Haiku, both switches off and synthetic limits are visible. It caught a pending
cost save (`Working…`, old $0.01 summary versus the 20,000 input), so it does not
prove settled persisted limits. The runner separately checked persisted
four-call/20,000-micro-USD caps before dispatch. No proposal/accepted screenshot
was produced. The earlier provider-free browser suite passed 17/17 at `8aa1ebb`;
its seeded cards do not replace this missing actual-provider journey proof.

Both opt-ins ended off. The owned server exited, port 4241 was released, and
only the runner's temporary key/config/local state was removed. Retained
artifacts passed a byte scan for the existing operator key. No key is included.

Private evidence directory:
`/private/var/folders/75/p5ymw8gs2nl_ww1fkqkvytlc0000gn/T/opencode/haiku-j2-5676edd-txc5uxa_`.
It retains original source snapshots, raw proposal JSON/receipts, report,
startup log, screenshot, review, cleanup observations and SHA-256 manifest.

| Artifact | SHA-256 |
| --- | --- |
| `journey/report.json` | `608ba5d02d6d1ceeb6425b58706711eaf5620774112fd0b4cb192e9b88c9f4c7` |
| `run.log` | `68ddd578f47d03904cfad167bab3ce8c147d04c9444c961dc6a8a3add12a4ddf` |
| `journey/consent-off.png` | `b0deb7248410f669fd7db3e847326145cb3fc5b8872f87dfa84a9d74dd9ffaad` |

J2 evidence belongs to `todo:tdo_dcd7f6e3-46b8-42d1-a4d9-fcfaf37e8b45`;
model delivery belongs to `todo:tdo_90b0405a-0332-41d8-afbf-470cc00bf762`.
