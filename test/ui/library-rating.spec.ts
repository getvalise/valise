import type { Page } from "@playwright/test";
import { expect, goto, mcp, test } from "./fixtures/session";

/**
 * The reader's rating: one to three stars, set and cleared by the same
 * control (P7, P12), with and without scripting (P11), and what an agent's
 * search then says about it. ADR-0015, amendment of 2026-11-01 (use).
 */

async function bookmark(request: Parameters<typeof mcp>[0]) {
  const marker = crypto.randomUUID().slice(0, 8);
  const saved = await mcp<{ id: string }>(request, "save_source", {
    kind: "bookmark",
    title: `Hedgerows and pollinators ${marker}`,
    url: `https://en.wikipedia.org/wiki/Hedge?${marker}`,
    notes: `Hawthorn hedges shelter bumblebees early in spring. ${marker}`,
    tags: [],
  });
  return { id: saved.id.slice("source:".length), marker };
}

const rating = (page: Page) => page.getByRole("form", { name: "Your rating" });

async function rateAndClear(page: Page) {
  const form = rating(page);
  await expect(form).toContainText("Not rated");
  await form.getByRole("button", { name: "Rate 2 of 3 stars" }).click();
  await expect(form).toContainText("Rated 2 of 3");
  await expect(
    form.getByRole("button", { name: "Rate 1 of 3 stars" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    form.getByRole("button", { name: "Rate 3 of 3 stars" }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.reload();
  await expect(rating(page)).toContainText("Rated 2 of 3");
  await rating(page)
    .getByRole("button", { name: "Clear rating of 2 of 3 stars" })
    .click();
  await expect(rating(page)).toContainText("Not rated");
}

test("rates a bookmark in the reader, and the same star clears it", async ({
  page,
  request,
}) => {
  const { id } = await bookmark(request);
  await goto(page, `/library/read/${id}`);
  await rateAndClear(page);
});

test.describe("with scripting off", () => {
  test.use({ javaScriptEnabled: false });
  test("rates and clears through plain form posts", async ({
    page,
    request,
  }) => {
    const { id } = await bookmark(request);
    await page.goto(`/library/read/${id}`);
    await rateAndClear(page);
  });
});

test("an agent's search says the owner rated it", async ({ page, request }) => {
  const { id, marker } = await bookmark(request);
  await goto(page, `/library/read/${id}`);
  // The label paints on the click (P11); search only once the post landed.
  const saved = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.ok(),
  );
  await rating(page).getByRole("button", { name: "Rate 3 of 3 stars" }).click();
  await expect(rating(page)).toContainText("Rated 3 of 3");
  await saved;
  const found = await mcp<{
    results: { id: string; metadata: { use?: { why: string[] } } }[];
  }>(request, "search", { query: marker, type: "source" });
  expect(found.results[0]).toMatchObject({
    id: `source:${id}`,
    metadata: {
      use: {
        why: expect.arrayContaining([
          "you rated this 3 of 3 stars",
          "you opened this once in the last 90 days",
        ]),
      },
    },
  });
});

for (const [name, viewport] of [
  ["desktop", { width: 1280, height: 800 }],
  ["mobile", { width: 390, height: 844 }],
] as const)
  test(`the rating sits in the reader header at ${name} width with 24px targets`, async ({
    page,
    request,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const { id } = await bookmark(request);
    await goto(page, `/library/read/${id}`);
    const form = rating(page);
    await expect(form).toBeVisible();
    await form.getByRole("button", { name: "Rate 2 of 3 stars" }).click();
    await expect(form).toContainText("Rated 2 of 3");
    for (const star of await form.getByRole("button").all()) {
      const box = await star.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(24);
      expect(box?.height).toBeGreaterThanOrEqual(24);
    }
    const header = page.getByRole("article").locator("header");
    const headerBox = await header.boundingBox();
    const formBox = await form.boundingBox();
    expect(formBox && headerBox).toBeTruthy();
    if (formBox && headerBox)
      expect(formBox.x + formBox.width).toBeLessThanOrEqual(
        headerBox.x + headerBox.width + 1,
      );
    expect(
      await page.evaluate(
        "document.documentElement.scrollWidth <= window.innerWidth",
      ),
    ).toBe(true);
    await testInfo.attach(`reader-rating-${name}`, {
      body: await page.screenshot({ fullPage: false }),
      contentType: "image/png",
    });
  });
