import type { Page } from "@playwright/test";
import { localSql } from "./fixtures/local-d1.mjs";
import { expect, goto, test } from "./fixtures/session";

/**
 * Spend per account on /workbench?tab=costs, docs/design/spend.md. The job:
 * find the account, or the cron job, driving spend over 30 days, then reach
 * its cap. Rows are written straight into this worker's D1, because the
 * meters behind them need providers the suite does not call.
 */

const costs = "/workbench?tab=costs";

function dayBefore(n: number) {
  const at = new Date();
  at.setUTCDate(at.getUTCDate() - n);
  return at.toISOString().slice(0, 10);
}

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

function spendRow(
  userId: string,
  daysAgo: number,
  category: string,
  values: {
    calls?: number;
    unpriced?: number;
    units?: number;
    microusd: number;
  },
) {
  return `INSERT INTO spend_daily (user_id, day, category, calls, unpriced_calls, units, microusd)
    VALUES (${quote(userId)}, ${quote(dayBefore(daysAgo))}, ${quote(category)},
      ${values.calls ?? 1}, ${values.unpriced ?? 0}, ${values.units ?? 0}, ${values.microusd});`;
}

function member(userId: string, email: string) {
  return `INSERT INTO users (user_id, email, display_name, role, created_at, email_verified)
    VALUES (${quote(userId)}, ${quote(email)}, '', 'member', unixepoch(), 1);`;
}

test.beforeEach(({ baseURL }) => {
  localSql(baseURL!, "DELETE FROM spend_daily;");
});

test.afterEach(({ baseURL }) => {
  localSql(
    baseURL!,
    `DELETE FROM spend_daily;
     DELETE FROM users WHERE user_id LIKE 'usr_spend_%';`,
  );
});

const table = (page: Page) =>
  page.getByRole("table").filter({ hasText: "Est. USD, 30 days" });
const row = (page: Page, accountId: string) =>
  table(page).locator(`tr[data-account="${accountId}"]`);

async function noSidewaysScroll(page: Page, at: string) {
  const overflow = await page.evaluate<number>(
    "document.documentElement.scrollWidth - document.documentElement.clientWidth",
  );
  expect(overflow, `${at} scrolls sideways`).toBeLessThanOrEqual(1);
}

test("with nothing metered, every account, System and Unattributed read $0.00", async ({
  page,
}) => {
  await goto(page, costs);
  const section = page.getByRole("region", { name: "Spend per account" });
  await expect(section).toContainText("No metered spend in these 30 days.");
  await expect(section).toContainText("Estimated USD over the 30 days");
  for (const id of ["local", "(system)", "(unattributed)"])
    await expect(row(page, id).locator("td").nth(1)).toHaveText("$0.00");
  await expect(table(page).locator("tfoot")).toContainText("$0.00");
  // The caps the table leads to are still below it.
  await expect(
    page.getByRole("heading", { name: "Memory review caps" }),
  ).toBeVisible();
});

for (const width of [1280, 320]) {
  test(`at ${width}px an admin finds the costliest account and opens it to its caps`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width, height: width === 1280 ? 900 : 700 });
    localSql(
      baseURL!,
      [
        member("usr_spend_a", "ada@example.org"),
        member("usr_spend_b", "bo@example.org"),
        spendRow("usr_spend_a", 0, "bookmark_summary", {
          calls: 120,
          units: 400_000,
          microusd: 2_400_000,
        }),
        spendRow("usr_spend_a", 10, "embedding", {
          calls: 900,
          units: 3_000_000,
          microusd: 35_400,
        }),
        spendRow("usr_spend_a", 1, "mcp_requests", { calls: 812, microusd: 0 }),
        spendRow("(system)", 0, "d1:source_enrichment", {
          calls: 14_400,
          units: 1_600_000_000,
          microusd: 1_600_000,
        }),
        spendRow("local", 2, "memory_review", { calls: 9, microusd: 81_000 }),
        // An image description: a call the binding gives no price for.
        spendRow("usr_spend_b", 3, "file_conversion", {
          calls: 2,
          unpriced: 2,
          units: 2,
          microusd: 0,
        }),
      ].join("\n"),
    );
    await goto(page, costs);
    await noSidewaysScroll(page, `${width}px`);

    // Ranked by estimated USD: the account first, then the cron jobs.
    const order = await table(page)
      .locator("tbody tr")
      .evaluateAll((rows) =>
        rows.map(
          (r) =>
            (r as unknown as { dataset: { account: string } }).dataset.account,
        ),
      );
    expect(order.slice(0, 3)).toEqual(["usr_spend_a", "(system)", "local"]);
    const ada = row(page, "usr_spend_a");
    await expect(ada).toContainText("$2.44");
    await expect(ada).toContainText("Bookmark summaries");
    await expect(ada).toContainText("59%");
    await expect(row(page, "(system)")).toContainText(
      "D1 load: source enrichment",
    );
    await expect(row(page, "usr_spend_b")).toContainText("unpriced (2 calls)");

    // The primary action: open the row.
    const open = ada.getByRole("link", { name: "ada@example.org" });
    await expect(open).toBeInViewport();
    await open.click();
    await expect(page).toHaveURL(/[?&]spend=usr_spend_a/);
    const detail = page.getByRole("region", {
      name: "Spend for ada@example.org",
    });
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("812 MCP requests in the window");
    await expect(
      detail.locator('tr[data-category="bookmark_summary"]'),
    ).toContainText("400,000 tokens");
    await expect(
      detail.locator('tr[data-category="bookmark_summary"]'),
    ).toContainText(/read 20\d\d-\d\d-\d\d/);
    await expect(
      detail.locator('tr[data-category="mcp_requests"]'),
    ).toContainText("not priced");
    await expect(detail.getByRole("img")).toHaveAttribute(
      "aria-label",
      new RegExp(`the highest was \\$2\\.40 on ${dayBefore(0)}`),
    );
    await noSidewaysScroll(page, `${width}px, open`);
    // The card fits the screen; its tables scroll inside their own band.
    const box = await detail.boundingBox();
    expect(box!.x + box!.width, `${width}px detail edge`).toBeLessThanOrEqual(
      width + 1,
    );

    // From the account to its cap on the same tab.
    await detail
      .getByRole("link", { name: "Review caps for ada@example.org" })
      .click();
    await expect(page).toHaveURL(/#caps-usr_spend_a$/);
    await expect(page.locator("#caps-usr_spend_a")).toBeInViewport();

    // System has no cap; it says where its cost comes from instead.
    await goto(page, `${costs}&spend=(system)`);
    await expect(
      page.getByRole("region", { name: "Spend for System" }),
    ).toContainText("No cap applies: these are Valise's own cron jobs");
  });
}

test("a row opens with scripting off, because it is a link", async ({
  browser,
  baseURL,
  storageState,
}) => {
  localSql(
    baseURL!,
    [
      member("usr_spend_a", "ada@example.org"),
      spendRow("usr_spend_a", 0, "file_summary", {
        calls: 3,
        units: 9000,
        microusd: 4000,
      }),
    ].join("\n"),
  );
  const context = await browser.newContext({
    baseURL,
    storageState,
    javaScriptEnabled: false,
  });
  try {
    const page = await context.newPage();
    await page.goto(costs);
    await row(page, "usr_spend_a")
      .getByRole("link", { name: "ada@example.org" })
      .click();
    await expect(
      page.getByRole("region", { name: "Spend for ada@example.org" }),
    ).toContainText("File summaries");
  } finally {
    await context.close();
  }
});

test("fifty accounts over ninety days rank in one read", async ({
  page,
  baseURL,
}) => {
  const statements: string[] = [];
  for (let i = 0; i < 50; i++) {
    const id = `usr_spend_${String(i).padStart(2, "0")}`;
    statements.push(member(id, `account-${i}@example.org`));
    for (let d = 0; d < 90; d += 3)
      statements.push(
        spendRow(id, d, "embedding", { units: 1000, microusd: (i + 1) * 10 }),
      );
  }
  localSql(baseURL!, statements.join("\n"));
  const started = Date.now();
  await goto(page, costs);
  const elapsed = Date.now() - started;
  const seeded = table(page).locator('tbody tr[data-account^="usr_spend_"]');
  await expect(seeded).toHaveCount(50);
  // The costliest seeded account leads; ten days a month at $0.0005 a day.
  await expect(table(page).locator("tbody tr").first()).toHaveAttribute(
    "data-account",
    "usr_spend_49",
  );
  await expect(row(page, "usr_spend_49")).toContainText("$0.0050");
  // The contract's budget is 300 ms of server time; a page load here also
  // pays for wrangler dev, hydration and a busy machine.
  expect(elapsed).toBeLessThan(10_000);
  await noSidewaysScroll(page, "50 accounts");
});

test("a failed read shows unavailable, never $0, and a quiet meter is flagged stale", async ({
  page,
  baseURL,
}) => {
  localSql(
    baseURL!,
    spendRow("local", 9, "file_summary", { calls: 1, microusd: 2000 }),
  );
  await goto(page, costs);
  await expect(
    page.getByRole("status").filter({ hasText: "Stale" }),
  ).toContainText(`File summaries has no rows since ${dayBefore(9)}`);

  localSql(
    baseURL!,
    "ALTER TABLE spend_daily RENAME TO spend_daily_hidden_by_test;",
  );
  try {
    await goto(page, costs);
    const section = page.getByRole("region", { name: "Spend per account" });
    await expect(section.getByRole("alert")).toContainText(
      "Spend is unavailable",
    );
    await expect(section).not.toContainText("$0.00");
    // The caps still load and still save.
    await expect(
      page.getByRole("heading", { name: "Memory review caps" }),
    ).toBeVisible();
  } finally {
    localSql(
      baseURL!,
      "ALTER TABLE spend_daily_hidden_by_test RENAME TO spend_daily;",
    );
  }
});
