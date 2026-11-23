import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

// Explicit fresh shortlist authorization only. No private corpus or Worker bindings.
if (
  process.argv[2] !== "--allow-54-paid-synthetic-calls" ||
  !process.env.OPENROUTER_API_KEY
)
  throw new Error(
    "Requires --allow-54-paid-synthetic-calls and inherited OPENROUTER_API_KEY.",
  );
const dir = resolve(
  process.argv[3] || "evals/memory-review/2026-10-24-shortlist",
);
await mkdir(dir, { recursive: true });
try {
  await access(resolve(dir, "results.json"));
  throw new Error(
    "Existing results cannot be overwritten; choose a fresh directory.",
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const sourcePaths = [
  "app/concepts/memory-review-model.ts",
  "app/concepts/memory-review.ts",
];
const sourceHashes = {};
for (const path of sourcePaths) {
  const bytes = await readFile(path);
  assert.equal(
    sha256(bytes),
    sha256(execFileSync("git", ["show", `origin/main:${path}`])),
    "Production source differs from current origin/main",
  );
  sourceHashes[path] = sha256(bytes);
}
const fixturePath = "evals/memory-review/2026-10-24/fixtures.json";
const fixtureBytes = await readFile(fixturePath);
const fixtureData = JSON.parse(fixtureBytes);
const { fixtures } = fixtureData;
const built = await build({
  entryPoints: sourcePaths.map((p) => resolve(p)),
  bundle: true,
  write: false,
  outdir: "out",
  format: "esm",
  platform: "node",
  alias: { "~": resolve("app") },
});
const modules = await Promise.all(
  built.outputFiles.map(
    (f) =>
      import(
        `data:text/javascript;base64,${Buffer.from(f.text).toString("base64")}`
      ),
  ),
);
const { validateReviewProposal } = modules.find(
  (m) => m.validateReviewProposal,
);
const {
  REVIEW_SYSTEM,
  REVIEW_PROMPT_VERSION,
  REVIEW_INPUT_BYTES,
  REVIEW_OUTPUT_TOKENS,
  reviewProposalSchema,
} = modules.find((m) => m.REVIEW_SYSTEM);
assert.equal(fixtureData.system, REVIEW_SYSTEM);
assert.equal(fixtureData.promptVersion, REVIEW_PROMPT_VERSION);
assert.equal(fixtures.length, 6);
await writeFile(resolve(dir, "fixtures.json"), fixtureBytes);
const ids = [
  "anthropic/claude-haiku-5.5",
  "openai/gpt-6-luna",
  "deepseek/deepseek-v4.1-flash-1017",
];
const catalogResponse = await fetch("https://openrouter.ai/api/v1/models");
if (!catalogResponse.ok) throw new Error("Catalog unavailable");
const catalog = await catalogResponse.json();
const models = ids.map((id) => {
  const m = catalog.data.find((m) => m.id === id);
  if (!m) throw new Error(`Missing exact model ${id}`);
  return m;
});
for (const m of models) {
  assert(m.supported_parameters.includes("reasoning"));
  assert(m.supported_parameters.includes("response_format"));
  assert(!m.reasoning?.mandatory, "This shortlist requires optional reasoning");
  assert(m.reasoning?.supported_efforts?.includes("none"));
}
await writeFile(
  resolve(dir, "catalog.json"),
  JSON.stringify(
    {
      fetchedAt: new Date().toISOString(),
      source: "https://openrouter.ai/api/v1/models",
      models,
    },
    null,
    2,
  ),
);
const config = {
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  originMain: execFileSync("git", ["rev-parse", "origin/main"], {
    encoding: "utf8",
  }).trim(),
  sourceHashes,
  fixtureSource: fixturePath,
  fixtureFileSha256: sha256(fixtureBytes),
  fixtureCanonicalSha256: sha256(JSON.stringify(fixtureData)),
  promptSha256: sha256(REVIEW_SYSTEM),
  runnerSha256: sha256(await readFile("scripts/memory-review-shortlist.mjs")),
  syntheticOnly: true,
  maxCalls: 54,
  repeats: 3,
  concurrency: 1,
  retries: 0,
  hardBudgetUsd: 1,
  inputBytes: REVIEW_INPUT_BYTES,
  maxOutputTokens: REVIEW_OUTPUT_TOKENS,
  timeoutMs: 30_000,
  responseBytes: 65536,
  reasoning: { enabled: false },
  ordering:
    "Sequential balanced Latin rotation: model position=(repeat-1+caseIndex+offset)%3; each model occupies each within-case position once across repeats. No parallel provider load burst.",
  pricing:
    "Router caps use fetched base rates (October24 weekend). Conservative reservations include every override reachable within24KB, including DeepSeek weekday peak. Cache discounts are not assumed.",
};
const rates = (model) => {
  const base = {
    prompt: Number(model.pricing.prompt),
    completion: Number(model.pricing.completion),
  };
  // One token per byte bound makes high-context Haiku/Luna overrides unreachable.
  const reachable = (model.pricing.overrides ?? []).filter(
    (o) => !o.min_prompt_tokens || o.min_prompt_tokens <= REVIEW_INPUT_BYTES,
  );
  return {
    base,
    bound: {
      prompt: Math.max(
        base.prompt,
        ...reachable.map((o) => Number(o.prompt ?? base.prompt)),
      ),
      completion: Math.max(
        base.completion,
        ...reachable.map((o) => Number(o.completion ?? base.completion)),
      ),
    },
  };
};
const reservationFor = (model, bytes) => {
  const { bound } = rates(model);
  return bytes * bound.prompt + REVIEW_OUTPUT_TOKENS * bound.completion;
};
const plannedBound = models.reduce(
  (total, model) =>
    total +
    fixtures.reduce(
      (sum, f) =>
        sum +
        3 *
          reservationFor(
            model,
            Buffer.byteLength(
              REVIEW_SYSTEM + JSON.stringify(f.sources.map((s) => s.source)),
            ),
          ),
      0,
    ),
  0,
);
assert(plannedBound <= config.hardBudgetUsd);
config.plannedConservativeBoundUsd = plannedBound;
await writeFile(resolve(dir, "config.json"), JSON.stringify(config, null, 2));
const results = [];
let totalReserved = 0;
const knownCost = () =>
  results.reduce(
    (s, x) => s + (typeof x.usage?.cost === "number" ? x.usage.cost : 0),
    0,
  );
const unknownBound = () =>
  results.reduce(
    (s, x) => s + (typeof x.usage?.cost === "number" ? 0 : x.reservationUsd),
    0,
  );
for (let repeat = 1; repeat <= 3; repeat++)
  for (let caseIndex = 0; caseIndex < fixtures.length; caseIndex++)
    for (let offset = 0; offset < models.length; offset++) {
      const fixture = fixtures[caseIndex];
      const model = models[(repeat - 1 + caseIndex + offset) % models.length];
      const input = JSON.stringify(fixture.sources.map((s) => s.source));
      const inputBytes = Buffer.byteLength(REVIEW_SYSTEM + input);
      const reservationUsd = reservationFor(model, inputBytes);
      assert(inputBytes <= REVIEW_INPUT_BYTES);
      assert(results.length < 54);
      assert(
        knownCost() + unknownBound() + reservationUsd <= 1,
        "Reported cost plus unknown reservations would exceed $1",
      );
      totalReserved += reservationUsd;
      assert(totalReserved <= 1);
      const { base } = rates(model);
      const request = {
        model: model.id,
        messages: [
          { role: "system", content: REVIEW_SYSTEM },
          { role: "user", content: input },
        ],
        max_tokens: REVIEW_OUTPUT_TOKENS,
        reasoning: { enabled: false },
        response_format: { type: "json_object" },
        ...(model.supported_parameters.includes("temperature")
          ? { temperature: 0.1 }
          : {}),
        provider: {
          allow_fallbacks: false,
          data_collection: "deny",
          max_price: {
            prompt: base.prompt * 1e6,
            completion: base.completion * 1e6,
          },
        },
      };
      const result = {
        sequence: results.length + 1,
        model: model.id,
        case: fixture.name,
        repeat,
        position: offset + 1,
        expected: fixture.expected,
        inputBytes,
        reservationUsd,
        request,
        startedAt: new Date().toISOString(),
      };
      const start = performance.now();
      let stage = "transport";
      try {
        const response = await fetch(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            method: "POST",
            signal: AbortSignal.timeout(30_000),
            headers: {
              authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(request),
          },
        );
        result.httpStatus = response.status;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let size = 0;
        let text = "";
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 65536) throw new Error("Response exceeds64KiB");
            text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          await reader.cancel();
        }
        result.rawResponseText = text;
        stage = "response-json";
        result.response = JSON.parse(text);
        result.usage = result.response.usage ?? null;
        result.catalogTokenEstimateUsd = result.usage
          ? result.usage.prompt_tokens * base.prompt +
            result.usage.completion_tokens * base.completion
          : null;
        if (!response.ok || result.response.error) {
          stage =
            response.status >= 400 && response.status < 500
              ? "configuration-or-access"
              : "provider";
          throw new Error(
            `HTTP${response.status}: ${JSON.stringify(result.response.error)}`,
          );
        }
        stage = "proposal-json";
        result.proposal = JSON.parse(
          result.response.choices[0].message.content,
        );
        const schema = reviewProposalSchema.safeParse(result.proposal);
        result.schemaValid = schema.success;
        if (!schema.success) result.schemaError = schema.error.message;
        try {
          validateReviewProposal(result.proposal, fixture.sources);
          result.evidenceValid = true;
          result.validated = true;
        } catch (error) {
          result.evidenceValid = false;
          result.validated = false;
          result.validationError = error.message;
        }
        result.matchesExpectedKind = result.proposal.kind === fixture.expected;
      } catch (error) {
        result.error = error.message;
        result.failureClass =
          error.name === "TimeoutError" || error.name === "AbortError"
            ? "timeout"
            : stage;
      }
      result.latencyMs = Math.round(performance.now() - start);
      result.finishedAt = new Date().toISOString();
      results.push(result);
      await writeFile(
        resolve(dir, "results.json"),
        JSON.stringify(
          {
            ...config,
            updatedAt: new Date().toISOString(),
            calls: results.length,
            totalReservedUsd: totalReserved,
            reportedCostUsd: knownCost(),
            unknownCostReservedUsd: unknownBound(),
            reportedPlusUnknownBoundUsd: knownCost() + unknownBound(),
            results,
          },
          null,
          2,
        ),
      );
      console.log(
        JSON.stringify({
          sequence: result.sequence,
          model: result.model,
          case: result.case,
          repeat,
          schema: result.schemaValid,
          valid: result.validated,
          kind: result.proposal?.kind,
          ms: result.latencyMs,
          cost: result.usage?.cost,
          failureClass: result.failureClass,
          error: result.error,
        }),
      );
      assert(
        knownCost() + unknownBound() <= 1,
        "Provider-reported cost plus unknown bounds exceeds $1; stop before further dispatch",
      );
    }
