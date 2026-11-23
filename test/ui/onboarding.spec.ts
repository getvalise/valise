import type { Browser, Page } from "@playwright/test";
import { expect, goto, signedOut, test } from "./fixtures/session";

/** A fresh member: no calls and no skills of their own, only built-ins. */
async function member(browser: Browser, javaScriptEnabled = true) {
  const context = await browser.newContext({
    storageState: signedOut,
    javaScriptEnabled,
  });
  const email = `onboarding-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const made = await context.request.post(
    `/__dev/member?email=${encodeURIComponent(email)}`,
  );
  expect(made.ok()).toBe(true);
  return context;
}

const checklist = (page: Page) =>
  page.getByRole("region", { name: "Get started" });

test("a new member sees the checklist on To-dos and Skills, previews a starter, hides it and brings it back", async ({
  browser,
}) => {
  const context = await member(browser);
  try {
    const page = await context.newPage();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await goto(page, "/todos");
      await expect(checklist(page)).toBeVisible();
      // Built-in skills are already published for this member; they do not
      // tick "Add your first skill".
      await expect(checklist(page).locator("ol > li")).toContainText([
        "Connect an MCP client, not done yet",
        "Add your first skill, not done yet",
      ]);
      const overflow = await page.evaluate<number>(
        "document.documentElement.scrollWidth - document.documentElement.clientWidth",
      );
      expect(overflow, `/todos at ${width}px`).toBeLessThanOrEqual(1);
    }
    await expect(
      checklist(page).getByRole("link", { name: "Open Connections" }),
    ).toHaveAttribute("href", "/connections");
    // Each starter opens the Add skill preview; nothing is installed.
    await expect(
      checklist(page).getByRole("link", { name: "Preview grill-me" }),
    ).toHaveAttribute(
      "href",
      "/skills?add=search&find=grill-me&preview=mattpocock%2Fskills%2Fgrill-me",
    );
    await expect(
      checklist(page).getByRole("link", {
        name: "Preview conversation-history",
      }),
    ).toHaveAttribute("href", /\/skills\?add=url&url=.*conversation-history/);
    await expect(
      checklist(page).getByRole("link", { name: "Preview tdd" }),
    ).toHaveAttribute(
      "href",
      "/skills?add=search&find=tdd&preview=mattpocock%2Fskills%2Ftdd",
    );

    await goto(page, "/skills");
    await expect(checklist(page)).toBeVisible();

    // Hide goes at once, and stays gone for the account on every page.
    await checklist(page)
      .getByRole("button", { name: "Hide the getting-started checklist" })
      .click();
    await expect(checklist(page)).toHaveCount(0);
    await page.waitForLoadState("networkidle");
    await goto(page, "/todos");
    await expect(checklist(page)).toHaveCount(0);
    const other = await context.browser()!.newContext({
      storageState: await context.storageState(),
    });
    const elsewhere = await other.newPage();
    await goto(elsewhere, "/skills");
    await expect(checklist(elsewhere)).toHaveCount(0);
    await other.close();

    // Account brings it back.
    await goto(page, "/account");
    await page.getByRole("button", { name: "Show it again" }).click();
    await expect(page).toHaveURL(/\/todos$/);
    await expect(checklist(page)).toBeVisible();
  } finally {
    await context.close();
  }
});

test("hides the checklist with scripting off and lands back on the page", async ({
  browser,
}) => {
  const context = await member(browser, false);
  try {
    const page = await context.newPage();
    await goto(page, "/skills", false);
    await expect(checklist(page)).toBeVisible();
    await checklist(page)
      .getByRole("button", { name: "Hide the getting-started checklist" })
      .click();
    await expect(page).toHaveURL(/\/skills$/);
    await expect(checklist(page)).toHaveCount(0);
  } finally {
    await context.close();
  }
});
