import { IOS_SHORTCUT_LINK } from "../../app/concepts/ios-shortcuts";
import { expect, goto, test } from "./fixtures/session";

/**
 * Connections hands out an iPhone capture URL, and that URL saves. The
 * clipboard write is stubbed, and the POST is Playwright's, not Shortcuts':
 * this is evidence about the page and the endpoint, not about iOS.
 */

const article = (run: string) =>
  Array.from({ length: 200 }, (_, at) => `capture${run}word${at}`).join(" ");

for (const width of [390, 1280]) {
  test(`creates, copies, uses and revokes a capture URL at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      const copied: string[] = [];
      Object.defineProperty(globalThis, "__copied", { value: copied });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (text: string) => {
            copied.push(text);
            return Promise.resolve();
          },
        },
      });
    });
    await goto(page, "/connections");
    await expect(page.getByText("iPhone share sheet")).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`connections-${width}.png`),
      fullPage: true,
    });

    await page.getByRole("button", { name: "Create capture URL" }).click();
    const reveal = page.getByRole("region", { name: "Capture URL" });
    await expect(reveal.getByText("Shown once")).toBeVisible();
    const captureUrl = (await reveal.locator("code").textContent()) ?? "";
    expect(captureUrl).toMatch(/^http:\/\/[^/]+\/capture#vls_[\w-]{43}$/);
    await reveal.getByRole("button", { name: "Copy" }).click();
    await expect(reveal.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate("globalThis.__copied")).toEqual([captureUrl]);
    if (IOS_SHORTCUT_LINK)
      await expect(
        reveal.getByRole("link", { name: "Add Shortcut" }),
      ).toHaveAttribute("href", IOS_SHORTCUT_LINK);
    else
      await expect(
        reveal.getByText("This install offers no Capture Shortcut link"),
      ).toBeVisible();
    await expect(
      reveal.getByText(
        "When the Shortcut asks for your capture URL, paste what you just copied.",
      ),
    ).toBeVisible();
    expect(
      await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`capture-url-${width}.png`),
      fullPage: true,
    });

    // What the Shortcut does: the URL without its fragment, the fragment as
    // the bearer token.
    const [endpoint, token] = captureUrl.split("#");
    const run = crypto.randomUUID().slice(0, 8);
    const saved = await page.request.post(endpoint, {
      headers: { authorization: `Bearer ${token}` },
      data: {
        url: `https://news.example/gated/${run}`,
        title: `Captured ${run}`,
        text: article(run),
      },
    });
    expect(saved.status()).toBe(200);
    expect(await saved.json()).toMatchObject({
      article: true,
      message: `Saved "Captured ${run}" with the article, 200 words.`,
    });
    await goto(page, `/library?q=${encodeURIComponent(`Captured ${run}`)}`);
    await expect(page.getByText(`Captured ${run}`).first()).toBeVisible();

    // Cards carry no token id, and other tests on this worker mint the same
    // label, so revoke every active one.
    await goto(page, "/connections");
    const active = page
      .locator(".todo-card")
      .filter({ hasText: "iPhone Shortcut" })
      .filter({ hasText: "active" });
    await expect(active.first().getByText("sources:write")).toBeVisible();
    while ((await active.count()) > 0) {
      const before = await active.count();
      await active
        .first()
        .getByRole("button", { name: "Revoke token" })
        .click();
      await expect(active).toHaveCount(before - 1);
    }
    const refused = await page.request.post(endpoint, {
      headers: { authorization: `Bearer ${token}` },
      data: { url: `https://news.example/after/${run}` },
    });
    expect(refused.status()).toBe(401);
  });
}

test("creates a capture URL with scripting off", async ({
  browser,
  baseURL,
  storageState,
}) => {
  const context = await browser.newContext({
    baseURL,
    javaScriptEnabled: false,
    storageState,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await goto(page, "/connections", false);
  await page.getByRole("button", { name: "Create capture URL" }).click();
  const reveal = page.getByRole("region", { name: "Capture URL" });
  await expect(reveal.locator("code")).toHaveText(/\/capture#vls_/);
  await expect(reveal.getByRole("button", { name: "Copy" })).toHaveCount(0);
  await context.close();
});
