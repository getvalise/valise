/**
 * Which Workers AI model should write summaries and key concepts? Sends the
 * same public pages and one book through the production prompts and parsers
 * (`probe.ts`) to each model, and records validity, latency, tokens and cost.
 *
 *   cd evals/summary-model && npx wrangler dev --port 8797   # in one terminal
 *   gunzip -k ../passages/on-liberty.md.gz                   # if only the .gz is present
 *   node evals/summary-model/run.mjs --out evals/summary-model/<date>-run.json
 *
 * Calls are billed by Workers AI at list price; a full run costs about $0.10.
 * Faithfulness and concept usefulness are judged by reading the output file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const flag = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const ORIGIN = flag("--origin", "http://localhost:8797");
const OUT = flag("--out", null);
const ONLY = flag("--models", null)?.split(",");

/** From `npx wrangler ai models list --json`, read 2026-10-29. USD per million tokens. */
const MODELS = [
  {
    id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    input: 0.293,
    output: 2.253,
    context: 24_000,
    options: {},
  },
  {
    id: "@cf/zai-org/glm-5.3-flash",
    input: 0.15,
    output: 0.5,
    context: 1_048_576,
    // Reasoning cannot be turned off on this model; low is the least.
    options: { reasoning_effort: "low" },
  },
  {
    id: "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
    input: 0.3,
    output: 1.2,
    context: 1_048_576,
    options: { reasoning_effort: "none" },
  },
  {
    id: "@cf/google/gemma-4-26b-a4b-it",
    input: 0.1,
    output: 0.3,
    context: 256_000,
    options: { chat_template_kwargs: { enable_thinking: false } },
  },
].filter((m) => !ONLY || ONLY.some((name) => m.id.includes(name)));

const PAGES = [
  "https://en.wikipedia.org/wiki/Jevons_paradox",
  "https://en.wikipedia.org/wiki/Agroforestry",
  "https://en.wikipedia.org/wiki/Pollination",
  "https://en.wikipedia.org/wiki/Tragedy_of_the_commons",
  "https://en.wikipedia.org/wiki/Mycorrhiza",
  "https://en.wikipedia.org/wiki/Bloom_filter",
  "https://en.wikipedia.org/wiki/Dunbar%27s_number",
  "https://en.wikipedia.org/wiki/Photosynthesis",
  "https://www.gutenberg.org/ebooks/84",
  "https://www.gutenberg.org/cache/epub/34901/pg34901-images.html",
  "https://www.gutenberg.org/cache/epub/3300/pg3300-images.html",
];

/** Bookmarks: production's 8 KiB prefix and a 32 KiB one. Files: production's
 * 12 KiB prefix of the book and the whole book where the context holds it. */
const CASES = [
  { kind: "bookmark", prefixBytes: 8 * 1024, max_tokens: 500 },
  { kind: "bookmark", prefixBytes: 32 * 1024, max_tokens: 500 },
  { kind: "file", prefixBytes: 0, max_tokens: 900 },
  {
    kind: "file",
    prefixBytes: 1024 * 1024,
    max_tokens: 900,
    minContext: 100_000,
  },
];

const post = async (path, body) => {
  const response = await fetch(`${ORIGIN}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return response.json();
};

const articles = [];
for (const url of PAGES) {
  const article = await post("/article", { url });
  console.log(`${article.status} ${article.wordCount} words  ${url}`);
  if (article.status === "fetched") articles.push({ url, ...article });
}
const book = readFileSync(join(HERE, "../passages/on-liberty.md"), "utf8");

const cost = (model, usage) =>
  usage
    ? (usage.prompt_tokens * model.input +
        usage.completion_tokens * model.output) /
      1e6
    : null;

const results = [];
await Promise.all(
  MODELS.map(async (model) => {
    for (const c of CASES) {
      if (c.minContext && model.context < c.minContext) continue;
      const items =
        c.kind === "bookmark"
          ? articles.map((a) => ({
              name: a.url,
              title: a.title,
              authors: a.authors,
              text: a.text,
            }))
          : [{ name: "on-liberty.md", text: book }];
      for (const item of items) {
        const reply = await post(`/${c.kind}`, {
          model: model.id,
          options: model.options,
          max_tokens: c.max_tokens,
          prefixBytes: c.prefixBytes,
          title: item.title,
          authors: item.authors,
          text: item.text,
        });
        const row = {
          model: model.id,
          kind: c.kind,
          prefixBytes: c.prefixBytes || 12_000,
          item: item.name,
          ok: Boolean(reply.parsed),
          ms: reply.ms,
          inputTokens: reply.usage?.prompt_tokens ?? null,
          outputTokens: reply.usage?.completion_tokens ?? null,
          usd: cost(model, reply.usage),
          finish: reply.finish ?? null,
          parsed: reply.parsed ?? null,
          error: reply.error ?? null,
          content: reply.parsed ? undefined : reply.content,
        };
        results.push(row);
        console.log(
          `${row.ok ? "ok  " : "FAIL"} ${String(row.ms).padStart(6)} ms  $${(row.usd ?? 0).toFixed(5)}  ${model.id.split("/").pop()} ${c.kind}@${row.prefixBytes} ${item.name.split("/").pop()}${row.error ? `  ${row.error.slice(0, 120)}` : ""}`,
        );
      }
    }
  }),
);

const summary = {};
for (const r of results) {
  const key = `${r.model} ${r.kind}@${r.prefixBytes}`;
  const s = (summary[key] ??= { n: 0, ok: 0, ms: [], usd: 0, over25s: 0 });
  s.n++;
  s.ok += r.ok ? 1 : 0;
  s.ms.push(r.ms);
  s.usd += r.usd ?? 0;
  s.over25s += r.ms > 25_000 ? 1 : 0;
}
const total = results.reduce((sum, r) => sum + (r.usd ?? 0), 0);
console.log("\nmodel case  valid  p50 ms  max ms  >25s  usd/item");
for (const [key, s] of Object.entries(summary)) {
  const ms = s.ms.sort((a, b) => a - b);
  console.log(
    `${key}  ${s.ok}/${s.n}  ${ms[Math.floor(ms.length / 2)]}  ${ms.at(-1)}  ${s.over25s}  ${(s.usd / s.n).toFixed(5)}`,
  );
}
console.log(`\ntotal $${total.toFixed(4)}`);
if (OUT)
  writeFileSync(
    OUT,
    `${JSON.stringify({ ranAt: new Date().toISOString(), models: MODELS, cases: CASES, summary, totalUsd: total, results }, null, 2)}\n`,
  );
