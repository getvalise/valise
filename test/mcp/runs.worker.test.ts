import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ActivityFilters,
  readClientSessions,
  readRuns,
} from "~/concepts/activity";

/**
 * A run is a heuristic, so what it groups and what it refuses to group both
 * have to be asserted. The sessionization runs in SQLite through D1, which is
 * the only place `LAG` and the running sum are exercised.
 */

const db = env.DB;
const MINUTE = 60 * 1000;

/** One reading, so a span assertion is exact rather than within a millisecond. */
const NOW = Date.now();

const filters: ActivityFilters = {
  windowHours: 24,
  tool: null,
  client: null,
  outcome: null,
  fields: {},
  errorsOnly: false,
  intentOnly: false,
  handshakes: false,
};

afterEach(async () => {
  await db.prepare("DELETE FROM mcp_calls").run();
});

/** Minutes before now, so every row lands inside the 24 hour window. */
async function call(
  minutesAgo: number,
  row: {
    agent: string;
    client?: string;
    method?: string;
    session?: string | null;
    sessionName?: string | null;
    tool?: string | null;
    outcome?: string;
    args?: string | null;
    intent?: string | null;
    durationMs?: number;
  },
) {
  await db
    .prepare(
      `INSERT INTO mcp_calls (
         call_id, at, transport, user_id, agent, client, method, tool, args_json,
         intent, outcome, status, duration_ms, session, session_name
       ) VALUES (?, ?, 'loopback', 'local', ?, ?, ?, ?, ?, ?, ?, 200, ?, ?, ?)`,
    )
    .bind(
      `cal_${crypto.randomUUID()}`,
      NOW - minutesAgo * MINUTE,
      row.agent,
      row.client ?? "test",
      row.method ?? "tools/call",
      row.tool === undefined ? "search" : row.tool,
      row.args ?? null,
      row.intent ?? null,
      row.outcome ?? "ok",
      row.durationMs ?? 5,
      row.session ?? null,
      row.sessionName ?? null,
    )
    .run();
}

describe("grouping calls into runs", () => {
  it("keeps calls close in time together and splits on a long gap", async () => {
    await call(60, { agent: "codex" });
    await call(59, { agent: "codex" });
    await call(58, { agent: "codex" });
    // Past the ten minute gap, so this is a second run.
    await call(20, { agent: "codex" });

    const runs = await readRuns(env, "local", filters, "recent");
    expect(runs).toHaveLength(2);
    expect(runs[0].calls).toHaveLength(1);
    expect(runs[1].calls).toHaveLength(3);
    // Two minutes from the first call to the last, in milliseconds.
    expect(runs[1].spanMs).toBe(2 * MINUTE);
  });

  it("does not merge two agents working at the same moment", async () => {
    await call(10, { agent: "codex" });
    await call(10, { agent: "claude-code" });
    await call(9, { agent: "codex" });

    const runs = await readRuns(env, "local", filters, "recent");
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.agent).sort()).toEqual([
      "claude-code",
      "codex",
    ]);
  });

  it("splits the same agent on two clients", async () => {
    await call(10, { agent: "codex", client: "cli" });
    await call(10, { agent: "codex", client: "desktop" });

    const runs = await readRuns(env, "local", filters, "recent");
    expect(runs).toHaveLength(2);
  });

  it("rolls up the counts a row shows", async () => {
    await call(10, { agent: "codex", tool: "search", durationMs: 7 });
    await call(10, { agent: "codex", tool: "fetch", durationMs: 11 });
    await call(9, { agent: "codex", tool: "search", outcome: "tool_error" });
    // A listing carries no tool, so it counts as a call and not as a tool.
    await call(9, { agent: "codex", tool: null, durationMs: 2 });

    const [run] = await readRuns(env, "local", filters, "recent");
    expect(run.calls).toHaveLength(4);
    expect(run.tools).toBe(2);
    expect(run.errors).toBe(1);
    expect(run.serverMs).toBe(25);
  });

  it("badges a run where a tool failed and then answered", async () => {
    await call(10, {
      agent: "codex",
      tool: "create_todo",
      outcome: "invalid_input",
    });
    await call(9, { agent: "codex", tool: "create_todo" });

    const [run] = await readRuns(env, "local", filters, "recent");
    expect(run.recovered).toBe(true);
    expect(run.repeated).toBe(false);
  });

  it("does not badge a failure that never recovered", async () => {
    await call(10, { agent: "codex", tool: "create_todo" });
    await call(9, {
      agent: "codex",
      tool: "create_todo",
      outcome: "invalid_input",
    });

    const [run] = await readRuns(env, "local", filters, "recent");
    expect(run.recovered).toBe(false);
  });

  it("badges the same tool called twice with the same arguments", async () => {
    await call(10, {
      agent: "codex",
      tool: "search",
      args: '{"query":"duckdb"}',
    });
    await call(9, {
      agent: "codex",
      tool: "search",
      args: '{"query":"duckdb"}',
    });

    const [run] = await readRuns(env, "local", filters, "recent");
    expect(run.repeated).toBe(true);
  });

  it("leaves two different questions unbadged", async () => {
    await call(10, {
      agent: "codex",
      tool: "search",
      args: '{"query":"duckdb"}',
    });
    await call(9, { agent: "codex", tool: "search", args: '{"query":"bm25"}' });

    const [run] = await readRuns(env, "local", filters, "recent");
    expect(run.repeated).toBe(false);
  });

  it("carries the first reason any call in the run gave", async () => {
    await call(10, { agent: "codex", tool: "list_ready" });
    await call(9, {
      agent: "codex",
      tool: "claim_todo",
      intent: "Starting on the rank work the user asked about.",
    });

    const [run] = await readRuns(env, "local", filters, "recent");
    expect(run.intent).toBe("Starting on the rank work the user asked about.");
  });

  it("names the caller from the initialize it sent", async () => {
    await db
      .prepare(
        `INSERT INTO mcp_calls (
           call_id, at, transport, user_id, agent, client, method, args_json,
           outcome, status, duration_ms
         ) VALUES (?, ?, 'oauth', 'local', ?, 'oauth', 'initialize', ?, 'ok', 200, 3)`,
      )
      .bind(
        `cal_${crypto.randomUUID()}`,
        NOW - 10 * MINUTE,
        "https://claude.ai/oauth/claude-code-client-metadata",
        JSON.stringify({
          clientInfo: { name: "claude-code", version: "2.4.1" },
        }),
      )
      .run();
    await call(9, {
      agent: "https://claude.ai/oauth/claude-code-client-metadata",
      client: "oauth",
    });

    const [run] = await readRuns(env, "local", filters, "recent");
    expect(run.caller).toBe("claude-code 2.4.1");
  });

  it("falls back to the product name of a known oauth registration url", async () => {
    await call(10, {
      agent: "https://claude.ai/oauth/claude-code-client-metadata",
      client: "oauth",
    });

    const [run] = await readRuns(env, "local", filters, "recent");
    expect(run.caller).toBe("Claude Code");
  });

  it("falls back to the readable end of an unknown registration url", async () => {
    await call(10, {
      agent: "https://example.test/oauth/acme-client-metadata",
      client: "oauth",
    });

    const [run] = await readRuns(env, "local", filters, "recent");
    expect(run.caller).toBe("acme");
  });

  it("leaves a plain agent name alone", async () => {
    await call(10, { agent: "codex" });

    const [run] = await readRuns(env, "local", filters, "recent");
    expect(run.caller).toBe("codex");
  });

  it("sorts by span and by errors, not only by recency", async () => {
    // Newest, short, clean.
    await call(5, { agent: "quick" });
    await call(4, { agent: "quick" });
    // Older and it failed twice. Eight minutes apart, inside the gap, so it
    // stays one run; thirty minutes apart would be two runs of one call.
    await call(120, { agent: "slow", outcome: "tool_error" });
    await call(112, { agent: "slow", outcome: "tool_error" });

    expect((await readRuns(env, "local", filters, "recent"))[0].agent).toBe(
      "quick",
    );
    expect((await readRuns(env, "local", filters, "longest"))[0].agent).toBe(
      "slow",
    );

    const byErrors = await readRuns(env, "local", filters, "errors");
    expect(byErrors[0].agent).toBe("slow");
    expect(byErrors[0].errors).toBe(2);
  });

  it("puts the run with the latest call first, not the one that began last", async () => {
    // Began an hour ago and is still going.
    for (let minute = 60; minute >= 0; minute -= 5) {
      await call(minute, { agent: "long" });
    }
    // Began later, finished twenty minutes ago.
    await call(25, { agent: "short" });
    await call(20, { agent: "short" });

    const runs = await readRuns(env, "local", filters, "recent");
    expect(runs.map((run) => run.agent)).toEqual(["long", "short"]);
    expect(runs[0].lastAt).toBe(NOW);
  });

  it("leaves out the handshakes a client sends on every connect", async () => {
    await call(60, { agent: "codex", method: "server/discover", tool: null });
    await call(60, { agent: "codex", method: "tools/list", tool: null });
    await call(59, { agent: "codex", tool: "list_ready" });
    // An hourly reconnect with no work in it is not a run.
    await call(30, { agent: "codex", method: "resources/list", tool: null });
    await call(30, {
      agent: "codex",
      method: "notifications/initialized",
      tool: null,
    });

    const runs = await readRuns(env, "local", filters, "recent");
    expect(runs).toHaveLength(1);
    expect(runs[0].calls.map((row) => row.tool)).toEqual(["list_ready"]);

    const everything = await readRuns(
      env,
      "local",
      { ...filters, handshakes: true },
      "recent",
    );
    expect(everything.flatMap((run) => run.calls)).toHaveLength(5);
  });

  it("does not let a handshake hold two bursts of work together", async () => {
    await call(40, { agent: "codex", tool: "search" });
    // Reconnects every eight minutes would bridge the gap if they counted.
    await call(32, { agent: "codex", method: "tools/list", tool: null });
    await call(24, { agent: "codex", method: "tools/list", tool: null });
    await call(16, { agent: "codex", tool: "fetch" });

    expect(await readRuns(env, "local", filters, "recent")).toHaveLength(2);
  });

  it("keeps a handshake that failed", async () => {
    await call(10, {
      agent: "codex",
      method: "tools/list",
      tool: null,
      outcome: "protocol_error",
    });

    const [run] = await readRuns(env, "local", filters, "recent");
    expect(run.calls[0].outcome).toBe("protocol_error");
  });

  it("splits two sessions of one agent working at the same moment", async () => {
    // Three Claude Codes on one OAuth grant: identical agent and client.
    await call(10, {
      agent: "claude-code",
      session: "a",
      sessionName: "valise-34",
    });
    await call(10, {
      agent: "claude-code",
      session: "b",
      sessionName: "kampala",
    });
    await call(9, {
      agent: "claude-code",
      session: "a",
      sessionName: "valise-34",
    });
    // No plugin, so no session: it still falls back to the gap heuristic.
    await call(9, { agent: "claude-code" });

    const runs = await readRuns(env, "local", filters, "recent");
    expect(runs).toHaveLength(3);
    const named = runs.find((run) => run.session === "a");
    expect(named?.calls).toHaveLength(2);
    expect(named?.sessionName).toBe("valise-34");
  });

  it("reads whole runs rather than cutting the oldest one in half", async () => {
    // One long run, so a call-capped query would return part of it.
    for (let minute = 0; minute < 40; minute++) {
      await call(60 - minute, { agent: "chatty" });
    }

    const [run] = await readRuns(env, "local", filters, "recent");
    expect(run.calls).toHaveLength(40);
    expect(run.spanMs).toBe(39 * MINUTE);
  });
});

describe("the sessions the connections page lists", () => {
  /** A row as the logger writes it, with only what this test varies. */
  async function seen(
    minutesAgo: number,
    row: {
      session?: string | null;
      sessionName?: string | null;
      clientInfo?: string | null;
      host?: string | null;
      plugin?: string | null;
      userAgent?: string | null;
      method?: string;
    },
  ) {
    await db
      .prepare(
        `INSERT INTO mcp_calls (
           call_id, at, transport, user_id, principal, agent, client, method,
           outcome, status, duration_ms, session, session_name, client_info,
           host, plugin, user_agent
         ) VALUES (?, ?, 'oauth', 'local', 'claude-code-metadata',
                   'claude-code-metadata', 'oauth', ?, 'ok', 200, 1,
                   ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        `cal_${crypto.randomUUID()}`,
        NOW - minutesAgo * MINUTE,
        row.method ?? "tools/call",
        row.session ?? null,
        row.sessionName ?? null,
        row.clientInfo ?? null,
        row.host ?? null,
        row.plugin ?? null,
        row.userAgent ?? null,
      )
      .run();
  }

  it("lists each plugin session once, described by its latest call", async () => {
    await seen(30, {
      session: "a",
      sessionName: "old-name",
      clientInfo: "claude-code 2.1.301",
    });
    await seen(10, {
      session: "a",
      sessionName: "valise-34",
      clientInfo: "claude-code 2.1.302",
      host: "laptop",
      plugin: "valise/0.3.0",
    });
    await seen(9, {
      session: "a",
      method: "tools/list",
      sessionName: "valise-34",
      clientInfo: "claude-code 2.1.302",
      host: "laptop",
      plugin: "valise/0.3.0",
    });
    await seen(5, {
      session: "b",
      sessionName: "kampala-7",
      clientInfo: "claude-code 2.1.302",
      plugin: "valise/0.3.0",
    });

    const sessions = await readClientSessions(env, "local", NOW);
    expect(sessions.map((s) => s.sessionName)).toEqual([
      "kampala-7",
      "valise-34",
    ]);
    expect(sessions[1]).toMatchObject({
      clientInfo: "claude-code 2.1.302",
      host: "laptop",
      plugin: "valise/0.3.0",
      lastSeen: NOW - 9 * MINUTE,
      // The listing is a call, not a tool call.
      toolCalls: 2,
    });
  });

  it("keeps two versions apart when neither sends a session", async () => {
    await seen(10, { clientInfo: "claude-code 2.1.302" });
    await seen(9, { clientInfo: "claude-code 2.1.274" });
    await seen(8, { clientInfo: "claude-code 2.1.274" });

    const sessions = await readClientSessions(env, "local", NOW);
    expect(sessions.map((s) => [s.clientInfo, s.toolCalls])).toEqual([
      ["claude-code 2.1.274", 2],
      ["claude-code 2.1.302", 1],
    ]);
  });

  it("lists a client that names itself only on initialize once", async () => {
    // Codex sends clientInfo on initialize and never again.
    const userAgent = "codex_cli_rs/0.163.0 (Mac OS 26.0.0; arm64)";
    await seen(20, {
      method: "initialize",
      clientInfo: "codex-mcp-client 0.163.0",
      userAgent,
    });
    await seen(19, { method: "tools/list", userAgent });
    await seen(18, { userAgent });
    await seen(17, { userAgent });

    const sessions = await readClientSessions(env, "local", NOW);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      clientInfo: "codex-mcp-client 0.163.0",
      userAgent,
      lastSeen: NOW - 17 * MINUTE,
      toolCalls: 2,
    });
  });

  it("leaves out calls older than a week", async () => {
    await seen(8 * 24 * 60, { session: "stale" });

    expect(await readClientSessions(env, "local", NOW)).toEqual([]);
  });
});
