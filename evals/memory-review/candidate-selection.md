# Candidate selection experiment

Status: offline baseline and bounded live synthetic comparison measured on
2026-10-29. [Live results](2026-10-29-candidates-run1/report.md). Production
selection, provider configuration, consent and budgets unchanged.

## Corpus and scoring

`candidates.ts` defines eight synthetic Kestrel cases, 42 memories in total,
with seven useful anchor-neighbor pairs. Useful means qualified duplicate,
complementary facts about the same concrete subject/workflow, or conflicting
claims about the same subject and scope. Same topic/project and unresolved
referents are negatives. A conflict belongs in human review, not an automatic
merge or an inferred winner. These human-written labels are experiment inputs,
not model judgments or production truth. They have not been independently rated.

Each case has one anchor and four or five neighbors. Three recent unrelated
neighbors crowd older useful ones. Cases cover differently worded duplicates,
compatible grower advice, incompatible claims, different entities/dates,
missing context, injected instructions and qualifications near the end of long
bodies. The corpus is small and adversarial, not a production prevalence estimate.
Positions rotate deterministically; the live plan also reverses candidate order.
Neither ids, timestamps nor labels enter Jev state. Full titles/bodies/projects
do; a request over 24,000 UTF-8 bytes is rejected rather than truncated.

`test/d1/memory-review-candidates.worker.test.ts` seeds a fresh real local D1/FTS,
isolates one pending anchor and calls unchanged `runMemoryReview`. Its injected
drafter records a no-op, not a model decision. Selection comes from persisted
source snapshots, including groups that could be decided locally. Fetch throws;
remote bindings are disabled. No browser/server/production access is involved.

```sh
env -u OPENROUTER_API_KEY -u TYPESAFE_API_KEY npm run test:d1 -- \
  test/d1/memory-review-candidates.worker.test.ts --reporter=verbose
```

The scorer excludes the anchor, deduplicates neighbors and rejects unknown ids.
Recall is null when there are no positive pairs; precision is null on abstention.
Exact-set success requires all useful neighbors and no negatives. Missing-context
negatives count as unsuitable neighbors, not established unrelated facts.
Measurements print without quality floors: a test must not enshrine today's
unrelated selections as the desired behavior. Integrity/contract assertions gate
the test separately from these quality numbers.

## Offline baseline

| Case | Useful available | Current selector: useful / unsuitable | Keyword depth 50: useful / unsuitable |
| --- | ---: | ---: | ---: |
| Duplicate | 1 | 1 / 2 | 1 / 0 |
| Paraphrase | 1 | 0 / 3 | 0 / 0 |
| Compatible | 1 | 0 / 3 | 0 / 0 |
| Conflict | 1 | 1 / 2 | 1 / 0 |
| Same topic, different subject/scope | 0 | 0 / 3 | 0 / 1 |
| Missing context | 0 | 0 / 3 | 0 / 1 |
| Injection distractor | 1 | 1 / 2 | 1 / 1 |
| Long qualifier | 2 | 2 / 1 | 2 / 0 |
| Total | 7 | 5 / 19 | 5 / 3 |

Current neighbor recall is 5/7 and precision 5/24; exact-set success is 0/8.
The wider lexical pool has recall 5/7; its precision is not a selected-group
comparison because it has no three-neighbor cap or relevance threshold.

Both missed pairs have no shared title words with their anchor. `search()`
first requires all query terms and retries OR only if there are zero hits.
The stored anchor matches its own title, so that OR retry never happens here.
Increasing only the limit cannot broaden that query. Recent-project fill sends
three unrelated neighbors instead. This measurement motivates a recall change
and an abstaining ranker; it does not establish vector or Jev quality.

## Bounded live experiment

Compare the current selector, lexical-only pool and lexical/vector union. Reuse
`memoryVectorCandidates()`'s tenant/current-head hydration for eventual runtime
selection. For an initial synthetic offline ANN experiment, embeddings/cosine
over this tiny fixture corpus measure semantic recall only: they cannot prove
Vectorize filtering, projection freshness or tenant isolation. Existing
`test/d1/vector-candidates.worker.test.ts` is separate provider-double boundary
evidence; it does not measure live ranking quality.

Measure Jev twice over the same frozen full synthetic pools: a generic
answer-relevance question versus the joint-review question in `candidates.ts`.
Both share state and use pinned `jev-1.14.0`, not the moving `jev-latest` alias.
Repeat with reversed order: 8 cases × 2 questions × 2 orders = 32 Jev calls.
Full-pool oracle availability is reported separately from actual retrieval recall;
the ranker must not get credit for a useful memory retrieval failed to find.
Measure top-three useful recall, negative leakage and abstention at prespecified
thresholds 0.5, 0.75 and 0.9. Do not choose a production threshold on these same
eight cases; a larger held-out set and repeat runs are needed for that decision.

The owner approved an additional grant: at most 40 external inference requests and $0.10
combined conservative reservations, synthetic text only. At most eight batched
embedding calls plus 32 Jev calls; no retries, generation, production resource
provisioning, settings changes or private corpus. Reserve before every dispatch,
retain failed/unknown spend and persist the ledger. The runner does not support
resume; starting a new output directory does not renew the authorization.
Fail closed on malformed/missing/out-of-range scores or model mismatch.
`scripts/memory-review-candidates.mjs` implements a 64 KiB HTTP response bound,
10-second deadlines, isolated AI-only proxy and reservations before every call.
No live runner or paid call is part of the offline baseline test. The run used
all 40 requests, reserved $0.006893 and made no retries. The grant is exhausted
by count even though most of the dollar allowance remains.

TypeSafe's model/API docs read 2026-10-29 list `jev-1.14.0` at $0.042 per million
input tokens, output free, 64k request/32k question context. At the experiment's
24 KB request cap, one token per UTF-8 byte reserves $0.001008 per Jev call,
or at most $0.032256 for 32 calls. These are current-rate reservations, not an
invoice or protection from a future provider rate increase. Embedding model
availability/rates must be reread from the Cloudflare catalog before reserving.

- <https://docs.typesafe.ai/models>
- <https://docs.typesafe.ai/api>

This is separate from the existing 24-call/$0.50 GLM/Haiku/Sonnet comparison:
eight calls already spent, sixteen unrun, retained in the context-run1 ledger.
The owner corrected BWS access during this session. Both development OpenRouter
and Jev keys were read directly into child-process environments, not arguments,
source or evidence. The [matched context comparison](2026-10-29-context-complete/report.md)
has now used all 24 calls. Do not print keys or copy them into evidence.

## Subjects and repeat coverage

The owner additionally requested subject formation and reported repeated reuse
of the same memory across runs. Existing `memory_subjects` has stable identity,
many-to-many source membership and an optional current summary; Review neither
proposes subjects nor attaches accepted summaries/members automatically.

A provider-free reproduction seeds seven unchanged notes and runs two passes.
Four distinct groups are generated; the same three notes occur in all four,
with byte-identical source fingerprints. Every exact group is unique, so the
existing history/fingerprint protection is working at its documented boundary.
It does not avoid repeated pairs across different four-source groups or show
a per-memory review history. This is a local reproduction of the reported
pattern, not a diagnosis of any particular private production group.

Do not add a single permanent `consolidated` bit to a memory. Comparison is not
integration: an input may be an uncited distractor, a dismissed proposal, an
accepted summary contribution or an explicitly superseded original. A memory
may also support multiple subjects and gain genuinely new neighboring evidence.
Coverage needs source revisions/fingerprints, review id, decision, cited versus
merely compared status, and subject/summary context where one exists. Show prior
reviews and the reason for revisiting unchanged text. Candidate scheduling should
prefer uncovered relationships and avoid resubmitting already-covered pairs
merely because the third/fourth neighbor rotated; preserve new-evidence paths.

Subject formation is a different human-approved action from consolidation:
propose a stable named subject or an existing-subject attachment, list proposed
members, and optionally nominate the accepted summary as current understanding.
Do not promote all compared inputs into members, silently replace an existing
summary, or infer supersession. Creating/attaching subject metadata, accepted
memory, membership evidence and their projections must share the same stale-
source/optimistic write boundary. The interaction contract, version-aware
coverage mechanism and failure/restore behavior still need implementation and
desktop/mobile evidence. Neither behavior is shipped by this experiment slice.

## Production boundary still to implement

After quality earns a change, selecting hybrid ranking must separately disclose
Workers AI embedding and TypeSafe/Jev transmission; OpenRouter synthesis consent
does not authorize either. Default populated view and Run review stay as shipped.
Provider, model/version, input scope, daily ranking requests/USD reservations and
separate synthesis limits belong in settings; ranking permission defaults off.
Changing a ranking destination revokes its permission and overnight execution.
Old settings are not migrated into consent. Every dispatch must recheck the
current account, lease, destination and permission after reserving its budget.

Rank lazily within the existing two-group pass, not all eight anchors before
discovering the generation budget is exhausted. Keep tenant/project scope,
source fingerprints and human-confirmed supersession exclusions. No new
all-pairs/corpus scan or automatic re-embedding. Ranker failure/timeout must stop
that anchor without clearing eligibility or silently calling another provider;
retain its reservation and disclose the safe failure. A legacy lexical path
remains available only as an explicit choice, never disguised as successful Jev.

Persist bounded candidate provenance: retrieval methods, actual ranker version,
scores, threshold, included/omitted ids and full-source size refusals. The pane
must distinguish selection evidence from source authority and model synthesis.
Absence of a useful candidate is not a conclusion that no relevant memory exists.
Human approval, exact quotes, append-only revisions and original model output
remain the acceptance boundary. Consent races, restore-to-off behavior and
ranking-budget recovery need tests before a production change. No user-facing
ranking screen ships in this experiment-only slice.
