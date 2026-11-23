import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect, goto, signedOut, test } from "./fixtures/session";

/**
 * A member who joined with Google sets a password on /account, signs in with
 * it on /login, and changing it signs every other browser out. The member is
 * made by `/__dev/member` the way Google sign-in leaves one: verified, with
 * no password. ADR-0016, amendment of 2026-10-29.
 */

async function googleMember(
  browser: Browser,
  width: number,
): Promise<{ context: BrowserContext; page: Page; email: string }> {
  const email = `google-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const context = await browser.newContext({
    storageState: signedOut,
    viewport: { width, height: width > 400 ? 900 : 844 },
  });
  const made = await context.request.post(
    `/__dev/member?email=${encodeURIComponent(email)}`,
  );
  expect(made.ok()).toBe(true);
  return { context, page: await context.newPage(), email };
}

async function fitsTheWidth(page: Page, at: string): Promise<void> {
  const overflow = await page.evaluate<number>(
    "document.documentElement.scrollWidth - document.documentElement.clientWidth",
  );
  expect(overflow, `${at} scrolls sideways`).toBeLessThanOrEqual(1);
}

for (const width of [1280, 320]) {
  test(`a Google-only member sets a password and signs in with it at ${width}px`, async ({
    browser,
  }) => {
    const member = await googleMember(browser, width);
    const other = await browser.newContext({
      storageState: signedOut,
      viewport: { width, height: 844 },
    });
    try {
      const { page, email } = member;
      await goto(page, "/todos");
      // The name in the sidebar is the way to the account page; a phone
      // opens the sidebar from the menu button first.
      if (width < 768) {
        await page.getByRole("button", { name: "Toggle Sidebar" }).click();
      }
      await page
        .getByRole("navigation", { name: "Workspace" })
        .getByRole("link", { name: email.split("@")[0] })
        .click();
      await expect(page).toHaveURL(/\/account$/);
      await expect(
        page.getByRole("heading", { level: 1, name: "Account" }),
      ).toBeVisible();
      await expect(page.getByText("You sign in with Google.")).toBeVisible();
      await expect(page.getByLabel("Current password")).toHaveCount(0);
      await fitsTheWidth(page, `/account at ${width}px`);

      // A mismatch is named, and nothing is saved.
      await page.getByLabel("Password", { exact: true }).fill("first-pass-1");
      await page.getByLabel("Confirm password").fill("first-pass-2");
      await page.getByRole("button", { name: "Set password" }).click();
      await expect(page.getByRole("alert")).toHaveText(
        "Passwords do not match.",
      );

      await page.getByLabel("Password", { exact: true }).fill("first-pass-1");
      await page.getByLabel("Confirm password").fill("first-pass-1");
      await page.getByRole("button", { name: "Set password" }).click();
      await expect(page.getByRole("status")).toContainText("Password saved.");
      await expect(page.getByLabel("Current password")).toBeVisible();
      await fitsTheWidth(page, `/account after saving at ${width}px`);

      // The email and the new password sign a second browser in on /login.
      const second = await other.newPage();
      await goto(second, "/login");
      await second.getByLabel("Email").fill(email);
      await second.getByLabel("Password", { exact: true }).fill("first-pass-1");
      await second.getByRole("button", { name: "Log in" }).click();
      await second.waitForURL(/\/todos/);

      // Changing it needs the current password and ends the other session.
      await page.getByLabel("Current password").fill("not-the-password");
      await page.getByLabel("New password").fill("second-pass-2");
      await page.getByLabel("Confirm password").fill("second-pass-2");
      await page.getByRole("button", { name: "Change password" }).click();
      await expect(page.getByRole("alert")).toHaveText(
        "The current password is wrong.",
      );
      await page.getByLabel("Current password").fill("first-pass-1");
      await page.getByLabel("New password").fill("second-pass-2");
      await page.getByLabel("Confirm password").fill("second-pass-2");
      await page.getByRole("button", { name: "Change password" }).click();
      await expect(page.getByRole("status")).toContainText("Password saved.");

      await second.goto("/account");
      await expect(second).toHaveURL(/\/login\?next=%2Faccount/);
      // This browser stays signed in.
      await page.reload();
      await expect(
        page.getByRole("heading", { level: 1, name: "Account" }),
      ).toBeVisible();
    } finally {
      await other.close();
      await member.context.close();
    }
  });
}

test("the owner is told the administrator password is set elsewhere", async ({
  page,
}) => {
  await goto(page, "/account");
  await expect(page.getByText("administrator password")).toBeVisible();
  await expect(page.getByRole("button", { name: /password/ })).toHaveCount(0);
});
