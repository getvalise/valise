import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Offline only: no inference, secrets, network or repaired proposals.
const dir = resolve(
  process.argv[2] || "evals/memory-review/2026-10-24-shortlist",
);
const run = JSON.parse(await readFile(resolve(dir, "results.json"), "utf8"));
assert.equal(
  run.calls,
  54,
  "Summarize the completed authorized run, not an interim subset.",
);
assert.equal(run.results.length, 54);
const ids = [...new Set(run.results.map((r) => r.model))];
assert.equal(ids.length, 3);
assert.equal(
  new Set(run.results.map((r) => `${r.model}/${r.case}/${r.repeat}`)).size,
  54,
);
const sum = (rows, get) => rows.reduce((s, x) => s + (get(x) ?? 0), 0);
const quantile = (sorted, p) => sorted[Math.ceil(p * sorted.length) - 1];
const median = (sorted) =>
  sorted.length % 2
    ? sorted[Math.floor(sorted.length / 2)]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
// The raw runner groups all HTTP4xx as configuration-or-access. Separate
// upstream pool capacity from genuine parameter/access/retention failures here.
const failureClass = (row) =>
  row.httpStatus === 429 ? "upstream-rate-limit" : (row.failureClass ?? null);
const summary = {
  calls: run.calls,
  hardBudgetUsd: run.hardBudgetUsd,
  totalReservedUsd: run.totalReservedUsd,
  reportedCostUsd: run.reportedCostUsd,
  unknownCostReservedUsd: run.unknownCostReservedUsd,
  reportedPlusUnknownBoundUsd: run.reportedPlusUnknownBoundUsd,
  models: ids.map((model) => {
    const rows = run.results.filter((x) => x.model === model);
    const latencies = rows.map((x) => x.latencyMs).sort((a, b) => a - b);
    const successfulLatencies = rows
      .filter((x) => x.validated)
      .map((x) => x.latencyMs)
      .sort((a, b) => a - b);
    return {
      model,
      attempts: rows.length,
      proposals: rows.filter((x) => x.proposal).length,
      schemaValid: rows.filter((x) => x.schemaValid).length,
      evidenceValid: rows.filter((x) => x.evidenceValid).length,
      expectedKind: rows.filter((x) => x.matchesExpectedKind).length,
      medianMs: median(latencies),
      p90Ms: quantile(latencies, 0.9),
      p95Ms: quantile(latencies, 0.95),
      maxMs: latencies.at(-1),
      successfulMedianMs: successfulLatencies.length
        ? median(successfulLatencies)
        : null,
      successfulP95Ms: successfulLatencies.length
        ? quantile(successfulLatencies, 0.95)
        : null,
      timeouts: rows.filter((x) => x.failureClass === "timeout").length,
      upstreamRateLimits: rows.filter(
        (x) => failureClass(x) === "upstream-rate-limit",
      ).length,
      configurationFailures: rows.filter(
        (x) => failureClass(x) === "configuration-or-access",
      ).length,
      unknownCostAttempts: rows.filter((x) => typeof x.usage?.cost !== "number")
        .length,
      reportedCostUsd: sum(rows, (x) => x.usage?.cost),
      unknownCostReservedUsd: sum(
        rows.filter((x) => typeof x.usage?.cost !== "number"),
        (x) => x.reservationUsd,
      ),
      catalogTokenEstimateUsd: sum(rows, (x) => x.catalogTokenEstimateUsd),
      promptTokens: sum(rows, (x) => x.usage?.prompt_tokens),
      completionTokens: sum(rows, (x) => x.usage?.completion_tokens),
      reasoningTokens: sum(
        rows,
        (x) => x.usage?.completion_tokens_details?.reasoning_tokens,
      ),
      cachedPromptTokens: sum(
        rows,
        (x) => x.usage?.prompt_tokens_details?.cached_tokens,
      ),
      cacheWriteTokens: sum(
        rows,
        (x) => x.usage?.prompt_tokens_details?.cache_write_tokens,
      ),
      providers: [
        ...new Set(rows.map((x) => x.response?.provider).filter(Boolean)),
      ],
      resolvedModels: [
        ...new Set(rows.map((x) => x.response?.model).filter(Boolean)),
      ],
      finishReasons: [
        ...new Set(
          rows
            .map((x) => x.response?.choices?.[0]?.finish_reason)
            .filter(Boolean),
        ),
      ],
      errors: rows
        .filter((x) => x.error || x.validationError)
        .map((x) => ({
          case: x.case,
          repeat: x.repeat,
          failureClass: failureClass(x),
          rawFailureClass: x.failureClass,
          providerErrorCode: x.response?.error?.metadata?.provider_error_code,
          limitSource: x.response?.error?.metadata?.limit_source,
          error: x.error,
          validationError: x.validationError,
        })),
      matrix: [...new Set(rows.map((x) => x.case))].map((name) => ({
        case: name,
        repeats: rows
          .filter((x) => x.case === name)
          .sort((a, b) => a.repeat - b.repeat)
          .map((x) => ({
            repeat: x.repeat,
            schemaValid: x.schemaValid ?? false,
            evidenceValid: x.evidenceValid ?? false,
            kind: x.proposal?.kind ?? null,
            matchesExpectedKind: x.matchesExpectedKind ?? false,
            failureClass: failureClass(x),
            latencyMs: x.latencyMs,
          })),
      })),
    };
  }),
};
assert(summary.reportedPlusUnknownBoundUsd <= 1);
for (const model of summary.models) assert.equal(model.attempts, 18);
await writeFile(
  resolve(dir, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));
