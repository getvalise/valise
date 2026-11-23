import {
  expect,
  goto,
  hydrated,
  signedOut,
  signIn,
  test,
} from "./fixtures/session";

/**
 * Money caps on memory review are an admin's control on /workbench, not a
 * person's setting (ADR-0012, 2026-11-04 limits). The owner is the admin in
 * the suite; a member can neither read nor write the caps.
 */

const costs = "/workbench?tab=costs";
const ownerCaps = 'form:has(input[name="user"][value="local"])';

test("an admin sets an account's review and ranking caps, and the account reads them", async ({
  page,
  baseURL,
}) => {
  await signIn(page, costs);
  await hydrated(page);
  await expect(
    page.getByRole("navigation", { name: "Workbench sections" }),
  ).toContainText("Costs");
  const form = page.locator(ownerCaps);
  await expect(form.getByLabel("Review cap (USD a day)")).toHaveValue("0.5");
  await expect(form.getByLabel("Ranking cap (USD a day)")).toHaveValue("0.2");
  try {
    await form.getByLabel("Review cap (USD a day)").fill("0.75");
    await form.getByLabel("Ranking cap (USD a day)").fill("0.3");
    await form.getByRole("button", { name: "Save caps" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved." }),
    ).toBeVisible();
    await page.reload();
    const card = page.locator("li", { has: page.locator(ownerCaps) });
    await expect(
      card.getByText("set by an admin", { exact: true }),
    ).toBeVisible();
    await expect(card).toContainText("review $0.0000 of $0.7500");
    await expect(
      page.locator(ownerCaps).getByLabel("Review cap (USD a day)"),
    ).toHaveValue("0.75");

    // Out of bounds: the field refuses it, and so does the server.
    const field = page.locator(ownerCaps).getByLabel("Review cap (USD a day)");
    await field.fill("9");
    expect(
      await field.evaluate(
        (input) =>
          (input as unknown as { validity: { valid: boolean } }).validity.valid,
      ),
    ).toBe(false);
    const refused = await page.request.post(costs, {
      headers: { origin: baseURL! },
      form: {
        intent: "review-caps",
        user: "local",
        reviewUsd: "9",
        rankingUsd: "0.3",
        wasReview: "750000",
        wasRanking: "300000",
      },
    });
    expect(await refused.text()).toContain("from $0.001 to $5.00");
    await page.reload();
    await expect(
      page.locator(ownerCaps).getByLabel("Review cap (USD a day)"),
    ).toHaveValue("0.75");

    // The account sees the caps it lives under, read-only, beside its counts.
    await goto(page, "/memories?tab=review&settings=open");
    await expect(
      page.getByText(
        "An admin caps what a day may cost: $0.7500 for review, $0.3000 for ranking.",
        { exact: false },
      ),
    ).toBeVisible();
    await expect(page.getByLabel(/USD/)).toHaveCount(0);
  } finally {
    // Back to the defaults, which removes the row, so other tests see them.
    await goto(page, costs);
    const reset = page.locator(ownerCaps);
    await reset.getByLabel("Review cap (USD a day)").fill("0.5");
    await reset.getByLabel("Ranking cap (USD a day)").fill("0.2");
    await reset.getByRole("button", { name: "Save caps" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved." }),
    ).toBeVisible();
  }
});

test("a member can neither read nor post review caps", async ({
  browser,
  page,
  baseURL,
}) => {
  const context = await browser.newContext({ storageState: signedOut });
  try {
    const email = `member-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const made = await context.request.post(
      `/__dev/member?email=${encodeURIComponent(email)}`,
    );
    expect(made.ok()).toBe(true);
    const member = await context.newPage();
    const response = await member.goto(costs);
    expect(response?.status()).toBe(404);
    const posted = await context.request.post(costs, {
      headers: { origin: baseURL! },
      form: {
        intent: "review-caps",
        user: "local",
        reviewUsd: "5",
        rankingUsd: "5",
        wasReview: "500000",
        wasRanking: "200000",
      },
    });
    expect(posted.status()).toBe(404);
  } finally {
    await context.close();
  }
  // The owner's caps are still the defaults.
  await signIn(page, costs);
  const card = page.locator("li", { has: page.locator(ownerCaps) });
  await expect(card.getByText("default", { exact: true })).toBeVisible();
  await expect(
    page.locator(ownerCaps).getByLabel("Review cap (USD a day)"),
  ).toHaveValue("0.5");
});
