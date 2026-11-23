import type { Page } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import {
  isolateProcessing,
  pendingSuggestions,
} from "./fixtures/asset-processing";
import { addDocuments, itemDetails, showView } from "./fixtures/library";
import { expect, goto, signedOut, test } from "./fixtures/session";

async function original(page: Page, hydrated: boolean, standard = false) {
  await goto(page, "/library", hydrated);
  const upload = await addDocuments(page);
  const title = `Unsupported original ${crypto.randomUUID()}`;
  await upload.getByLabel(/^File, up to/).setInputFiles({
    name: standard ? "standard.pptx" : "legacy.ppt",
    mimeType: standard
      ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      : "application/vnd.ms-powerpoint",
    buffer: standard
      ? Buffer.from(
          zipSync({
            "ppt/slides/slide1.xml": strToU8(
              "<p:sld><a:p><a:t>Orchards conserve moisture through drip irrigation.</a:t></a:p></p:sld>",
            ),
          }),
        )
      : Buffer.from("untrusted legacy content"),
  });
  await upload.getByLabel("Title", { exact: true }).fill(title);
  await upload.getByRole("button", { name: "Upload", exact: true }).click();
  // Setup only: library.spec covers where an upload lands.
  await showView(page, "Documents");
  const card = page.locator(".library-item", {
    has: page.getByRole("heading", { name: title, exact: true }),
  });
  await expect(card).toBeVisible();
  const ref = await card.locator('input[name="id"]').first().inputValue();
  if (!ref?.startsWith("asset:")) throw new Error("asset reference missing");
  return { id: ref.slice(6), title };
}

test("processing failure is visible without changing the uploaded original", async ({
  page,
  request,
  playwright,
  baseURL,
}) => {
  const { id, title } = await original(page, true);
  await page.goto(`/library/${id}/process`);
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("status").first()).toContainText(
    "not available for this file type",
  );
  await expect(
    page.getByRole("button", { name: "Process file" }),
  ).toBeDisabled();
  // CSRF and authentication are enforced on the separate processing endpoint.
  const denied = await request.post(`/library/${id}/process`, {
    headers: { origin: "https://untrusted.invalid" },
    form: { intent: "process" },
  });
  // React Router rejects forwarded-origin attacks before the route's own
  // same-origin check (400); direct route CSRF refusals are 403.
  expect([400, 403]).toContain(denied.status());
  const oversized = await page.request.post(`/library/${id}/process`, {
    headers: {
      origin: new URL(page.url()).origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    data: `intent=process&padding=${"x".repeat(8192)}`,
  });
  expect(oversized.status()).toBe(413);
  const visitor = await playwright.request.newContext({
    baseURL,
    storageState: signedOut,
  });
  const anonymous = await visitor.get(`/library/${id}/process`, {
    maxRedirects: 0,
  });
  expect(anonymous.headers().location).toContain("/login");
  await visitor.dispose();
  await page.getByRole("link", { name: "Back to library" }).click();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
});

test("processing remains a native form with scripting off", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.setViewportSize({ width: 320, height: 800 });
  const { id } = await original(page, false);
  await page.goto(`/library/${id}/process`);
  await expect(
    page.getByRole("button", { name: "Process file", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("status").first()).toContainText(
    "not available for this file type",
  );
  await expect(
    page.getByRole("link", { name: "Download original" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      "document.documentElement.scrollWidth <= window.innerWidth",
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("library-processing-noscript-320.png"),
    fullPage: true,
  });
  await context.close();
});

test("a standard upload starts processing without a Process file click, preserving its title and download", async ({
  page,
  baseURL,
}) => {
  await isolateProcessing(baseURL!);
  await page.setViewportSize({ width: 390, height: 844 });
  const { id, title } = await original(page, true, true);
  const card = page.locator(".library-item", {
    has: page.getByRole("heading", { name: title, exact: true }),
  });
  await expect(card.getByRole("status").first()).toContainText(
    "Extracted content is searchable",
    { timeout: 20000 },
  );
  await expect(
    card.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  await itemDetails(card);
  const href = await card
    .getByRole("link", { name: "Download", exact: true })
    .getAttribute("href");
  const download = await page.request.get(href ?? "");
  expect(download.ok()).toBe(true);
  expect((await download.body()).byteLength).toBeGreaterThan(0);
  await page.goto(`/library/${id}/process`);
  await expect(
    page.getByRole("link", { name: "Download original" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      "document.documentElement.scrollWidth <= window.innerWidth",
    ),
  ).toBe(true);
});

test("late suggestions retain focus, review individual fields, and reject an old tab's value", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { id, title } = await original(page, true);
  const vocabulary = await page.request.post("/library", {
    headers: { origin: baseURL ?? "" },
    form: {
      intent: "source-create",
      kind: "reference",
      title: `Synthetic vocabulary ${id}`,
      notes: "Existing library label fixture.",
      tags: "synthetic-existing",
    },
  });
  expect(vocabulary.ok()).toBe(true);
  const publish = await pendingSuggestions(baseURL ?? "", id);
  await page.reload();
  const card = page.locator(".library-item", {
    has: page.locator(`input[name="id"][value="asset:${id}"]`),
  });
  await expect(card.getByRole("status").first()).toContainText("Queued");
  await itemDetails(card);
  const download = card.getByRole("link", { name: "Download", exact: true });
  await download.focus();
  await publish();
  const review = card.getByRole("link", {
    name: "Review suggestions",
    exact: true,
  });
  await expect(review).toBeVisible({ timeout: 15000 });
  await expect(download).toBeFocused();
  // The details pane is open beside the list; nothing modal took focus.
  await expect(page.locator("dialog:modal")).toHaveCount(0);
  // The row's own title; the open pane repeats it as its heading.
  await expect(
    card.getByRole("heading", { level: 3, name: title, exact: true }),
  ).toBeVisible();
  await review.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: `Review suggestions for ${title}`,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("Suggested, not saved.", { exact: false }),
  ).toBeVisible();
  await expect(
    dialog.getByText("synthetic-new (new suggestion)"),
  ).toBeVisible();
  await expect(dialog.getByText("synthetic-existing (existing)")).toBeVisible();
  // An independent human edit lands after this dialog rendered its expected title.
  const edit = await page.request.post("/library", {
    headers: { origin: baseURL ?? "" },
    form: {
      intent: "asset-field",
      id: `asset:${id}`,
      field: "title",
      value: "Human orchard title",
    },
  });
  expect(edit.ok()).toBe(true);
  await dialog
    .getByRole("button", { name: "Accept suggested title", exact: true })
    .click();
  await expect(page.getByRole("alert").last()).toContainText(
    "field or suggestions changed",
  );
  expect(new URL(page.url()).searchParams.get("processing")).toBe(id);
  await page.reload();
  // Reload restores the URL-backed pane; on mobile it already covers the list.
  const current = page.getByRole("dialog", {
    name: "Review suggestions for Human orchard title",
  });
  await expect(current).toBeVisible();
  await current
    .getByRole("button", { name: "Dismiss suggested title", exact: true })
    .click();
  await expect(
    current.getByRole("button", {
      name: "Accept suggested title",
      exact: true,
    }),
  ).toHaveCount(0);
  await current
    .getByRole("button", { name: "Dismiss suggested summary", exact: true })
    .click();
  // Each decision lands before the next click. The buttons disable only once
  // React commits the pending state, so an immediate second click can hit a
  // button that is disabled by the time the event arrives.
  await expect(
    current.getByRole("button", {
      name: "Dismiss suggested summary",
      exact: true,
    }),
  ).toHaveCount(0);
  await current
    .getByRole("button", {
      name: "Accept tag: synthetic-existing",
      exact: true,
    })
    .click();
  await expect(
    current.getByRole("button", {
      name: "Accept tag: synthetic-existing",
      exact: true,
    }),
  ).toHaveCount(0);
  await current
    .getByRole("button", {
      name: "Dismiss suggested tag: synthetic-new",
      exact: true,
    })
    .click();
  await expect(
    current.getByRole("button", {
      name: "Dismiss suggested tag: synthetic-new",
      exact: true,
    }),
  ).toHaveCount(0);
  await current
    .getByRole("button", {
      name: "Accept project: synthetic-orchard",
      exact: true,
    })
    .click();
  await expect(current.getByText("No unreviewed suggestions.")).toBeVisible();
  expect(
    await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
  ).toBe(true);
  await page.keyboard.press("Escape");
  // The pane shuts at once; the URL follows when the navigation's loader
  // returns, and only then does the item's details pane take the floor.
  // Reloading before that would reload the old URL.
  await expect(current).toBeHidden();
  await expect
    .poll(() => new URL(page.url()).searchParams.has("processing"))
    .toBe(false);
  expect(new URL(page.url()).searchParams.has("review")).toBe(false);
  const details = page.getByRole("dialog", {
    name: "Human orchard title",
    exact: true,
  });
  await expect(details).toBeVisible();
  await page.reload();
  await expect(details).toBeVisible();
  await expect(
    card.getByRole("heading", {
      level: 3,
      name: "Human orchard title",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    card.getByRole("link", { name: "Review suggestions", exact: true }),
  ).toHaveCount(0);
  // The card's details are still open, so its tags show in the editable set.
  await expect(
    card.locator(".tagset").getByText("synthetic-existing", { exact: true }),
  ).toBeVisible();
  await expect(card.getByText("synthetic-new", { exact: true })).toHaveCount(0);
  await expect(
    card.getByText("Synthetic summary awaiting explicit review.", {
      exact: true,
    }),
  ).toHaveCount(0);
});

test("suggestion decisions persist through native no-script forms", async ({
  browser,
  baseURL,
}, testInfo) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 320, height: 800 },
  });
  try {
    const page = await context.newPage();
    const { id } = await original(page, false);
    await (await pendingSuggestions(baseURL ?? "", id))();
    await page.goto(`/library/${id}/process`);
    await page
      .getByRole("button", { name: "Accept suggested title", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "Synthetic orchard guide",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Dismiss suggested summary", exact: true })
      .click();
    // Each decision redirects, so a reload reads the page instead of
    // submitting the last decision again.
    await expect(page).toHaveURL(new RegExp(`/library/${id}/process$`));
    await page.reload();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: "Accept suggested summary",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: "Accept tag: synthetic-new",
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("library-review-noscript-320.png"),
      fullPage: true,
    });
  } finally {
    await context.close();
  }
});
