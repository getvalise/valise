import { localSql } from "./fixtures/asset-processing";
import { expect, goto, hydrated, mcp, test } from "./fixtures/session";

/**
 * A bookmark has two times: when it was saved and when the page or post was
 * published. Library shows both and sorts by either; an undated bookmark
 * sorts after the dated ones. Synthetic posts only.
 */
test("sorts bookmarks by saved or published time and shows both dates, at desktop and 320px", async ({
  page,
  request,
  baseURL,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  const save = (title: string, published?: string) =>
    mcp(request, "save_source", {
      kind: "bookmark",
      title: `${title} ${run}`,
      url: `https://x.example/${run}/${title.replaceAll(" ", "-")}`,
      notes: `${title}.`,
      tags: [run],
      ...(published ? { published } : {}),
    });
  const saved = [
    await save("Old essay", "2019-04-02T08:00:00Z"),
    await save("Undated note"),
    await save("Recent post", "2026-10-12T06:40:00Z"),
  ];
  // Saved a minute apart, so the default order does not fall to id ties.
  await localSql(
    baseURL ?? "",
    saved
      .map(
        (source, at) =>
          `UPDATE sources SET created_at = created_at + ${at * 60} WHERE source_id = '${String(source.id).replace(/^source:/, "")}';`,
      )
      .join("\n"),
  );
  const titles = (order: string[]) => order.map((title) => `${title} ${run}`);

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await goto(page, `/library?tag=${run}`);
    await hydrated(page);
    const rows = page.locator(".library-item h3");
    await expect(rows).toHaveText(
      titles(["Recent post", "Undated note", "Old essay"]),
    );
    const recent = page.locator(".library-item", {
      hasText: `Recent post ${run}`,
    });
    await expect(recent.locator(".library-byline")).toContainText(
      "Published 12 Oct 2026 · Saved ",
    );
    await expect(
      recent.locator('time[datetime="2026-10-12T06:40:00.000Z"]'),
    ).toHaveAttribute("title", "2026-10-12 06:40 UTC");

    await page.getByRole("button", { name: "Sort bookmarks" }).click();
    await page.getByRole("menuitem", { name: "Newest published" }).click();
    await expect(page).toHaveURL(/sort=published/);
    await expect(rows).toHaveText(
      titles(["Recent post", "Old essay", "Undated note"]),
    );
    await expect(
      page.getByRole("button", { name: "Sort bookmarks" }),
    ).toContainText("Newest published");
    await page.screenshot({
      path: test.info().outputPath(`dates-${width}.png`),
      fullPage: true,
    });

    // The order survives opening a bookmark and closing it again.
    await recent.locator(".library-details-link").click();
    await expect(page).toHaveURL(/sort=published/);
  }
});
