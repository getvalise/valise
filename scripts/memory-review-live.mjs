import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { getPlatformProxy } from "wrangler";

// Deliberately outside verify: three paid calls, synthetic constants only.
if (
  process.argv[2] !== "--allow-three-paid-synthetic-calls" ||
  !process.env.CLOUDFLARE_ACCOUNT_ID
) {
  throw new Error(
    "Requires --allow-three-paid-synthetic-calls and an explicitly selected CLOUDFLARE_ACCOUNT_ID.",
  );
}
const cases = [
  {
    name: "compatible-synthesis",
    expected: "summary",
    bodies: [
      "For the fictional Orchard test project, the grower says ripe apples must stay cool, never frozen. This is the grower's claim, not the user's judgment.",
      "For the fictional Orchard test project, the grower says pears must stay dry during transport. This is the grower's claim, not the user's judgment.",
    ],
  },
  {
    name: "contradiction",
    expected: "contradiction",
    bodies: [
      "For the fictional Orchard test project on 2026-10-01, grower Ada claims all apple crates must be kept at exactly 4 degrees Celsius during transport.",
      "For the fictional Orchard test project on 2026-10-01, grower Bo claims all apple crates must be kept at exactly 20 degrees Celsius during transport.",
    ],
  },
  {
    name: "missing-context-noop",
    expected: "noop",
    bodies: [
      "Synthetic incomplete fragment: it should be that way. No referent, date, project or surrounding context was retained.",
      "Synthetic incomplete fragment: they said the other thing. No referent, attribution, date or surrounding context was retained.",
    ],
  },
];
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
  LEGACY_REVIEW_MODELS,
  REVIEW_PROMPT_VERSION,
} = modules.find((module) => module.draftMemoryReview);
const dir = await mkdtemp(resolve(".wrangler/memory-review-live-"));
let platform;
let calls = 0;
let reservedMicrousd = 0;
const report = {
  date: new Date().toISOString(),
  // Preserve this historical Workers AI proof; do not turn it into a provider switch.
  model: LEGACY_REVIEW_MODELS[0],
  prompt: REVIEW_PROMPT_VERSION,
  syntheticOnly: true,
  callLimit: 3,
  budgetMicrousd: 50000,
  retries: 0,
  results: [],
};
try {
  const configPath = join(dir, "wrangler.json");
  // No D1, R2, KV, DO, Vectorize, deployed Worker or secret bindings.
  await writeFile(
    configPath,
    JSON.stringify({
      name: "valise-synthetic-review-probe",
      account_id: process.env.CLOUDFLARE_ACCOUNT_ID,
      compatibility_date: "2026-07-14",
      ai: { binding: "AI" },
    }),
  );
  platform = await getPlatformProxy({
    configPath,
    persist: false,
    envFiles: [],
    remoteBindings: true,
  });
  for (const fixture of cases) {
    const sources = fixture.bodies.map((body, index) => ({
      source: {
        id: `mem_synthetic_${fixture.name}_${index}`,
        revision: 1,
        type: "fact",
        title: `Synthetic ${fixture.name} evidence ${index + 1}`,
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
    const reservation = reviewReservation(report.model, input);
    if (calls >= 3 || reservedMicrousd + reservation > report.budgetMicrousd)
      throw new Error("Probe budget exhausted");
    const result = {
      name: fixture.name,
      expected: fixture.expected,
      reservationMicrousd: reservation,
    };
    try {
      const env = {
        AI: {
          run: async (...args) => {
            calls++;
            reservedMicrousd += reservation;
            // getPlatformProxy cannot serialize a Node AbortSignal. Keep the
            // production request/model untouched, but enforce its deadline on the
            // host rather than transporting that non-POJO across the RPC bridge.
            const [model, input, { signal, ...options }] = args;
            const response = await new Promise((resolve, reject) => {
              const abort = () => reject(signal.reason);
              signal.addEventListener("abort", abort, { once: true });
              platform.env.AI.run(model, input, options)
                .then(resolve, reject)
                .finally(() => signal.removeEventListener("abort", abort));
            });
            result.usage = response?.usage ?? null;
            return response;
          },
        },
      };
      result.raw = await draftMemoryReview(env, report.model, input);
      const proposal = validateReviewProposal(result.raw, sources);
      result.validated = true;
      result.kind = proposal.kind;
      result.matchesExpectedKind = proposal.kind === fixture.expected;
    } catch (error) {
      result.validated = false;
      result.error = error.message;
    }
    report.results.push(result);
    console.log(JSON.stringify(result));
  }
} finally {
  await platform?.dispose();
  await rm(dir, { recursive: true, force: true });
  console.log(JSON.stringify({ ...report, calls, reservedMicrousd }, null, 2));
}
