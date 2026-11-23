import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ActivityFilters,
  readActivity,
  readCalls,
  readRuns,
} from "~/concepts/activity";
import { type ObservedCall, observeCall } from "~/mcp/observe";
import { handleMcp, mcpHandler } from "../../workers/mcp";

const filters: ActivityFilters = {
  windowHours: 24,
  tool: null,
  client: null,
  outcome: null,
  fields: {},
  errorsOnly: false,
  intentOnly: false,
  handshakes: true,
};

afterEach(async () => {
  await env.DB.prepare("DELETE FROM mcp_calls").run();
});

async function probe(headers: Record<string, string> = {}, method = "GET") {
  const ctx = createExecutionContext();
  const response = await handleMcp(
    new Request("http://127.0.0.1/mcp", {
      method,
      headers: {
        host: "127.0.0.1",
        accept: "text/event-stream",
        "mcp-protocol-version": "2025-11-25",
        "x-valise-agent": "stream-test",
        "x-valise-client": "test",
        ...headers,
      },
    }),
    env,
    ctx,
  );
  const body = await response.text();
  await waitOnExecutionContext(ctx);
  const [row] = await readCalls(env, "local", filters);
  return { response, body, row };
}

describe("optional MCP event-stream probes", () => {
  it("keeps the real 405 response but does not count a refused fresh stream as an error", async () => {
    const { response, body, row } = await probe();
    expect(response.status).toBe(405);
    expect(JSON.parse(body).error).toEqual({
      code: -32000,
      message: "Method not allowed.",
    });
    expect(row).toMatchObject({
      httpMethod: "GET",
      method: "GET",
      tool: null,
      outcome: "ok",
      status: 405,
      errorCode: null,
      errorMessage: null,
    });
    expect((await readActivity(env, "local", filters)).totals).toMatchObject({
      calls: 1,
      errors: 0,
      tools: 0,
    });
    expect((await readRuns(env, "local", filters, "errors"))[0].errors).toBe(0);
    expect(
      await readCalls(env, "local", { ...filters, errorsOnly: true }),
    ).toEqual([]);
    // Still recorded, but only included with the other connection chatter.
    expect(
      await readCalls(env, "local", { ...filters, handshakes: false }),
    ).toEqual([]);
    expect(
      await readRuns(env, "local", { ...filters, handshakes: false }, "recent"),
    ).toEqual([]);
  });

  it.each([
    ["application/json, text/event-stream", "ok"],
    ["TEXT/EVENT-STREAM; q=0.5", "ok"],
    ["application/json", "protocol_error"],
    ["*/*", "protocol_error"],
    ["", "protocol_error"],
    ["text/event-stream; q=0", "protocol_error"],
    ["text/event-stream; q=0.0", "protocol_error"],
    ["text/event-stream; q=invalid", "protocol_error"],
    ["text/event-stream; q=2", "protocol_error"],
    ["text/event-streaming", "protocol_error"],
  ])("classifies Accept %j as %s", async (accept, outcome) => {
    expect((await probe({ accept })).row.outcome).toBe(outcome);
  });

  it.each(["last-event-id", "mcp-session-id"])(
    "does not hide an unsupported session or resumption: %s",
    async (header) => {
      const { row } = await probe({ [header]: "existing-stream" });
      expect(row).toMatchObject({
        outcome: "protocol_error",
        status: 405,
        errorMessage: "Method not allowed.",
      });
      expect(
        await readCalls(env, "local", { ...filters, errorsOnly: true }),
      ).toHaveLength(1);
      expect(
        await readCalls(env, "local", { ...filters, handshakes: false }),
      ).toHaveLength(1);
    },
  );

  it.each(["PUT", "DELETE", "PATCH"])(
    "keeps %s method refusals as failures",
    async (method) => {
      const { row } = await probe({}, method);
      expect(row).toMatchObject({
        httpMethod: method,
        method,
        outcome: "protocol_error",
        status: 405,
        errorMessage: "Method not allowed.",
      });
    },
  );

  it("does not hide a rejected origin on a stream probe", async () => {
    const { row } = await probe({ origin: "https://untrusted.example" });
    expect(row.status).toBe(403);
    expect(row.outcome).not.toBe("ok");
    expect(row.errorMessage).toBeTruthy();
  });

  it("does not classify a GET without a verified principal as an expected probe", async () => {
    const ctx = createExecutionContext();
    const response = await mcpHandler.fetch(
      new Request("https://valise.example/mcp", {
        headers: { accept: "text/event-stream" },
      }),
      env,
      ctx,
    );
    await response.text();
    await waitOnExecutionContext(ctx);
    expect((await readCalls(env, "local", filters))[0]).toMatchObject({
      httpMethod: "GET",
      outcome: "unauthorized",
      status: 401,
    });
  });

  it("records the same expected probe on the authenticated OAuth path", async () => {
    const ctx = createExecutionContext();
    Object.assign(ctx, {
      auth: { clientId: "opencode-test", scope: ["search:read"] },
      props: { userId: "local" },
    });
    const response = await mcpHandler.fetch(
      new Request("https://valise.example/mcp", {
        headers: {
          host: "valise.example",
          accept: "text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(405);
    await response.text();
    await waitOnExecutionContext(ctx);
    expect((await readCalls(env, "local", filters))[0]).toMatchObject({
      httpMethod: "GET",
      transport: "oauth",
      principal: "opencode-test",
      outcome: "ok",
      status: 405,
      errorMessage: null,
    });
  });

  it.each([
    [405, -32000, "A different refusal", true],
    [405, -32603, "Method not allowed.", true],
    [500, -32000, "Method not allowed.", true],
    [405, -32000, "Method not allowed.", false],
  ])(
    "does not suppress another response (%s, %s, %s, probe=%s)",
    async (status, code, message, streamProbe) => {
      const ctx = createExecutionContext();
      const call: ObservedCall = {
        startedAt: Date.now(),
        transport: "loopback",
        userId: "local",
        principal: "stream-test",
        agent: "stream-test",
        client: "test",
        session: null,
        httpMethod: streamProbe ? "GET" : "POST",
        limiterMethod: "rpc",
        limiterName: "unclassified",
        streamProbe,
        method: streamProbe ? "GET" : "tools/call",
        tool: null,
        requiredScope: null,
        args: null,
        intent: null,
        clientInfo: null,
        userAgent: null,
        sessionName: null,
        host: null,
        plugin: null,
      };
      observeCall(
        ctx,
        env,
        call,
        Response.json(
          {
            jsonrpc: "2.0",
            id: null,
            error: { code, message },
          },
          { status },
        ),
      );
      await waitOnExecutionContext(ctx);
      expect((await readCalls(env, "local", filters))[0]).toMatchObject({
        outcome: "protocol_error",
        status,
        errorMessage: message,
      });
    },
  );

  it("leaves historical failures unchanged when the HTTP method is unknown", async () => {
    await env.DB.prepare(`INSERT INTO mcp_calls (
      call_id, at, transport, user_id, method, outcome, status, duration_ms, error_message
    ) VALUES ('cal_legacy', ?, 'oauth', 'local', '(no rpc body)', 'protocol_error', 405, 0, 'Method not allowed.')`)
      .bind(Date.now())
      .run();
    const [row] = await readCalls(env, "local", {
      ...filters,
      errorsOnly: true,
    });
    expect(row).toMatchObject({ httpMethod: null, outcome: "protocol_error" });
  });
});
