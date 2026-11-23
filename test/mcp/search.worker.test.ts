import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import nudges from "~/mcp/nudges.json";
import { seed } from "~/search/seed";
import { handleMcp } from "../../workers/mcp";
import { callMcp } from "./fixture-worker";

const db = env.DB;

afterEach(async () => {
  for (const table of [
    "search_docs",
    "todo_updates",
    "todos",
    "memory_revisions",
    "skill_versions",
    "skills",
    "memories",
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await db
    .prepare("INSERT INTO search_docs_fts(search_docs_fts) VALUES('rebuild')")
    .run();
});

describe("the MCP endpoint", () => {
  it("lists the V1-2 tools with JSON schemas", async () => {
    const response = await rpc("tools/list", {});
    const tools = response.result.tools as Array<{
      name: string;
      description: string;
      inputSchema: unknown;
      securitySchemes: Array<{ type: string; scopes: string[] }>;
    }>;

    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["search", "fetch", "save_memory"]),
    );
    expect(tools.every((tool) => tool.description.length > 0)).toBe(true);
    expect(tools.every((tool) => tool.inputSchema !== undefined)).toBe(true);
    expect(tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "search",
          securitySchemes: [{ type: "oauth2", scopes: ["search:read"] }],
        }),
        expect.objectContaining({
          name: "save_memory",
          securitySchemes: [{ type: "oauth2", scopes: ["memories:write"] }],
        }),
      ]),
    );
  });

  it("searches across concepts, fetches authoritative rows, and captures memories", async () => {
    await seed(env);

    const found = await tool("search", { query: "duckdb" });
    const results = found.structuredContent.results as Array<{
      id: string;
      type: string;
      title: string;
      snippet: string;
    }>;
    expect(new Set(results.map((result) => result.type))).toEqual(
      new Set(["skill", "memory", "todo"]),
    );
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^(skill|memory|todo):/),
          title: expect.any(String),
          snippet: expect.any(String),
        }),
      ]),
    );
    // Every kind, skills included, says when and by whom it was saved.
    const metadata = (
      found.structuredContent.results as {
        metadata: { created_at?: unknown; saved_by?: unknown };
      }[]
    ).map((result) => result.metadata);
    expect(metadata.length).toBeGreaterThan(0);
    for (const entry of metadata) {
      expect(entry.created_at).toEqual(expect.any(Number));
      expect(entry.saved_by).toEqual(expect.any(String));
    }

    const fetched = await tool("fetch", {
      id: "memory:mem_seed_duckdb_default",
    });
    expect(fetched.structuredContent).toMatchObject({
      id: "memory:mem_seed_duckdb_default",
      title: expect.any(String),
      text: expect.stringContaining("warehouse"),
      metadata: expect.any(Object),
    });

    const saved = await tool("save_memory", {
      type: "decision",
      title: "MCP contract",
      body: "Search results use ids that fetch returns as authoritative rows.",
      tags: ["mcp", "contract"],
      project: "valise",
    });
    const id = saved.structuredContent.id as string;
    const roundTrip = await tool("search", { query: "authoritative" });
    expect(
      (roundTrip.structuredContent.results as Array<{ id: string }>).map(
        (result) => result.id,
      ),
    ).toContain(id);

    const memory = await tool("fetch", { id });
    expect(memory.structuredContent).toMatchObject({
      id,
      text: "Search results use ids that fetch returns as authoritative rows.",
      metadata: { type: "decision", tags: ["mcp", "contract"] },
    });
  });

  it("rejects missing provenance before the MCP handler starts", async () => {
    const request = new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tools/list" }),
    });
    const response = await handleMcp(request, env, createExecutionContext());
    expect(response.status).toBe(401);
  });

  it("names invalid save_memory fields in its tool error", async () => {
    const response = await rpc("tools/call", {
      name: "save_memory",
      arguments: { body: "A memory without type or tags." },
    });

    expect(response.result.isError).toBe(true);
    expect(response.result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("type, title, tags"),
        }),
      ]),
    );
  });

  it("lists similar memories on save, same project first, and asks about them", async () => {
    const memory = async (title: string, project: string) =>
      (await tool("save_memory", {
        type: "insight",
        title,
        body: "Body.",
        tags: ["evals"],
        project,
      })) as Awaited<ReturnType<typeof tool>> & { content: unknown[] };
    const first = await memory("Eval runs need a fresh store too", "blog");
    expect(first.structuredContent.similar).toEqual([]);
    expect(first.content).toHaveLength(1);

    const sameProject = await memory("Eval runs need a fresh store", "valise");
    const restated = await memory("Eval runs need a fresh store", "valise");
    expect(
      (restated.structuredContent.similar as { id: string }[]).map(
        (hit) => hit.id,
      ),
    ).toEqual([sameProject.structuredContent.id, first.structuredContent.id]);
    expect(restated.content.at(-1)).toEqual({
      type: "text",
      text: nudges.save_memory,
    });
  });

  // ADR-0009: a facet is a tag, and a reserved key writes its column instead.
  it("routes reserved facets to their columns and filters by the rest", async () => {
    const saved = await tool("save_memory", {
      type: "fact",
      title: "Facets are tags with a colon",
      body: "facetmarker",
      tags: ["project:valise", "priority:1"],
    });
    expect(saved.structuredContent.metadata).toMatchObject({
      project: "valise",
      tags: ["priority:1"],
    });

    const hits = async (args: Record<string, unknown>) =>
      (
        (await tool("search", { query: "facetmarker", ...args }))
          .structuredContent.results as { id: string }[]
      ).map((hit) => hit.id);
    expect(await hits({ tags: ["priority:1"] })).toEqual([
      saved.structuredContent.id,
    ]);
    expect(await hits({ tags: ["priority:10"] })).toEqual([]);
    expect(await hits({ tags: ["project:valise", "type:memory"] })).toEqual([
      saved.structuredContent.id,
    ]);
    expect(await hits({ tags: ["project:other"] })).toEqual([]);

    for (const [name, args] of [
      ["search", { query: "x", tags: ["state:done"] }],
      ["search", { query: "x", tags: ["type:note"] }],
      ["create_todo", { title: "t", project: "valise", tags: ["project:x"] }],
      ["create_todo", { title: "t", project: "valise", tags: ["type:bug"] }],
    ] as const) {
      const response = await rpc("tools/call", { name, arguments: args });
      expect(response.result.isError, JSON.stringify(args)).toBe(true);
    }
  });
});

async function tool(name: string, args: Record<string, unknown>) {
  const response = await rpc("tools/call", { name, arguments: args });
  expect(response.result.isError).not.toBe(true);
  const { structuredContent } = response.result;
  if (structuredContent === undefined) {
    throw new Error(`${name} returned no structured content`);
  }
  return { ...response.result, structuredContent };
}

async function rpc(method: string, params: Record<string, unknown>) {
  const { raw, response, value } = await callMcp(method, params);
  expect(response.status, raw).toBe(200);
  return value;
}
