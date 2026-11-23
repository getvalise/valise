import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { capturePage } from "../../clients/chrome-extension/capture.mjs";
import {
  savedMessage,
  ValiseClient,
} from "../../clients/chrome-extension/client.mjs";
import { itemDetails } from "./fixtures/library";
import { expect, goto, test } from "./fixtures/session";

/**
 * Article extraction runs in the page at capture, against the live DOM, the
 * way the extension injects it: one bundled script, then one call. The
 * article is a synthetic fixture with a nav, cookie banner, `<noscript>`
 * tag-manager iframe, newsletter form, related links and page metadata.
 */

const fixture = new URL("./fixtures/article-capture.html", import.meta.url);
let extractor = "";

test.beforeAll(async () => {
  const bundled = await build({
    stdin: {
      contents:
        'import { extractArticle } from "./extract.mjs"; globalThis.valiseExtractArticle = extractArticle;',
      resolveDir: new URL("../../clients/chrome-extension/", import.meta.url)
        .pathname,
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
  });
  extractor = bundled.outputFiles[0].text;
});

type Extracted =
  import("../../clients/chrome-extension/capture.mjs").ExtractedArticle;

async function extract(page: import("@playwright/test").Page) {
  await page.addScriptTag({ content: extractor });
  return (await page.evaluate(
    "globalThis.valiseExtractArticle()",
  )) as Extracted;
}

test("extracts the article and its metadata, saves both, and Library shows the byline and text", async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const suffix = Math.random().toString(36).slice(2, 10);
  const title = `The engineer who measured Wrenmouth harbour ${suffix}`;
  const html = (await readFile(fixture, "utf8")).replace(
    "<title>The engineer who measured Wrenmouth harbour | Coastal Notes</title>",
    `<title>${title}</title>`,
  );
  await page.route("https://capture.example.org/**", (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: html }),
  );
  await page.goto("https://capture.example.org/stories/wrenmouth-harbour");
  const before = await page.evaluate("document.documentElement.outerHTML");
  const snapshot = await page.evaluate(capturePage);
  const article = await extract(page);
  // Extraction worked on clones: the page is as it was, bar our own script.
  expect(
    await page.evaluate(
      `(() => { const s = document.querySelectorAll("script"); s[s.length - 1].remove(); return document.documentElement.outerHTML; })()`,
    ),
  ).toBe(before);

  expect(article).toMatchObject({
    detected: true,
    extractor: "defuddle-0.19",
    authors: ["Mara Lindqvist", "Tomas Oyelaran"],
    published: "2026-09-14T08:00:00Z",
    siteName: "Coastal Notes",
    canonicalUrl:
      "https://capture.example.org/stories/wrenmouth-harbour?ref=canonical",
    leadImage: "https://capture.example.org/images/wrenmouth.jpg",
    language: "en-GB",
    truncated: false,
  });
  expect(article.wordCount).toBeGreaterThan(380);
  expect(article.markdown).toMatch(/^The harbour at Wrenmouth was dredged/);
  expect(article.markdown).toMatch(/the patient notes beside them\.$/);
  for (const chrome of [
    "Accept all cookies",
    "Get the weekly newsletter",
    "Related stories",
    "Privacy",
    "googletagmanager",
  ])
    expect(article.text).not.toContain(chrome);
  // The archive keeps the whole page, but not <noscript> as literal text.
  expect(snapshot.html).toContain("Get the weekly newsletter");
  expect(snapshot.html).not.toContain("googletagmanager");

  await goto(page, `${baseURL}/connections`);
  await page.getByLabel("Label", { exact: true }).fill(`Article ${suffix}`);
  for (const scope of ["assets:write", "assets:read", "sources:write"])
    await page.getByRole("checkbox", { name: scope, exact: true }).check();
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  const token = (await page.locator(".token-reveal code").textContent()) ?? "";
  const client = new ValiseClient(
    { endpoint: `${baseURL}/mcp`, token },
    async (url, init) => {
      const response = await request.fetch(String(url), {
        method: init?.method,
        headers: {
          ...(init?.headers as Record<string, string>),
          origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        maxRedirects: 0,
        data:
          init?.body instanceof Uint8Array
            ? Buffer.from(init.body)
            : (init?.body as string),
      });
      return new Response(await response.body(), {
        status: response.status(),
        headers: response.headers(),
      });
    },
  );
  const saved = await client.saveArchive(
    { ...snapshot, article },
    { tags: [suffix] },
  );
  expect(savedMessage(saved)).toMatch(
    new RegExp(
      `^Saved article \\(${article.wordCount} words, by Mara Lindqvist and Tomas Oyelaran\\) and archived the page`,
    ),
  );

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await goto(page, `${baseURL}/library?tag=${suffix}`);
    const card = page.locator(".library-item", {
      has: page.locator(`input[name="id"][value="${saved.sourceId}"]`),
    });
    await expect(card.locator(".library-byline")).toContainText(
      "By Mara Lindqvist and Tomas Oyelaran · Coastal Notes · Published 14 Sept 2026 · Saved ",
    );
    await expect(card.locator(".library-byline")).toContainText(
      `Article, ${article.wordCount} words`,
    );
    await page.screenshot({
      path: testInfo.outputPath(`article-card-${width}.png`),
      fullPage: true,
    });
    await itemDetails(card);
    const reading = card.locator(".library-article");
    await expect(reading).toContainText("Kettering measured before she acted");
    await expect(reading.locator("img")).toHaveCount(0);
    // No horizontal page scroll at either width.
    expect(
      await page.evaluate(
        "document.documentElement.scrollWidth <= window.innerWidth",
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`article-details-${width}.png`),
      fullPage: true,
    });
  }

  // Authors are an ordinary field: edit in place, one commit.
  const card = page.locator(".library-item", {
    has: page.locator(`input[name="id"][value="${saved.sourceId}"]`),
  });
  await card.getByRole("link", { name: "Edit authors" }).click();
  await card
    .getByRole("textbox", { name: "Authors" })
    .fill("Mara Lindqvist, Tomas Oyelaran, Ada Kettering");
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.locator(".library-byline")).toContainText(
    "By Mara Lindqvist, Tomas Oyelaran and Ada Kettering",
  );
});

test("reports no article on a page that is mostly navigation", async ({
  page,
}) => {
  const links = Array.from(
    { length: 120 },
    (_, index) => `<li><a href="/p/${index}">Product number ${index}</a></li>`,
  ).join("");
  await page.route("https://shop.example.org/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><title>Shop</title></head><body><nav><ul>${links}</ul></nav><p>Free delivery on orders over 50.</p></body></html>`,
    }),
  );
  await page.goto("https://shop.example.org/");
  const article = await extract(page);
  expect(article.detected).toBe(false);
  expect(article.markdown).toBe("");
  expect(article.pageWordCount).toBeGreaterThan(300);
  expect(
    savedMessage({
      article: { detected: false, word_count: 0 },
      authors: [],
      assetId: "asset:ast_00000000-0000-0000-0000-000000000001",
    }),
  ).toBe("Archived the page.");
});
