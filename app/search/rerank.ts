import { PRICES, recordSpend } from "~/concepts/spend";
import { assetVectorCandidates } from "~/search/asset-vectors";
import {
  CRITERIA,
  JEV_TIMEOUT_MS,
  jev,
  QUESTION,
  RerankFailure,
} from "~/search/jev";
import { capBody } from "~/search/project";
import {
  DEFAULT_LIMIT,
  type SearchFilters,
  type SearchHit,
  search,
} from "~/search/query";
import { sourceVectorCandidates } from "~/search/source-vectors";
import {
  memoryVectorCandidates,
  type VectorBindings,
  VectorSearchFailure,
} from "~/search/vectors";

/**
 * Retrieve-then-rerank, ADR-0013. The MCP `search` tool reranks the FTS top
 * 50 with Jev, on TypeSafe's API, whenever the Worker has `TYPESAFE_API_KEY`,
 * and falls back to the FTS order when Jev fails or is slow. The Workers AI
 * rerankers stay for the dev experiment: the loopback `/__dev/rerank` route,
 * which `evals/retrieval/rerank.mjs` sends candidate texts to, and `search`
 * under `VALISE_RERANK=clef` (`fts` is its legacy alias). Hybrid uses the
 * optional Vectorize read path and Jev; it never embeds the store during search.
 */

export const RERANKERS = [
  "@cf/baai/bge-reranker-base",
  "@cf/cloudflare/clef",
  "@cf/cloudflare/clef-flash",
] as const;
export type Reranker = (typeof RERANKERS)[number];

export type RerankResult = {
  /** One per candidate, in candidate order. Higher is more relevant. */
  scores: number[];
  calls: number;
  inputTokens: number;
};

// The schema allows 64 questions per call. Fifty memories fit Clef-flash's
// 24k context with room to spare, and a full context truncates the state
// silently, which would score the cut documents on nothing.
const CLEF_BATCH = 50;

type RerankEnv = { DB: D1Database; AI: Pick<Ai, "run"> };
type SearchEnv = VectorBindings & {
  DB: D1Database;
  AI?: Pick<Ai, "run">;
  TYPESAFE_API_KEY?: string;
};

export async function rerank(
  env: RerankEnv,
  model: Reranker,
  query: string,
  candidates: string[],
): Promise<RerankResult> {
  if (model === "@cf/baai/bge-reranker-base") {
    // A cross-encoder: one call scores every (query, context) pair, and the
    // response refers to each by its index in `contexts`.
    // The generated input type lost `query`, which the model's published
    // schema requires, so the object goes in through a variable.
    const input = { query, contexts: candidates.map((text) => ({ text })) };
    const { response = [] } = await env.AI.run(model, input);
    const scores = candidates.map(() => Number.NEGATIVE_INFINITY);
    for (const row of response) {
      if (row.id !== undefined && row.score !== undefined) {
        scores[row.id] = row.score;
      }
    }
    return { scores, calls: 1, inputTokens: 0 };
  }

  const selector = model.replace("@cf/cloudflare/", "");
  const batches: number[][] = [];
  for (let start = 0; start < candidates.length; start += CLEF_BATCH) {
    batches.push(
      candidates
        .slice(start, start + CLEF_BATCH)
        .map((_, offset) => start + offset),
    );
  }
  const scores = candidates.map(() => 0);
  let inputTokens = 0;
  await Promise.all(
    batches.map(async (indexes) => {
      const ids = indexes.map((_, j) => `D${String(j).padStart(2, "0")}`);
      const out = (await env.AI.run(model, {
        model: selector,
        state: {
          query,
          documents: Object.fromEntries(
            ids.map((id, j) => [id, candidates[indexes[j]]]),
          ),
        },
        questions: Object.fromEntries(
          ids.map((id) => [
            id,
            { type: "noul", instructions: QUESTION(id), criteria: CRITERIA },
          ]),
        ),
      })) as {
        answers: Record<string, { noul: number }>;
        usage: { input_tokens: number };
      };
      inputTokens += out.usage.input_tokens;
      ids.forEach((id, j) => {
        scores[indexes[j]] = out.answers[id].noul;
      });
    }),
  );
  return { scores, calls: batches.length, inputTokens };
}

/**
 * Which reranker `search` runs, from `VALISE_RERANK` and `TYPESAFE_API_KEY`.
 * Unset, it is `jev` when the key is set and off when it is not, so
 * production turns reranking on by setting the secret. `off` forces the FTS
 * order, which is how an eval measures the baseline on a machine that holds
 * the key. `lexical` also forces FTS order. `clef` (legacy `fts`) reranks the
 * FTS top 50 with Clef, and `hybrid` the FTS top 50 unioned with up to 50
 * current Vectorize memory heads, using Jev. Hybrid
 * requires the optional vector capabilities and a Jev key. `jev` without a
 * key is off: there is nothing to call.
 */
export type RerankMode = "jev" | "clef" | "fts" | "hybrid";
export function rerankMode(env: {
  VALISE_RERANK?: string;
  TYPESAFE_API_KEY?: string;
}): RerankMode | null {
  const mode = env.VALISE_RERANK || "jev";
  if (mode === "clef" || mode === "fts" || mode === "hybrid") return mode;
  return mode === "jev" && env.TYPESAFE_API_KEY ? "jev" : null;
}

/**
 * What the rerank stage did on one search, for the call row. `reranked` is
 * false when the result came back in FTS order, and `fallback` says why.
 */
export type RerankOutcome = {
  backend: "jev" | "clef";
  reranked: boolean;
  ms: number;
  fallback?: string;
};

const LIVE_MODEL = "@cf/cloudflare/clef";
const DEPTH = 50;

type Doc = {
  doc_key: string;
  concept: SearchHit["concept"];
  concept_id: string;
  project: string | null;
  title: string;
  body: string;
  updated_at: number;
};

/**
 * The live `search` with a second stage: same filters, same hit shape. The
 * FTS top 50 are the candidates, plus the bge-m3 top 50 under `hybrid`. The
 * score is the reranker's probability that the document answers the query.
 * An FTS candidate keeps its highlighted snippet; a vector candidate has no
 * matched terms, so its snippet is the body's opening. A limit past 50 gets
 * the FTS hits below the candidates, in FTS order.
 *
 * The rerank stage never fails the search. An error, a status Jev does not
 * ask to be retried, or a call past `JEV_TIMEOUT_MS` returns the FTS order,
 * and `rerank` on the result says which happened. It is null when there was
 * no candidate to rerank.
 */
export async function rerankedSearch(
  env: SearchEnv,
  mode: RerankMode,
  filters: SearchFilters,
): Promise<{ hits: SearchHit[]; rerank: RerankOutcome | null }> {
  const limit = filters.limit ?? DEFAULT_LIMIT;
  const fts = await search(env, {
    ...filters,
    limit: Math.max(DEPTH, limit),
  });
  const started = Date.now();
  const outcome = (fallback?: string): RerankOutcome => ({
    backend: mode === "fts" || mode === "clef" ? "clef" : "jev",
    reranked: fallback === undefined,
    ms: Date.now() - started,
    ...(fallback === undefined ? {} : { fallback }),
  });
  try {
    const keys = new Set(fts.slice(0, DEPTH).map((hit) => hit.docKey));
    if (mode === "hybrid" && !env.TYPESAFE_API_KEY) {
      throw new VectorSearchFailure("hybrid requires Jev key");
    }
    const currentVectorHeads =
      mode === "hybrid"
        ? (
            await Promise.all([
              memoryVectorCandidates(env, filters),
              assetVectorCandidates(env, filters),
              sourceVectorCandidates(env, filters),
            ])
          ).flat()
        : [];
    // Nothing to reorder, so no rerank stage ran and none is recorded.
    if (keys.size === 0 && currentVectorHeads.length === 0)
      return { hits: [], rerank: null };
    const { results } = await env.DB.prepare(
      `SELECT doc_key, concept, concept_id, project, title, body, updated_at
         FROM search_docs
        WHERE user_id = ? AND doc_key IN (SELECT value FROM json_each(?))`,
    )
      .bind(filters.userId, JSON.stringify([...keys]))
      .all<Doc>();
    // In FTS rank order, so Jev's batches of 30 split the candidates where
    // `evals/retrieval/rerank.mjs` split them, and a tie keeps the FTS order.
    const order = [...keys];
    const docs = results.sort(
      (a, b) => order.indexOf(a.doc_key) - order.indexOf(b.doc_key),
    );
    for (const p of currentVectorHeads) {
      if (keys.has(p.docKey)) continue;
      keys.add(p.docKey);
      docs.push({
        doc_key: p.docKey,
        concept: p.concept,
        concept_id: p.conceptId,
        project: p.project,
        title: p.title,
        body: p.body,
        updated_at: p.updatedAt,
      });
    }
    // Extracted documents can exceed the other concepts' 16 KiB projection
    // cap. Keep provider input bounded, with the lexical matched passage first.
    const lexicalSnippets = new Map(
      fts.map((hit) => [hit.docKey, hit.snippet]),
    );
    const texts = docs.map((doc) =>
      doc.concept === "asset" || doc.concept === "source"
        ? `${doc.title}\n\n${lexicalSnippets.get(doc.doc_key) ?? ""}\n${capBody(doc.body, 8192)}`
        : `${doc.title}\n\n${doc.body}`,
    );
    if ((mode === "clef" || mode === "fts") && !env.AI)
      throw new RerankFailure("Clef requires Workers AI");
    const scores =
      mode !== "fts" && mode !== "clef"
        ? await meterRerank(env.DB, filters.userId, "jev", async (usage) =>
            jev(env.TYPESAFE_API_KEY ?? "", filters.query, texts, { usage }),
          )
        : await meterRerank(
            env.DB,
            filters.userId,
            LIVE_MODEL,
            async (usage) => {
              const result = await rerank(
                { DB: env.DB, AI: env.AI as Pick<Ai, "run"> },
                LIVE_MODEL,
                filters.query,
                texts,
              );
              usage.calls += result.calls;
              usage.inputTokens += result.inputTokens;
              return result.scores;
            },
          );
    const snippets = new Map(fts.map((hit) => [hit.docKey, hit.snippet]));
    const reranked = docs
      .map((doc, i) => ({ doc, score: scores[i] }))
      .sort((a, b) => b.score - a.score)
      .map(({ doc, score }) => ({
        docKey: doc.doc_key,
        concept: doc.concept,
        conceptId: doc.concept_id,
        project: doc.project,
        title: doc.title,
        snippet:
          snippets.get(doc.doc_key) ??
          `${doc.body.split(/\s+/).slice(0, 20).join(" ")}…`,
        score,
        updatedAt: doc.updated_at,
      }));
    return {
      hits: [
        ...reranked,
        ...fts.slice(DEPTH).filter((hit) => !keys.has(hit.docKey)),
      ].slice(0, limit),
      rerank: outcome(),
    };
  } catch (error) {
    return {
      hits: fts.slice(0, limit),
      rerank: outcome(fallbackReason(error)),
    };
  }
}

/**
 * Records one rerank stage under the searching account, whether it answered
 * or threw: a provider call that timed out may still be billed. Tokens the
 * provider reported are priced; a stage that reported none is unpriced.
 */
async function meterRerank<T>(
  db: D1Database,
  userId: string,
  backend: "jev" | Reranker,
  run: (usage: { calls: number; inputTokens: number }) => Promise<T>,
): Promise<T> {
  const usage = { calls: 0, inputTokens: 0 };
  try {
    return await run(usage);
  } finally {
    const price =
      backend === "jev"
        ? PRICES.jev.microusdPerUnit
        : PRICES.rerankers[backend];
    await recordSpend(db, userId, "rerank", {
      calls: Math.max(1, usage.calls),
      units: usage.inputTokens,
      microusd:
        usage.inputTokens > 0 && price !== undefined
          ? usage.inputTokens * price
          : null,
    });
  }
}

/** A short reason for the call row: never the key, never a memory body. */
function fallbackReason(error: unknown): string {
  if (error instanceof VectorSearchFailure) return error.message;
  if (error instanceof RerankFailure) return error.message;
  if (error instanceof Error && error.name === "TimeoutError") {
    return `timeout ${JEV_TIMEOUT_MS} ms`;
  }
  return error instanceof Error ? error.name.slice(0, 100) : "error";
}

export { JEV_TIMEOUT_MS, JEV_URL } from "~/search/jev";
