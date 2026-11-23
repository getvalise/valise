import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import {
  parseActivityFilters,
  readActivity,
  readCalls,
  readClientSessions,
  readRuns,
} from "~/concepts/activity";
import { readMemoryUsage } from "~/concepts/memories";

// Capture the application's actual statements, including bound tenant predicates.
function capture(db: D1Database) {
  const queries: { sql: string; values: unknown[] }[] = [];
  return {
    queries,
    db: new Proxy(db, {
      get(target, key) {
        if (key !== "prepare") {
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(target, key) {
              if (key === "bind")
                return (...values: unknown[]) => {
                  queries.push({ sql, values });
                  return target.bind(...values);
                };
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        };
      },
    }),
  };
}

it("probes tenant skew using real activity and memory usage SQL before/after indexes", async () => {
  const now = Date.now();
  // 20,000 newer foreign rows compete with 60 member, 60 owner and 60 anonymous
  // rows. Every tenant uses the same memory ids and sessions deliberately.
  for (const [tenant, size] of [
    ["foreign", 20000],
    ["member", 60],
    ["local", 60],
    [null, 60],
  ] as const) {
    await env.DB.prepare(`WITH RECURSIVE n(i) AS (
      VALUES(0) UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?
    ) INSERT INTO mcp_calls (call_id, at, transport, user_id, principal, agent,
      client, session, method, tool, outcome, status, duration_ms, target_id,
      args_json, search_result_ids_json)
      SELECT ? || i, ? + i, 'oauth', ?, 'client', 'agent', 'client', 'session',
        'tools/call', CASE WHEN i % 3 = 0 THEN 'search' ELSE 'fetch' END,
        CASE WHEN i % 3 = 2 THEN 'tool_error' ELSE 'ok' END, 200, 1,
        CASE WHEN i % 2 = 0 THEN 'memory:shared' ELSE NULL END,
        '{"id":"memory:shared"}', '["memory:shared","skill:ignored"]' FROM n`)
      .bind(size, `probe-${tenant}-`, now, tenant)
      .run();
    await env.DB.prepare(`WITH RECURSIVE n(i) AS (
      VALUES(0) UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?
    ) INSERT INTO auth_events (event_id, at, kind, user_id)
      SELECT ? || i, ? + i, 'console_login', ? FROM n`)
      .bind(size, `probe-${tenant}-`, now, tenant)
      .run();
  }

  const indexes = ["mcp_calls_user_at", "auth_events_user_at"] as const;
  const observations: { rows: number; rowsRead: number }[][] = [];
  try {
    for (const name of indexes)
      await env.DB.prepare(`DROP INDEX ${name}`).run();
    for (const phase of ["before", "after"] as const) {
      if (phase === "after") {
        for (const table of ["mcp_calls", "auth_events"]) {
          await env.DB.prepare(
            `CREATE INDEX ${table}_user_at ON ${table}(user_id, at)`,
          ).run();
        }
      }
      const captured = capture(env.DB);
      const scoped = { DB: captured.db };
      const filters = parseActivityFilters(new URL("https://example.test"));
      const member = await readActivity(scoped, "member", filters);
      const owner = await readActivity(scoped, "local", filters);
      const calls = await readCalls(scoped, "member", filters);
      const sessions = await readClientSessions(scoped, "member", now + 30000);
      const runs = await readRuns(scoped, "member", filters, "recent");
      const usage = await readMemoryUsage(captured.db, "member");
      expect(member.totals).toEqual({
        calls: 60,
        errors: 20,
        clients: 1,
        tools: 2,
      });
      expect(member.logins).toHaveLength(25);
      expect(member.logins.every((row) => row.userId === "member")).toBe(true);
      expect(owner.totals.calls).toBe(120);
      expect(owner.logins.some((row) => row.userId === null)).toBe(true);
      expect(
        owner.logins.every(
          (row) => row.userId === null || row.userId === "local",
        ),
      ).toBe(true);
      expect(calls).toHaveLength(60);
      expect(calls.every((row) => row.callId.startsWith("probe-member-"))).toBe(
        true,
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0].toolCalls).toBe(60);
      expect(runs).toHaveLength(1);
      expect(runs[0].calls).toHaveLength(60);
      expect([...usage]).toEqual([
        [
          "memory:shared",
          { fetches: 20, appearances: 20, lastFetched: now + 58 },
        ],
      ]);

      const report = [];
      for (const { sql, values } of captured.queries) {
        const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .bind(...values)
          .all<{ detail: string }>();
        const result = await env.DB.prepare(sql)
          .bind(...values)
          .all();
        report.push({
          plan: plan.results.map((row) => row.detail),
          rows: result.results.length,
          rowsRead: result.meta.rows_read,
          durationMs: result.meta.duration,
        });
      }
      observations.push(report);
      console.log(
        JSON.stringify({ phase, foreignRows: 20000, memberRows: 60, report }),
      );
      if (phase === "after") {
        // Every query must enter the logs through a tenant-leading index.
        for (const [i, query] of report.entries()) {
          expect(query.plan.join(" ")).toMatch(
            /(?:mcp_calls|auth_events)_user_at/,
          );
          expect(query.rows).toBe(observations[0][i].rows);
          expect(query.rowsRead).toBeLessThan(observations[0][i].rowsRead / 10);
        }
      }
    }
    expect(observations).toHaveLength(2);
  } finally {
    for (const table of ["mcp_calls", "auth_events"]) {
      await env.DB.prepare(
        `CREATE INDEX IF NOT EXISTS ${table}_user_at ON ${table}(user_id, at)`,
      ).run();
      await env.DB.prepare(
        `DELETE FROM ${table} WHERE ${table === "mcp_calls" ? "call_id" : "event_id"} LIKE 'probe-%'`,
      ).run();
    }
  }
}, 30000);
