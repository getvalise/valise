#!/usr/bin/env node
/**
 * Screenshot every console route against a running dev server, at desktop and
 * at phone width. This is the lever behind V1-10's live lane: a reviewer reruns
 * it rather than taking a screenshot's word for it.
 *
 *   npm run dev
 *   node scripts/console-shots.mjs
 *
 * VALISE_DEV_ORIGIN, VALISE_ADMIN_PASSWORD, and VALISE_SHOTS_DIR override the
 * defaults.
 */
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { DEV_ORIGIN } from "./dev-lever.mjs";

const out = process.env.VALISE_SHOTS_DIR ?? ".context/evidence/v1-10-console";
const password =
  process.env.VALISE_ADMIN_PASSWORD ?? "local-development-password-01";

const PAGES = [
  ["02-todos", "/todos"],
  ["03-memories", "/memories"],
  ["04-skills", "/skills"],
  ["05-connections", "/connections"],
  ["06-workbench-components", "/workbench?tab=components"],
  ["07-workbench-logs", "/workbench?tab=logs&window=720"],
  ["08-workbench-evals", "/workbench?tab=evals"],
];

mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
});
const page = await context.newPage();

await page.goto(`${DEV_ORIGIN}/login?next=/todos`);
await page.screenshot({ path: `${out}/01-login.png`, fullPage: true });
await page.getByLabel("Administrator password").fill(password);
await page.getByRole("button", { name: "Sign in" }).click();
// Wait on the page, not the URL: a failed sign-in lands on
// /login?next=/todos, which also ends in /todos, and the run would go on to
// screenshot the login form.
await page.waitForSelector("h1:text('To-dos')", { timeout: 10_000 });

for (const [name, path] of PAGES) {
  await page.goto(`${DEV_ORIGIN}${path}`);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
}

// Two states of the components tab rather than two more routes. A modal and
// an open listbox are the only parts of the system a static capture misses,
// and they are exactly what that tab exists to show.
await page.goto(`${DEV_ORIGIN}/workbench?tab=components`);
await page.getByRole("button", { name: "Open modal" }).click();
await page.waitForSelector("dialog.modal[open]");
await page.screenshot({ path: `${out}/06a-components-modal.png` });
await page.keyboard.press("Escape");

const combobox = page.getByRole("combobox", { name: "Model" });
await combobox.click();
await combobox.fill("claude");
await page.waitForSelector(".combobox-list");
await page.screenshot({ path: `${out}/06b-components-combobox.png` });

// The logs tab with a call open in the pane, by the URL the row links to. An
// empty log has no row to open, so the shot is skipped rather than faked.
await page.goto(`${DEV_ORIGIN}/workbench?tab=logs&window=720`);
const callHref = await page
  .locator(".call-row")
  .first()
  .getAttribute("href", { timeout: 2_000 })
  .catch(() => null);
let shots = PAGES.length + 7;
if (callHref) {
  await page.goto(`${DEV_ORIGIN}${callHref}`);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${out}/07a-workbench-logs-call.png` });
  shots += 1;
}

// Resize the signed-in page rather than opening a second one: a new page in
// this context does not carry the session.
await page.setViewportSize({ width: 390, height: 844 });
for (const [name, path] of [
  ["10-todos-390", "/todos"],
  ["11-connections-390", "/connections"],
  ["12-workbench-logs-390", "/workbench?tab=logs&window=720"],
  ["13-workbench-components-390", "/workbench?tab=components"],
]) {
  await page.goto(`${DEV_ORIGIN}${path}`);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
}
if (callHref) {
  await page.goto(`${DEV_ORIGIN}${callHref}`);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${out}/12a-workbench-logs-call-390.png` });
  shots += 1;
}

await browser.close();
process.stdout.write(`${shots} screenshots in ${out}\n`);
