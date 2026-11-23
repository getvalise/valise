import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { handleMcp } from "../../workers/mcp";

// Frozen from abf1bc9:app/mcp/contracts.ts, before PR134. Do not derive this
// from today's contracts: that would update the supposedly stale client too.
const originalReceipt = z.object({
  id: z.string(),
  title: z.string(),
  text: z.string(),
  metadata: z.object({
    type: z.string(),
    tags: z.array(z.string()),
    project: z.string().nullable(),
    created_at: z.number(),
  }),
  similar: z.array(z.object({ id: z.string(), title: z.string() })),
});

const originalInput = z.object({
  type: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(500),
  body: z
    .string()
    .trim()
    .min(1)
    .max(16 * 1024),
  tags: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
  project: z.string().trim().min(1).max(200).optional(),
  why: z.string().trim().min(1).max(280).optional(),
});

// Frozen from 4d0cd4e:app/mcp/contracts.ts (PR134). This intermediate
// contract requires links, while the original contract forbids them.
const pr134Receipt = originalReceipt.extend({
  metadata: originalReceipt.shape.metadata.extend({
    links: z.array(
      z.object({
        kind: z.enum([
          "part-of",
          "supersedes",
          "contradicts",
          "related",
          "superseded-by",
          "has-part",
        ]),
        id: z
          .string()
          .trim()
          .regex(/^memory:[^:\s]+$/),
        title: z.string(),
        confirmed: z.boolean(),
        asserted_by: z.enum(["model", "person"]),
      }),
    ),
  }),
});

// A real HTTP discovery server for the historical contract, not a patched
// validator or a toolDefinition override. Only discovery runs before deploy.
function historicalServer(generation: "original" | "pr134") {
  const server = new McpServer({ name: "valise", version: "0.1.0" });
  server.registerTool(
    "save_memory",
    {
      inputSchema: originalInput,
      outputSchema: generation === "original" ? originalReceipt : pr134Receipt,
    },
    async () => {
      throw new Error("Historical fixture serves discovery only");
    },
  );
  return server;
}

// Where a schema forbids properties it does not list. A client caches the
// schema it discovered, so a closed object turns every later field into a
// rejected response until the client reconnects.
function closedPaths(schema: unknown, path = "$"): string[] {
  if (Array.isArray(schema))
    return schema.flatMap((item, i) => closedPaths(item, `${path}[${i}]`));
  if (typeof schema !== "object" || schema === null) return [];
  return Object.entries(schema).flatMap(([key, value]) =>
    key === "additionalProperties" && value === false
      ? [path]
      : closedPaths(value, `${path}.${key}`),
  );
}

function withoutClosure(schema: unknown): unknown {
  return JSON.parse(
    JSON.stringify(schema, (key, value) =>
      key === "additionalProperties" ? undefined : value,
    ),
  );
}

afterEach(async () => {
  for (const table of [
    "search_docs",
    "memory_links",
    "memory_revisions",
    "memories",
    "mcp_calls",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

function connection(
  protocol: "legacy" | "modern",
  historical: "original" | "pr134" | null,
) {
  let deployed = historical === null;
  const methods: string[] = [];
  const client = new Client(
    { name: "valise-cached-schema-test", version: "1.0.0" },
    {
      versionNegotiation: {
        mode: protocol === "modern" ? { pin: "2026-07-28" } : "legacy",
      },
    },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL("http://127.0.0.1/mcp"),
    {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        request.headers.set("host", "127.0.0.1");
        request.headers.set("x-valise-agent", "cached-schema-test");
        request.headers.set("x-valise-client", "sdk");
        if (request.method === "POST") {
          const body = (await request.clone().json()) as { method: string };
          methods.push(body.method);
        }
        const ctx = createExecutionContext();
        const response = deployed
          ? await handleMcp(request, env, ctx)
          : await createMcpHandler(() =>
              historicalServer(historical ?? "original"),
            )(request, env, ctx);
        // Drain the HTTP response before flushing waitUntil's observation.
        const buffered = new Response(await response.arrayBuffer(), response);
        await waitOnExecutionContext(ctx);
        return buffered;
      },
    },
  );
  return {
    client,
    transport,
    methods,
    deploy: () => {
      deployed = true;
    },
  };
}

const claim = {
  type: "fact",
  title: "Cached schema write proof",
  body: "A receipt validation error does not undo a committed memory.",
  tags: ["compatibility"],
};

describe.each(["legacy", "modern"] as const)("%s cached MCP schemas", (era) => {
  it("advertises every output schema open, so an added field reaches a cached client", async () => {
    const { client, transport } = connection(era, null);
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(20);
      const closed = tools.flatMap((tool) =>
        closedPaths(tool.outputSchema).map((path) => `${tool.name} ${path}`),
      );
      expect(closed).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("accepts one write after discovery before deployment, without refreshing or retrying", async () => {
    const { client, transport, deploy, methods } = connection(era, "original");
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        ["save_memory"],
      );
      deploy();
      const lists = methods.filter((method) => method === "tools/list").length;
      const saved = await client.callTool({
        name: "save_memory",
        arguments: claim,
      });
      expect(saved.isError).not.toBe(true);
      expect(saved.structuredContent).toMatchObject({ title: claim.title });
      expect(methods.filter((method) => method === "tools/list")).toHaveLength(
        lists,
      );
      expect(methods.filter((method) => method === "tools/call")).toHaveLength(
        1,
      );
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS n FROM memories").first("n"),
      ).toBe(1);
      expect(
        await env.DB.prepare(
          "SELECT outcome FROM mcp_calls WHERE tool = 'save_memory'",
        ).first("outcome"),
      ).toBe("ok");
      // Explicit refresh discovers the missing tool and must not replay the
      // successful write. callTool itself did not refresh the stale catalog.
      expect(
        (await client.listTools(undefined, { cacheMode: "refresh" })).tools.map(
          (tool) => tool.name,
        ),
      ).toContain("edit_memory");
      expect(methods.filter((method) => method === "tools/call")).toHaveLength(
        1,
      );
    } finally {
      await client.close();
    }
  });

  it("discovers edit_memory on a fresh connection and validates the write receipt", async () => {
    const { client, transport } = connection(era, null);
    try {
      await client.connect(transport);
      expect(client.getServerCapabilities()).toMatchObject({
        tools: { listChanged: false },
        resources: { listChanged: false },
        prompts: { listChanged: false },
      });
      expect(
        (await client.listTools()).tools.map((tool) => tool.name),
      ).toContain("edit_memory");
      const saved = await client.callTool({
        name: "save_memory",
        arguments: claim,
      });
      expect(saved.isError).not.toBe(true);
      const receipt = originalReceipt.parse(saved.structuredContent);
      const edited = await client.callTool({
        name: "edit_memory",
        arguments: {
          id: receipt.id,
          body: "Updated through the freshly discovered tool.",
        },
      });
      expect(edited.isError).not.toBe(true);
      expect(edited.structuredContent).toMatchObject({
        id: receipt.id,
        text: "Updated through the freshly discovered tool.",
      });
    } finally {
      await client.close();
    }
  });

  it("keeps link details outside the closed receipt and in authoritative reads", async () => {
    const { client, transport } = connection(era, null);
    try {
      await client.connect(transport);
      await client.listTools();
      const parent = originalReceipt.parse(
        (await client.callTool({ name: "save_memory", arguments: claim }))
          .structuredContent,
      );
      const child = await client.callTool({
        name: "save_memory",
        arguments: {
          ...claim,
          title: "Child of the cached schema write proof",
          relates: [{ id: parent.id, kind: "part-of" }],
        },
      });
      expect(child.isError).not.toBe(true);
      const receipt = originalReceipt.parse(child.structuredContent);
      expect(receipt.metadata).not.toHaveProperty("links");
      expect(child.content[0]).toEqual({
        type: "text",
        text: JSON.stringify(child.structuredContent),
      });
      const linkDetails = {
        links: [
          {
            id: parent.id,
            title: parent.title,
            kind: "part-of",
            confirmed: false,
            asserted_by: "model",
          },
        ],
      };
      // Claude Code drops a second text block, so the links are fetch's.
      expect(child.content).not.toContainEqual(
        expect.objectContaining({ text: expect.stringContaining('{"links"') }),
      );
      const fetched = await client.callTool({
        name: "fetch",
        arguments: { id: receipt.id },
      });
      expect(fetched.structuredContent).toMatchObject({
        metadata: linkDetails,
      });
    } finally {
      await client.close();
    }
  });

  it("recovers an intermediate PR134 cache with reads and an explicit refresh, not a write retry", async () => {
    const { client, transport, deploy, methods } = connection(era, "pr134");
    try {
      await client.connect(transport);
      await client.listTools();
      deploy();
      // Existing preflight errors bypass output validation and remain logged.
      const invalid = await client.callTool({
        name: "save_memory",
        arguments: {},
      });
      expect(invalid.isError).toBe(true);
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS n FROM memories").first("n"),
      ).toBe(0);
      await expect(
        client.callTool({ name: "save_memory", arguments: claim }),
      ).rejects.toThrow(/output schema/);
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS n FROM memories").first("n"),
      ).toBe(1);
      const searched = await client.callTool({
        name: "search",
        arguments: { query: claim.title },
      });
      const hits = searched.structuredContent as { results: { id: string }[] };
      expect(hits.results).toHaveLength(1);
      const fetched = await client.callTool({
        name: "fetch",
        arguments: { id: hits.results[0].id },
      });
      expect(fetched.structuredContent).toMatchObject({
        id: hits.results[0].id,
        title: claim.title,
        text: claim.body,
        metadata: { links: [] },
      });
      const logs = await env.DB.prepare(
        "SELECT outcome, target_id FROM mcp_calls WHERE tool = 'save_memory' ORDER BY rowid",
      ).all();
      expect(logs.results).toEqual([
        { outcome: "invalid_input", target_id: null },
        { outcome: "ok", target_id: hits.results[0].id },
      ]);
      const saveCalls = methods.filter(
        (method) => method === "tools/call",
      ).length;
      const refreshed = await client.listTools(undefined, {
        cacheMode: "refresh",
      });
      const schema = refreshed.tools.find(
        (tool) => tool.name === "save_memory",
      )?.outputSchema;
      // Same fields as the frozen receipt, advertised open (ADR-0003).
      expect(closedPaths(schema)).toEqual([]);
      expect(withoutClosure(schema)).toEqual(
        withoutClosure(z.toJSONSchema(originalReceipt)),
      );
      expect(methods.filter((method) => method === "tools/call")).toHaveLength(
        saveCalls,
      );
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS n FROM memories").first("n"),
      ).toBe(1);
    } finally {
      await client.close();
    }
  });
});
