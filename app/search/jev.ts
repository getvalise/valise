/**
 * Jev, TypeSafe's hosted reranker, as the live `search` calls it
 * (`rerankedSearch` in `rerank.ts`, ADR-0013). It imports nothing, so an
 * eval under plain Node scores candidates with the production request rather
 * than a copy of it, as `evals/bookmarks/run.mjs` does.
 */

/**
 * The relevance question `hev/jev-rerank` asks per document (prompt.yaml,
 * version generic-1). Clef takes the same System One request shape as Jev, so
 * the two are scored by one prompt.
 */
export const QUESTION = (id: string) =>
  `Document \`documents.${id}\` is relevant to \`query\`: it contains information that answers or directly addresses it.`;
export const CRITERIA = {
  true: "The document contains information that answers the query or directly addresses what it asks about.",
  false:
    "The document is only loosely related, on a similar topic, or does not address what the query asks.",
};

/**
 * Jev answered in 0.45 s median and 0.65 s p95 over the FTS top 50, called
 * from a laptop (ADR-0013), so a call past 1.5 s has stalled rather than
 * slowed, and waiting longer costs the agent more than the ordering buys.
 */
export const JEV_TIMEOUT_MS = 1500;
export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
// Thirty documents per state, as `hev/jev-rerank` batches them and as the
// eval measured; the batches go out in parallel.
const JEV_BATCH = 30;

export class RerankFailure extends Error {}

/**
 * One `noul` question per document, the prompt Clef gets too, scored by the
 * answer's `noul` field, the probability of yes. TypeSafe asks for backoff on
 * 429 and 529, so those retry inside the timeout; any other status fails the
 * stage at once.
 */
export async function jev(
  key: string,
  query: string,
  candidates: string[],
  options: {
    timeoutMs?: number;
    usage?: { calls: number; inputTokens: number };
  } = {},
): Promise<number[]> {
  // One signal for every batch and retry, so the deadline belongs to the
  // stage, and a failed batch cancels its siblings instead of leaving them
  // running on the Worker's subrequest budget.
  const stop = new AbortController();
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? JEV_TIMEOUT_MS),
    stop.signal,
  ]);
  const scores = candidates.map(() => 0);
  const batch = async (start: number) => {
    const slice = candidates.slice(start, start + JEV_BATCH);
    const ids = slice.map((_, j) => `D${String(j).padStart(2, "0")}`);
    const body = JSON.stringify({
      model: "jev-latest",
      state: {
        query,
        documents: Object.fromEntries(ids.map((id, j) => [id, slice[j]])),
      },
      questions: Object.fromEntries(
        ids.map((id) => [
          id,
          { type: "noul", instructions: QUESTION(id), criteria: CRITERIA },
        ]),
      ),
    });
    for (let wait = 100; ; wait *= 2) {
      const response = await fetch(JEV_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body,
        signal,
      });
      if (response.ok) {
        const out = (await response.json()) as {
          answers?: Record<string, { noul?: unknown }>;
          usage?: { input_tokens?: number };
        };
        if (options.usage) {
          options.usage.calls++;
          options.usage.inputTokens += out.usage?.input_tokens ?? 0;
        }
        ids.forEach((id, j) => {
          const noul = out.answers?.[id]?.noul;
          if (typeof noul !== "number") {
            throw new RerankFailure(`no answer for ${id}`);
          }
          scores[start + j] = noul;
        });
        return;
      }
      await response.body?.cancel();
      if (response.status !== 429 && response.status !== 529) {
        throw new RerankFailure(`status ${response.status}`);
      }
      await pause(wait, signal);
    }
  };
  try {
    const starts = [];
    for (let start = 0; start < candidates.length; start += JEV_BATCH) {
      starts.push(start);
    }
    await Promise.all(starts.map(batch));
  } finally {
    stop.abort();
  }
  return scores;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
