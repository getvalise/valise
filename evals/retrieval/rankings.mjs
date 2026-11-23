/**
 * What `vectors.mjs` and `rerank.mjs` both rank against: the store at one
 * size, its labelled queries, the live FTS `search`, and cosine over
 * embeddings fetched through OpenRouter.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCorpus } from "./corpus.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ORIGIN = process.env.VALISE_DEV_ORIGIN ?? "http://localhost:5173";
export const KINDS = ["exact-title", "paraphrase", "project-question"];
export const TOP = 5;
// Deep enough that a memory FTS ranks 40th still reaches the second stage.
export const DEPTH = 50;
export const EMBED_BATCH = 128;

export function loadStore(size) {
  const { memories, queries } = buildCorpus(
    size,
    JSON.parse(
      readFileSync(join(HERE, "../fixtures/retrieval-memories.json"), "utf8"),
    ),
    JSON.parse(
      readFileSync(join(HERE, "../fixtures/retrieval-pool.json"), "utf8"),
    ),
  );
  return {
    memories,
    labelled: queries.filter((q) => KINDS.includes(q.kind)),
  };
}

/**
 * The corpus copies a target's project, type and tags onto its relatives and
 * keeps every title word or drops one or two, so that is how to find them.
 */
export function relativesOf(memories, id) {
  const target = memories.find((m) => m.id === id);
  const words = new Set(target.title.split(" "));
  return new Set(
    memories
      .filter(
        (m) =>
          m.project === target.project &&
          m.type === target.type &&
          JSON.stringify(m.tags) === JSON.stringify(target.tags) &&
          m.title.split(" ").every((word) => words.has(word)),
      )
      .map((m) => m.id),
  );
}

/** Title and body, the two columns the FTS projection weights most. */
export const memoryText = (m) => `${m.title}\n\n${m.body}`;

/**
 * Embeds in batches and tallies what it spent into `spent`, which is what a
 * reindex of the whole store would cost.
 */
export async function embed(model, texts, spent) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const vectors = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH) {
    const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: texts.slice(start, start + EMBED_BATCH),
      }),
    });
    const body = await response.json();
    if (!response.ok || !body.data) {
      throw new Error(
        `${response.status} ${JSON.stringify(body).slice(0, 300)}`,
      );
    }
    spent.tokens += body.usage?.prompt_tokens ?? 0;
    spent.usd += body.usage?.cost ?? 0;
    vectors.push(...body.data.map((row) => normalise(row.embedding)));
  }
  return vectors;
}

function normalise(vector) {
  const norm = Math.hypot(...vector);
  return vector.map((x) => x / norm);
}

const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);

/** The live `search`, restricted to memories, as the D1 test calls it. */
export async function ftsRanking(query, depth = DEPTH) {
  const url = new URL("/__dev/search", ORIGIN);
  url.searchParams.set("q", query.query);
  url.searchParams.set("concept", "memory");
  url.searchParams.set("limit", String(depth));
  if (query.project) url.searchParams.set("project", query.project);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const { hits } = await response.json();
  return hits.map((hit) => hit.conceptId);
}

export function vectorRanking(
  memories,
  docVectors,
  queryVector,
  project,
  depth = DEPTH,
) {
  return memories
    .map((memory, index) => ({
      memory,
      score: dot(queryVector, docVectors[index]),
    }))
    .filter(({ memory }) => !project || memory.project === project)
    .sort((a, b) => b.score - a.score)
    .slice(0, depth)
    .map(({ memory }) => memory.id);
}
