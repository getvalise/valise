import { expect, goto, hydrated, mcp, test } from "./fixtures/session";

// A 1×1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * A bookmark's images are its linked files; the pane shows each as a
 * thumbnail beside its title, so a saved post's photo is seen, not named.
 * Synthetic post and image.
 */
test("shows a bookmark's linked image as a thumbnail, at desktop and 320px", async ({
  page,
  request,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  const begun = await mcp(request, "upload_asset", {
    file_name: `dawn-${run}.png`,
    content_type: "image/png",
    size: PNG.byteLength,
    title: `Image from img.example ${run}`,
  });
  const put = await request.put(begun.upload.url, { data: PNG });
  expect(put.status()).toBe(200);
  const title = `@petrel: dawn ${run}`;
  const source = await mcp(request, "save_source", {
    kind: "bookmark",
    title,
    url: `https://x.example/petrel/status/${run}`,
    notes: "Four petrels at dawn.",
    asset_ids: [begun.id],
  });

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await goto(page, `/library?details=${encodeURIComponent(source.id)}`);
    await hydrated(page);
    const pane = page.getByRole("dialog", { name: title });
    await expect(
      pane.getByRole("img", {
        name: `Thumbnail of Image from img.example ${run}`,
      }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`images-${width}.png`),
      fullPage: true,
    });
  }
});
