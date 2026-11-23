import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  JEV_TIMEOUT_MS,
  JEV_URL,
  rerankedSearch,
  rerankMode,
} from "~/search/rerank";
import { callMcp } from "./fixture-worker";

/**
 * `search` reranks the FTS top 50 with Jev when the Worker holds
 * `TYPESAFE_API_KEY`, and returns the FTS order whenever Jev cannot answer.
 * TypeSafe is stubbed: ranking quality is an eval measurement (ADR-0013), and
 * what these pin is the contract around the call, and that the call row says
 * which path a search took.
 */

const db = env.DB;
const KEY = { TYPESAFE_API_KEY: "test-typesafe-key" };
const MEMORIES = 35;

type JevRequest = {
  model: string;
  state: { query: string; documents: Record<string, string> };
  questions: Record<string, { type: string }>;
};

let requests: { authorization: string | null; body: JevRequest }[] = [];

/**
 * Answer each Jev call with `respond`, and anything else with a 404 so a
 * stray network call fails loudly rather than reaching the internet.
 */
function stubJev(
  respond: (body: JevRequest, init: RequestInit) => Promise<Response>,
) {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(input) !== JEV_URL) return new Response(null, { status: 404 });
      const body = JSON.parse(String(init.body)) as JevRequest;
      requests.push({
        authorization: new Headers(init.headers).get("authorization"),
        body,
      });
      return respond(body, init);
    },
  );
}

/** Scores each document by the number in its title, so `Lantern 34` wins. */
function scoredByTitle(body: JevRequest): Response {
  const answers = Object.fromEntries(
    Object.entries(body.state.documents).map(([id, text]) => [
      id,
      { type: "noul", noul: Number(/Lantern (\d+)/.exec(text)?.[1]) / 100 },
    ]),
  );
  return Response.json({
    model: "jev-latest",
    answers,
    usage: { input_tokens: 1, output_tokens: 0 },
  });
}

beforeEach(async () => {
  requests = [];
  for (let n = 0; n < MEMORIES; n++) {
    await callMcp("tools/call", {
      name: "save_memory",
      arguments: {
        type: "fact",
        title: `Lantern ${String(n).padStart(2, "0")}`,
        // Fewer repeats for higher numbers, so BM25 puts them last and a
        // reranker that prefers them visibly reorders.
        body: `lantern ${"lantern ".repeat(MEMORIES - n)}`,
        tags: ["rerank-test"],
      },
    });
  }
});

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const table of [
    "mcp_calls",
    "search_docs",
    "memory_revisions",
    "memories",
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await db
    .prepare("INSERT INTO search_docs_fts(search_docs_fts) VALUES('rebuild')")
    .run();
});

async function titles(bindings: Partial<Env> = KEY): Promise<string[]> {
  const { value } = await callMcp(
    "tools/call",
    { name: "search", arguments: { query: "lantern", limit: 50 } },
    "vitest",
    undefined,
    {},
    bindings,
  );
  expect(value.result.isError).not.toBe(true);
  return (value.result.structuredContent?.results as { title: string }[]).map(
    (hit) => hit.title,
  );
}

/** The rerank stage the newest `search` row recorded, parsed. */
async function loggedRerank(): Promise<Record<string, unknown> | null> {
  const row = await db
    .prepare(
      "SELECT rerank_json FROM mcp_calls WHERE tool = 'search' ORDER BY at DESC LIMIT 1",
    )
    .first<{ rerank_json: string | null }>();
  return row?.rerank_json ? JSON.parse(row.rerank_json) : null;
}

const byNumberDescending = Array.from(
  { length: MEMORIES },
  (_, n) => `Lantern ${String(MEMORIES - 1 - n).padStart(2, "0")}`,
);

describe("explicit self-host search choices", () => {
  it.each([
    ["lexical", "present", null],
    ["off", "present", null],
    ["clef", "", "clef"],
    ["fts", "", "fts"],
    ["jev", "", null],
    ["jev", "present", "jev"],
    [undefined, "", null],
    [undefined, "present", "jev"],
    ["hybrid", "present", "hybrid"],
  ])("%s selects %s => %s", (mode, key, expected) => {
    expect(rerankMode({ VALISE_RERANK: mode, TYPESAFE_API_KEY: key })).toBe(
      expected,
    );
  });

  it("Clef uses Workers AI without a TypeSafe key and reorders the scoped candidates", async () => {
    stubJev(async (body) => scoredByTitle(body));
    const run = vi.fn();
    run.mockImplementation(async (_model: string, input: JevRequest) =>
      scoredByTitle(input).json(),
    );
    const { hits, rerank } = await rerankedSearch(
      { DB: db, AI: { run } },
      "clef",
      { query: "lantern", userId: "local", limit: 50 },
    );
    expect(hits.map((hit) => hit.title)).toEqual(byNumberDescending);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0]).toBe("@cf/cloudflare/clef");
    expect(requests).toEqual([]);
    expect(rerank).toMatchObject({ backend: "clef", reranked: true });
  });

  it("Clef failures return lexical results without exposing the provider message", async () => {
    const lexical = await titles({ TYPESAFE_API_KEY: "" });
    const run = vi.fn().mockRejectedValue(new Error("private provider detail"));
    const { hits, rerank } = await rerankedSearch(
      { DB: db, AI: { run } },
      "clef",
      { query: "lantern", userId: "local", limit: 50 },
    );
    expect(hits.map((hit) => hit.title)).toEqual(lexical);
    expect(rerank).toMatchObject({
      backend: "clef",
      reranked: false,
      fallback: "Error",
    });
    expect(JSON.stringify(rerank)).not.toContain("private");
  });
});

describe("search with Jev", () => {
  it("skips the rerank stage when the key is absent", async () => {
    stubJev(async (body) => scoredByTitle(body));
    const fts = await titles({ TYPESAFE_API_KEY: "" });

    expect(requests).toEqual([]);
    expect(fts).toHaveLength(MEMORIES);
    expect(fts).not.toEqual(byNumberDescending);
    expect(await loggedRerank()).toBeNull();
  });

  it("records no rerank stage when FTS finds nothing", async () => {
    stubJev(async (body) => scoredByTitle(body));
    const { value } = await callMcp(
      "tools/call",
      { name: "search", arguments: { query: "zeppelin" } },
      "vitest",
      undefined,
      {},
      KEY,
    );

    expect(value.result.structuredContent?.results).toEqual([]);
    expect(requests).toEqual([]);
    expect(await loggedRerank()).toBeNull();
  });

  it("reorders the FTS candidates by Jev's score, 30 documents a call", async () => {
    stubJev(async (body) => scoredByTitle(body));

    expect(await titles()).toEqual(byNumberDescending);
    expect(
      requests.map((r) => Object.keys(r.body.state.documents).length),
    ).toEqual([30, 5]);
    expect(requests[0].authorization).toBe("Bearer test-typesafe-key");
    expect(requests[0].body).toMatchObject({
      model: "jev-latest",
      state: { query: "lantern" },
      questions: { D00: { type: "noul" }, D29: { type: "noul" } },
    });
    expect(await loggedRerank()).toMatchObject({
      backend: "jev",
      reranked: true,
      ms: expect.any(Number),
    });
  });

  it("retries a 429 and still reranks", async () => {
    let calls = 0;
    stubJev(async (body) =>
      ++calls === 1
        ? Response.json({ error: "rate_limited" }, { status: 429 })
        : scoredByTitle(body),
    );

    expect(await titles()).toEqual(byNumberDescending);
    expect(requests).toHaveLength(3);
    expect(await loggedRerank()).toMatchObject({ reranked: true });
  });

  it("returns the FTS order on a status Jev does not ask to retry", async () => {
    const fts = await titles({ TYPESAFE_API_KEY: "" });
    stubJev(async () => Response.json({ error: "bad key" }, { status: 401 }));

    expect(await titles()).toEqual(fts);
    expect(await loggedRerank()).toMatchObject({
      backend: "jev",
      reranked: false,
      fallback: "status 401",
    });
  });

  it("returns the FTS order when Jev is slower than the timeout", async () => {
    const fts = await titles({ TYPESAFE_API_KEY: "" });
    // Never answers; only the stage's abort signal ends the call.
    stubJev(
      (_, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );

    expect(await titles()).toEqual(fts);
    const rerank = await loggedRerank();
    expect(rerank).toMatchObject({
      backend: "jev",
      reranked: false,
      fallback: `timeout ${JEV_TIMEOUT_MS} ms`,
    });
    expect(rerank?.ms).toBeGreaterThanOrEqual(JEV_TIMEOUT_MS - 50);
  });
});
