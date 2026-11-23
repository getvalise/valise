import { localSql } from "./fixtures/asset-processing";
import { addDocuments, itemDetails, showView } from "./fixtures/library";
import { expect, test } from "./fixtures/session";

/*
 * Scripting off only: the bounded page is a server query, and the loader
 * paging and SQL-side filtering it relies on are test/d1's library-loading
 * suite. The scripted variant repeated the same server pages.
 */
test("895 linked bookmarks load as bounded server pages with scripting off", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const run = `scale-${crypto.randomUUID()}`;
  let assetId = "";
  try {
    await page.goto("/library");
    const upload = await addDocuments(page);
    await upload.getByLabel(/^File, up to/).setInputFiles({
      name: `${run}.json`,
      mimeType: "application/json",
      buffer: Buffer.from("{}"),
    });
    await upload.getByLabel("Title", { exact: true }).fill(run);
    await upload.getByRole("button", { name: "Upload", exact: true }).click();
    // Setup only: library.spec covers where an upload lands.
    await showView(page, "Documents");
    const file = page.locator(".library-item", {
      has: page.getByRole("heading", { name: run, exact: true }),
    });
    await expect(file).toBeVisible();
    assetId = (
      await file.locator('input[name="id"]').first().inputValue()
    ).slice(6);
    await localSql(
      baseURL ?? "",
      `
        WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<894)
        INSERT INTO sources (source_id,user_id,kind,title,url,notes,project,tags_json,revision,source_agent,source_client,created_at,updated_at)
        SELECT 'src_'||lower(hex(randomblob(4)))||'-0000-4000-8000-'||lower(hex(randomblob(6))),a.user_id,'bookmark',
          '${run} Bookmark '||x,'https://example.test/'||x,'Retained highlight '||x,'${run}',
          CASE WHEN x=0 THEN '["scale-shared","scale-rare"]' ELSE '["scale-shared"]' END,
          1,'synthetic-scale','playwright',1900000000+x,1900000000+x FROM n JOIN assets a ON a.asset_id='${assetId}';
        INSERT INTO source_revisions (revision_id,source_id,revision,kind,title,url,notes,project,tags_json,source_agent,source_client,created_at)
        SELECT 'srv_'||source_id,source_id,revision,kind,title,url,notes,project,tags_json,source_agent,source_client,created_at
          FROM sources WHERE project='${run}';
        INSERT INTO source_revision_assets (source_id,revision,asset_id,position)
        SELECT source_id,revision,'${assetId}',0 FROM sources WHERE project='${run}';`,
    );

    const response = await page.goto(`/library?project=${run}`);
    expect(response?.status()).toBe(200);
    expect((await response!.body()).byteLength).toBeLessThan(1_000_000);
    const sources = page.getByRole("region", {
      name: "Saved pages",
      exact: true,
    });
    await expect(sources.locator(".library-item")).toHaveCount(30);
    await expect(
      sources.getByRole("heading", {
        name: `${run} Bookmark 894`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      sources.getByRole("heading", {
        name: `${run} Bookmark 0`,
        exact: true,
      }),
    ).toHaveCount(0);
    await page
      .getByRole("link", { name: "Older sources", exact: true })
      .click();
    const older = page.url();
    expect(older).toContain("sourcesAfter=");
    expect(older).toContain(`project=${run}`);
    await expect(sources.locator(".library-item")).toHaveCount(30);
    const card = sources.locator(".library-item").first();
    await expect(card).toContainText(`${run} Bookmark 864`);
    await expect(card).toContainText(run); // shared snapshot link, still hydrated
    await itemDetails(card);
    await card.getByRole("link", { name: "Edit notes", exact: true }).click();
    await card
      .getByRole("textbox", { name: "Notes", exact: true })
      .fill("Edited on an older bounded page.");
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await expect(card).toContainText("Edited on an older bounded page.");
    expect(new URL(page.url()).searchParams.get("sourcesAfter")).toBe(
      new URL(older).searchParams.get("sourcesAfter"),
    );
    await page.reload();
    await expect(sources.locator(".library-item")).toHaveCount(30);
    await expect(card).toContainText("Edited on an older bounded page.");
    await page
      .getByRole("link", { name: "Newest sources", exact: true })
      .click();
    await expect(
      sources.getByRole("heading", {
        name: `${run} Bookmark 894`,
        exact: true,
      }),
    ).toBeVisible();

    // The rare match is the oldest of 895: filtering must happen in SQL before LIMIT.
    await page.goto(`/library?project=${run}&tag=scale-shared&tag=scale-rare`);
    await expect(sources.locator(".library-item")).toHaveCount(1);
    await expect(
      sources.getByRole("heading", {
        name: `${run} Bookmark 0`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Older sources", exact: true }),
    ).toHaveCount(0);
  } finally {
    await localSql(
      baseURL ?? "",
      `
        DELETE FROM search_docs WHERE doc_key IN (SELECT 'source:'||source_id FROM sources WHERE project='${run}');
        DELETE FROM source_revision_assets WHERE source_id IN (SELECT source_id FROM sources WHERE project='${run}');
        DELETE FROM source_revisions WHERE source_id IN (SELECT source_id FROM sources WHERE project='${run}');
        DELETE FROM sources WHERE project='${run}';`,
    );
    if (assetId)
      await page.request.post("/library", {
        headers: { origin: baseURL ?? "" },
        form: { intent: "asset-delete", id: `asset:${assetId}` },
      });
    await context.close();
  }
});
