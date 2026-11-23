#!/usr/bin/env node
/**
 * Screenshot the loaded Chrome extension's popup against a running dev
 * server: a page not saved yet, then the same page once archived with a note, then its
 * To-do side filled in and once added, each in the light and the dark theme,
 * then the archived page in the archive viewer. The popup is a real action
 * popup at its real size, opened through CDP as test/ui/fixtures/extension.ts
 * does.
 *
 *   npm run dev
 *   node scripts/extension-shots.mjs
 *
 * VALISE_DEV_ORIGIN, VALISE_ADMIN_PASSWORD, and VALISE_SHOTS_DIR override the
 * defaults.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { DEV_ORIGIN } from "./dev-lever.mjs";

const out = process.env.VALISE_SHOTS_DIR ?? ".context/evidence/extension-popup";
const password =
  process.env.VALISE_ADMIN_PASSWORD ?? "local-development-password-01";
const dir = mkdtempSync(join(tmpdir(), "valise-extension-"));
mkdirSync(out, { recursive: true });

const debugPort = await new Promise((done) => {
  const server = createServer().listen(0, () => {
    const { port } = server.address();
    server.close(() => done(port));
  });
});
execFileSync(process.execPath, ["clients/chrome-extension/build.mjs", dir]);
const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: true,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [
    "--enable-unsafe-extension-debugging",
    `--remote-debugging-port=${debugPort}`,
  ],
});
const cdp = await context.browser().newBrowserCDPSession();
const { id } = await cdp.send("Extensions.loadUnpacked", { path: dir });

async function openPopup(tab) {
  await tab.bringToFront();
  const { targetInfos } = await cdp.send("Target.getTargets", {
    filter: [{ type: "tab" }],
  });
  const target = targetInfos.find((info) => info.url === tab.url());
  await cdp.send("Extensions.triggerAction", { id, targetId: target.targetId });
  for (let tries = 0; tries < 50; tries++) {
    const attached = await chromium.connectOverCDP(
      `http://localhost:${debugPort}`,
    );
    const popup = attached
      .contexts()[0]
      .pages()
      .find((page) => page.url().endsWith("/popup.html"));
    if (popup) return popup;
    await new Promise((wait) => setTimeout(wait, 100));
  }
  throw new Error("The popup did not open.");
}

try {
  const host = new URL(DEV_ORIGIN);
  const consolePage = await context.newPage();
  await consolePage.goto(`${DEV_ORIGIN}/login?next=/connections`);
  await consolePage.getByLabel("Administrator password").fill(password);
  await consolePage
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await consolePage
    .getByLabel("Label", { exact: true })
    .fill(`Extension shots ${Date.now()}`);
  for (const scope of [
    "assets:write",
    "assets:read",
    "sources:write",
    "todos:write",
  ])
    await consolePage
      .getByRole("checkbox", { name: scope, exact: true })
      .check();
  await consolePage
    .getByRole("button", { name: "Create token", exact: true })
    .click();
  const token = await consolePage.locator(".token-reveal code").textContent();

  const management = await context.newPage();
  await management.goto("chrome://extensions");
  await management.evaluate(
    ({ id, origin }) =>
      chrome.developerPrivate.addHostPermission(id, `${origin}/*`),
    { id, origin: `${host.protocol}//${host.hostname}` },
  );
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${id}/settings.html`);
  await settings.evaluate(
    (origin) => chrome.permissions.request({ origins: [`${origin}/*`] }),
    `${host.protocol}//${host.hostname}`,
  );
  await settings
    .getByText("Advanced: self-hosted Valise or a pasted token")
    .click();
  await settings.locator("#endpoint").fill(`${DEV_ORIGIN}/mcp`);
  await settings.locator("#token").fill(token);
  await settings
    .getByRole("button", { name: "Save token", exact: true })
    .click();
  await settings.locator("#status").getByText("Token saved.").waitFor();

  // A fresh URL each run, so the first popup always shows a page not saved.
  const story = `/stories/wrenmouth-${Date.now()}`;
  // The article fixture with a site stylesheet and a banner image, so the
  // archived copy shows whether its CSS and images came along.
  const html = readFileSync("test/ui/fixtures/article-capture.html", "utf8")
    .replace(
      "</head>",
      '<link rel="stylesheet" href="/assets/site.css"></head>',
    )
    .replace("<h1", '<img class="banner" src="/assets/banner.png" alt=""><h1');
  const css = `body { max-width: 42rem; margin: 2rem auto; font: 17px/1.6 Georgia, serif; color: #2b2118; background: #f6efe3; }
nav a { color: #7a3b12; margin-right: 1rem; }
h1 { font: 700 2.2rem/1.15 "Helvetica Neue", Arial, sans-serif; color: #1d3557; }
.banner { display: block; width: 100%; height: 120px; object-fit: cover; border-radius: 6px; }
header { border-bottom: 4px solid #1d3557; background: url("stripe.png") repeat-x bottom; }`;
  // One opaque pixel, stretched by the stylesheet.
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await context.route("https://capture.example.org/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/assets/site.css")
      return route.fulfill({ contentType: "text/css", body: css });
    if (path.endsWith(".png"))
      return route.fulfill({ contentType: "image/png", body: pixel });
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: html,
    });
  });
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`https://capture.example.org${story}`);

  async function themes(popup, name) {
    for (const scheme of ["light", "dark"]) {
      await popup.emulateMedia({ colorScheme: scheme });
      await popup.screenshot({ path: `${out}/${name}-${scheme}.png` });
    }
    const [width, height, content] = await popup.evaluate(() => [
      window.innerWidth,
      window.innerHeight,
      document.documentElement.scrollHeight,
    ]);
    console.log(
      `${name}: popup ${width}x${height}px, content ${content}px tall`,
    );
  }

  async function shoot(name) {
    const popup = await openPopup(page);
    await popup.locator("#capture[aria-busy=false]").waitFor();
    await themes(popup, name);
    return popup;
  }

  const unsaved = await shoot("unsaved");
  // The saved shots then show Note open, filled from what Valise holds.
  await unsaved.getByRole("button", { name: "Note", exact: true }).click();
  await themes(unsaved, "note-open");
  await unsaved
    .getByRole("textbox", { name: "Note" })
    .fill("Compare with the ferry timetable before booking.");
  await unsaved.getByRole("button", { name: "Archive full page" }).click();
  await unsaved.locator("#status").getByText("Archived").waitFor({
    timeout: 60_000,
  });
  await unsaved.close();
  const saved = await shoot("saved");
  await saved.getByText("To-do", { exact: true }).click();
  await saved
    .getByLabel("Description")
    .fill("Book the harbour tour for the first weekend of December.");
  await saved.getByLabel("Project (required)").fill("errands");
  await saved.getByLabel("Tag", { exact: true }).fill("travel");
  await saved.getByLabel("Tag", { exact: true }).press("Enter");
  await themes(saved, "todo-form");
  await saved.getByRole("button", { name: "Add to-do" }).click();
  await saved.locator("#todo-added").waitFor();
  await themes(saved, "todo-added");
  const archive = await saved.locator("#archive-link").getAttribute("href");
  await consolePage.goto(archive);
  await consolePage.waitForLoadState("networkidle");
  await consolePage.screenshot({ path: `${out}/archive-viewer.png` });
  console.log(`Archive viewer at ${new URL(consolePage.url()).pathname}`);
  console.log(`Screenshots in ${out}`);
} finally {
  await context.close();
}
