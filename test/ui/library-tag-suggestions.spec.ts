import { localSql } from "./fixtures/asset-processing";
import { expect, goto, mcp, test } from "./fixtures/session";

/**
 * Suggested tags sit under a bookmark's tags. Adding one writes it as an
 * ordinary tag; dismissing one stops it being offered. Nothing is written
 * until the person chooses. Synthetic post and seeded model output.
 */
test("adds one suggested tag and dismisses another, at desktop and 320px", async ({
  page,
  request,
  baseURL,
}) => {
  for (const width of [1280, 320]) {
    const run = crypto.randomUUID().slice(0, 8);
    const title = `@hedgerow_ada: Saturday ${run}`;
    const source = await mcp(request, "save_source", {
      kind: "bookmark",
      title,
      url: `https://x.example/hedgerow_ada/status/${run}`,
      notes: "A hedgerow walk, three bumblebee species before ten.",
      tags: [`walk-${run}`],
    });
    const sourceId = String(source.id).replace(/^source:/, "");
    await localSql(
      baseURL ?? "",
      `INSERT INTO source_enrichments (enrichment_id, user_id, source_id, revision, state,
         concepts_json, suggested_tags_json, model, input_tokens, output_tokens, cost_microusd, created_at)
       SELECT 'sen_${run}', user_id, source_id, revision, 'ready', '[]',
         '["bumblebees-${run}","hedgerows-${run}","walk-${run}"]', 'fixture', 200, 30, 45, unixepoch()
         FROM sources WHERE source_id = '${sourceId}';`,
    );

    await page.setViewportSize({ width, height: 900 });
    await goto(page, `/library?details=${encodeURIComponent(source.id)}`);
    const pane = page.getByRole("dialog", { name: title });
    const suggested = pane.getByRole("list", { name: "Suggested tags" });
    // A tag the bookmark already has is not offered again.
    await expect(suggested.getByRole("button")).toHaveText([
      `bumblebees-${run}`,
      "",
      `hedgerows-${run}`,
      "",
    ]);

    await suggested
      .getByRole("button", { name: `Add tag bumblebees-${run}` })
      .click();
    await expect(
      suggested.getByRole("button", { name: `Add tag bumblebees-${run}` }),
    ).toHaveCount(0);
    await expect(
      pane.getByText(`bumblebees-${run}`, { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`tag-suggestions-${width}.png`),
      fullPage: true,
    });

    await suggested
      .getByRole("button", { name: `Dismiss suggested tag hedgerows-${run}` })
      .click();
    await expect(suggested).toHaveCount(0);
    await page.reload();
    await expect(
      pane.getByRole("list", { name: "Suggested tags" }),
    ).toHaveCount(0);
    const saved = await mcp(request, "fetch", { id: source.id });
    expect(saved.metadata.tags).toEqual([`walk-${run}`, `bumblebees-${run}`]);
  }
});
