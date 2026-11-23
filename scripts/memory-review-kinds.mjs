import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

// Outside verify: paid OpenRouter calls on synthetic text only. Sends every
// fixture in evals/memory-review/2026-10-29-kinds/fixtures.json to every offered
// model through the production adapter and validator, and records whether the
// returned kind is one the fixture accepts. Answers one question: does the
// prompt keep compatible, conflicting and insufficient-context groups apart?
// Optional fifth and sixth arguments narrow the run to comma-separated fixture
// names and models, for extra repeats of the cases that actually vary.
const [flag, calls, repeatsArg, outDir, onlyFixtures, onlyModels] =
  process.argv.slice(2);
const fixturesPath = resolve(
  "evals/memory-review/2026-10-29-kinds/fixtures.json",
);
const fixtures = JSON.parse(
  await readFile(fixturesPath, "utf8"),
).fixtures.filter(
  (f) => !onlyFixtures || onlyFixtures.split(",").includes(f.name),
);
const repeats = Number(repeatsArg);
if (
  flag !== "--allow-paid-synthetic-calls" ||
  !Number.isInteger(repeats) ||
  repeats < 1 ||
  !outDir ||
  !process.env.OPENROUTER_API_KEY
)
  throw new Error(
    "Usage: node scripts/memory-review-kinds.mjs --allow-paid-synthetic-calls <count> <repeats> <new evidence dir>, with OPENROUTER_API_KEY set.",
  );
const output = await build({
  entryPoints: [
    resolve("app/concepts/memory-review.ts"),
    resolve("app/concepts/memory-review-model.ts"),
  ],
  bundle: true,
  write: false,
  outdir: "out",
  format: "esm",
  platform: "node",
  alias: { "~": resolve("app") },
});
const modules = await Promise.all(
  output.outputFiles.map(
    (file) =>
      import(
        `data:text/javascript;base64,${Buffer.from(file.text).toString("base64")}`
      ),
  ),
);
const { validateReviewProposal } = modules.find(
  (m) => m.validateReviewProposal,
);
const {
  draftMemoryReview,
  reviewReservation,
  NEW_REVIEW_MODELS,
  REVIEW_PROMPT_VERSION,
  REVIEW_SYSTEM,
} = modules.find((m) => m.draftMemoryReview);

const models = NEW_REVIEW_MODELS.filter(
  (m) => !onlyModels || onlyModels.split(",").includes(m),
);
const planned = fixtures.length * models.length * repeats;
if (Number(calls) !== planned)
  throw new Error(`This run makes ${planned} calls; pass exactly that count.`);
const BUDGET_MICROUSD = 1_000_000;

// Same shape the application sends (modelInput in app/concepts/memory-review.ts).
const snapshot = (s) => ({
  source: {
    id: s.id,
    revision: s.revision,
    type: "fact",
    title: s.title,
    body: s.body,
    tags: "[]",
    project: s.project,
    agent: "synthetic-probe",
    client: "local-probe",
    session: null,
    sessionName: null,
    links: [],
  },
});

const realFetch = globalThis.fetch;
let observed;
globalThis.fetch = async (...args) => {
  const response = await realFetch(...args);
  observed = response.clone();
  return response;
};

const report = {
  date: new Date().toISOString(),
  prompt: REVIEW_PROMPT_VERSION,
  system: REVIEW_SYSTEM,
  repeats,
  fixtures: fixtures.map((f) => f.name),
  models,
  retries: 0,
  syntheticOnly: true,
  budgetMicrousd: BUDGET_MICROUSD,
  reservedMicrousd: 0,
  billedUsd: 0,
  unknownCostCalls: 0,
  results: [],
};
for (let repeat = 0; repeat < repeats; repeat++)
  for (const fixture of fixtures)
    for (const model of models) {
      const sources = fixture.sources.map(snapshot);
      const input = JSON.stringify(sources.map(({ source }) => source));
      const reservation = reviewReservation(model, input);
      if (report.reservedMicrousd + reservation > BUDGET_MICROUSD)
        throw new Error("Run budget exhausted");
      report.reservedMicrousd += reservation;
      const result = {
        fixture: fixture.name,
        class: fixture.class,
        model,
        repeat,
        reservationMicrousd: reservation,
      };
      const start = performance.now();
      observed = undefined;
      try {
        result.proposal = await draftMemoryReview(
          { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY },
          model,
          input,
        );
        result.kind = validateReviewProposal(result.proposal, sources).kind;
        result.validated = true;
      } catch (error) {
        result.validated = false;
        result.error = error.message;
      }
      result.pass = result.validated && fixture.accept.includes(result.kind);
      result.latencyMs = Math.round(performance.now() - start);
      if (observed) {
        const body = await observed.json().catch(() => null);
        result.provider = body?.provider ?? null;
        result.usage = body?.usage ?? null;
        if (!result.validated)
          result.raw = body?.choices?.[0]?.message?.content ?? null;
      }
      if (typeof result.usage?.cost === "number")
        report.billedUsd += result.usage.cost;
      else report.unknownCostCalls++;
      report.results.push(result);
      console.log(
        `${result.pass ? "PASS" : "FAIL"} ${fixture.name} ${model} r${repeat} ${result.kind ?? result.error}`,
      );
    }
globalThis.fetch = realFetch;

const tally = {};
for (const r of report.results) {
  const key = `${r.model} ${r.class}`;
  tally[key] ??= { pass: 0, total: 0 };
  tally[key].total++;
  if (r.pass) tally[key].pass++;
}
report.tally = tally;
await mkdir(outDir, { recursive: true });
await writeFile(
  resolve(
    outDir,
    `results-${REVIEW_PROMPT_VERSION}${onlyFixtures || onlyModels ? "-focus" : ""}.json`,
  ),
  `${JSON.stringify(report, null, 2)}\n`,
  { flag: "wx" },
);
console.log(JSON.stringify(tally, null, 1));
console.log(
  `reserved $${(report.reservedMicrousd / 1e6).toFixed(6)}, billed $${report.billedUsd.toFixed(6)}, unknown-cost calls ${report.unknownCostCalls}`,
);
