import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordMcpCall, trimActivity } from "~/concepts/activity";
import { saveMemory } from "~/concepts/memories";
import {
  meteredD1,
  meterJob,
  PRICES,
  readSpend,
  SPEND_RETENTION_DAYS,
  SYSTEM_ACCOUNT,
  spendStatement,
  UNATTRIBUTED_ACCOUNT,
  utcToday,
} from "~/concepts/spend";
import { reserveEmbedding } from "~/search/embedding-budget";
import { rerankedSearch } from "~/search/rerank";
import migration from "../../drizzle/0066_spend_daily.sql?raw";

// Real workerd/D1. docs/design/spend.md is the contract under test.
const db = env.DB;
const today = utcToday();
const dayBefore = (n: number) => {
  const at = new Date(`${today}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - n);
  return at.toISOString().slice(0, 10);
};

async function spendRows(userId?: string) {
  const { results } = await db
    .prepare(
      `SELECT user_id, day, category, calls, unpriced_calls, units, microusd
       FROM spend_daily WHERE ?1 IS NULL OR user_id = ?1 ORDER BY user_id, category`,
    )
    .bind(userId ?? null)
    .all();
  return results;
}

async function seed(
  userId: string,
  day: string,
  category: string,
  values: {
    calls?: number;
    unpriced?: number;
    units?: number;
    microusd: number;
  },
) {
  await db
    .prepare(
      `INSERT INTO spend_daily (user_id, day, category, calls, unpriced_calls, units, microusd)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      userId,
      day,
      category,
      values.calls ?? 1,
      values.unpriced ?? 0,
      values.units ?? 0,
      values.microusd,
    )
    .run();
}

async function user(userId: string, email: string, createdAt = 1) {
  await db
    .prepare(
      `INSERT INTO users (user_id, email, display_name, role, created_at, email_verified)
       VALUES (?, ?, '', 'member', ?, 1)`,
    )
    .bind(userId, email, createdAt)
    .run();
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const table of [
    "spend_daily",
    "embedding_usage_daily",
    "mcp_calls",
    "source_enrichments",
    "asset_processing_outputs",
    "memory_review_budgets",
    "memory_review_ranking_budgets",
    "search_docs",
    "memory_revisions",
    "memories",
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
  await db.prepare("DELETE FROM users WHERE user_id <> 'local'").run();
});

describe("spend_daily writes", () => {
  it("adds calls, units and money into one row per account, day and category", async () => {
    await db.batch([
      spendStatement(db, "local", "bookmark_summary", {
        units: 3100,
        microusd: 500,
      }),
      spendStatement(db, "local", "bookmark_summary", {
        units: 900,
        microusd: 120.2,
      }),
      spendStatement(db, "local", "file_conversion", {
        units: 1,
        microusd: null,
      }),
    ]);
    expect(await spendRows("local")).toEqual([
      {
        user_id: "local",
        day: today,
        category: "bookmark_summary",
        calls: 2,
        unpriced_calls: 0,
        units: 4000,
        microusd: 621,
      },
      {
        user_id: "local",
        day: today,
        category: "file_conversion",
        calls: 1,
        unpriced_calls: 1,
        units: 1,
        microusd: 0,
      },
    ]);
  });

  it("records a guarded row only when the statement before it changed one", async () => {
    const guarded = () =>
      spendStatement(
        db,
        "local",
        "memory_review",
        { units: 1, microusd: 40 },
        { afterWrite: true },
      );
    // An INSERT … SELECT that selects nothing, and an upsert whose WHERE refuses.
    await db.batch([
      db.prepare(
        "INSERT INTO memory_review_budgets(user_id, day, calls, reserved_microusd) SELECT 'local', 1, 1, 40 WHERE 0",
      ),
      guarded(),
    ]);
    expect(await spendRows("local")).toEqual([]);
    await db
      .prepare(
        "INSERT INTO memory_review_budgets(user_id, day, calls, reserved_microusd) VALUES ('local', 1, 1, 40)",
      )
      .run();
    await db.batch([
      db.prepare(
        "INSERT INTO memory_review_budgets(user_id, day, calls, reserved_microusd) VALUES ('local', 1, 1, 40) ON CONFLICT(user_id, day) DO UPDATE SET calls = calls + 1 WHERE 0",
      ),
      guarded(),
    ]);
    expect(await spendRows("local")).toEqual([]);
    await db.batch([
      db.prepare(
        "INSERT INTO memory_review_budgets(user_id, day, calls, reserved_microusd) VALUES ('local', 1, 1, 40) ON CONFLICT(user_id, day) DO UPDATE SET calls = calls + 1",
      ),
      guarded(),
    ]);
    expect(await spendRows("local")).toMatchObject([
      { category: "memory_review", calls: 1, microusd: 40 },
    ]);
  });

  it("charges a granted embedding and nothing for a refused one", async () => {
    const budgeted = { DB: db, VALISE_EMBEDDING_DAILY_BYTES: "1000" };
    expect(await reserveEmbedding(budgeted, "local", "memory", 1000)).toBe(
      true,
    );
    expect(await reserveEmbedding(budgeted, "local", "query", 10)).toBe(false);
    expect(await spendRows("local")).toEqual([
      {
        user_id: "local",
        day: today,
        category: "embedding",
        calls: 1,
        unpriced_calls: 0,
        units: 1000,
        microusd: Math.ceil(1000 * PRICES.embedding.microusdPerUnit),
      },
    ]);
  });

  it("counts an MCP request under its account, and a refusal before sign-in as unattributed", async () => {
    const call = (userId: string | null) =>
      recordMcpCall(
        { DB: db },
        {
          at: Date.now(),
          transport: "oauth",
          userId,
          principal: null,
          agent: null,
          client: null,
          session: null,
          httpMethod: "POST",
          limiterMethod: "tools/call",
          limiterName: "search",
          method: "tools/call",
          tool: "search",
          requiredScope: null,
          args: {},
          intent: null,
          outcome: "ok",
          errorCode: null,
          errorMessage: null,
          status: 200,
          durationMs: 3,
          resultBytes: 10,
          clientInfo: null,
          userAgent: null,
          sessionName: null,
          host: null,
          plugin: null,
          targetId: null,
          rerank: null,
        },
      );
    await call("local");
    await call("local");
    await call(null);
    expect(
      (await spendRows()).map((row) => [row.user_id, row.category, row.calls]),
    ).toEqual([
      [UNATTRIBUTED_ACCOUNT, "mcp_requests", 1],
      ["local", "mcp_requests", 2],
    ]);
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM mcp_calls").first("n"),
    ).toBe(3);
  });

  it("prices a rerank by the tokens the provider reported, and leaves a failed one unpriced", async () => {
    for (const title of ["Hedgerow notes", "Hedgerow birds"])
      await saveMemory(
        { DB: db },
        { type: "fact", title, body: `${title} body`, tags: [] },
        { userId: "local", agent: "test", client: "test", session: null },
      );
    const run = vi.spyOn(env.AI, "run").mockResolvedValue({
      answers: { D00: { noul: 0.9 }, D01: { noul: 0.1 } },
      usage: { input_tokens: 2000 },
    } as never);
    const search = () =>
      rerankedSearch({ DB: db, AI: env.AI }, "clef", {
        query: "hedgerow",
        userId: "local",
      });
    expect((await search()).rerank).toMatchObject({ reranked: true });
    run.mockRejectedValue(new Error("provider down"));
    expect((await search()).rerank).toMatchObject({ reranked: false });
    expect(await spendRows("local")).toMatchObject([
      {
        category: "rerank",
        calls: 2,
        unpriced_calls: 1,
        units: 2000,
        microusd: Math.ceil(2000 * PRICES.rerankers["@cf/cloudflare/clef"]),
      },
    ]);
  });

  it("charges a cron job's D1 rows to the system account, even when the job throws", async () => {
    await user("usr_a", "a@example.org");
    const report = await meterJob({ DB: db }, "probe", async ({ DB }) => {
      const first = await DB.prepare(
        "SELECT user_id FROM users WHERE user_id = ?",
      )
        .bind("usr_a")
        .first<{ user_id: string }>();
      const column = await DB.prepare("SELECT COUNT(*) AS n FROM users").first(
        "n",
      );
      const none = await DB.prepare(
        "SELECT 1 FROM users WHERE user_id = 'nobody'",
      ).first();
      await DB.batch([
        DB.prepare(
          "UPDATE users SET display_name = 'A' WHERE user_id = ?",
        ).bind("usr_a"),
      ]);
      return { first, column, none };
    });
    expect(report).toEqual({
      first: { user_id: "usr_a" },
      column: 2,
      none: null,
    });
    await expect(
      meterJob({ DB: db }, "probe", async ({ DB }) => {
        await DB.prepare("SELECT * FROM users").all();
        throw new Error("job failed");
      }),
    ).rejects.toThrow("job failed");
    const [row] = await spendRows(SYSTEM_ACCOUNT);
    expect(row).toMatchObject({ category: "d1:probe", calls: 5 });
    expect(row.units).toBeGreaterThanOrEqual(4);
  });

  it("refuses an unknown column on first() as D1 does", async () => {
    const { db: metered } = meteredD1(db);
    await expect(
      metered.prepare("SELECT 1 AS one").first("two"),
    ).rejects.toThrow(/D1_COLUMN_NOTFOUND/);
  });

  it("trims rows past the retention window at night", async () => {
    await seed("local", dayBefore(SPEND_RETENTION_DAYS + 1), "embedding", {
      microusd: 1,
    });
    await seed("local", dayBefore(1), "embedding", { microusd: 1 });
    await trimActivity({ DB: db });
    expect((await spendRows("local")).map((row) => row.day)).toEqual([
      dayBefore(1),
    ]);
  });
});

describe("the spend view", () => {
  it("ranks accounts with System and Unattributed rows, and an idle account at $0.00", async () => {
    await user("usr_a", "a@example.org", 2);
    await user("usr_idle", "idle@example.org", 3);
    await seed("usr_a", today, "bookmark_summary", { microusd: 3_000_000 });
    await seed("usr_a", dayBefore(10), "embedding", { microusd: 1_000_000 });
    await seed("usr_a", today, "mcp_requests", { calls: 40, microusd: 0 });
    await seed("local", dayBefore(3), "memory_review", { microusd: 500_000 });
    await seed(SYSTEM_ACCOUNT, today, "d1:vectors", {
      calls: 1440,
      units: 9_000_000,
      microusd: 2_000_000,
    });
    // An account that no longer exists, and a day outside the window.
    await seed("usr_gone", dayBefore(2), "file_summary", { microusd: 100 });
    await seed("usr_a", dayBefore(30), "bookmark_summary", {
      microusd: 9_000_000,
    });
    const read = await readSpend(db, today);
    if (!read.ok) throw new Error(read.reason);
    const { report } = read;
    expect(report.from).toBe(dayBefore(29));
    expect(report.totalMicrousd).toBe(6_500_100);
    expect(
      report.accounts.map((a) => [a.name, a.kind, a.microusd, a.mcpCalls]),
    ).toEqual([
      ["a@example.org", "account", 4_000_000, 40],
      ["System", "system", 2_000_000, 0],
      ["Owner", "account", 500_000, 0],
      ["Unattributed", "unattributed", 100, 0],
      ["idle@example.org", "account", 0, 0],
    ]);
    const a = report.accounts[0];
    expect(a.share).toBeCloseTo(4 / 6.5001, 4);
    expect(a.largest).toMatchObject({ category: "bookmark_summary" });
    expect(a.last7).toBe(3_000_000);
    expect(a.prior7).toBe(1_000_000);
    expect(a.daily).toHaveLength(30);
    expect(a.daily.at(-1)).toEqual({ day: today, microusd: 3_000_000 });
    expect(a.categories.map((c) => c.category)).toEqual([
      "bookmark_summary",
      "embedding",
      "mcp_requests",
    ]);
    expect(report.accounts[1].categories[0]).toMatchObject({
      label: "D1 load: vectors",
      unit: "rows read",
      units: 9_000_000,
    });
    expect(report.accounts.at(-1)?.largest).toBeNull();
  });

  it("flags a category with no rows for seven days as stale", async () => {
    await seed("local", dayBefore(8), "file_summary", { microusd: 10 });
    await seed("local", dayBefore(6), "embedding", { microusd: 10 });
    const read = await readSpend(db, today);
    expect(read.ok && read.report.stale).toEqual([
      {
        category: "file_summary",
        label: "File summaries",
        lastDay: dayBefore(8),
      },
    ]);
  });

  it("answers unavailable, not $0, when the read fails", async () => {
    const failing = new Proxy(db, {
      get(target, property) {
        if (property === "batch")
          return async () => {
            throw new Error("D1_ERROR: no such table: spend_daily");
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(await readSpend(failing, today)).toEqual({
      ok: false,
      reason: "D1_ERROR: no such table: spend_daily",
    });
  });

  it("reads every aggregate through the day index, never the whole table", async () => {
    // 50 accounts, 90 days, four categories each: the contract's volume.
    const rows: D1PreparedStatement[] = [];
    for (let u = 0; u < 50; u++)
      for (let d = 0; d < 90; d++)
        for (const category of [
          "bookmark_summary",
          "embedding",
          "mcp_requests",
          "memory_review",
        ])
          rows.push(
            db
              .prepare(
                "INSERT INTO spend_daily (user_id, day, category, calls, units, microusd) VALUES (?, ?, ?, 1, 1, 1)",
              )
              .bind(`usr_${u}`, dayBefore(d), category),
          );
    for (let i = 0; i < rows.length; i += 500)
      await db.batch(rows.slice(i, i + 500));
    await db.prepare("ANALYZE").run();

    const seen: { sql: string; args: unknown[] }[] = [];
    const recording = new Proxy(db, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            const entry = { sql, args: [] as unknown[] };
            seen.push(entry);
            const statement = target.prepare(sql);
            return new Proxy(statement, {
              get(inner, name) {
                if (name === "bind")
                  return (...args: unknown[]) => {
                    entry.args = args;
                    return inner.bind(...args);
                  };
                const value = Reflect.get(inner, name);
                return typeof value === "function" ? value.bind(inner) : value;
              },
            });
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const started = Date.now();
    const read = await readSpend(recording, today);
    const elapsed = Date.now() - started;
    expect(read.ok).toBe(true);
    const aggregates = seen.filter((entry) =>
      entry.sql.includes("FROM spend_daily"),
    );
    expect(aggregates).toHaveLength(3);
    for (const query of aggregates) {
      const { results } = await db
        .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
        .bind(...query.args)
        .all<{ detail: string }>();
      const details = results.map((row) => row.detail);
      expect(details).toContainEqual(
        expect.stringMatching(
          /^SEARCH spend_daily USING INDEX spend_daily_day \(day>\? AND day<\?\)$/,
        ),
      );
      expect(details.filter((d) => /^SCAN spend_daily\b/.test(d))).toEqual([]);
    }
    // The budget is 300 ms of server time; a local workerd is slower, not faster.
    expect(elapsed).toBeLessThan(1500);
    const [aggregate] = await db.batch([
      db.prepare(aggregates[0].sql).bind(...aggregates[0].args),
    ]);
    // D1 counts the index entry and the row it leads to, so the window's
    // 6,000 rows read as 12,000; a scan of the table would read 18,000 more.
    expect(aggregate.meta.rows_read).toBeLessThanOrEqual(2 * 50 * 30 * 4);
  });
});

describe("the backfill", () => {
  it("fills spend_daily from the ledgers that existed before it", async () => {
    await user("usr_a", "a@example.org");
    const at = Math.floor(Date.parse(`${dayBefore(2)}T12:00:00Z`) / 1000);
    const epochDay = Math.floor(at / 86400);
    await db.batch([
      db
        .prepare(
          `INSERT INTO embedding_usage_daily (user_id, day, kind, calls, input_bytes)
           VALUES ('usr_a', ?, 'memory', 3, 2000), ('usr_a', ?, 'query', 2, 100)`,
        )
        .bind(dayBefore(2), dayBefore(2)),
      db
        .prepare(
          `INSERT INTO memory_review_budgets (user_id, day, calls, reserved_microusd) VALUES ('usr_a', ?, 4, 9000)`,
        )
        .bind(epochDay),
      db
        .prepare(
          `INSERT INTO memory_review_ranking_budgets (user_id, day, requests, reserved_microusd) VALUES ('usr_a', ?, 2, 700)`,
        )
        .bind(epochDay),
      db
        .prepare(
          `INSERT INTO mcp_calls (call_id, at, transport, user_id, method, outcome, status, duration_ms)
           VALUES ('c1', ?, 'oauth', 'usr_a', 'tools/call', 'ok', 200, 1),
                  ('c2', ?, 'oauth', NULL, 'tools/call', 'unauthorized', 401, 1)`,
        )
        .bind(at * 1000, at * 1000),
    ]);
    const inserts = migration
      .split("--> statement-breakpoint")
      .map((part) =>
        part
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join("\n")
          .trim(),
      )
      .filter((part) => part.startsWith("INSERT INTO spend_daily"));
    expect(inserts).toHaveLength(7);
    await db.batch(inserts.map((sql) => db.prepare(sql)));
    expect(
      (await spendRows()).map((row) => [
        row.user_id,
        row.day,
        row.category,
        row.calls,
        row.units,
        row.microusd,
      ]),
    ).toEqual([
      [UNATTRIBUTED_ACCOUNT, dayBefore(2), "mcp_requests", 1, 1, 0],
      ["usr_a", dayBefore(2), "embedding", 5, 2100, Math.ceil(2100 * 0.0118)],
      ["usr_a", dayBefore(2), "mcp_requests", 1, 1, 0],
      ["usr_a", dayBefore(2), "memory_review", 4, 4, 9000],
      ["usr_a", dayBefore(2), "review_ranking", 2, 0, 700],
    ]);
  });
});
