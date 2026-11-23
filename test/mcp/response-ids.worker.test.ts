import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { mcpHandler } from "../../workers/mcp";

/**
 * A JSON-RPC response with `id: null` and a `result` matches no member of the
 * client's message union, so the SDK throws `invalid_union` instead of
 * surfacing the failure. Before #179 the rate limiter answered every limited
 * call that way; these pin the preflight paths that could still do it.
 */

afterEach(async () => {
  await env.DB.prepare("DELETE FROM mcp_calls").run();
});

async function send(body: unknown, scope = ["search:read", "skills:read"]) {
  const ctx = createExecutionContext();
  Object.assign(ctx, {
    auth: { clientId: "opencode-test", scope },
    props: { userId: "local" },
  });
  const response = await mcpHandler.fetch(
    new Request("https://valise.test/mcp", {
      method: "POST",
      headers: {
        host: "valise.test",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  const buffered = new Response(await response.arrayBuffer(), response);
  await waitOnExecutionContext(ctx);
  return buffered;
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

describe("preflight responses to an id-less tools/call", () => {
  it.each([
    ["invalid input", { name: "search", arguments: {} }, "protocol_error"],
    [
      "a missing scope",
      { name: "list_ready", arguments: {} },
      "insufficient_scope",
    ],
  ])("answer %s without a null-id result", async (_, params, outcome) => {
    const response = await send({
      jsonrpc: "2.0",
      method: "tools/call",
      params,
    });
    const body = parsed(await response.text());
    expect(body).not.toMatchObject({ id: null });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(
      await env.DB.prepare("SELECT outcome FROM mcp_calls").first(),
    ).toEqual({ outcome });
  });

  it("still correlates a preflight failure with the request id", async () => {
    const response = await send({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "search", arguments: {} },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: 7,
      result: { isError: true, error: "invalid_input" },
    });
  });
});

describe("JSON-RPC batches", () => {
  it("refuses a batch instead of dispatching it past the scope check", async () => {
    const response = await send([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create_todo", arguments: { title: "x" } },
      },
    ]);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("JSON-RPC batches are not supported.");
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM todos").first(),
    ).toEqual({ n: 0 });
    expect(
      await env.DB.prepare("SELECT method, outcome FROM mcp_calls").first(),
    ).toEqual({ method: "POST", outcome: "protocol_error" });
  });
});
