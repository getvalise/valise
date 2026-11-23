import type { Page } from "@playwright/test";
import { expect, goto, signedOut, test } from "./fixtures/session";

/**
 * `/save` as the iPhone Shortcut opens it. The clipboard is stubbed: this
 * is evidence about the page, not about Safari's Paste callout or Shortcuts.
 */
async function clipboard(page: Page, text: string | null) {
  await page.addInitScript((value) => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: () =>
          value === null
            ? Promise.reject(new DOMException("Denied", "NotAllowedError"))
            : Promise.resolve(value),
      },
    });
  }, text);
}

const article = (run: string) =>
  Array.from({ length: 200 }, (_, at) => `gated${run}word${at}`).join(" ");

test("saves a gated article from the clipboard on a phone and reads it", async ({
  page,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  await page.setViewportSize({ width: 390, height: 844 });
  await clipboard(page, article(run));
  const url = `https://news.example/gated/${run}`;
  await goto(
    page,
    `/save?url=${encodeURIComponent(url)}&title=${encodeURIComponent(`Gated ${run}`)}&clipboard=1`,
  );
  await expect(page.getByText(url)).toBeVisible();
  await expect(page.getByLabel("Title")).toHaveValue(`Gated ${run}`);
  await page.getByLabel("Tags").fill("phone, gated");
  await page.screenshot({ path: test.info().outputPath("save-390.png") });
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.getByRole("heading", { name: "Saved" })).toBeVisible();
  await expect(
    page.getByText("With the article you pasted, 200 words."),
  ).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("saved-390.png") });
  await page.getByRole("link", { name: "Read it" }).click();
  await expect(page.getByText(`gated${run}word199`)).toBeVisible();
});

test("opens a paste box when Safari refuses the clipboard, and saves what is pasted", async ({
  page,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  await clipboard(page, null);
  await goto(
    page,
    `/save?url=${encodeURIComponent(`https://news.example/refused/${run}`)}&clipboard=1`,
  );
  await expect(page.getByLabel("Title")).toHaveValue("");
  await expect(page.getByLabel("Article text")).toBeHidden();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Article text")).toBeVisible();
  await expect(
    page.getByText(/Safari did not hand over the clipboard/),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Saved" })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("paste-box.png") });
  await page.getByLabel("Article text").fill(article(run));
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByText("With the article you pasted, 200 words."),
  ).toBeVisible();

  await clipboard(page, "");
  await goto(
    page,
    `/save?url=${encodeURIComponent(`https://news.example/empty/${run}`)}&clipboard=1`,
  );
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Article text")).toBeVisible();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/The text held 0 words/)).toBeVisible();
  await expect(page.getByText(`news.example/empty/${run}`)).toBeVisible();

  await goto(
    page,
    `/save?url=${encodeURIComponent(`https://news.example/link/${run}`)}`,
  );
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByText(/Valise fetches the page itself in the next few minutes/),
  ).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("saved-1280.png") });
});

test("explains a missing or unsavable link instead of showing a form", async ({
  page,
}) => {
  await goto(page, "/save");
  await expect(
    page.getByRole("heading", { name: "No link to save" }),
  ).toBeVisible();
  await goto(page, `/save?url=${encodeURIComponent("javascript:alert(1)")}`);
  await expect(page.getByText("is not an http or https link")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
});

test.describe("signed out", () => {
  test.use({ storageState: signedOut });

  test("goes through sign-in and keeps the link", async ({ page }) => {
    await page.goto("/save?url=https%3A%2F%2Fnews.example%2Fa&clipboard=1");
    await expect(page).toHaveURL(
      /\/login\?next=%2Fsave%3Furl%3Dhttps%253A%252F%252Fnews\.example%252Fa%26clipboard%3D1/,
    );
  });
});
