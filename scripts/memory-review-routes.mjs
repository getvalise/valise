import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

// Outside verify: one paid OpenRouter call per offered model, synthetic text only.
// Proves each route answers through the production adapter with a proposal
// the production validator accepts. Not a quality benchmark.
const [flag, outDir] = process.argv.slice(2);
if (
  flag !== "--allow-three-paid-synthetic-calls" ||
  !outDir ||
  !process.env.OPENROUTER_API_KEY
)
  throw new Error(
    "Usage: node scripts/memory-review-routes.mjs --allow-three-paid-synthetic-calls <new evidence dir>, with OPENROUTER_API_KEY set.",
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
  (module) => module.validateReviewProposal,
);
const {
  draftMemoryReview,
  reviewReservation,
  NEW_REVIEW_MODELS,
  REVIEW_PROMPT_VERSION,
} = modules.find((module) => module.draftMemoryReview);

const BUDGET_MICROUSD = 1_000_000;
const sources = [
  "For the fictional Orchard test project on 2026-10-01, grower Ada claims all apple crates must be kept at exactly 4 degrees Celsius during transport.",
  "For the fictional Orchard test project on 2026-10-01, grower Bo claims all apple crates must be kept at exactly 20 degrees Celsius during transport.",
].map((body, index) => ({
  source: {
    id: `mem_synthetic_contradiction_${index}`,
    revision: 1,
    type: "fact",
    title: `Synthetic contradiction evidence ${index + 1}`,
    body,
    tags: "[]",
    project: "synthetic-live-proof",
    agent: "synthetic-probe",
    client: "local-probe",
    session: null,
    sessionName: null,
    links: [],
  },
}));
const input = JSON.stringify(sources.map(({ source }) => source));
const report = {
  date: new Date().toISOString(),
  prompt: REVIEW_PROMPT_VERSION,
  fixture: "contradiction",
  expected: "contradiction",
  syntheticOnly: true,
  retries: 0,
  budgetMicrousd: BUDGET_MICROUSD,
  reservedMicrousd: 0,
  results: [],
};

// Observe the adapter's own request without changing it: keep a copy of the
// provider response so usage and route are recorded alongside the proposal.
const realFetch = globalThis.fetch;
let observed;
globalThis.fetch = async (...args) => {
  const response = await realFetch(...args);
  observed = response.clone();
  return response;
};

for (const model of NEW_REVIEW_MODELS) {
  const reservation = reviewReservation(model, input);
  if (report.reservedMicrousd + reservation > BUDGET_MICROUSD)
    throw new Error("Probe budget exhausted");
  report.reservedMicrousd += reservation;
  const result = { model, reservationMicrousd: reservation };
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
  result.latencyMs = Math.round(performance.now() - start);
  if (observed) {
    result.httpStatus = observed.status;
    const body = await observed.json().catch(() => null);
    result.provider = body?.provider ?? null;
    result.usage = body?.usage ?? null;
  }
  report.results.push(result);
  console.log(JSON.stringify(result));
}
globalThis.fetch = realFetch;
await mkdir(outDir, { recursive: true });
await writeFile(
  resolve(outDir, "results.json"),
  `${JSON.stringify({ ...report, input }, null, 2)}\n`,
  { flag: "wx" },
);
