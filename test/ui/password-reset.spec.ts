import type { Page } from "@playwright/test";
import { expect, goto, signedOut, test } from "./fixtures/session";

/**
 * The owner issues a one-time password-reset link for a member on /people;
 * the member opens it signed out, sets a password, and signs in with it on
 * /login. Every browser the member was signed in on is signed out, and the
 * link does not work twice. Expiry, replacement and the foreign-member checks
 * are in test/mcp/password-reset.worker.test.ts. ADR-0016, amendment of
 * 2026-10-29 (reset).
 */

async function fitsTheWidth(page: Page, at: string): Promise<void> {
  const overflow = await page.evaluate<number>(
    "document.documentElement.scrollWidth - document.documentElement.clientWidth",
  );
  expect(overflow, `${at} scrolls sideways`).toBeLessThanOrEqual(1);
}

for (const width of [1280, 320]) {
  test(`the owner resets a member's password with a one-time link at ${width}px`, async ({
    browser,
  }) => {
    const email = `reset-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const viewport = { width, height: width > 400 ? 900 : 844 };
    const owner = await browser.newContext({ viewport });
    const memberBrowser = await browser.newContext({
      storageState: signedOut,
      viewport,
    });
    const stranger = await browser.newContext({
      storageState: signedOut,
      viewport,
    });
    try {
      // The member is signed in somewhere, as Google sign-in leaves them.
      const made = await memberBrowser.request.post(
        `/__dev/member?email=${encodeURIComponent(email)}`,
      );
      expect(made.ok()).toBe(true);
      const memberPage = await memberBrowser.newPage();
      await goto(memberPage, "/account");
      await expect(
        memberPage.getByRole("heading", { level: 1, name: "Account" }),
      ).toBeVisible();

      const page = await owner.newPage();
      await goto(page, "/people");
      const card = page.getByRole("listitem").filter({ hasText: email });
      await card
        .getByRole("button", { name: "Create password reset link" })
        .click();
      const reveal = card.locator(".token-reveal");
      await expect(reveal).toContainText("It works once");
      const link = (await reveal.locator("code").textContent())?.trim() ?? "";
      expect(link).toMatch(/\/reset-password\/[\w-]{43}$/);
      await fitsTheWidth(page, `/people with a reset link at ${width}px`);

      // The member opens it signed out.
      const reset = await stranger.newPage();
      await reset.goto(new URL(link).pathname);
      await expect(
        reset.getByRole("heading", { level: 1, name: "Set a new password" }),
      ).toBeVisible();
      await expect(reset.getByText(`For ${email}.`)).toBeVisible();
      await fitsTheWidth(reset, `/reset-password at ${width}px`);
      await reset.getByLabel("New password").fill("reset-pass-1");
      await reset.getByLabel("Confirm password").fill("reset-pass-2");
      await reset.getByRole("button", { name: "Set password" }).click();
      await expect(reset.getByRole("alert")).toHaveText(
        "Passwords do not match.",
      );
      await reset.getByLabel("New password").fill("reset-pass-1");
      await reset.getByLabel("Confirm password").fill("reset-pass-1");
      await reset.getByRole("button", { name: "Set password" }).click();
      await expect(reset.getByRole("status")).toContainText("Password saved.");

      // Every browser the member was signed in on is signed out.
      await memberPage.goto("/account");
      await expect(memberPage).toHaveURL(/\/login\?next=%2Faccount/);

      // The new password works on /login.
      await reset.getByRole("link", { name: "Sign in" }).click();
      await reset.getByLabel("Email").fill(email);
      await reset.getByLabel("Password", { exact: true }).fill("reset-pass-1");
      await reset.getByRole("button", { name: "Log in" }).click();
      await reset.waitForURL(/\/todos/);

      // The link does not work twice.
      const again = await (
        await browser.newContext({
          storageState: signedOut,
          viewport,
        })
      ).newPage();
      await again.goto(new URL(link).pathname);
      await expect(again.getByRole("alert")).toContainText(
        "This link is used, replaced or expired.",
      );
      await expect(
        again.getByRole("button", { name: "Set password" }),
      ).toHaveCount(0);
      await again.context().close();

      // The owner sees that it was used.
      await page.reload();
      await expect(
        page.getByRole("listitem").filter({ hasText: email }),
      ).toContainText("Reset link used");
    } finally {
      await owner.close();
      await memberBrowser.close();
      await stranger.close();
    }
  });
}
