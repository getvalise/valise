/**
 * Estimated spend per account per UTC day, at list price, from Valise's own
 * records. `docs/design/spend.md` is the contract; it is not the invoice.
 *
 * Every call site that spends money upserts `spend_daily` in the same
 * `db.batch` as the write it already makes, so the workbench reads 30 days
 * as one indexed aggregate instead of a join over every ledger.
 *
 * `units` is the category's own unit (tokens, input bytes, calls, rows read).
 * `microusd` sums the priced calls only; `unpriced_calls` counts the calls
 * that had no list price, so an unpriced model shows as `unpriced`, never as
 * $0.
 */

import { SUMMARY_MODEL } from "~/concepts/summary-model";

/**
 * The account a cron job's D1 load is charged to. SQLite treats NULLs as
 * distinct in a primary key, so a NULL `user_id` could never be the target of
 * the upsert; this literal cannot be a user id, which is `local` or a
 * `usr_`-prefixed UUID.
 */
export const SYSTEM_ACCOUNT = "(system)";

/** The account for load with no signed-in account: an MCP request refused
 * before sign-in. The workbench also counts here the rows of deleted accounts. */
export const UNATTRIBUTED_ACCOUNT = "(unattributed)";

/** List prices. USD per million units equals micro-USD per unit. */
export const PRICES = {
  summary: {
    label: `${SUMMARY_MODEL.id}: $${SUMMARY_MODEL.inputUsdPerMillion}/M input, $${SUMMARY_MODEL.outputUsdPerMillion}/M output tokens`,
    readOn: SUMMARY_MODEL.catalogReadOn,
  },
  /** `npx wrangler ai models list --json`, 2026-11-08. One token per input
   * byte is the same conservative reading the ranking reservation uses. */
  embedding: {
    microusdPerUnit: 0.0118,
    label: "@cf/baai/bge-m3: $0.0118/M input tokens, one token per byte",
    readOn: "2026-11-08",
  },
  /** TypeSafe's catalog for Jev 1.14, as `memory-review-ranking.ts` reads it. */
  jev: {
    microusdPerUnit: 0.042,
    label: "TypeSafe Jev 1.14: $0.042/M input tokens",
    readOn: "2026-10-29",
  },
  /** `npx wrangler ai models list --json`, 2026-11-08. */
  rerankers: {
    "@cf/cloudflare/clef": 0.24,
    "@cf/cloudflare/clef-flash": 0.038,
    "@cf/baai/bge-reranker-base": 0.00311,
  } as Record<string, number>,
  rerankersReadOn: "2026-11-08",
  /** developers.cloudflare.com/d1/platform/pricing, Workers Paid, read
   * 2026-11-08: $0.001 per million rows read, $1.00 per million written. */
  d1: {
    readMicrousdPerRow: 0.001,
    writtenMicrousdPerRow: 1,
    label: "D1: $0.001/M rows read, $1.00/M rows written",
    readOn: "2026-11-08",
  },
} as const;

export type SpendCategory =
  | "bookmark_summary"
  | "file_summary"
  | "file_conversion"
  | "memory_review"
  | "review_ranking"
  | "embedding"
  | "rerank"
  | "mcp_requests"
  | `d1:${string}`;

export type CategoryInfo = {
  label: string;
  unit: string;
  /** How the USD figure is reached, with the date the price was read. */
  price: string;
  /** A request-load proxy, never priced. */
  proxy?: boolean;
};

const CATEGORY_INFO: Record<string, CategoryInfo> = {
  bookmark_summary: {
    label: "Bookmark summaries",
    unit: "tokens",
    price: `${PRICES.summary.label}, read ${PRICES.summary.readOn}. A call with no usage report counts its ceiling.`,
  },
  file_summary: {
    label: "File summaries",
    unit: "tokens",
    price: `${PRICES.summary.label}, read ${PRICES.summary.readOn}. A call with no usage report counts its prompt and output cap.`,
  },
  file_conversion: {
    label: "File conversion",
    unit: "calls",
    price:
      "Workers AI toMarkdown. Documents convert free; an image description runs a model Cloudflare does not price per call, so it is unpriced.",
  },
  memory_review: {
    label: "Memory review",
    unit: "calls",
    price:
      "The reservation made before each call at the chosen model's list price (memory-review-model.ts), not what the provider reported.",
  },
  review_ranking: {
    label: "Review ranking",
    unit: "input bytes",
    price: `${PRICES.jev.label}, read ${PRICES.jev.readOn}, reserved before each call. Its embedding stage counts under Embeddings.`,
  },
  embedding: {
    label: "Embeddings",
    unit: "input bytes",
    price: `${PRICES.embedding.label}, read ${PRICES.embedding.readOn}. Failed attempts count; the provider charges them.`,
  },
  rerank: {
    label: "Search rerank",
    unit: "input tokens",
    price: `${PRICES.jev.label}, read ${PRICES.jev.readOn}; Workers AI rerankers at catalog price, read ${PRICES.rerankersReadOn}. A call that failed before reporting usage is unpriced.`,
  },
  mcp_requests: {
    label: "MCP requests",
    unit: "calls",
    price:
      "Not priced. The request-load proxy: Worker requests, CPU and request-path D1 are not metered per account.",
    proxy: true,
  },
};

export function categoryInfo(category: string): CategoryInfo {
  const known = CATEGORY_INFO[category];
  if (known) return known;
  if (category.startsWith("d1:"))
    return {
      label: `D1 load: ${category.slice(3).replaceAll("_", " ")}`,
      unit: "rows read",
      price: `${PRICES.d1.label}, read ${PRICES.d1.readOn}. The USD figure includes rows written.`,
    };
  return { label: category, unit: "units", price: "Unknown category." };
}

export type SpendUsage = {
  calls?: number;
  units?: number;
  /** null: the call had no list price. */
  microusd: number | null;
};

const UPSERT = `INSERT INTO spend_daily (user_id, day, category, calls, unpriced_calls, units, microusd)
  SELECT ?1, date('now'), ?2, ?3, ?4, ?5, ?6 WHERE ?7 = 0 OR changes() > 0
  ON CONFLICT(user_id, day, category) DO UPDATE SET
    calls = calls + excluded.calls,
    unpriced_calls = unpriced_calls + excluded.unpriced_calls,
    units = units + excluded.units,
    microusd = microusd + excluded.microusd`;

/**
 * One upsert into today's row. With `afterWrite`, it applies only when the
 * statement just before it in the same `db.batch` changed a row, so a refused
 * reservation records no spend.
 */
export function spendStatement(
  db: D1Database,
  userId: string,
  category: SpendCategory,
  usage: SpendUsage,
  options: { afterWrite?: boolean } = {},
): D1PreparedStatement {
  const calls = usage.calls ?? 1;
  const unpriced = usage.microusd === null;
  return db
    .prepare(UPSERT)
    .bind(
      userId,
      category,
      calls,
      unpriced ? calls : 0,
      Math.max(0, Math.round(usage.units ?? 0)),
      unpriced ? 0 : Math.max(0, Math.ceil(usage.microusd ?? 0)),
      options.afterWrite ? 1 : 0,
    );
}

/** Best effort: a metering failure never fails the work it meters. */
export async function recordSpend(
  db: D1Database,
  userId: string,
  category: SpendCategory,
  usage: SpendUsage,
): Promise<void> {
  try {
    await spendStatement(db, userId, category, usage).run();
  } catch (error) {
    console.error("spend metering failed", category, error);
  }
}

/** Kept for a year and a month, then trimmed by the nightly cron. */
export const SPEND_RETENTION_DAYS = 400;

export function trimSpendStatement(db: D1Database) {
  return db
    .prepare("DELETE FROM spend_daily WHERE day < date('now', ?)")
    .bind(`-${SPEND_RETENTION_DAYS} days`);
}

/* ----------------------------------------------------- system D1 load --- */

export type D1Load = { queries: number; rowsRead: number; rowsWritten: number };

/**
 * A view of `db` that adds up `rows_read` and `rows_written` from every
 * result's meta. `first()` runs as `all()`, which D1 does internally anyway,
 * so the meta is not lost. `raw()` passes through uncounted; nothing in a
 * cron job calls it. A statement prepared here can only be batched here.
 */
export function meteredD1(db: D1Database): { db: D1Database; load: D1Load } {
  const load: D1Load = { queries: 0, rowsRead: 0, rowsWritten: 0 };
  const inner = new WeakMap<object, D1PreparedStatement>();
  const count = (meta: D1Meta | undefined) => {
    load.queries++;
    load.rowsRead += meta?.rows_read ?? 0;
    load.rowsWritten += meta?.rows_written ?? 0;
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      async run() {
        const result = await statement.run();
        count(result.meta);
        return result;
      },
      async all() {
        const result = await statement.all();
        count(result.meta);
        return result;
      },
      async first(column?: string) {
        const result = await statement.all<Record<string, unknown>>();
        count(result.meta);
        const row = result.results[0];
        if (row === undefined) return null;
        if (column === undefined) return row;
        if (!(column in row))
          throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
        return row[column];
      },
      raw: (options?: { columnNames?: boolean }) =>
        statement.raw(options as { columnNames: true }),
    };
    inner.set(wrapped, statement);
    return wrapped as unknown as D1PreparedStatement;
  };
  const metered = new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (query: string) => wrap(target.prepare(query));
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(
            statements.map((statement) => inner.get(statement) ?? statement),
          );
          for (const result of results) count(result.meta);
          return results;
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: metered, load };
}

/** The `d1:<job>` row for one cron job's load. */
export function d1LoadStatement(
  db: D1Database,
  job: string,
  load: D1Load,
): D1PreparedStatement {
  return spendStatement(db, SYSTEM_ACCOUNT, `d1:${job}`, {
    calls: load.queries,
    units: load.rowsRead,
    // Rounded, not ceiled: a minute's few hundred rows read are a fraction
    // of a micro-dollar, and ceiling them every minute would invent spend.
    microusd: Math.round(
      load.rowsRead * PRICES.d1.readMicrousdPerRow +
        load.rowsWritten * PRICES.d1.writtenMicrousdPerRow,
    ),
  });
}

/**
 * Runs one cron job on a metered `DB` and records its load under the system
 * account, whether the job succeeded or threw.
 */
export async function meterJob<E extends { DB: D1Database }, T>(
  env: E,
  job: string,
  run: (env: E) => Promise<T>,
): Promise<T> {
  const { db, load } = meteredD1(env.DB);
  try {
    return await run({ ...env, DB: db });
  } finally {
    if (load.queries > 0) {
      try {
        await d1LoadStatement(env.DB, job, load).run();
      } catch (error) {
        console.error("d1 load metering failed", job, error);
      }
    }
  }
}

/* ---------------------------------------------------------- the view --- */

export const SPEND_WINDOW_DAYS = 30;
/** A category with rows in the last 90 days and none in the last 7 has a
 * meter that stopped writing. */
export const STALE_AFTER_DAYS = 7;
const LAST_SEEN_DAYS = 90;

export type CategorySpend = CategoryInfo & {
  category: string;
  calls: number;
  unpricedCalls: number;
  units: number;
  microusd: number;
};

export type AccountSpend = {
  accountId: string;
  kind: "account" | "system" | "unattributed";
  name: string;
  email: string | null;
  microusd: number;
  unpricedCalls: number;
  /** Of the metered total over the window, 0 to 1. */
  share: number;
  largest: { category: string; label: string; microusd: number } | null;
  last7: number;
  prior7: number;
  mcpCalls: number;
  categories: CategorySpend[];
  /** One entry per day of the window, oldest first. */
  daily: { day: string; microusd: number }[];
};

export type SpendReport = {
  from: string;
  to: string;
  days: number;
  totalMicrousd: number;
  accounts: AccountSpend[];
  /** Categories whose newest row is older than STALE_AFTER_DAYS. */
  stale: { category: string; label: string; lastDay: string }[];
};

export type SpendRead =
  | { ok: true; report: SpendReport }
  | { ok: false; reason: string };

function shiftDay(day: string, by: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + by);
  return at.toISOString().slice(0, 10);
}

export function utcToday(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * The spend view in one `db.batch`. Every aggregate reads `spend_daily`
 * through its `day` index, so the rows read are the rows in the window, not
 * the table; `test/d1/spend.worker.test.ts` pins the plans. A failed read
 * answers `ok: false`, which the page shows as unavailable, never as $0.
 */
export async function readSpend(
  db: D1Database,
  today = utcToday(),
): Promise<SpendRead> {
  const from = shiftDay(today, -(SPEND_WINDOW_DAYS - 1));
  const last7 = shiftDay(today, -6);
  const prior7 = shiftDay(today, -13);
  let results: D1Result[];
  try {
    results = await db.batch([
      db
        .prepare(`SELECT user_id, category, SUM(calls) AS calls,
            SUM(unpriced_calls) AS unpriced_calls, SUM(units) AS units,
            SUM(microusd) AS microusd,
            SUM(CASE WHEN day >= ?2 THEN microusd ELSE 0 END) AS last7,
            SUM(CASE WHEN day >= ?3 AND day < ?2 THEN microusd ELSE 0 END) AS prior7
          FROM spend_daily INDEXED BY spend_daily_day
          WHERE day >= ?1 AND day <= ?4
          GROUP BY user_id, category`)
        .bind(from, last7, prior7, today),
      db
        .prepare(`SELECT user_id, day, SUM(microusd) AS microusd
          FROM spend_daily INDEXED BY spend_daily_day
          WHERE day >= ?1 AND day <= ?2
          GROUP BY user_id, day`)
        .bind(from, today),
      db
        .prepare(`SELECT category, MAX(day) AS last_day
          FROM spend_daily INDEXED BY spend_daily_day
          WHERE day >= ?1 AND day <= ?2
          GROUP BY category`)
        .bind(shiftDay(today, -LAST_SEEN_DAYS), today),
      db.prepare(`SELECT user_id, email, display_name FROM users
          ORDER BY created_at, user_id LIMIT 500`),
    ]);
  } catch (error) {
    console.error("spend read failed", error);
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const [byCategory, byDay, lastSeen, users] = results as [
    D1Result<{
      user_id: string;
      category: string;
      calls: number;
      unpriced_calls: number;
      units: number;
      microusd: number;
      last7: number;
      prior7: number;
    }>,
    D1Result<{ user_id: string; day: string; microusd: number }>,
    D1Result<{ category: string; last_day: string }>,
    D1Result<{
      user_id: string;
      email: string | null;
      display_name: string | null;
    }>,
  ];

  const days = Array.from({ length: SPEND_WINDOW_DAYS }, (_, i) =>
    shiftDay(from, i),
  );
  const accounts = new Map<string, AccountSpend>();
  const blank = (
    accountId: string,
    kind: AccountSpend["kind"],
    name: string,
    email: string | null,
  ): AccountSpend => ({
    accountId,
    kind,
    name,
    email,
    microusd: 0,
    unpricedCalls: 0,
    share: 0,
    largest: null,
    last7: 0,
    prior7: 0,
    mcpCalls: 0,
    categories: [],
    daily: days.map((day) => ({ day, microusd: 0 })),
  });
  for (const user of users.results)
    accounts.set(
      user.user_id,
      blank(
        user.user_id,
        "account",
        user.display_name || user.email || user.user_id,
        user.email,
      ),
    );
  accounts.set(SYSTEM_ACCOUNT, blank(SYSTEM_ACCOUNT, "system", "System", null));
  accounts.set(
    UNATTRIBUTED_ACCOUNT,
    blank(UNATTRIBUTED_ACCOUNT, "unattributed", "Unattributed", null),
  );
  // Rows of an account that no longer exists are nobody's now.
  const owner = (userId: string) =>
    accounts.get(userId) ??
    (accounts.get(UNATTRIBUTED_ACCOUNT) as AccountSpend);

  for (const row of byCategory.results) {
    const account = owner(row.user_id);
    const existing = account.categories.find(
      (entry) => entry.category === row.category,
    );
    const entry: CategorySpend = existing ?? {
      ...categoryInfo(row.category),
      category: row.category,
      calls: 0,
      unpricedCalls: 0,
      units: 0,
      microusd: 0,
    };
    entry.calls += row.calls;
    entry.unpricedCalls += row.unpriced_calls;
    entry.units += row.units;
    entry.microusd += row.microusd;
    if (!existing) account.categories.push(entry);
    account.microusd += row.microusd;
    account.unpricedCalls += row.unpriced_calls;
    account.last7 += row.last7;
    account.prior7 += row.prior7;
    if (row.category === "mcp_requests") account.mcpCalls += row.calls;
  }
  for (const row of byDay.results) {
    const slot = owner(row.user_id).daily.find((d) => d.day === row.day);
    if (slot) slot.microusd += row.microusd;
  }

  const list = [...accounts.values()];
  const totalMicrousd = list.reduce((sum, a) => sum + a.microusd, 0);
  for (const account of list) {
    account.share = totalMicrousd ? account.microusd / totalMicrousd : 0;
    account.categories.sort(
      (a, b) =>
        b.microusd - a.microusd ||
        b.unpricedCalls - a.unpricedCalls ||
        a.label.localeCompare(b.label),
    );
    const top = account.categories.find(
      (entry) =>
        !entry.proxy && (entry.microusd > 0 || entry.unpricedCalls > 0),
    );
    account.largest = top
      ? { category: top.category, label: top.label, microusd: top.microusd }
      : null;
  }
  list.sort(
    (a, b) =>
      b.microusd - a.microusd ||
      b.unpricedCalls - a.unpricedCalls ||
      b.mcpCalls - a.mcpCalls ||
      a.name.localeCompare(b.name),
  );
  const staleBefore = shiftDay(today, -(STALE_AFTER_DAYS - 1));
  return {
    ok: true,
    report: {
      from,
      to: today,
      days: SPEND_WINDOW_DAYS,
      totalMicrousd,
      accounts: list,
      stale: lastSeen.results
        .filter((row) => row.last_day < staleBefore)
        .map((row) => ({
          category: row.category,
          label: categoryInfo(row.category).label,
          lastDay: row.last_day,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    },
  };
}
