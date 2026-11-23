import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { loadReviewComparisonModule } from "../../scripts/memory-review-context-module.mjs";

test("comparison validation and diagnostics share one failure class without inference", async () => {
  const { validateReviewProposal, reviewFailureCode } =
    await loadReviewComparisonModule();
  for (const [input, code] of [
    [null, "invalid-schema"],
    [
      {
        kind: "summary",
        title: "Synthetic",
        body: "Synthetic",
        why: "Synthetic",
        evidence: [],
      },
      "invalid-evidence",
    ],
  ]) {
    assert.throws(
      () => validateReviewProposal(input, []),
      (error) => reviewFailureCode(error) === code,
    );
  }
});

test("retained candidate run reconciles all reservations within its separate grant", async () => {
  const r = JSON.parse(
    await readFile(
      new URL(
        "../../evals/memory-review/2026-10-29-candidates-run1/results.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(r.syntheticOnly, true);
  assert.equal(r.calls, 40);
  assert.equal(r.results.length, r.calls);
  assert.equal(r.results.filter((x) => x.kind === "embedding").length, 8);
  assert.equal(r.results.filter((x) => x.kind === "ranking").length, 32);
  assert.equal(r.retries, 0);
  assert.equal(
    r.reservedMicrousd,
    r.results.reduce((sum, x) => sum + x.reservationMicrousd, 0),
  );
  assert.ok(r.reservedMicrousd <= 100000);
  assert.equal(
    new Set(
      r.results.map((x) =>
        JSON.stringify([x.kind, x.fixture, x.question, x.reverse]),
      ),
    ).size,
    40,
  );
  for (const x of r.results) {
    assert.equal(x.state, "finished");
    assert.ok(x.inputBytes > 0 && x.inputBytes <= 24000);
    assert.equal(
      x.reservationMicrousd,
      Math.ceil(x.inputBytes * r.ratesPerMillion[x.kind]),
    );
  }
});

test("completed context run carries spent GLM calls rather than renewing its original grant", async () => {
  const read = async (name) =>
    JSON.parse(
      await readFile(
        new URL(
          `../../evals/memory-review/${name}/results.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
  const prior = await read("2026-10-29-context-run1");
  const r = await read("2026-10-29-context-complete");
  assert.equal(r.calls, 24);
  assert.equal(r.results.length, 24);
  assert.equal(r.retries, 0);
  assert.equal(r.system, prior.system);
  assert.deepEqual(r.fixtures, prior.fixtures);
  assert.deepEqual(r.results.slice(0, 8), prior.results);
  assert.equal(
    new Set(r.results.map((x) => `${x.fixture}/${x.model}`)).size,
    24,
  );
  assert.equal(
    r.reservedMicrousd,
    r.results.reduce((sum, x) => sum + x.reservationMicrousd, 0),
  );
  assert.ok(r.reservedMicrousd <= 500000);
});
