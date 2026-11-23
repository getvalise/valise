import type { Locator, Page } from "@playwright/test";
import { localSql } from "./fixtures/asset-processing";
import { expect, goto, mcp, test } from "./fixtures/session";

/**
 * A bookmark's Library pane, read the way the owner reads it: the summary
 * first, the saved article under its own heading with the rest behind Read
 * more, how the summary was made behind a disclosure, suggested tags as
 * ghost chips on the tags' left edge, and the reader's stars. Synthetic
 * articles and seeded model output. ADR-0015, amendment of 2026-11-03.
 */

const sentence = (n: number, run: string) =>
  `Hawthorn hedge ${n} shelters bumblebees early in spring, and the walk along it counts three species before ten in the morning (${run}).`;

/** `paragraphs` paragraphs of about 260 characters; the last names `tail`. */
function articleMarkdown(paragraphs: number, run: string) {
  return Array.from({ length: paragraphs }, (_, index) =>
    index === paragraphs - 1
      ? `The last hedge is the tail ${run}.`
      : `${sentence(index, run)} ${sentence(index + 100, run)}`,
  ).join("\n\n");
}

async function seededBookmark(
  request: Parameters<typeof mcp>[0],
  baseURL: string,
  {
    paragraphs,
    summary = true,
    suggested = [],
    tags = [],
  }: {
    paragraphs: number;
    summary?: boolean;
    suggested?: string[];
    tags?: string[];
  },
) {
  const run = crypto.randomUUID().slice(0, 8);
  const title = `Hedgerows and pollinators ${run}`;
  const source = await mcp<{ id: string }>(request, "save_source", {
    kind: "bookmark",
    title,
    url: `https://hedges.example/${run}`,
    tags,
  });
  const sourceId = source.id.slice("source:".length);
  const markdown = articleMarkdown(paragraphs, run).replaceAll("'", "''");
  await localSql(
    baseURL,
    `INSERT INTO source_articles (source_id, revision, user_id, detected, markdown, text,
       word_count, page_word_count, extractor, site_name, created_at)
     SELECT source_id, revision, user_id, 1, '${markdown}', '${markdown}',
       ${paragraphs * 45}, ${paragraphs * 60}, 'defuddle-0.19', 'Hedge Notes', unixepoch()
       FROM sources WHERE source_id = '${sourceId}';
     ${
       summary || suggested.length
         ? `INSERT INTO source_enrichments (enrichment_id, user_id, source_id, revision,
       article_revision, state, summary, concepts_json, suggested_tags_json, model,
       input_tokens, output_tokens, cost_microusd, created_at)
     SELECT 'sen_${run}', user_id, source_id, revision, revision, 'ready',
       ${summary ? `'Hedges feed bumblebees before the meadows flower (${run}).'` : "NULL"},
       '["hedgerows","pollinators"]', '${JSON.stringify(suggested)}', 'fixture-model',
       1911, 145, 400, unixepoch()
       FROM sources WHERE source_id = '${sourceId}';`
         : ""
     }`,
  );
  return { id: source.id, sourceId, run, title };
}

const pane = (page: Page, title: string) =>
  page.getByRole("dialog", { name: title });

async function left(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).toBeTruthy();
  return Math.round(box?.x ?? 0);
}

for (const [name, viewport] of [
  ["desktop", { width: 1280, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
] as const)
  test(`a long article opens on the summary, with the rest behind Read more, at ${name} width`, async ({
    page,
    request,
    baseURL,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const item = await seededBookmark(request, baseURL ?? "", {
      paragraphs: 10,
    });
    await goto(page, `/library?details=${encodeURIComponent(item.id)}`);
    const open = pane(page, item.title);
    await expect(
      open.getByText(`Hedges feed bumblebees before the meadows flower`),
    ).toBeVisible();
    // How the summary was made is one closed line, not content.
    const provenance = open.locator("details.library-provenance");
    await expect(
      provenance.getByText("How this summary was made"),
    ).toBeVisible();
    await expect(
      open.getByText(/Generated on .* by fixture-model/),
    ).toBeHidden();

    // The page's own words start under their own heading.
    const saved = open.getByRole("region", { name: "Saved article" });
    await expect(
      saved.getByRole("heading", { name: "Saved article" }),
    ).toBeVisible();
    await expect(saved.getByText(sentence(0, item.run))).toBeVisible();
    await expect(saved.getByText(`The last hedge is the tail`)).toBeHidden();
    await page.screenshot({
      path: testInfo.outputPath(`pane-summary-${name}.png`),
    });

    await saved.getByText("Read more").click();
    await expect(saved.getByText(`The last hedge is the tail`)).toBeVisible();
    await expect(saved.getByText("Show less")).toBeVisible();
    await expect(saved.getByText("Read more")).toBeHidden();
    // Open, Show less is where the reading stops: after the last paragraph.
    const tail = await saved
      .getByText(`The last hedge is the tail`)
      .boundingBox();
    const less = await saved.getByText("Show less").boundingBox();
    expect((less?.y ?? 0) > (tail?.y ?? 0)).toBe(true);

    await provenance.getByText("How this summary was made").click();
    await expect(
      open.getByText(
        /Generated on .* by fixture-model from the article: \$0\.0004 \(1,911 tokens in, 145 out\)\./,
      ),
    ).toBeVisible();
    expect(
      await page.evaluate(
        "document.documentElement.scrollWidth <= window.innerWidth",
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`pane-read-more-${name}.png`),
    });
  });

test("a short article is shown whole, and an article with no summary still has its heading", async ({
  page,
  request,
  baseURL,
}) => {
  const item = await seededBookmark(request, baseURL ?? "", {
    paragraphs: 2,
    summary: false,
  });
  await goto(page, `/library?details=${encodeURIComponent(item.id)}`);
  const open = pane(page, item.title);
  const saved = open.getByRole("region", { name: "Saved article" });
  await expect(saved.getByText(`The last hedge is the tail`)).toBeVisible();
  await expect(saved.getByText("Read more")).toHaveCount(0);
  await expect(open.getByRole("region", { name: "Summary" })).toHaveCount(0);
  await expect(open.locator("details.library-provenance")).toHaveCount(0);
});

test.describe("with scripting off", () => {
  test.use({ javaScriptEnabled: false });
  test("Read more opens natively, and the pane's stars post as forms", async ({
    page,
    request,
    baseURL,
  }) => {
    const item = await seededBookmark(request, baseURL ?? "", {
      paragraphs: 10,
    });
    await page.goto(`/library?details=${encodeURIComponent(item.id)}`);
    const saved = page.getByRole("region", { name: "Saved article" });
    await expect(saved.getByText(`The last hedge is the tail`)).toBeHidden();
    await saved.getByText("Read more").click();
    await expect(saved.getByText(`The last hedge is the tail`)).toBeVisible();

    const stars = page.getByRole("form", { name: "Your rating" });
    await stars.getByRole("button", { name: "Rate 3 of 3 stars" }).click();
    await expect(page.getByRole("form", { name: "Your rating" })).toContainText(
      "Rated 3 of 3",
    );
    await expect(page.getByRole("img", { name: "Rated 3 of 3" })).toHaveCount(
      1,
    );
  });
});

test("rates in the pane with the reader's stars, shows it on the row, and the same star clears it", async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const item = await seededBookmark(request, baseURL ?? "", {
    paragraphs: 3,
  });
  await goto(page, `/library?details=${encodeURIComponent(item.id)}`);
  const open = pane(page, item.title);
  const row = page.locator(".library-item", {
    has: page.locator(`input[name="id"][value="${item.id}"]`),
  });
  const stars = open.getByRole("form", { name: "Your rating" });
  await expect(stars).toContainText("Not rated");
  // Unrated rows carry no stars at all.
  await expect(
    row.locator(".library-byline").getByRole("img", { name: /^Rated / }),
  ).toHaveCount(0);
  for (const star of await stars.getByRole("button").all()) {
    const box = await star.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(24);
    expect(box?.height).toBeGreaterThanOrEqual(24);
  }
  await stars.getByRole("button", { name: "Rate 2 of 3 stars" }).click();
  await expect(stars).toContainText("Rated 2 of 3");
  await page.reload();
  await expect(open.getByRole("form", { name: "Your rating" })).toContainText(
    "Rated 2 of 3",
  );
  await expect(
    row.locator(".library-byline").getByRole("img", { name: "Rated 2 of 3" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("pane-rating.png"),
  });

  // The reader reads the same rating: one action, two places.
  await goto(page, `/library/read/${item.sourceId}`);
  await expect(page.getByRole("form", { name: "Your rating" })).toContainText(
    "Rated 2 of 3",
  );
  await goto(page, `/library?details=${encodeURIComponent(item.id)}`);
  await open
    .getByRole("form", { name: "Your rating" })
    .getByRole("button", { name: "Clear rating of 2 of 3 stars" })
    .click();
  await expect(open.getByRole("form", { name: "Your rating" })).toContainText(
    "Not rated",
  );
  await page.reload();
  await expect(
    row.locator(".library-byline").getByRole("img", { name: /^Rated / }),
  ).toHaveCount(0);
});

for (const width of [1280, 390])
  test(`suggested tags are ghost chips on the tags' left edge, and Add tag opens in its own space, at ${width}px`, async ({
    page,
    request,
    baseURL,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const run = crypto.randomUUID().slice(0, 8);
    const tags = Array.from({ length: 9 }, (_, n) => `hedge-${n}-${run}`);
    const item = await seededBookmark(request, baseURL ?? "", {
      paragraphs: 3,
      tags,
      suggested: [`bumblebees-${run}`, `meadows-${run}`, tags[0]],
    });
    await goto(page, `/library?details=${encodeURIComponent(item.id)}`);
    const open = pane(page, item.title);
    const suggested = open.getByRole("list", { name: "Suggested tags" });
    // A tag it already has is not suggested again.
    await expect(suggested.getByRole("listitem")).toHaveCount(2);
    const ghost = suggested.getByRole("listitem").first();
    await expect(ghost).toHaveCSS("border-top-style", "dashed");
    await expect(ghost).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    // The dismiss is inside the chip it dismisses.
    const chip = await ghost.boundingBox();
    const dismiss = await ghost
      .getByRole("button", { name: `Dismiss suggested tag bumblebees-${run}` })
      .boundingBox();
    expect(chip && dismiss).toBeTruthy();
    if (chip && dismiss)
      expect(dismiss.x + dismiss.width).toBeLessThanOrEqual(
        chip.x + chip.width + 1,
      );

    // Tags, suggestions and Add a project share one left edge.
    const tagRow = open.locator(".tagset .tags").first();
    const edge = await left(tagRow.locator(".chip").first());
    expect(await left(ghost)).toBe(edge);
    expect(await left(open.getByRole("link", { name: "Add a project" }))).toBe(
      edge,
    );

    // Add tag is spelled out in the row, and opening it covers no chip.
    const add = open.getByRole("link", { name: "Add tag", exact: true });
    await expect(add).toBeVisible();
    await add.click();
    const box = open.getByRole("combobox", { name: "Add tag" });
    await expect(box).toBeFocused();
    const field = await box.boundingBox();
    for (const other of await tagRow.locator(".chip").all()) {
      const taken = await other.boundingBox();
      if (!field || !taken) continue;
      const overlaps =
        field.x < taken.x + taken.width &&
        taken.x < field.x + field.width &&
        field.y < taken.y + taken.height &&
        taken.y < field.y + field.height;
      expect(overlaps).toBe(false);
    }
    expect(
      await page.evaluate(
        "document.documentElement.scrollWidth <= window.innerWidth",
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`pane-tags-${width}.png`),
    });
    await page.keyboard.press("Escape");

    await suggested
      .getByRole("button", { name: `Add tag meadows-${run}` })
      .click();
    await expect(
      open.locator(".tagset").getByText(`meadows-${run}`, { exact: true }),
    ).toBeVisible();
    await expect(
      open.getByRole("list", { name: "Suggested tags" }).getByRole("listitem"),
    ).toHaveCount(1);
  });

test("no suggestions, no suggestion row", async ({
  page,
  request,
  baseURL,
}) => {
  const item = await seededBookmark(request, baseURL ?? "", {
    paragraphs: 3,
    tags: ["hedgerows"],
  });
  await goto(page, `/library?details=${encodeURIComponent(item.id)}`);
  const open = pane(page, item.title);
  await expect(open.getByRole("list", { name: "Suggested tags" })).toHaveCount(
    0,
  );
  await expect(
    open.getByRole("link", { name: "Add tag", exact: true }),
  ).toBeVisible();
});

for (const [name, viewport] of [
  ["desktop", { width: 1280, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
] as const)
  test(`the reader's header stands on the article's left edge at ${name} width`, async ({
    page,
    request,
    baseURL,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const item = await seededBookmark(request, baseURL ?? "", {
      paragraphs: 4,
    });
    await goto(page, `/library/read/${item.sourceId}`);
    const article = page.getByRole("article");
    const edge = await left(article);
    expect(await left(page.locator(".page-title"))).toBe(edge);
    expect(
      await left(
        page.getByRole("link", { name: "Back to this item in Library" }),
      ),
    ).toBe(edge);
    // The list's tabs belong to the list, not to one article.
    await expect(page.getByRole("navigation", { name: "Library" })).toHaveCount(
      0,
    );
    expect(
      await page.evaluate(
        "document.documentElement.scrollWidth <= window.innerWidth",
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`reader-${name}.png`),
    });
  });

test("the pane's rating refuses a malformed rating and an item that is not the owner's", async ({
  page,
  request,
  baseURL,
}) => {
  const item = await seededBookmark(request, baseURL ?? "", { paragraphs: 2 });
  await goto(page, "/library");
  const post = (id: string, stars: string) =>
    page.request.post("/library", {
      headers: { origin: baseURL ?? "" },
      form: { intent: "rate", id, stars },
      maxRedirects: 0,
    });
  expect((await post(item.id, "7")).status()).toBe(400);
  expect(
    (
      await post("source:src_00000000-0000-4000-8000-000000000000", "2")
    ).status(),
  ).toBe(404);
  const fine = await post(item.id, "1");
  expect(fine.status()).toBeLessThan(400);
});
