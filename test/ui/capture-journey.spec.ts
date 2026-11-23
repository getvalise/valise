import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { launchExtension } from "./fixtures/extension";
import { freePort } from "./fixtures/server";
import { expect, password, test } from "./fixtures/session";

/**
 * J1 capture journey, docs/testing/user-journeys.md: open an article, see it
 * found and tinted on the page before saving, save the article or archive the
 * page, label it after the save, see the page as saved when the popup opens
 * again, find it in Library and read it in the reader view. Failure
 * states: not connected, a page Chrome forbids, Chrome's own pages, and pages
 * with no article (a paywall teaser, a tiny page). The loaded extension runs
 * against the local Worker; pages are routed fixtures, so the run repeats.
 */

// Setup handles a token. Capture only explicit, post-setup screenshots.
test.use({ trace: "off", screenshot: "off" });

const fixture = new URL("./fixtures/article-capture.html", import.meta.url);
const highlighted = (page: Page) =>
  page.evaluate(() =>
    (
      globalThis as unknown as { CSS: { highlights: Map<string, unknown> } }
    ).CSS.highlights.has("valise-article"),
  );

/**
 * Signs into the console, creates a capture-scoped token and pastes it into
 * the extension's Settings against the local Worker. Returns the console tab.
 */
async function connectWithToken(
  { context, id, grantHost }: Awaited<ReturnType<typeof launchExtension>>,
  baseURL: string,
  suffix: string,
) {
  const consolePage = await context.newPage();
  await consolePage.goto(`${baseURL}/login?next=/connections`);
  await consolePage.getByLabel("Administrator password").fill(password);
  await consolePage
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await consolePage.getByLabel("Label", { exact: true }).fill(`J1 ${suffix}`);
  for (const scope of ["assets:write", "assets:read", "sources:write"])
    await consolePage
      .getByRole("checkbox", { name: scope, exact: true })
      .check();
  await consolePage
    .getByRole("button", { name: "Create token", exact: true })
    .click();
  const token =
    (await consolePage.locator(".token-reveal code").textContent()) ?? "";
  await grantHost();
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${id}/settings.html`);
  await settings
    .getByText("Advanced: self-hosted Valise or a pasted token")
    .click();
  await settings.locator("#endpoint").fill(`${baseURL}/mcp`);
  await settings.locator("#token").fill(token);
  await settings
    .getByRole("button", { name: "Save token", exact: true })
    .click();
  await expect(settings.locator("#status")).toHaveText("Token saved.");
  await expect(settings.locator("#connected-how")).toHaveText("Pasted token");
  await settings.close();
  return consolePage;
}

test("J1 capture: see the article before saving, save it or archive the page, label it after, and read it in Library", async ({
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000);
  const extension = await launchExtension(testInfo.outputPath("extension"));
  const { context, openPopup } = extension;
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
  // Save must be reachable without scrolling the popup.
  const inView = async (popup: Page, name: string) => {
    const box = await popup.getByRole("button", { name }).boundingBox();
    const height = (await popup.evaluate("window.innerHeight")) as number;
    expect(box && box.y + box.height).toBeLessThanOrEqual(height);
  };
  try {
    const suffix = Math.random().toString(36).slice(2, 10);
    const story = `Wrenmouth harbour ${suffix}`;
    const project = `coast-${suffix}`;
    const html = (await readFile(fixture, "utf8")).replace(
      "<title>The engineer who measured Wrenmouth harbour | Coastal Notes</title>",
      `<title>${story}</title>`,
    );
    await context.route("https://capture.example.org/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      const body =
        path === "/stories/wrenmouth"
          ? html
          : path === "/stories/wrenmouth-again"
            ? html.replace(
                `<title>${story}</title>`,
                `<title>${story} again</title>`,
              )
            : path === "/premium"
              ? `<!doctype html><html><head><title>Premium story</title></head><body><article><h1>The harbour accounts</h1><p>${"The council's books for 1852 show three payments to the harbour board that nobody has explained. ".repeat(4)}</p><div class="paywall"><p>Subscribe to keep reading.</p><button>Subscribe</button></div></article></body></html>`
              : `<!doctype html><html><head><title>Tiny page</title></head><body><p>Back soon.</p></body></html>`;
      return route.fulfill({ contentType: "text/html; charset=utf-8", body });
    });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("https://capture.example.org/stories/wrenmouth");

    // Not connected: only the sign-in prompt.
    const fresh = await openPopup(page);
    await expect(fresh.locator("#status")).toHaveText("Not connected.");
    await expect(fresh.locator("#capture")).toBeHidden();
    await shot(fresh, "not-connected");
    await fresh.close();

    const consolePage = await connectWithToken(extension, baseURL!, suffix);

    // Open the popup on the article: it says what it found before any save,
    // and tints the article on the page without changing the page.
    const before = await page.evaluate("document.documentElement.outerHTML");
    const popup = await openPopup(page);
    await expect(popup.locator("#capture")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    await expect(popup.locator("#page-title")).toHaveText(story);
    await expect(popup.locator("#page-host")).toHaveText("capture.example.org");
    await expect(popup.locator("#not-saved")).toHaveText("Not saved");
    await expect(popup.locator("#saved")).toBeHidden();
    await expect(popup.locator("#article-byline")).toHaveText(
      /^By Mara Lindqvist and Tomas Oyelaran · Coastal Notes · 14 Sept 2026 · \d{3} words$/,
    );
    await expect(popup.locator("#article-excerpt")).toContainText(
      "The harbour at Wrenmouth was dredged",
    );
    await expect(popup.locator("#no-article")).toBeHidden();
    // With an article, the primary saves it on a bookmark; archiving the
    // whole page is the secondary, left of it.
    const save = popup.getByRole("button", {
      name: "Save article",
      exact: true,
    });
    const archive = popup.getByRole("button", {
      name: "Archive full page",
      exact: true,
    });
    await expect(save).toBeEnabled();
    await expect(archive).toBeEnabled();
    await expect(save).not.toHaveClass(/ghost/);
    await expect(archive).toHaveClass(/ghost/);
    expect((await archive.boundingBox())!.x).toBeLessThan(
      (await save.boundingBox())!.x,
    );
    await expect(popup.getByRole("checkbox")).toHaveCount(0);
    await expect(popup.locator("#selection")).toBeHidden();
    await expect.poll(() => highlighted(page)).toBe(true);
    expect(await page.evaluate("document.documentElement.outerHTML")).toBe(
      before,
    );
    // The popup at its real size, with the tinted page behind it.
    expect(
      await popup.evaluate("document.documentElement.scrollWidth"),
    ).toBeLessThanOrEqual(await popup.evaluate("window.innerWidth"));
    await inView(popup, "Save article");
    await shot(popup, "popup-article-found");
    await shot(page, "page-tinted");

    await popup.locator("#tag").fill(suffix);
    await save.click();
    await expect(popup.locator("#status")).toHaveText(
      /^Saved article \(\d{3} words, by Mara Lindqvist and Tomas Oyelaran\)\.$/,
      { timeout: 20_000 },
    );
    await expect(popup.locator("#error")).toBeHidden();
    // The saved state links the reader, at the endpoint, and no archive.
    await expect(popup.locator("#saved-link")).toHaveText(/^Saved \d/);
    await expect(popup.locator("#saved-link")).toHaveAttribute(
      "href",
      new RegExp(`^${baseURL}/library/read/src_[0-9a-f-]{36}$`),
    );
    await expect(popup.locator("#archive-link")).toBeHidden();
    await expect(popup.locator("#not-saved")).toBeHidden();
    // A second click cannot save the page twice.
    await expect(save).toBeDisabled();
    await expect(archive).toBeDisabled();

    // Labels stay editable after the save. A tag picked through the
    // combobox by keyboard revises the saved source as revision 2.
    const tagBox = popup.getByRole("combobox", { name: "Tag", exact: true });
    const later = `${suffix}-later`;
    const tagWrite = popup.waitForRequest(
      (request) =>
        request.url() === `${baseURL}/mcp` &&
        (request.postData() ?? "").includes('"expected_revision"'),
    );
    await tagBox.pressSequentially(later);
    await tagBox.press("ArrowDown");
    await tagBox.press("Enter");
    const written = await tagWrite;
    expect(JSON.parse(written.postData()!).params.arguments).toMatchObject({
      expected_revision: 1,
      tags: [suffix, later],
    });
    expect(await (await written.response())!.text()).toContain('"revision":2');
    await expect(popup.locator("#status")).toHaveText("Tags saved.");
    await expect(popup.locator("#tags")).toContainText(later);
    await expect(tagBox).toHaveValue("");
    // The project write needs the revision the tag write returned; a stale
    // one would be refused.
    const projectBox = popup.getByRole("combobox", {
      name: "Project",
      exact: true,
    });
    await projectBox.fill(project);
    await projectBox.press("Enter");
    await expect(popup.locator("#status")).toHaveText("Project saved.");
    await expect(popup.locator("#error")).toBeHidden();
    await shot(popup, "popup-saved-labelled");
    await popup.close();
    // Closing the popup clears the tint.
    await expect.poll(() => highlighted(page)).toBe(false);

    // Opened again, the popup says the page is saved, from Valise.
    const reopened = await openPopup(page);
    await expect(reopened.locator("#capture")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    await expect(reopened.locator("#saved-link")).toHaveText(/^Saved \d/);
    await expect(
      reopened.getByRole("link", { name: "Open archived page" }),
    ).toBeHidden();
    await expect(
      reopened.getByRole("button", { name: "Archive full page", exact: true }),
    ).toBeEnabled();
    // Focus opens the owner's tags; typing filters them; a click picks one.
    const offered = reopened.getByRole("listbox", { name: "Your tags" });
    const reopenedTag = reopened.getByRole("combobox", {
      name: "Tag",
      exact: true,
    });
    await reopenedTag.focus();
    await expect(offered).toBeVisible();
    await expect(reopenedTag).toHaveAttribute("aria-expanded", "true");
    expect(await offered.getByRole("option").count()).toBeLessThanOrEqual(8);
    await reopenedTag.fill(suffix);
    await expect(
      offered.getByRole("option", { name: suffix, exact: true }),
    ).toBeVisible();
    await shot(reopened, "popup-tag-offered");
    await offered.getByRole("option", { name: suffix, exact: true }).click();
    await expect(reopened.locator("#tags")).toContainText(suffix);
    await expect(reopenedTag).toHaveValue("");
    await reopenedTag.fill(suffix);
    await expect(
      offered.getByRole("option", { name: suffix, exact: true }),
    ).toHaveCount(0);
    await shot(reopened, "popup-already-saved");
    await reopened.close();

    // The archive: the secondary keeps the whole page and its article.
    await page.goto("https://capture.example.org/stories/wrenmouth-again");
    const again = await openPopup(page);
    await expect(again.locator("#capture")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    // The tag is offered now, so its list opens over the save row until
    // Enter adds it.
    await again.locator("#tag").fill(suffix);
    await again.locator("#tag").press("Enter");
    await expect(again.locator("#tags")).toContainText(suffix);
    await again
      .getByRole("button", { name: "Archive full page", exact: true })
      .click();
    await expect(again.locator("#status")).toContainText(
      /^Saved article \(\d{3} words, by Mara Lindqvist and Tomas Oyelaran\) and archived the page/,
      { timeout: 20_000 },
    );
    await expect(again.locator("#archive-link")).toHaveAttribute(
      "href",
      new RegExp(`^${baseURL}/library/archive/ast_[0-9a-f-]{36}$`),
    );
    await expect(
      again.getByRole("button", { name: "Archive again", exact: true }),
    ).toBeDisabled();
    await shot(again, "popup-saved-archive");
    await again.close();

    // No article: a paywall teaser and a tiny page make the bookmark the
    // primary, and the tiny one saves as one.
    for (const [path, name] of [
      ["/premium", "paywalled"],
      ["/tiny", "tiny"],
    ]) {
      await page.goto(`https://capture.example.org${path}`);
      const none = await openPopup(page);
      await expect(none.locator("#capture")).toHaveAttribute(
        "aria-busy",
        "false",
      );
      await expect(none.locator("#no-article")).toHaveText(
        "No article on this page",
      );
      await expect(none.locator("#article-excerpt")).toBeHidden();
      const bookmark = none.getByRole("button", {
        name: "Save bookmark",
        exact: true,
      });
      await expect(bookmark).toBeEnabled();
      await expect(
        none.getByRole("button", { name: "Archive full page", exact: true }),
      ).toBeEnabled();
      expect(await highlighted(page)).toBe(false);
      await inView(none, "Save bookmark");
      await shot(none, `popup-no-article-${name}`);
      if (name === "tiny") {
        await bookmark.click();
        await expect(none.locator("#status")).toHaveText(
          "Saved the bookmark.",
          { timeout: 20_000 },
        );
        await expect(none.locator("#saved-link")).toBeVisible();
      }
      await none.close();
    }

    // Pages Chrome does not let an extension read. Chrome refuses scripts
    // on its error pages the way it refuses them on the Web Store, which
    // Playwright cannot open (the manual check covers it); a refused
    // connection gives a repeatable one at an http URL.
    for (const [url, message, name] of <[string, RegExp, string][]>[
      [
        `http://127.0.0.1:${await freePort()}/`,
        // Chrome lists an error page under its URL or chrome-error://, so
        // either refusal can be the one the popup meets.
        /Chrome does not let extensions read this page|Open a normal web page/,
        "error-page",
      ],
      ["chrome://version/", /^Open a normal web page to save it\./, "chrome"],
    ]) {
      const tab = await context.newPage();
      await tab.goto(url).catch(() => {});
      const blocked = await openPopup(tab, url);
      await expect(blocked.locator("#error")).toContainText(message);
      await expect(blocked.locator("#capture")).toBeHidden();
      await expect(blocked.locator("#status")).toHaveText(
        "Nothing can be saved from this page.",
      );
      await shot(blocked, `popup-blocked-${name}`);
      await blocked.close();
      await tab.close();
    }

    // Library: find the saved article and read it.
    for (const width of [1280, 320]) {
      await consolePage.setViewportSize({ width, height: 900 });
      await consolePage.goto(`${baseURL}/library?tag=${suffix}`);
      const card = consolePage.locator(".library-item").filter({
        has: consolePage.getByRole("heading", {
          name: `${story} again`,
          exact: true,
        }),
      });
      await expect(card.locator(".library-byline")).toContainText(
        "By Mara Lindqvist and Tomas Oyelaran · Coastal Notes · Published 14 Sept 2026 · Saved ",
      );
      await card.getByRole("link", { name: "Read the article" }).click();
      await expect(
        consolePage.getByRole("heading", {
          level: 2,
          name: `${story} again`,
        }),
      ).toBeVisible();
      const reader = consolePage.getByRole("article");
      await expect(
        reader.getByText(
          /^By Mara Lindqvist and Tomas Oyelaran · 14 Sept 2026 · \d{3} words$/,
        ),
      ).toBeVisible();
      await expect(reader.locator(".eyebrow")).toHaveText("Coastal Notes");
      await expect(
        reader.getByRole("link", { name: "Original page" }),
      ).toHaveAttribute(
        "href",
        "https://capture.example.org/stories/wrenmouth-again",
      );
      await expect(
        reader.getByRole("link", { name: "Open archived page" }),
      ).toHaveAttribute("href", /^\/library\/archive\/ast_[0-9a-f-]{36}$/);
      await expect(
        reader.getByRole("region", { name: "Article text" }),
      ).toContainText("Kettering measured before she acted");
      await expect(
        reader.getByRole("region", { name: "Article text" }),
      ).not.toContainText("Get the weekly newsletter");
      await expect(
        reader.getByRole("region", { name: "Article text" }).locator("img"),
      ).toHaveCount(0);
      expect(
        await consolePage.evaluate(
          "document.documentElement.scrollWidth <= window.innerWidth",
        ),
      ).toBe(true);
      await consolePage.screenshot({
        path: testInfo.outputPath(`reader-${width}.png`),
        fullPage: true,
      });
    }
    // The archive link opens the archived page in the archive viewer.
    await consolePage.getByRole("link", { name: "Open archived page" }).click();
    await expect(consolePage).toHaveURL(
      /\/archives\/[^/]+\/\d+\/[^/]+\/[^/]+\.html$/,
    );
    await expect(consolePage.locator("body")).toContainText(
      "Kettering measured before she acted",
    );

    // The bookmark carries the tag and project added after its save, and
    // alone in that project, reads the same way and says no archive exists.
    await consolePage.goto(`${baseURL}/library?tag=${later}`);
    await expect(
      consolePage.getByRole("heading", { name: story, exact: true }),
    ).toBeVisible();
    await consolePage.goto(`${baseURL}/library?project=${project}`);
    const inProject = consolePage.locator(".library-item");
    await expect(inProject).toHaveCount(1);
    await expect(
      inProject.getByRole("heading", { name: story, exact: true }),
    ).toBeVisible();
    await expect(inProject).toContainText(project);
    await inProject.getByRole("link", { name: "Read the article" }).click();
    const only = consolePage.getByRole("article");
    await expect(
      only.getByRole("link", { name: "Open archived page" }),
    ).toHaveCount(0);
    await expect(only.locator("footer")).toContainText(
      "No page archive was kept; this text is the saved copy.",
    );

    // An id that is not the owner's, or not an id, is a 404, not a blank page.
    for (const id of ["src_00000000-0000-4000-8000-000000000000", "nonsense"])
      expect(
        (await consolePage.goto(`${baseURL}/library/read/${id}`))?.status(),
      ).toBe(404);
  } finally {
    await context.close();
  }
});

// A 2×2 PNG: small enough to inline, large enough to have a natural size.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==",
  "base64",
);

test("J1 capture: the archive keeps the page's stylesheet and images in one folder and renders them", async ({
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000);
  const extension = await launchExtension(testInfo.outputPath("extension"));
  const { context, openPopup } = extension;
  try {
    const suffix = Math.random().toString(36).slice(2, 10);
    await context.route("https://styled.example.org/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/page")
        return route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><html><head><title>Styled ${suffix}</title><link rel="stylesheet" href="/assets/site.css"></head><body><div class="hero">Hero</div><p>${"A styled paragraph about the harbour wall. ".repeat(3)}</p><img id="photo" src="/assets/photo.png" alt="Photo"></body></html>`,
        });
      if (path === "/assets/site.css")
        return route.fulfill({
          contentType: "text/css",
          body: `.hero { width: 40px; height: 40px; background-image: url("hero.png"); }`,
        });
      if (path === "/assets/hero.png" || path === "/assets/photo.png")
        return route.fulfill({ contentType: "image/png", body: PNG });
      return route.fulfill({ status: 404, body: "" });
    });
    const consolePage = await connectWithToken(extension, baseURL!, suffix);
    const page = await context.newPage();
    await page.goto("https://styled.example.org/page");
    const popup = await openPopup(page);
    await expect(popup.locator("#capture")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    await popup.locator("#tag").fill(suffix);
    await popup
      .getByRole("button", { name: "Archive full page", exact: true })
      .click();
    // page.css, the background and the <img>.
    await expect(popup.locator("#status")).toHaveText(
      "Archived the page with 3 files.",
      { timeout: 20_000 },
    );
    const archive = await popup.locator("#archive-link").getAttribute("href");
    expect(archive).toMatch(/\/library\/archive\/ast_[0-9a-f-]{36}$/);
    await popup.close();

    // The folder holds the stylesheet and both images beside the HTML.
    await consolePage.goto(archive!);
    const viewer = new URL(consolePage.url());
    expect(viewer.pathname).toMatch(
      /^\/archives\/[^/]+\/\d+\/[^/]+\/[^/]+\.html$/,
    );
    const sibling = (name: string) => new URL(name, viewer).href;
    const css = await consolePage.request.get(sibling("page.css"));
    expect(css.status()).toBe(200);
    expect(css.headers()["content-type"]).toBe("text/css; charset=utf-8");
    expect(await css.text()).toContain('url("img-');
    for (const name of ["img-001.png", "img-002.png"]) {
      const image = await consolePage.request.get(sibling(name));
      expect(image.status()).toBe(200);
      expect(image.headers()["content-type"]).toBe("image/png");
    }

    await expect
      .poll(() =>
        consolePage.evaluate(
          `getComputedStyle(document.querySelector(".hero")).backgroundImage`,
        ),
      )
      .toMatch(/^url\(".*\/img-00\d\.png"\)$/);
    await expect
      .poll(() =>
        consolePage.evaluate(
          `document.querySelector("#photo").complete && document.querySelector("#photo").naturalWidth`,
        ),
      )
      .toBeGreaterThan(0);
    await consolePage.screenshot({
      path: testInfo.outputPath("archive-viewer.png"),
    });
  } finally {
    await context.close();
  }
});
