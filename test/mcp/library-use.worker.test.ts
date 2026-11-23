import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { McpScope } from "~/auth/scopes";
import { setRating } from "~/concepts/library-use";
import { mintBearerToken } from "~/concepts/tokens";

/**
 * Use ordering through the Worker's own MCP path. These tests run with the
 * reranker off, so hits carry BM25 scores and use orders exact ties only;
 * `test/d1/library-use.worker.test.ts` covers the 0.05 near-tie rule.
 */

afterEach(async () => {
  for (const table of [
    "search_docs",
    "source_revisions",
    "sources",
    "library_use_events",
    "library_ratings",
    "mcp_calls",
    "bearer_token_grants",
    "bearer_token_scopes",
    "bearer_tokens",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
});

type Result = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

async function tool(
  name: string,
  args: Record<string, unknown>,
  scopes: McpScope[],
): Promise<Record<string, unknown>> {
  const minted = await mintBearerToken(
    { DB: env.DB, TOKEN_PEPPER: "local-test-token-pepper" },
    { userId: "local", label: crypto.randomUUID(), scopes },
  );
  const response = await SELF.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${minted.token}`,
        "content-type": "application/json",
        host: "localhost",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  );
  const raw = await response.text();
  const payload =
    raw
      .split("\n")
      .find((line) => line.startsWith("data:"))
      ?.slice(5)
      .trim() ?? raw;
  const result = JSON.parse(payload).result as Result;
  if (!result || result.isError) throw new Error(JSON.stringify(result));
  return result.structuredContent as Record<string, unknown>;
}

type Hit = { id: string; metadata: { use?: { why: string[] } } };

async function twins() {
  const save = (url: string) =>
    tool(
      "save_source",
      {
        kind: "bookmark",
        title: "Heron nesting colonies",
        url,
        notes: "",
        tags: [],
      },
      ["sources:write"],
    );
  const first = (await save("https://example.org/a")).id as string;
  const second = (await save("https://example.org/b")).id as string;
  return { first, second };
}

async function hits(): Promise<Hit[]> {
  return (
    await tool("search", { query: "heron colonies", type: "source" }, [
      "search:read",
    ])
  ).results as Hit[];
}

describe("search ordered by use", () => {
  it("puts the rated twin first and says why, and an unused hit carries no use", async () => {
    const { first, second } = await twins();
    const before = await hits();
    expect(before).toHaveLength(2);
    expect(before.every((hit) => hit.metadata.use === undefined)).toBe(true);
    const last = before[1].id;
    const other = before[0].id;
    await setRating(env.DB, "local", "source", last.slice(7), 3);

    const after = await hits();
    expect(after.map((hit) => hit.id)).toEqual([last, other]);
    expect(after[0].metadata.use?.why).toEqual(["you rated this 3 of 3 stars"]);
    expect(after[1].metadata.use).toBeUndefined();
    expect([first, second].sort()).toEqual([last, other].sort());
  });

  it("records an agent's fetch of a bookmark once per half hour and explains it", async () => {
    const { first } = await twins();
    await tool("fetch", { id: first }, ["search:read"]);
    await tool("fetch", { id: first }, ["search:read"]);
    const { results } = await env.DB.prepare(
      "SELECT concept, concept_id AS conceptId, kind FROM library_use_events",
    ).all();
    expect(results).toEqual([
      { concept: "source", conceptId: first.slice(7), kind: "fetched" },
    ]);
    const found = await hits();
    expect(found[0]).toMatchObject({
      id: first,
      metadata: {
        use: { why: ["an agent fetched this once in the last 90 days"] },
      },
    });
  });
});
