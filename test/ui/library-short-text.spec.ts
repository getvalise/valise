import { localSql } from "./fixtures/asset-processing";
import { expect, goto, mcp, test } from "./fixtures/session";

/**
 * A post saved with its text, from a site whose robots.txt refuses Valise:
 * the pane reads the text, says why there is no summary, and does not
 * present the saved text as content Valise could not get. Synthetic post.
 */
test("shows a short saved post as itself, with the robots.txt refusal beside it, at desktop and 320px", async ({
  page,
  request,
  baseURL,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  const text = `My Saturday ${run}: a hedgerow walk, three bumblebee species before ten.`;
  const source = await mcp(request, "save_source", {
    kind: "bookmark",
    title: `@hedgerow_ada: My Saturday ${run}`,
    url: `https://x.example/hedgerow_ada/status/${run}`,
    notes: text,
  });
  const sourceId = String(source.id).replace(/^source:/, "");
  await localSql(
    baseURL ?? "",
    `INSERT INTO source_enrichments (enrichment_id, user_id, source_id, revision,
       state, fetch_status, concepts_json, input_tokens, output_tokens, cost_microusd, created_at)
     SELECT 'sen_${run}', user_id, source_id, revision, 'skipped', 'robots_disallowed', '[]', 0, 0, 0, unixepoch()
       FROM sources WHERE source_id = '${sourceId}';`,
  );

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await goto(page, `/library?details=${encodeURIComponent(source.id)}`);
    const pane = page.getByRole("dialog", {
      name: `@hedgerow_ada: My Saturday ${run}`,
    });
    await expect(pane.getByText(text, { exact: true })).toBeVisible();
    await expect(
      pane.getByText(
        `Shown whole rather than summarised: ${text.length} characters. Valise did not fetch the page, as its robots.txt asks. The text here is what was saved with the bookmark.`,
        { exact: true },
      ),
    ).toBeVisible();
    await expect(pane.getByText(/Nothing to summarise/)).toHaveCount(0);
    await expect(pane.getByText(/asks not to be fetched/)).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath(`short-text-${width}.png`),
      fullPage: true,
    });
  }
});
