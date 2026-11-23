import { expect, goto, mcp, test } from "./fixtures/session";

/**
 * The author lens: a byline on a saved page links to the author, the author
 * page gathers their items and the highlights saved from them, and a short
 * spelling of the same name lands on the same page. Synthetic people only.
 */
test("follows a byline to an author page with their items and highlights, at desktop and 320px", async ({
  page,
  request,
}, testInfo) => {
  const run = Array.from(
    { length: 8 },
    () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)],
  ).join("");
  const surname = `Harrow${run}`;
  const author = `Imogen ${surname}`;
  const url = `https://example.org/${run}/tidal-ledgers`;
  const article = await mcp(request, "save_source", {
    kind: "document",
    title: `Tidal ledgers ${run}`,
    url,
    tags: [run],
    authors: [author],
    article: {
      detected: true,
      markdown: "Measure first, then change the harbour.",
      text: "Measure first, then change the harbour.",
      word_count: 812,
      page_word_count: 1300,
      extractor: "defuddle-0.19",
      site_name: "Coastal Notes",
      description:
        "Why a harbour engineer measured for a year before dredging.",
    },
  });
  await mcp(request, "save_source", {
    kind: "bookmark",
    title: `Breakwaters revisited ${run}`,
    url: `https://example.org/${run}/breakwaters`,
    tags: [run],
    authors: [`I ${surname}`],
  });
  await mcp(request, "save_source", {
    kind: "reference",
    title: `Tidal ledgers ${run} — Highlight`,
    url,
    tags: [run],
    notes:
      "Captured text selection from the page.\n\nSelected text:\nA structure can succeed at its job and still cause a problem nobody asked it to solve.\n\nContext before:\nShe wrote that",
  });

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await goto(page, `/library?tag=${run}`);
    const card = page.locator(".library-item", {
      has: page.locator(`input[name="id"][value="${article.id}"]`),
    });
    await card.getByRole("link", { name: author, exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp(`/library/authors/imogen-harrow${run}$`),
    );
    await expect(
      page.getByRole("heading", { name: author, exact: true }),
    ).toBeVisible();
    await expect(page.locator(".author-page")).toContainText(
      "2 saved items and 1 highlight",
    );
    await expect(page.locator(".author-page")).toContainText(
      `Also saved as I ${surname}.`,
    );
    const highlights = page.getByRole("list", { name: "Highlights" });
    await expect(highlights.locator(".item-row")).toHaveCount(1);
    await expect(highlights.locator(".item-title")).toHaveText(
      "A structure can succeed at its job and still cause a problem nobody asked it to solve.",
    );
    const items = page.getByRole("list", { name: "Saved items" });
    await expect(items.locator(".item-row")).toHaveCount(2);
    for (const title of [
      `Breakwaters revisited ${run}`,
      `Tidal ledgers ${run}`,
    ])
      await expect(
        items.getByRole("link", { name: title, exact: true }),
      ).toBeVisible();
    // The page's own description is the row's description.
    await expect(
      items.locator(".item-row", { hasText: `Tidal ledgers ${run}` }),
    ).toContainText(
      "Why a harbour engineer measured for a year before dredging.",
    );
    expect(
      await page.evaluate(
        "document.documentElement.scrollWidth <= window.innerWidth",
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`author-page-${width}.png`),
      fullPage: true,
    });
  }

  // A click anywhere on an item's row, not only its title, opens that item
  // in Library.
  const tidal = page
    .getByRole("list", { name: "Saved items" })
    .locator(".item-row", { hasText: `Tidal ledgers ${run}` });
  const box = await tidal.boundingBox();
  if (!box) throw new Error("the item row has no box");
  await page.mouse.click(box.x + box.width - 8, box.y + box.height / 2);
  await expect(
    page.locator(".library-item", {
      has: page.locator(`input[name="id"][value="${article.id}"]`),
    }),
  ).toContainText("Measure first, then change the harbour.");

  await goto(page, "/library/authors");
  const row = page
    .getByRole("list", { name: "Authors" })
    .locator(".item-row", { hasText: author });
  // The count of items sits on the row, and the other spelling under it.
  await expect(row.locator(".item-meta")).toHaveText("2 items");
  await expect(row.locator(".item-description")).toHaveText(
    `Also saved as I ${surname}`,
  );
  await page.screenshot({
    path: testInfo.outputPath("authors-index-320.png"),
    fullPage: true,
  });
  // The whole row opens the author, not only the name.
  const rowBox = await row.boundingBox();
  if (!rowBox) throw new Error("the author row has no box");
  await page.mouse.click(
    rowBox.x + rowBox.width / 2,
    rowBox.y + rowBox.height - 4,
  );
  await expect(page).toHaveURL(
    new RegExp(`/library/authors/imogen-harrow${run}$`),
  );
});
