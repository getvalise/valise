import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getPlatformProxy } from "wrangler";
import {
  CANDIDATE_CASES,
  CANDIDATE_JEV_MODEL,
  candidateRankingRequest,
  candidateRankingScores,
  scoreCandidates,
} from "../evals/memory-review/candidates.ts";

// Outside verify. Only hard-coded synthetic fixtures; no input file, database,
// server, production Vectorize binding, resource provisioning or generation.
const [flag, out] = process.argv.slice(2);
if (
  flag !== "--allow-40-synthetic-calls-under-10-cents" ||
  !out ||
  !process.env.CLOUDFLARE_ACCOUNT_ID ||
  !process.env.TYPESAFE_API_KEY
)
  throw new Error(
    "Requires bounded grant, new output directory and configured providers",
  );
await mkdir(out, { recursive: false }); // Never overwrite a ledger or restart in place.
// Catalog read through `npx wrangler ai models list --json`, 2026-10-29.
const embeddingModel = "@cf/baai/bge-m3";
const report = {
  date: new Date().toISOString(),
  syntheticOnly: true,
  corpusSha256: createHash("sha256")
    .update(JSON.stringify(CANDIDATE_CASES))
    .digest("hex"),
  models: { embedding: embeddingModel, ranking: CANDIDATE_JEV_MODEL },
  ratesPerMillion: { embedding: 0.0118, ranking: 0.042 },
  callLimit: 40,
  budgetMicrousd: 100000,
  calls: 0,
  reservedMicrousd: 0,
  retries: 0,
  fixtures: CANDIDATE_CASES,
  results: [],
};
const persist = () =>
  writeFile(join(out, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
await persist();
const bytes = (text) => Buffer.byteLength(text, "utf8");
async function reserve(kind, fixture, inputBytes) {
  if (!Number.isSafeInteger(inputBytes) || inputBytes < 1 || inputBytes > 24000)
    throw new Error("Input byte budget exceeded");
  // One input token per UTF-8 byte, output free for both models.
  const reservationMicrousd = Math.ceil(
    inputBytes * report.ratesPerMillion[kind],
  );
  if (
    report.calls >= report.callLimit ||
    report.reservedMicrousd + reservationMicrousd > report.budgetMicrousd
  )
    throw new Error("Hard research cap reached");
  const row = {
    kind,
    fixture,
    inputBytes,
    reservationMicrousd,
    state: "reserved",
  };
  report.calls++;
  report.reservedMicrousd += reservationMicrousd;
  report.results.push(row);
  await persist(); // Reservation and ambiguous spend survive process failure.
  return row;
}
async function boundedJson(response) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`http-${response.status}`); // Never provider bodies/headers.
  }
  if (!response.body) throw new Error("missing-response");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 65536) throw new Error("response-too-large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid-json");
  }
}
function normalized(vector) {
  if (
    !Array.isArray(vector) ||
    vector.length !== 1024 ||
    vector.some((n) => !Number.isFinite(n))
  )
    throw new Error("invalid-vector");
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm === 0) throw new Error("invalid-vector");
  return vector.map((n) => n / norm);
}
const text = (m) => `${m.title}\n\n${m.body}`;
const vectorPools = new Map();
await mkdir(resolve(".wrangler"), { recursive: true });
const dir = await mkdtemp(resolve(".wrangler/memory-candidates-"));
let platform;
try {
  const configPath = join(dir, "wrangler.json");
  await writeFile(
    configPath,
    JSON.stringify({
      name: "valise-synthetic-candidate-probe",
      account_id: process.env.CLOUDFLARE_ACCOUNT_ID,
      compatibility_date: "2026-10-29",
      ai: { binding: "AI" },
    }),
  );
  platform = await getPlatformProxy({
    configPath,
    persist: false,
    envFiles: [],
    remoteBindings: true,
  });
  for (const fixture of CANDIDATE_CASES) {
    const memories = [fixture.anchor, ...fixture.candidates];
    const input = { text: memories.map(text) };
    const row = await reserve(
      "embedding",
      fixture.name,
      bytes(JSON.stringify(input)),
    );
    const start = performance.now();
    let timer;
    try {
      // Node enforces the deadline; the proxy cannot serialize an AbortSignal.
      const output = await Promise.race([
        platform.env.AI.run(embeddingModel, input),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("embedding-timeout")),
            10000,
          );
        }),
      ]);
      if (
        !Array.isArray(output?.data) ||
        output.data.length !== memories.length
      )
        throw new Error("invalid-embedding-response");
      const vectors = output.data.map(normalized);
      const ranking = fixture.candidates
        .map((m, i) => ({
          id: m.id,
          score: vectors[0].reduce((s, n, j) => s + n * vectors[i + 1][j], 0),
        }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      row.ranking = ranking;
      row.top3Score = scoreCandidates(
        fixture,
        ranking.slice(0, 3).map((r) => r.id),
      );
      vectorPools.set(
        fixture.name,
        ranking.slice(0, 3).map((r) => r.id),
      );
      row.state = "finished";
    } catch (error) {
      row.state = "failed";
      row.error =
        error instanceof Error &&
        [
          "embedding-timeout",
          "invalid-vector",
          "invalid-embedding-response",
        ].includes(error.message)
          ? error.message
          : "embedding-provider-failed";
      throw new Error("Embedding experiment stopped; inspect safe ledger");
    } finally {
      clearTimeout(timer);
      row.latencyMs = Math.round(performance.now() - start);
      await persist();
    }
  }
  // Same full pool, two question variants and two candidate orders. Post-hoc
  // intersection with vector top3 is an ablation, not actual retrieved-pool input.
  for (const fixture of CANDIDATE_CASES)
    for (const question of ["search-relevance", "joint-review"])
      for (const reverse of [false, true]) {
        const { request, candidateIds } = candidateRankingRequest(
          fixture,
          question,
          reverse,
        );
        const body = JSON.stringify(request);
        const row = await reserve("ranking", fixture.name, bytes(body));
        row.question = question;
        row.reverse = reverse;
        await persist();
        const start = performance.now();
        try {
          const response = await fetch("https://api.typesafe.ai/v1/systemone", {
            method: "POST",
            headers: {
              authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`,
              "content-type": "application/json",
            },
            body,
            signal: AbortSignal.timeout(10000),
            redirect: "error",
          });
          const output = await boundedJson(response);
          const scores = candidateRankingScores(output, candidateIds.length);
          row.model = output.model;
          row.usage = output.usage ?? null;
          row.ranking = candidateIds
            .map((id, i) => ({ id, score: scores[i] }))
            .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
          row.thresholds = Object.fromEntries(
            [0.5, 0.75, 0.9].map((t) => [
              t,
              scoreCandidates(
                fixture,
                row.ranking
                  .filter((r) => r.score >= t)
                  .slice(0, 3)
                  .map((r) => r.id),
              ),
            ]),
          );
          row.vectorTop3Intersection = Object.fromEntries(
            [0.5, 0.75, 0.9].map((t) => [
              t,
              scoreCandidates(
                fixture,
                row.ranking
                  .filter(
                    (r) =>
                      vectorPools.get(fixture.name).includes(r.id) &&
                      r.score >= t,
                  )
                  .slice(0, 3)
                  .map((r) => r.id),
              ),
            ]),
          );
          row.state = "finished";
        } catch (error) {
          row.state = "failed";
          row.error =
            error instanceof Error && /^http-\d{3}$/.test(error.message)
              ? error.message
              : "ranking-response-failed";
          // Stop on an infrastructure/schema failure, not a paid retry or fallback.
          throw new Error("Ranking experiment stopped; inspect safe ledger");
        } finally {
          row.latencyMs = Math.round(performance.now() - start);
          await persist();
        }
        console.log(
          JSON.stringify({
            fixture: fixture.name,
            question,
            reverse,
            state: row.state,
          }),
        );
      }
} finally {
  await platform?.dispose();
  await rm(dir, { recursive: true, force: true });
  await persist();
}
