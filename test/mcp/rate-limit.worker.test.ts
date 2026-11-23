import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mcpHandler } from "../../workers/mcp";

afterEach(async () => {
  await env.DB.prepare("DELETE FROM mcp_calls").run();
});

function limiter(success = false) {
  return { limit: vi.fn(async (_input: { key: string }) => ({ success })) };
}

async function send(request: Request, binding = limiter()) {
  const ctx = createExecutionContext();
  Object.assign(ctx, {
    auth: { clientId: "opencode-test", scope: ["search:read", "skills:read"] },
    props: { userId: "local" },
  });
  const response = await mcpHandler.fetch(
    request,
    { ...env, MCP_LIMITER: binding },
    ctx,
  );
  const buffered = new Response(await response.arrayBuffer(), response);
  await waitOnExecutionContext(ctx);
  return buffered;
}

function request(body: unknown) {
  return new Request("https://valise.test/mcp", {
    method: "POST",
    headers: {
      host: "valise.test",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify(body),
  });
}

describe("MCP admission failures", () => {
  it.each([
    ["initialize", 0],
    ["tools/list", "catalog-1"],
    ["resources/list", 2],
    ["tools/call", "search-1"],
  ])("returns a correlated HTTP 429 for %s", async (method, id) => {
    const binding = limiter();
    const response = await send(
      request({
        jsonrpc: "2.0",
        id,
        method,
        params: { name: "search", arguments: { query: "duckdb" } },
      }),
      binding,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: "Too many requests. Retry in one minute.",
        data: { code: "rate_limited", retryAfterSeconds: 60 },
      },
    });
    // Without an mcp-method header the bucket is the call's own method, so
    // resource polling cannot use up discovery's budget.
    expect(binding.limit).toHaveBeenCalledWith({
      key: `local:${method}:unclassified`,
    });
    expect(
      await env.DB.prepare(
        "SELECT outcome, status, error_code, error_message FROM mcp_calls",
      ).first(),
    ).toEqual({
      outcome: "rate_limited",
      status: 429,
      error_code: "rate_limited",
      error_message: "Too many requests. Retry in one minute.",
    });
  });

  it.each([
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 1, result: {} },
    { jsonrpc: "2.0", id: null, method: "tools/list" },
    null,
  ])("does not invent a JSON-RPC response for %j", async (body) => {
    const response = await send(request(body));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.text()).toBe("");
    expect(
      await env.DB.prepare("SELECT outcome, status FROM mcp_calls").first(),
    ).toEqual({ outcome: "rate_limited", status: 429 });
  });

  it("does not put an unsolicited result on a GET stream probe", async () => {
    const response = await send(
      new Request("https://valise.test/mcp", {
        headers: { accept: "text/event-stream" },
      }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.text()).toBe("");
    expect(
      await env.DB.prepare("SELECT outcome, status FROM mcp_calls").first(),
    ).toEqual({ outcome: "rate_limited", status: 429 });
  });
});

describe("rate-limit buckets without mcp-method headers", () => {
  /** Cloudflare's simple limiter, 60 per key, without the clock. */
  function quota(limit = 60) {
    const used = new Map<string, number>();
    return {
      limit: vi.fn(async ({ key }: { key: string }) => {
        const next = (used.get(key) ?? 0) + 1;
        used.set(key, next);
        return { success: next <= limit };
      }),
    };
  }
  const call = (method: string, id: number) =>
    request({
      jsonrpc: "2.0",
      id,
      method,
      params:
        method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              capabilities: {},
              clientInfo: { name: "poller", version: "1.0.0" },
            }
          : {},
    });

  it("keeps discovery admitted while a client's resource polling is refused", async () => {
    const binding = quota();
    for (let i = 0; i < 60; i++)
      expect((await send(call("resources/list", i), binding)).status).toBe(200);
    expect((await send(call("resources/list", 60), binding)).status).toBe(429);
    expect((await send(call("initialize", 61), binding)).status).toBe(200);
    expect((await send(call("tools/list", 62), binding)).status).toBe(200);
    const { results } = await env.DB.prepare(
      `SELECT method, limiter_method, outcome FROM mcp_calls
        WHERE method != 'resources/list' OR outcome = 'rate_limited'
        ORDER BY method`,
    ).all();
    // Calls in one clock tick tie on `at`, so the order asserted is by method.
    expect(results).toEqual([
      { method: "initialize", limiter_method: "initialize", outcome: "ok" },
      {
        method: "resources/list",
        limiter_method: "resources/list",
        outcome: "rate_limited",
      },
      { method: "tools/list", limiter_method: "tools/list", outcome: "ok" },
    ]);
  });

  it("keeps an unknown method in the shared bucket, and a sent header wins", async () => {
    const binding = limiter(true);
    await send(call("x/made-up", 1), binding);
    expect(binding.limit).toHaveBeenLastCalledWith({
      key: "local:rpc:unclassified",
    });
    const headed = call("resources/list", 2);
    headed.headers.set("mcp-method", "tools/call");
    headed.headers.set("mcp-name", "search");
    await send(headed, binding);
    expect(binding.limit).toHaveBeenLastCalledWith({
      key: "local:tools/call:search",
    });
  });
});

describe.each(["legacy", "modern"] as const)("%s SDK admission", (era) => {
  function connection(binding: ReturnType<typeof limiter>) {
    const client = new Client(
      { name: "valise-rate-limit-test", version: "1.0.0" },
      {
        versionNegotiation: {
          mode: era === "modern" ? { pin: "2026-07-28" } : "legacy",
        },
      },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL("https://valise.test/mcp"),
      {
        fetch: (input, init) => {
          const outgoing = new Request(input, init);
          outgoing.headers.set("host", "valise.test");
          return send(outgoing, binding);
        },
      },
    );
    return { client, transport };
  }

  it("rejects a reconnect burst without parsing a bogus result", async () => {
    const binding = limiter();
    const connections = Array.from({ length: 8 }, () => connection(binding));
    try {
      const results = await Promise.allSettled(
        connections.map(({ client, transport }) => client.connect(transport)),
      );
      for (const result of results) {
        expect(result.status).toBe("rejected");
        if (result.status !== "rejected") throw new Error("Expected rejection");
        if (era === "legacy") {
          expect(result.reason).toMatchObject({ status: 429 });
          expect(result.reason.message).toContain("rate_limited");
        } else {
          // The pinned modern SDK wraps a failed discovery probe as version
          // negotiation failure, rather than exposing its HTTP error.
          expect(result.reason.message).toContain("Version negotiation failed");
        }
        expect(result.reason.message).not.toMatch(
          /invalid_union|Invalid input/,
        );
      }
    } finally {
      await Promise.all(connections.map(({ client }) => client.close()));
    }
  });

  it("can retry catalog discovery once admission recovers, without a new grant", async () => {
    const binding = limiter(true);
    const { client, transport } = connection(binding);
    try {
      await client.connect(transport);
      binding.limit.mockResolvedValue({ success: false });
      await expect(client.listTools()).rejects.toMatchObject({ status: 429 });
      binding.limit.mockResolvedValue({ success: true });
      expect(
        (await client.listTools()).tools.map((tool) => tool.name),
      ).toContain("search");
    } finally {
      await client.close();
    }
  });
});
