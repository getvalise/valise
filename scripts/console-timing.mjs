#!/usr/bin/env node
/**
 * Time click-to-edit, Save and Cancel on /todos against a running dev server,
 * with a realistic list: 40 to-dos in project `timing`, each with a body, a
 * tag and four comments. The rows are filed once and reused on later runs.
 *
 *   npm run dev
 *   node scripts/console-timing.mjs
 *
 * Each figure is the median of RUNS tries, from the click to the first frame
 * that shows the result, measured inside the page with requestAnimationFrame.
 * It also counts the `.data` requests each step sent and how long they took,
 * which is the loader round trip a click waits on when it revalidates.
 *
 * VALISE_DEV_ORIGIN and VALISE_ADMIN_PASSWORD override the defaults.
 */
import { chromium } from "@playwright/test";
import { DEV_ORIGIN } from "./dev-lever.mjs";

const password =
  process.env.VALISE_ADMIN_PASSWORD ?? "local-playwright-password-0001";
const ROWS = 40;
const RUNS = 7;

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
});
const page = await context.newPage();

await page.goto(`${DEV_ORIGIN}/login?next=/todos`);
await page.getByLabel("Administrator password").fill(password);
await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForSelector("h1:text('To-dos')", { timeout: 10_000 });

const post = (fields) =>
  page.request.post(`${DEV_ORIGIN}/todos`, {
    form: fields,
    headers: { origin: DEV_ORIGIN },
    maxRedirects: 0,
  });

const list = `${DEV_ORIGIN}/todos?project=timing`;
await page.goto(list);
let ids = await rowIds();
for (let n = ids.length; n < ROWS; n++) {
  await post({
    intent: "create",
    text: `Timing row ${n} project:timing #perf`,
  });
}
if (ids.length < ROWS) {
  await page.goto(list);
  ids = await rowIds();
  for (const id of ids) {
    await post({
      intent: "edit-field",
      id,
      field: "body",
      value: "What done looks like.\n\n- [ ] first step\n- [ ] second step",
    });
    for (let c = 0; c < 4; c++) {
      await post({ intent: "comment", id, body: `Context number ${c}.` });
    }
  }
}

await page.goto(list);
await page.waitForFunction(
  `Object.keys(document.body).some((key) => key.startsWith("__reactProps$"))`,
);
console.log(`/todos?project=timing with ${ids.length} rows, ${RUNS} runs each`);

const row = 9;
const results = { open: [], cancel: [], save: [] };
for (let run = 0; run < RUNS; run++) {
  results.open.push(await step(openTitle));
  results.cancel.push(await step(cancelTitle));
  await step(openTitle);
  results.save.push(await step(saveTitle, `Timing row 9, run ${run}`));
}

for (const [name, samples] of Object.entries(results)) {
  const paint = median(samples.map((s) => s.paint));
  const requests = median(samples.map((s) => s.requests));
  const server = median(samples.map((s) => s.server));
  console.log(
    `${name.padEnd(6)} paint ${String(Math.round(paint)).padStart(4)}ms · ${requests} .data request(s), ${Math.round(server)}ms on the wire`,
  );
}

await browser.close();

async function rowIds() {
  return page
    .locator(".todo-card form.todo-check input[name=id]")
    .evaluateAll((inputs) => inputs.map((input) => input.value));
}

/** Run one in-page step and the `.data` traffic it caused. */
async function step(fn, arg) {
  await page.evaluate("performance.clearResourceTimings()");
  const paint = await page.evaluate(fn, { row, arg });
  // Let the write and the revalidation after it land before reading the
  // resource timings. The page is already loaded, so waiting for
  // "networkidle" would return at once.
  await page.waitForTimeout(750);
  const data = await page.evaluate(
    `performance.getEntriesByType("resource").filter((e) => new URL(e.name).pathname.endsWith(".data")).map((e) => e.duration)`,
  );
  return {
    paint,
    requests: data.length,
    server: data.reduce((a, b) => a + b, 0),
  };
}

// The three steps run inside the page, so the clock is the browser's own.
// Strings rather than closures over DOM types: this repo compiles without the
// DOM lib, and these are passed to evaluate as functions anyway.

function openTitle({ row }) {
  const card = document.querySelectorAll(".todo-card")[row];
  const start = performance.now();
  card.querySelector(".todo-title-edit").click();
  return until(
    () => card.querySelector(".editable-form input[name=value]"),
    start,
  );

  function until(done, from) {
    return new Promise((resolve) => {
      const tick = () =>
        done() || performance.now() - from > 10_000
          ? resolve(performance.now() - from)
          : requestAnimationFrame(tick);
      tick();
    });
  }
}

function cancelTitle({ row }) {
  const card = document.querySelectorAll(".todo-card")[row];
  const start = performance.now();
  card.querySelector(".editable-form .cancel").click();
  return until(
    () => !card.querySelector(".editable-form input[name=value]"),
    start,
  );

  function until(done, from) {
    return new Promise((resolve) => {
      const tick = () =>
        done() || performance.now() - from > 10_000
          ? resolve(performance.now() - from)
          : requestAnimationFrame(tick);
      tick();
    });
  }
}

function saveTitle({ row, arg }) {
  const card = document.querySelectorAll(".todo-card")[row];
  const input = card.querySelector(".editable-form input[name=value]");
  // React tracks the value it last set, so the native setter is what makes
  // the change visible to its onChange.
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  ).set;
  setter.call(input, arg);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  const start = performance.now();
  card.querySelector(".editable-form button[type=submit]").click();
  return until(
    () =>
      !card.querySelector(".editable-form input[name=value]") &&
      card.querySelector(".todo-title-edit")?.textContent === arg,
    start,
  );

  function until(done, from) {
    return new Promise((resolve) => {
      const tick = () =>
        done() || performance.now() - from > 10_000
          ? resolve(performance.now() - from)
          : requestAnimationFrame(tick);
      tick();
    });
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
