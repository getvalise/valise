import { UI_ADMIN_EMAIL } from "./fixtures/server";
import {
  expect,
  goto,
  seed,
  signedOut,
  signIn,
  test,
} from "./fixtures/session";

/**
 * The owner mints an invite on /people and the link lands on a page that
 * offers Google, or says why it cannot. Google itself is not configured in
 * the suite, so the join page's "not configured" line is the proof the code
 * resolved. ADR-0016.
 */

test.beforeEach(async ({ request }) => {
  await seed(request);
});

test("the owner invites someone and the link resolves to the invite", async ({
  page,
  browser,
}) => {
  await signIn(page);
  // The strap names the owner and offers the owner's page.
  await expect(
    page.getByRole("navigation", { name: "Workspace" }),
  ).toContainText("Owner");
  await page.getByRole("link", { name: "People" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "People", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("owner", { exact: true })).toBeVisible();

  await expect(page.getByLabel("Label", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Email", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Create invite" }).click();
  await expect(page.getByText("Invite link", { exact: true })).toBeVisible();
  const link = await page.locator(".token-reveal code").textContent();
  expect(link).toMatch(/\/join\/[A-Za-z0-9_-]{22}$/);
  await expect(page.getByText("open", { exact: true })).toBeVisible();

  // The link, opened signed out, is the invite.
  const visitor = await browser.newContext({ storageState: signedOut });
  const joinPage = await visitor.newPage();
  await goto(joinPage, new URL(link ?? "").pathname);
  await expect(
    joinPage.getByRole("heading", { name: "You're invited." }),
  ).toBeVisible();
  await expect(joinPage.getByLabel("Email", { exact: true })).toHaveValue("");
  await expect(
    joinPage.getByLabel("Display name", { exact: true }),
  ).toHaveValue("");
  await expect(
    joinPage.getByText("Google sign-in is not configured"),
  ).toBeVisible();
  await joinPage.goto("/join/not-a-real-code");
  await expect(
    joinPage.getByRole("heading", { name: "No such invite" }),
  ).toBeVisible();
  await visitor.close();

  // Withdrawn, the same link says so.
  await page.getByRole("button", { name: "Withdraw invite" }).click();
  await expect(page.getByText("revoked", { exact: true })).toBeVisible();
  await goto(page, new URL(link ?? "").pathname);
  // A signed-in person is sent to their case, not the invite.
  await expect(page).toHaveURL(/\/todos/);
});

test("the owner creates an expiring group link and can withdraw it", async ({
  page,
  browser,
}) => {
  await goto(page, "/people");
  await expect(page.getByLabel("Expires in days")).toHaveValue("14");
  await page.getByLabel("Invite type").selectOption("group");
  await page.getByLabel("Expires in days").fill("0");
  await page.getByRole("button", { name: "Create invite" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Group invite links must expire",
  );
  await expect(page.locator(".token-reveal")).toHaveCount(0);
  await page.getByLabel("Expires in days").fill("14");
  await page.getByRole("button", { name: "Create invite" }).click();
  await expect(page.locator(".token-reveal")).toContainText(
    "Multiple people can join",
  );
  const link = await page.locator(".token-reveal code").textContent();
  const path = new URL(link ?? "").pathname;
  const card = page.locator("li").filter({
    has: page.getByRole("heading", { name: "Group invite", exact: true }),
  });
  await expect(card).toContainText("0 accounts created");
  const visitor = await browser.newContext({ storageState: signedOut });
  try {
    const join = await visitor.newPage();
    await goto(join, path);
    await expect(
      join.getByRole("heading", { name: "You're invited." }),
    ).toBeVisible();
    await card.getByRole("button", { name: "Withdraw invite" }).click();
    await expect(card).toContainText("revoked");
    await join.reload();
    await expect(
      join.getByRole("heading", { name: "This invite was withdrawn." }),
    ).toBeVisible();
    await expect(card.locator("code")).toHaveCount(0);
  } finally {
    await visitor.close();
  }
});

test("group creation and withdrawal work without scripting", async ({
  browser,
}) => {
  const visitor = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await visitor.newPage();
    await page.goto("/people");
    await page.getByLabel("Invite type").selectOption("group");
    await page.getByRole("button", { name: "Create invite" }).click();
    await expect(page.locator(".token-reveal")).toContainText(
      "Multiple people can join",
    );
    const withdrawn = await page.getByText("revoked", { exact: true }).count();
    await page.getByRole("button", { name: "Withdraw invite" }).click();
    await expect(page.getByText("revoked", { exact: true })).toHaveCount(
      withdrawn + 1,
    );
  } finally {
    await visitor.close();
  }
});

test("a second admin address gets its own account with the admin pages", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: signedOut });
  try {
    const made = await context.request.post(
      `/__dev/member?email=${encodeURIComponent(UI_ADMIN_EMAIL)}`,
    );
    expect(made.ok()).toBe(true);
    const page = await context.newPage();
    await goto(page, "/todos");
    const nav = page.getByRole("navigation", { name: "Workspace" });
    await expect(nav).toContainText("Admin");
    await nav.getByRole("link", { name: "People" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "People", exact: true }),
    ).toBeVisible();
    const self = page.locator("li").filter({
      has: page.getByRole("heading", { name: "admin-ui", exact: true }),
    });
    await expect(self.getByText("admin", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Create invite" }).click();
    await expect(page.getByText("Invite link", { exact: true })).toBeVisible();
    await goto(page, "/workbench");
    await expect(
      page.getByRole("heading", { level: 1, name: "Workbench" }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("a member gets no admin pages", async ({ browser }) => {
  const context = await browser.newContext({ storageState: signedOut });
  try {
    const email = `member-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const made = await context.request.post(
      `/__dev/member?email=${encodeURIComponent(email)}`,
    );
    expect(made.ok()).toBe(true);
    const page = await context.newPage();
    await goto(page, "/todos");
    await expect(
      page
        .getByRole("navigation", { name: "Workspace" })
        .getByRole("link", { name: "People" }),
    ).toHaveCount(0);
    const response = await page.goto("/people");
    expect(response?.status()).toBe(404);
  } finally {
    await context.close();
  }
});
