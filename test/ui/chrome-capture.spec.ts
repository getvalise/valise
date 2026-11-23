import {
  capturePage,
  captureSelection,
} from "../../clients/chrome-extension/capture.mjs";
import { ValiseClient } from "../../clients/chrome-extension/client.mjs";
import { itemDetails, showView } from "./fixtures/library";
import { expect, goto, test } from "./fixtures/session";

test("captures a rendered DOM without form secrets or executable content, then shows original and source in Library", async ({
  page,
  request,
  context,
  baseURL,
}) => {
  const suffix = Math.random().toString(36).slice(2, 10);
  const title = `Chrome capture wren ${suffix}`;
  await page.route("https://capture.example.org/article*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>
    <h1>Rendered wren article</h1><p id="article">Original article text ☀</p>
    <input value="default-secret"><input type="password" value="password-secret"><input type="hidden" value="csrf-secret">
    <textarea>draft-secret</textarea><select><option selected>selected-secret</option></select>
    <div contenteditable="true">editable-secret</div><div hidden>hidden-secret</div>
    <script>window.originalScriptRan=true;</script><iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>
    <a href="javascript:alert(1)" onclick="alert(1)">Unsafe</a><a href="/next">Next article</a>
    <img src="data:image/svg+xml,x" onerror="alert(1)" data-key="attribute-secret" alt="Wren">
    <!-- comment-secret --></body></html>`,
    }),
  );
  await page.goto("https://capture.example.org/article#oauth-fragment-secret");
  await page.locator("input").first().fill("current-secret");
  await page
    .locator("#article")
    .evaluate((node) => node.append(" Dynamically rendered text."));
  const snapshot = await page.evaluate(capturePage);
  await page.evaluate(`(() => {
    const node = document.querySelector("#article");
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  })()`);
  const selection = await page.evaluate(captureSelection);
  if (!selection) throw new Error("Expected selected page text.");
  expect(snapshot.title).toBe(title);
  expect(snapshot.url).toBe("https://capture.example.org/article");
  expect(selection.quote).toBe(
    "Original article text ☀ Dynamically rendered text.",
  );
  expect(selection.url).toBe("https://capture.example.org/article");
  expect(snapshot.html).toContain("Dynamically rendered text.");
  expect(snapshot.html).toContain("https://capture.example.org/next");
  for (const forbidden of [
    "-secret",
    "<script",
    "<iframe",
    "srcdoc",
    "onclick",
    "onerror",
    "javascript:",
    "data-key",
  ])
    expect(snapshot.html).not.toContain(forbidden);
  // Live page was not changed by capture.
  await expect(page.locator("input").first()).toHaveValue("current-secret");
  const offline = await context.newPage();
  await offline.setContent(snapshot.html);
  expect(await offline.evaluate("window.originalScriptRan")).toBeUndefined();
  await offline.close();

  // Mint the same three-scope console credential that extension setup requires.
  // This tests the authenticated Origin path, not the loopback x-valise bypass.
  await goto(page, `${baseURL}/connections`);
  await page
    .getByLabel("Label", { exact: true })
    .fill(`Chrome capture ${suffix}`);
  for (const scope of ["assets:write", "assets:read", "sources:write"]) {
    await page.getByRole("checkbox", { name: scope, exact: true }).check();
  }
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  const reveal = page.locator(".token-reveal code");
  await expect(reveal).toBeVisible();
  const token = (await reveal.textContent()) ?? "";
  expect(token).toMatch(/^vls_/);
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
  const saved = await client.saveArchive(snapshot, {
    tags: ["chrome-capture", suffix],
  });
  const highlight = await client.saveHighlight(selection, {
    tags: ["chrome-capture", suffix],
  });
  // The snapshot is both a document and the saved page that keeps it; each
  // has its own Library tab.
  await page.goto(`${baseURL}/library?view=documents`);
  const original = page.locator(".library-item", {
    has: page.locator(`input[name="id"][value="${saved.assetId}"]`),
  });
  await expect(
    original.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  await expect(original.locator(".library-organization .tag")).toHaveText([
    "chrome-capture",
    suffix,
  ]);
  await original
    .getByRole("link", { name: `Preview ${title}`, exact: true })
    .click();
  await expect(page.getByRole("dialog").locator("pre")).toContainText(
    "<h1>Rendered wren article</h1>",
  );
  await expect(page.getByRole("dialog").locator("iframe")).toHaveCount(0);
  const download = page
    .getByRole("dialog")
    .getByRole("link", { name: "Download" });
  const response = await page.request.get(
    (await download.getAttribute("href")) as string,
  );
  expect(response.headers()["content-disposition"]).toMatch(/^attachment;/);
  expect(response.headers()["content-type"]).toBe("application/octet-stream");
  expect(await response.text()).toBe(snapshot.html);
  await page.keyboard.press("Escape");
  // Let the preview finish closing before switching tabs.
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await showView(page, "Bookmarks");
  const pageCard = page.locator(".library-item", {
    has: page.getByRole("heading", { name: title, exact: true }),
  });
  await expect(pageCard).toHaveCount(1);
  await expect(pageCard.locator(".library-organization .tag")).toHaveText([
    "chrome-capture",
    suffix,
  ]);
  const highlightCard = page.locator(".library-item", {
    has: page.getByRole("heading", {
      name: `${title} — Highlight`,
      exact: true,
    }),
  });
  await expect(highlightCard).toHaveCount(1);
  // The collapsed card shows its tags; open details move them into the tag
  // editor, so check them before expanding, not in a race with it.
  await expect(highlightCard.locator(".library-organization .tag")).toHaveText([
    "chrome-capture",
    suffix,
  ]);
  await itemDetails(highlightCard);
  await expect(highlightCard).toContainText(selection.quote);
  // The open pane's byline names the page's host and links to the page.
  await expect(
    highlightCard.getByRole("link", {
      name: new URL(selection.url).host,
      exact: true,
    }),
  ).toHaveAttribute("href", selection.url);
  expect(highlight.sourceId).toMatch(/^source:src_/);
});
