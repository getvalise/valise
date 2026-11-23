import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveMemory, editMemory, saveMemory } from "~/concepts/memories";
import type { ProjectionRow } from "~/search/project";
import { search } from "~/search/query";
import { JEV_URL, rerankedSearch } from "~/search/rerank";
import {
  memoryVectorCandidates,
  memoryVectorStamp,
  tenantVectorNamespace,
  VECTOR_DEPTH,
  VECTOR_MODEL,
  VECTOR_TAG_SCOPE_LIMIT,
  VECTOR_TIMEOUT_MS,
  vectorProjectKey,
} from "~/search/vectors";
import { callMcp } from "../mcp/fixture-worker";

// Real workerd + D1; external services are contract doubles, not live proof.
const db = env.DB;
// Tests use service doubles with remote bindings disabled, never this live partition.
const namespace: Env["VALISE_VECTOR_NAMESPACE"] = "valise-prod-v1";
const provenance = {
  userId: "local",
  agent: "test",
  client: "test",
  session: null,
};
const vector = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
const run = vi.fn<() => Promise<Record<string, unknown>>>();
const query = vi.fn<Vectorize["query"]>();
const bindings = {
  DB: db,
  AI: env.AI,
  VECTOR_INDEX: {
    query,
    describe: vi.fn<VectorizeIndex["describe"]>(),
    insert: vi.fn<VectorizeIndex["insert"]>(),
    upsert: vi.fn<VectorizeIndex["upsert"]>(),
    deleteByIds: vi.fn<VectorizeIndex["deleteByIds"]>(),
    getByIds: vi.fn<VectorizeIndex["getByIds"]>(),
  },
  VALISE_VECTOR_NAMESPACE: namespace,
  TYPESAFE_API_KEY: "test-key",
};
let texts: string[];

beforeEach(() => {
  run.mockReset().mockResolvedValue({ data: [vector] });
  vi.spyOn(env.AI, "run").mockImplementation(run);
  query.mockReset().mockResolvedValue({ matches: [], count: 0 });
  texts = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (url !== JEV_URL) throw new Error("unexpected external call");
    const body = JSON.parse(String(init.body)) as {
      state: { documents: Record<string, string> };
    };
    texts.push(...Object.values(body.state.documents));
    return Response.json({
      answers: Object.fromEntries(
        Object.entries(body.state.documents).map(([id, text]) => [
          id,
          {
            noul: text.startsWith("Meaning") ? 0.99 : 0.1,
          },
        ]),
      ),
    });
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await db.batch([
    db.prepare("DELETE FROM mcp_calls"),
    db.prepare("DELETE FROM search_docs"),
    db.prepare("DELETE FROM memory_revisions"),
    db.prepare("DELETE FROM memories"),
  ]);
});

async function add(
  title = "Meaning",
  body = "Cloud dashboard holds historical output",
  project = "valise",
  tags = ["logs", "ops"],
) {
  return saveMemory(
    { DB: db },
    { type: "fact", title, body, project, tags },
    provenance,
  );
}

async function match(
  key: string,
  partition: string = namespace,
): Promise<VectorizeMatch> {
  const projection = await db
    .prepare(
      `SELECT doc_key AS docKey, user_id AS userId, concept, concept_id AS conceptId, project,
            title, body, tags, updated_at AS updatedAt
       FROM search_docs WHERE doc_key = ?`,
    )
    .bind(key)
    .first<ProjectionRow>();
  if (!projection) throw new Error("fixture projection missing");
  const row = await db
    .prepare(
      "SELECT 1 + COALESCE(MAX(revision), 0) AS generation FROM memory_revisions WHERE memory_id = ?",
    )
    .bind(projection.conceptId)
    .first<{ generation: number }>();
  if (!row) throw new Error("fixture generation missing");
  const stamp = await memoryVectorStamp(partition, {
    projection,
    generation: row.generation,
  });
  return {
    id: stamp,
    namespace: await tenantVectorNamespace(partition, projection.userId),
    score: 0.99,
    metadata: { docKey: key, stamp },
  };
}

function returns(...matches: VectorizeMatch[]) {
  query.mockResolvedValue({ matches, count: matches.length });
}

describe("current vector candidates", () => {
  it("keeps the pre-tenancy v1 stamp byte-compatible for relocation and deletion", async () => {
    const projection: ProjectionRow = {
      docKey: "memory:legacy",
      userId: "other",
      concept: "memory",
      conceptId: "legacy",
      project: "valise",
      title: "Legacy title",
      body: "Legacy body",
      tags: "ops",
      updatedAt: 1700000000,
    };
    expect(
      await memoryVectorStamp("legacy-deployment", {
        projection,
        generation: 2,
      }),
    ).toBe("222f2b162791be867d4becfeee364683d137565c65be18893da078a3c0b718d1");
  });

  it("selects the authenticated tenant before top50 despite better foreign matches", async () => {
    const target = await add();
    const own = { ...(await match(target.id)), score: 0.5 };
    const foreign: VectorizeMatch[] = [];
    for (let i = 0; i < 60; i++) {
      const memory = await saveMemory(
        bindings,
        {
          type: "fact",
          title: `Foreign ${i}`,
          body: "private foreign content",
          project: "valise",
          tags: ["logs", "ops"],
        },
        { ...provenance, userId: "other" },
      );
      foreign.push(await match(memory.id));
    }
    const ranked = [...foreign, own];
    expect(ranked.slice(0, VECTOR_DEPTH)).not.toContain(own);
    query.mockImplementation(async (_vector, options) => {
      const matches = ranked
        .filter((m) => !options?.namespace || m.namespace === options.namespace)
        .slice(0, options?.topK);
      return { matches, count: matches.length };
    });
    // Bare, project-only and all-tag queries all apply the tenant partition.
    for (const scope of [
      {},
      { project: "valise" },
      { project: "valise", tags: ["logs", "ops"] },
    ]) {
      const result = await rerankedSearch(bindings, "hybrid", {
        userId: "local",
        query: "zeppelin",
        ...scope,
      });
      expect(result.hits.map((h) => h.docKey)).toEqual([target.id]);
    }
    expect(texts).not.toContain(
      expect.stringContaining("private foreign content"),
    );
    expect(
      query.mock.calls.every(
        ([, options]) => options?.namespace === own.namespace,
      ),
    ).toBe(true);
  });

  it("rechecks D1 ownership and freshness even for forged in-tenant hints", async () => {
    const own = await add();
    const stale = await match(own.id);
    await editMemory(
      bindings,
      own.id.slice(7),
      { type: "fact", title: "Meaning", body: "new head" },
      provenance,
    );
    const foreign = await saveMemory(
      bindings,
      { type: "fact", title: "Foreign", body: "secret", tags: [] },
      { ...provenance, userId: "other" },
    );
    const foreignRef = await match(foreign.id);
    returns(stale, { ...foreignRef, namespace: stale.namespace });
    expect(
      await memoryVectorCandidates(bindings, {
        userId: "local",
        query: "zeppelin",
      }),
    ).toEqual([]);
    expect(texts).toEqual([]);
  });

  it("never retries an empty tenant namespace against legacy shared heads", async () => {
    const own = await add();
    const legacy = { ...(await match(own.id)), namespace };
    returns(legacy);
    expect(
      await memoryVectorCandidates(bindings, {
        userId: "local",
        query: "zeppelin",
      }),
    ).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]?.namespace).toBe(
      await tenantVectorNamespace(namespace, "local"),
    );
    await expect(
      memoryVectorCandidates(bindings, { userId: "", query: "zeppelin" }),
    ).rejects.toThrow("vector tenant not configured");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("uses collision-safe bounded tenant namespaces, including long Unicode identities", async () => {
    const a = await tenantVectorNamespace("界".repeat(100), "用".repeat(100));
    expect(a).toMatch(/^t:[A-Za-z0-9_-]{43}$/);
    expect(new TextEncoder().encode(`h:${a}`).length).toBeLessThanOrEqual(64);
    expect(a).not.toBe(
      await tenantVectorNamespace("界".repeat(100), `${"用".repeat(100)}x`),
    );
    expect(await tenantVectorNamespace("a:b", "c")).not.toBe(
      await tenantVectorNamespace("a", "b:c"),
    );
    expect(await tenantVectorNamespace("a", "local")).not.toBe(
      await tenantVectorNamespace("b", "local"),
    );
  });

  it("carries the union through MCP search and records Jev on the call row", async () => {
    const memory = await add();
    returns(await match(memory.id));
    const hybrid = { ...bindings, VALISE_RERANK: "hybrid" as const };
    const { value } = await callMcp(
      "tools/call",
      {
        name: "search",
        arguments: { query: "zeppelin" },
      },
      "vitest",
      undefined,
      {},
      hybrid,
    );
    expect(value.result.isError).not.toBe(true);
    expect(value.result.structuredContent?.results).toMatchObject([
      { id: memory.id, title: "Meaning" },
    ]);
    const logged = await db
      .prepare(
        "SELECT rerank_json FROM mcp_calls WHERE tool = 'search' ORDER BY at DESC LIMIT 1",
      )
      .first<{ rerank_json: string }>();
    expect(JSON.parse(logged?.rerank_json ?? "null")).toMatchObject({
      backend: "jev",
      reranked: true,
    });
  });

  it("unions a vector-only memory with lexical candidates and sends D1 text to Jev", async () => {
    const meaning = await add();
    await add("Lexical", "zeppelin is an unrelated term");
    returns(await match(meaning.id));

    const result = await rerankedSearch(bindings, "hybrid", {
      userId: "local",
      query: "zeppelin",
    });
    expect(result.hits.map((h) => h.title)).toEqual(["Meaning", "Lexical"]);
    expect(result.rerank).toMatchObject({ backend: "jev", reranked: true });
    expect(texts).toContain(
      "Meaning\n\nCloud dashboard holds historical output",
    );
    expect(run).toHaveBeenCalledExactlyOnceWith(
      VECTOR_MODEL,
      { text: ["zeppelin"] },
      { signal: expect.any(AbortSignal) },
    );
    expect(query).toHaveBeenCalledExactlyOnceWith(vector, {
      namespace: await tenantVectorNamespace(namespace, "local"),
      topK: VECTOR_DEPTH,
      returnMetadata: "all",
      returnValues: false,
    });
  });

  it("works when the lexical half is empty", async () => {
    const memory = await add();
    returns(await match(memory.id));
    expect(
      await search(bindings, { userId: "local", query: "zeppelin" }),
    ).toEqual([]);
    const result = await rerankedSearch(bindings, "hybrid", {
      userId: "local",
      query: "zeppelin",
    });
    expect(result.hits.map((h) => h.docKey)).toEqual([memory.id]);
  });

  it("rejects identical-content same-second revisions and accepts the new head without isolate cache", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const memory = await add();
    const old = await match(memory.id);
    returns(old);
    expect(
      await memoryVectorCandidates(bindings, {
        userId: "local",
        query: "zeppelin",
      }),
    ).toHaveLength(1);
    await editMemory(
      bindings,
      memory.id.slice("memory:".length),
      {
        type: memory.type,
        title: memory.title,
        body: memory.body,
        project: memory.project,
        tags: memory.tags,
      },
      provenance,
    );
    expect(
      await memoryVectorCandidates(bindings, {
        userId: "local",
        query: "zeppelin",
      }),
    ).toEqual([]);
    const current = await match(memory.id);
    expect(current.id).not.toBe(old.id);
    returns(old, current, current);
    expect(
      await memoryVectorCandidates(bindings, {
        userId: "local",
        query: "zeppelin",
      }),
    ).toHaveLength(1);
  });

  it("excludes archives, missing heads, other namespaces and missing metadata", async () => {
    const archived = await add();
    const live = await add("Private", "do not leak");
    const old = await match(archived.id);
    const foreign = await match(live.id, "test-workspace-b");
    const noMetadata = { ...(await match(live.id)), metadata: undefined };
    await archiveMemory(bindings, "local", archived.id.slice("memory:".length));
    returns(old, foreign, noMetadata, {
      ...old,
      metadata: { ...old.metadata, docKey: "memory:missing" },
    });
    expect(
      await memoryVectorCandidates(bindings, {
        userId: "local",
        query: "zeppelin",
      }),
    ).toEqual([]);
    expect(texts).toEqual([]);
  });

  it("excludes an unpublished memory even when its authoritative row is not archived", async () => {
    const memory = await add();
    returns(await match(memory.id));
    await db
      .prepare("DELETE FROM search_docs WHERE doc_key = ?")
      .bind(memory.id)
      .run();
    expect(
      await memoryVectorCandidates(bindings, {
        userId: "local",
        query: "zeppelin",
      }),
    ).toEqual([]);
  });

  it("does not treat project or tags as ownership and rechecks every filter in D1", async () => {
    const a = await add();
    const b = await add("Elsewhere", "Other", "other", ["logs", "ops"]);
    const c = await add("Tag prefix", "Other", "valise", ["logs-more", "ops"]);
    returns(await match(a.id), await match(b.id), await match(c.id));
    expect(
      (
        await memoryVectorCandidates(bindings, {
          userId: "local",
          query: "zeppelin",
          concepts: ["memory"],
          project: "valise",
          tags: ["logs", "ops"],
        })
      ).map((p) => p.docKey),
    ).toEqual([a.id]);
    expect(
      await memoryVectorCandidates(bindings, {
        userId: "local",
        query: "zeppelin",
        tags: ["missing"],
      }),
    ).toEqual([]);
    run.mockClear();
    expect(
      await memoryVectorCandidates(bindings, {
        userId: "local",
        query: "zeppelin",
        concepts: ["skill", "todo"],
      }),
    ).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("prefilters project and all tags before ANN top50, including long Unicode values", async () => {
    const project = "界".repeat(100);
    const tag = "標".repeat(100);
    const target = await add("Scoped", "needle", project, [tag, "ops"]);
    const ref = await match(target.id);
    query.mockImplementation(async (_vector, options) => {
      expect(options?.filter).toEqual({
        project: await vectorProjectKey(project),
        docKey: { $in: [target.id] },
      });
      expect(
        new TextEncoder().encode(JSON.stringify(options?.filter)).length,
      ).toBeLessThan(2048);
      return { count: 1, matches: [ref] };
    });
    expect(
      (
        await memoryVectorCandidates(bindings, {
          userId: "local",
          query: "needle",
          project,
          tags: [tag, "ops"],
        })
      ).map((row) => row.docKey),
    ).toEqual([target.id]);
    expect(await vectorProjectKey(project)).toHaveLength(64);
    expect(await vectorProjectKey(`${project}x`)).not.toBe(
      await vectorProjectKey(project),
    );
  });

  it("uses explicit lexical fallback rather than truncating an oversized tag scope", async () => {
    for (let i = 0; i <= VECTOR_TAG_SCOPE_LIMIT; i++)
      await add(`Lexical ${i}`, "zeppelin", "valise", ["wide"]);
    const filters = { userId: "local", query: "zeppelin", tags: ["wide"] };
    const result = await rerankedSearch(bindings, "hybrid", filters);
    expect(result.hits).toEqual(await search(bindings, filters));
    expect(result.rerank?.fallback).toBe(
      `vector tag scope exceeds ${VECTOR_TAG_SCOPE_LIMIT} heads`,
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects a stale project stamp even when the caller has no project filter", async () => {
    const memory = await add();
    returns(await match(memory.id));
    await editMemory(
      bindings,
      memory.id.slice("memory:".length),
      {
        type: "fact",
        title: memory.title,
        body: memory.body,
        project: "moved",
        tags: memory.tags,
      },
      provenance,
    );
    expect(
      await memoryVectorCandidates(bindings, {
        userId: "local",
        query: "zeppelin",
      }),
    ).toEqual([]);
  });

  it("has no vector calls without configuration or without a reranker key", async () => {
    await add("Lexical", "zeppelin");
    const filters = { userId: "local", query: "zeppelin" };
    const fts = await search(bindings, filters);
    const missing = await rerankedSearch(
      { ...bindings, VECTOR_INDEX: undefined },
      "hybrid",
      filters,
    );
    expect(missing.hits).toEqual(fts);
    expect(missing.rerank?.fallback).toBe("vectors not configured");
    expect(
      (
        await rerankedSearch(
          { ...bindings, TYPESAFE_API_KEY: "" },
          "hybrid",
          filters,
        )
      ).hits,
    ).toEqual(fts);
    expect(run).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(texts).toEqual([]);
  });

  it.each([
    { data: [[]] },
    { data: [[1, 2]] },
    { data: [vector, vector] },
    { data: [Array(1024).fill(0)] },
    { data: [Array(1024).fill(Number.NaN)] },
    { request_id: "unexpected-async-result" },
  ])("keeps lexical availability for malformed embedding %j", async (bad) => {
    await add("Lexical", "zeppelin");
    run.mockResolvedValue(bad);
    const filters = { userId: "local", query: "zeppelin" };
    const result = await rerankedSearch(bindings, "hybrid", filters);
    expect(result.hits).toEqual(await search(bindings, filters));
    expect(result.rerank?.fallback).toBe("invalid query embedding");
    expect(query).not.toHaveBeenCalled();
  });

  it("keeps lexical order on vector network or rerank failures", async () => {
    const memory = await add("Lexical", "zeppelin");
    const filters = { userId: "local", query: "zeppelin" };
    const fts = await search(bindings, filters);
    query.mockRejectedValueOnce(new Error("network"));
    expect((await rerankedSearch(bindings, "hybrid", filters)).hits).toEqual(
      fts,
    );
    returns(await match(memory.id));
    vi.stubGlobal("fetch", async () => new Response(null, { status: 401 }));
    const failed = await rerankedSearch(bindings, "hybrid", filters);
    expect(failed.hits).toEqual(fts);
    expect(failed.rerank?.fallback).toBe("status 401");
  });

  it("bounds a stalled Vectorize call", async () => {
    await add("Lexical", "zeppelin");
    query.mockImplementationOnce(() => new Promise(() => {}));
    const filters = { userId: "local", query: "zeppelin" };
    const result = await rerankedSearch(bindings, "hybrid", filters);
    expect(result.hits).toEqual(await search(bindings, filters));
    expect(result.rerank?.fallback).toBe(
      `vector timeout ${VECTOR_TIMEOUT_MS} ms`,
    );
    expect(texts).toEqual([]);
  });

  it("does not start ANN work when project filtering resumes after the deadline", async () => {
    await add();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let release = () => {};
    let resumed = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      resumed = resolve;
    });
    vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(
      async (algorithm, data) => {
        await gate;
        const result = await digest(algorithm, data);
        resumed();
        return result;
      },
    );
    try {
      await expect(
        memoryVectorCandidates(bindings, {
          userId: "local",
          query: "zeppelin",
          project: "valise",
        }),
      ).rejects.toThrow(`vector timeout ${VECTOR_TIMEOUT_MS} ms`);
    } finally {
      release();
      await finished;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(query).not.toHaveBeenCalled();
  });

  it("does not duplicate a vector candidate also present in the FTS tail", async () => {
    const memories = [];
    for (let n = 0; n < 55; n++)
      memories.push(await add(`Lexical ${n}`, "zeppelin"));
    const fts = await search(bindings, {
      userId: "local",
      query: "zeppelin",
      limit: 100,
    });
    const tail = fts[54];
    returns(await match(tail.docKey));
    const result = await rerankedSearch(bindings, "hybrid", {
      userId: "local",
      query: "zeppelin",
      limit: 100,
    });
    expect(result.hits).toHaveLength(55);
    expect(new Set(result.hits.map((h) => h.docKey)).size).toBe(55);
    expect(texts).toHaveLength(51);
  });
});
