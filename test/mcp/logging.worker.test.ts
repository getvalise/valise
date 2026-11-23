import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CallRow,
  parseActivityFilters,
  readActivity,
  readCalls,
  trimActivity,
} from "~/concepts/activity";
import { readMemoryUsage } from "~/concepts/memories";
import { readSkillUsage } from "~/concepts/skills";
import { type ObservedCall, observeCall } from "~/mcp/observe";
import { callMcp } from "./fixture-worker";

/**
 * The call log is the only record of what a client actually sent, so what it
 * records has to be asserted rather than assumed. ADR-0006.
 */

const db = env.DB;

afterEach(async () => {
  for (const table of [
    "mcp_calls",
    "auth_events",
    "search_docs",
    "todo_updates",
    "todos",
    "memories",
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await db
    .prepare("INSERT INTO search_docs_fts(search_docs_fts) VALUES('rebuild')")
    .run();
});

async function logged(): Promise<CallRow[]> {
  return readCalls(env, "local", {
    windowHours: 24,
    tool: null,
    client: null,
    outcome: null,
    fields: {},
    errorsOnly: false,
    intentOnly: false,
    handshakes: true,
  });
}

describe("the MCP call log", () => {
  it("records a listing with no tool and no arguments", async () => {
    await callMcp("tools/list", {});

    const [row] = await logged();
    expect(row).toMatchObject({
      transport: "loopback",
      agent: "vitest",
      client: "test",
      method: "tools/list",
      httpMethod: "POST",
      tool: null,
      // No mcp-method header: the bucket is the call's own method (ADR-0006).
      limiterMethod: "tools/list",
      limiterName: "unclassified",
      outcome: "ok",
      status: 200,
    });
    expect(row.argsJson).toBeNull();
    expect(row.resultBytes).toBeGreaterThan(0);
  });

  it("records the normalized limiter dimensions from their headers", async () => {
    await callMcp("resources/templates/list", {}, "vitest", undefined, {
      "mcp-method": "x".repeat(250),
      "mcp-name": "resources/templates/list",
    });

    const [row] = await logged();
    expect(row).toMatchObject({
      method: "resources/templates/list",
      limiterMethod: "x".repeat(200),
      limiterName: "resources/templates/list",
    });
  });

  it("records the arguments a tool call carried, and its scope", async () => {
    await callMcp("tools/call", {
      name: "search",
      arguments: { query: "bm25 weighting" },
    });

    const [row] = await logged();
    expect(row).toMatchObject({
      method: "tools/call",
      tool: "search",
      requiredScope: "search:read",
      outcome: "ok",
    });
    expect(JSON.parse(row.argsJson ?? "{}")).toEqual({
      query: "bm25 weighting",
    });
    expect(row.argsBytes).toBe(row.argsJson?.length);
  });

  it("separates a rejected input from a tool that ran and failed", async () => {
    await callMcp("tools/call", {
      name: "create_todo",
      arguments: { title: "no project here" },
    });
    await callMcp("tools/call", {
      name: "fetch",
      arguments: { id: "memory:does-not-exist" },
    });

    const byTool = new Map((await logged()).map((row) => [row.tool, row]));
    expect(byTool.get("create_todo")).toMatchObject({
      outcome: "invalid_input",
      errorCode: "invalid_input",
    });
    // The arguments are kept even when the preflight refused them: a call that
    // never reached a tool is the one worth reading.
    expect(byTool.get("create_todo")?.argsJson).toContain("no project here");
    expect(byTool.get("fetch")).toMatchObject({
      outcome: "tool_error",
      errorCode: null,
    });
  });

  it("keeps the reason an MCP SDK tool error gave", async () => {
    // The shape behind a bare `tool_error` on production: an update_todo with
    // a fencing token the to-do does not hold.
    const created = await callMcp("tools/call", {
      name: "create_todo",
      arguments: { title: "stale token proof", project: "valise" },
    });
    const id = (created.value.result.structuredContent as { id: string }).id;
    await callMcp("tools/call", { name: "claim_todo", arguments: { id } });
    const answered = await callMcp("tools/call", {
      name: "update_todo",
      arguments: { id, token: 99, body: "a finding" },
    });
    const said = (answered.value.result.content as { text: string }[])[0].text;

    const row = (await logged()).find((call) => call.tool === "update_todo");
    expect(row).toMatchObject({ outcome: "tool_error", errorCode: null });
    expect(said.length).toBeGreaterThan(0);
    expect(row?.errorMessage).toBe(said);
  });

  it("keeps the reason a preflight rejection gave, beside its code", async () => {
    await callMcp("tools/call", {
      name: "create_todo",
      arguments: { title: "no project here" },
    });

    const [row] = await logged();
    expect(row.errorCode).toBe("invalid_input");
    expect(row.errorMessage).toContain("project");
  });

  it("keeps the message of a JSON-RPC error", async () => {
    const answered = await callMcp("no/such-method", {});
    expect(answered.value.error?.message).toBeTruthy();

    const [row] = await logged();
    expect(row.outcome).not.toBe("ok");
    expect(row.errorMessage).toBe(answered.value.error?.message);
  });

  it("records the item a call acted on, from its argument or its result", async () => {
    const created = await callMcp("tools/call", {
      name: "create_todo",
      arguments: { title: "target proof", project: "valise" },
    });
    const id = (created.value.result.structuredContent as { id: string }).id;
    await callMcp("tools/call", { name: "claim_todo", arguments: { id } });
    // A query that quotes an id is not the call's target.
    await callMcp("tools/call", { name: "search", arguments: { query: id } });
    // A refused fetch still names what it asked for.
    await callMcp("tools/call", {
      name: "fetch",
      arguments: { id: "memory:mem_gone" },
    });
    // A refused create has no result id to read.
    await callMcp("tools/call", {
      name: "create_todo",
      arguments: { title: "no project here" },
    });

    const rows = await logged();
    const target = (tool: string) =>
      rows.filter((row) => row.tool === tool).map((row) => row.targetId);
    expect(target("create_todo").sort()).toEqual([id, null].sort());
    expect(target("claim_todo")).toEqual([id]);
    expect(target("search")).toEqual([null]);
    expect(target("fetch")).toEqual(["memory:mem_gone"]);
  });

  it("leaves the message null on a call that worked", async () => {
    await callMcp("tools/call", {
      name: "search",
      arguments: { query: "duckdb" },
    });

    const [row] = await logged();
    expect(row.errorMessage).toBeNull();
  });

  it("records why a claim-path call says it was made", async () => {
    const created = await callMcp("tools/call", {
      name: "create_todo",
      arguments: { title: "intent proof", project: "valise" },
    });
    const id = (created.value.result.structuredContent as { id: string }).id;
    await callMcp("tools/call", {
      name: "claim_todo",
      arguments: { id, why: "The user asked me to start on the rank work." },
    });

    const row = (await logged()).find((call) => call.tool === "claim_todo");
    expect(row?.intent).toBe("The user asked me to start on the rank work.");
    expect(row?.outcome).toBe("ok");
  });

  it("prefers a SEP-2817 _meta reason over the argument", async () => {
    const created = await callMcp("tools/call", {
      name: "create_todo",
      arguments: { title: "meta proof", project: "valise" },
    });
    const id = (created.value.result.structuredContent as { id: string }).id;
    await callMcp("tools/call", {
      name: "claim_todo",
      arguments: { id, why: "from the argument" },
      _meta: {
        "io.modelcontextprotocol/aiInvocation": {
          invocationReason: { text: "from _meta" },
        },
      },
    });

    const row = (await logged()).find((call) => call.tool === "claim_todo");
    expect(row?.intent).toBe("from _meta");
  });

  it("records why a save_memory says it classified the way it did", async () => {
    await callMcp("tools/call", {
      name: "save_memory",
      arguments: {
        type: "preference",
        title: "Query the warehouse through its MCP, not ad hoc scripts",
        body: "Query the warehouse through its MCP, not ad hoc scripts.",
        tags: ["duckdb", "warehouse"],
        why: "Typed as a preference because the user said 'always', not once.",
      },
    });

    const row = (await logged()).find((call) => call.tool === "save_memory");
    expect(row?.intent).toContain("Typed as a preference");
    expect(row?.outcome).toBe("ok");
  });

  it("leaves the intent null on a tool that does not offer why", async () => {
    await callMcp("tools/call", {
      name: "search",
      arguments: { query: "duckdb" },
    });

    const [row] = await logged();
    expect(row.intent).toBeNull();
  });

  it("records the client an initialize announced, not just the transport", async () => {
    await callMcp("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "claude-code", version: "2.4.1" },
    });

    const [row] = await logged();
    expect(row.method).toBe("initialize");
    expect(JSON.parse(row.argsJson ?? "{}").clientInfo).toEqual({
      name: "claude-code",
      version: "2.4.1",
    });
  });

  it("filters to the calls that said why", async () => {
    const created = await callMcp("tools/call", {
      name: "create_todo",
      arguments: { title: "filter proof", project: "valise" },
    });
    const id = (created.value.result.structuredContent as { id: string }).id;
    await callMcp("tools/call", {
      name: "claim_todo",
      arguments: { id, why: "picking this up now" },
    });

    const said = await readCalls(env, "local", {
      windowHours: 24,
      tool: null,
      client: null,
      outcome: null,
      fields: {},
      errorsOnly: false,
      intentOnly: true,
      handshakes: true,
    });
    expect(said).toHaveLength(1);
    expect(said[0].tool).toBe("claim_todo");
  });

  it("counts a memory's fetches from the log, and not a refused one", async () => {
    const saved = await callMcp("tools/call", {
      name: "save_memory",
      arguments: {
        type: "fact",
        title: "Fetch counting proof",
        body: "Counted from mcp_calls.",
        tags: ["metrics"],
        project: "valise",
      },
    });
    const id = (saved.value.result.structuredContent as { id: string }).id;
    await callMcp("tools/call", { name: "fetch", arguments: { id } });
    await callMcp("tools/call", { name: "fetch", arguments: { id } });
    // A search that returns it is not an access, and nor is a refused fetch.
    await callMcp("tools/call", {
      name: "search",
      arguments: { query: "fetch counting proof" },
    });
    await callMcp("tools/call", {
      name: "fetch",
      arguments: { id: "memory:mem_gone" },
    });

    const usage = await readMemoryUsage(db, "local");
    expect(usage.get(id)?.fetches).toBe(2);
    expect(usage.get(id)).toMatchObject({ appearances: 1 });
    expect(usage.get(id)?.lastFetched).toBeGreaterThan(0);
    expect(usage.has("memory:mem_gone")).toBe(false);
  });

  it("counts successful prompt loads separately from listings and failed loads", async () => {
    const published = await callMcp("tools/call", {
      name: "publish_skill",
      arguments: {
        body: "---\nname: capture-this\ndescription: Save a durable memory.\n---\n\nRead the evidence first.",
      },
    });
    expect(published.value.result.isError).not.toBe(true);
    await callMcp("prompts/list", {});
    expect(
      (await readSkillUsage(db, "local", ["capture-this"])).has("capture-this"),
    ).toBe(false);
    expect(
      (await callMcp("prompts/get", { name: "capture-this" })).value.error,
    ).toBeUndefined();
    expect(
      (await callMcp("prompts/get", { name: "capture-this" })).value.error,
    ).toBeUndefined();
    await callMcp("prompts/get", { name: "missing-skill" });
    const usage = await readSkillUsage(db, "local", [
      "capture-this",
      "missing-skill",
    ]);
    expect(usage.get("capture-this")).toMatchObject({
      asTool: 0,
      viaGetSkill: 0,
      asResource: 0,
      asPrompt: 2,
      lastSeen: expect.any(Number),
    });
    expect(usage.has("missing-skill")).toBe(false);
  });

  it.each([
    ["resources/read", null],
    ["tools/call", "get_skill"],
    ["prompts/get", null],
  ])(
    "keeps skill usage readable with truncated %s arguments",
    async (method, tool) => {
      await db
        .prepare(`INSERT INTO mcp_calls (
      call_id, at, transport, method, tool, args_json, outcome, status, duration_ms
    ) VALUES (?, 1, 'loopback', ?, ?, '{', 'ok', 200, 1)`)
        .bind(`cal_${crypto.randomUUID()}`, method, tool)
        .run();
      expect(await readSkillUsage(db, "local", ["capture-this"])).toEqual(
        new Map(),
      );
    },
  );

  it("counts each of a skill's loading methods apart", async () => {
    await callMcp("tools/call", { name: "skill_capture-this", arguments: {} });
    await callMcp("tools/call", {
      name: "get_skill",
      arguments: { name: "capture-this" },
    });
    await callMcp("resources/read", {
      uri: "skill://capture-this/SKILL.md",
    });

    const usage = await readSkillUsage(db, "local", ["capture-this"]);
    expect(usage.get("capture-this")).toMatchObject({
      asTool: 1,
      viaGetSkill: 1,
      asResource: 1,
    });
  });

  it("counts fetches even when the logged arguments were truncated", async () => {
    const saved = await callMcp("tools/call", {
      name: "save_memory",
      arguments: {
        title: "Truncation proof",
        body: "A claim",
        type: "fact",
        tags: ["metrics"],
      },
    });
    const id = saved.value.result.structuredContent?.id;
    if (typeof id !== "string") throw new Error("Missing memory id");
    await callMcp("tools/call", {
      name: "fetch",
      arguments: { id, extra: "x".repeat(10000) },
    });
    expect((await readMemoryUsage(db, "local")).get(id)?.fetches).toBe(1);
    await db
      .prepare(`INSERT INTO mcp_calls (
      call_id, at, user_id, transport, method, tool, args_json, args_bytes, outcome, status, duration_ms
    ) VALUES ('legacy-fetch', ?, 'local', 'loopback', 'tools/call', 'fetch', ?, 50, 'ok', 200, 1)`)
      .bind(Date.now(), JSON.stringify({ id }))
      .run();
    expect((await readMemoryUsage(db, "local")).get(id)?.fetches).toBe(2);
  });

  it("counts only delivered search ids, capped and deduplicated, without fetching", async () => {
    const call: ObservedCall = {
      startedAt: Date.now(),
      transport: "loopback",
      userId: "local",
      principal: "test",
      agent: "test",
      client: "test",
      session: null,
      httpMethod: "POST",
      limiterMethod: "rpc",
      limiterName: "unclassified",
      streamProbe: false,
      method: "tools/call",
      tool: "search",
      requiredScope: "search:read",
      args: { query: "proof" },
      intent: null,
      clientInfo: null,
      userAgent: null,
      sessionName: null,
      host: null,
      plugin: null,
    };
    const results = Array.from({ length: 12 }, (_, i) => ({
      id: `memory:mem_${i}`,
    }));
    results[1] = results[0];
    for (const framing of ["json", "sse"]) {
      const ctx = createExecutionContext();
      const raw = JSON.stringify({
        result: {
          structuredContent: { results },
          _meta: { "valise/rerank": { candidates: ["memory:mem_candidate"] } },
        },
      });
      observeCall(
        ctx,
        env,
        call,
        new Response(
          framing === "sse" ? `event: message\ndata: ${raw}\n\n` : raw,
        ),
      );
      await waitOnExecutionContext(ctx);
    }
    const usage = await readMemoryUsage(db, "local");
    expect(usage.get("memory:mem_0")).toEqual({
      appearances: 2,
      fetches: 0,
      lastFetched: null,
    });
    expect(usage.get("memory:mem_9")?.appearances).toBe(2);
    expect(usage.has("memory:mem_10")).toBe(false);
    expect(usage.has("memory:mem_candidate")).toBe(false);
    const ctx = createExecutionContext();
    observeCall(
      ctx,
      env,
      call,
      new Response(
        JSON.stringify({
          result: { isError: true, structuredContent: { results } },
        }),
      ),
    );
    await waitOnExecutionContext(ctx);
    expect(
      (await readMemoryUsage(db, "local")).get("memory:mem_0")?.appearances,
    ).toBe(2);
  });

  it("counts a resource read logged in the pre-V1-14 bare-uri shape", async () => {
    // What `observed()` wrote before it recorded the whole params object. A
    // count that sees only the new shape reads as a cliff on deploy day.
    await db
      .prepare(
        `INSERT INTO mcp_calls (
           call_id, at, user_id, transport, method, args_json, args_bytes,
           outcome, status, duration_ms
         ) VALUES (?, ?, 'local', 'loopback', 'resources/read', ?, ?, 'ok', 200, 1)`,
      )
      .bind(
        `cal_${crypto.randomUUID()}`,
        Date.now(),
        JSON.stringify("skill://capture-this/references/a.md"),
        40,
      )
      .run();

    const usage = await readSkillUsage(db, "local", ["capture-this"]);
    expect(usage.get("capture-this")?.asResource).toBe(1);
  });

  it("records who the client says it is, from _meta and the plugin's headers", async () => {
    await callMcp(
      "tools/call",
      {
        name: "list_ready",
        arguments: {},
        _meta: {
          "io.modelcontextprotocol/clientInfo": {
            name: "claude-code",
            version: "2.1.302",
          },
        },
      },
      "vitest",
      undefined,
      {
        "user-agent": "claude-code/2.1.302 (cli)",
        "x-valise-session": "ddd24d1a-649e-4918-acae-e0c90e4b8f9e",
        "x-valise-session-name": "valise-34",
        "x-valise-host": "laptop",
        "x-valise-plugin": "valise/0.3.0",
      },
    );

    const [row] = await logged();
    expect(row).toMatchObject({
      tool: "list_ready",
      clientInfo: "claude-code 2.1.302",
      userAgent: "claude-code/2.1.302 (cli)",
      session: "ddd24d1a-649e-4918-acae-e0c90e4b8f9e",
      sessionName: "valise-34",
      host: "laptop",
      plugin: "valise/0.3.0",
    });
  });

  it("reads clientInfo from a legacy initialize's params", async () => {
    await callMcp("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "codex", version: "0.9" },
    });

    const [row] = await logged();
    expect(row.clientInfo).toBe("codex 0.9");
    // No plugin, so nothing the plugin would have said.
    expect(row.plugin).toBeNull();
    expect(row.sessionName).toBeNull();
  });

  it("records a transport refusal as a protocol error, not a tool error", async () => {
    await callMcp("tools/list", {}, "vitest", "application/json");

    const [row] = await logged();
    expect(row).toMatchObject({ outcome: "protocol_error", status: 406 });
  });

  it("totals the window for the counters and the filter selects", async () => {
    await callMcp("tools/call", { name: "search", arguments: { query: "a" } });
    await callMcp(
      "tools/call",
      { name: "search", arguments: { query: "b" } },
      "other-agent",
    );
    await callMcp("tools/call", {
      name: "create_todo",
      arguments: { title: "incomplete" },
    });

    const activity = await readActivity(env, "local", {
      windowHours: 24,
      tool: null,
      client: null,
      outcome: null,
      fields: {},
      errorsOnly: false,
      intentOnly: false,
      handshakes: true,
    });
    expect(activity.totals.calls).toBe(3);
    expect(activity.totals.errors).toBe(1);
    expect(activity.totals.tools).toBe(2);
    // The filter selects are built from these, so they have to stay complete
    // even though the per-tool and per-client tables are gone.
    expect(activity.knownTools).toEqual(["create_todo", "search"]);
    expect(activity.knownClients).toEqual(["test"]);
  });

  it("filters on any column a pane value carries, each one ANDed", async () => {
    const search = { name: "search", arguments: { query: "a" } };
    await callMcp("tools/call", search, "vitest", undefined, {
      "x-valise-host": "studio",
      "x-valise-session-name": "left",
    });
    await callMcp("tools/call", search, "vitest", undefined, {
      "x-valise-host": "studio",
      "x-valise-session-name": "right",
    });
    await callMcp("tools/call", search, "vitest", undefined, {
      "x-valise-host": "laptop",
      "x-valise-session-name": "left",
    });

    const narrowed = (fields: Record<string, string>) =>
      readCalls(env, "local", {
        windowHours: 24,
        tool: null,
        client: null,
        outcome: null,
        fields,
        errorsOnly: false,
        intentOnly: false,
        handshakes: true,
      });
    expect(await narrowed({ host: "studio" })).toHaveLength(2);
    const both = await narrowed({ host: "studio", name: "left" });
    expect(both.map((row) => [row.host, row.sessionName])).toEqual([
      ["studio", "left"],
    ]);
    expect(
      parseActivityFilters(
        new URL("http://x/workbench?host=studio&name=left&bogus=1&target=+"),
      ).fields,
    ).toEqual({ host: "studio", name: "left" });
  });

  it("filters to the calls that did not come back ok", async () => {
    await callMcp("tools/call", { name: "search", arguments: { query: "a" } });
    await callMcp("tools/call", {
      name: "create_todo",
      arguments: { title: "incomplete" },
    });

    const refused = await readCalls(env, "local", {
      windowHours: 24,
      tool: null,
      client: null,
      outcome: null,
      fields: {},
      errorsOnly: true,
      intentOnly: false,
      handshakes: true,
    });
    expect(refused).toHaveLength(1);
    expect(refused[0].tool).toBe("create_todo");
  });

  it("trims past the retention window and leaves the rest", async () => {
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO mcp_calls (call_id, at, transport, method, outcome, status, duration_ms)
           VALUES (?, ?, 'loopback', 'tools/list', 'ok', 200, 1)`,
      )
      .bind("cal_old", now - 31 * 24 * 60 * 60 * 1000)
      .run();
    await callMcp("tools/list", {});

    const removed = await trimActivity(env, now);
    expect(removed.calls).toBe(1);
    const kept = await db
      .prepare("SELECT call_id FROM mcp_calls")
      .all<{ call_id: string }>();
    expect(kept.results).toHaveLength(1);
    expect(kept.results[0].call_id).not.toBe("cal_old");
  });
});
