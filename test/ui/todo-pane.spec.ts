import type { APIRequestContext, Page } from "@playwright/test";
import { expect, goto, mcp, test } from "./fixtures/session";

const cardFor = (page: Page, id: string) =>
  page.locator(".todo-list > .todo-card", {
    has: page.locator(`input[name="id"][value="${id}"]`),
  });

async function make(
  request: APIRequestContext,
  title: string,
  project: string,
): Promise<string> {
  return (await mcp(request, "create_todo", { title, project })).id as string;
}

/** Opens a row's pane and waits for it. */
async function openPane(page: Page, id: string, title: string) {
  await cardFor(page, id).locator(".todo-open").click();
  const pane = page.getByRole("dialog", { name: title, exact: true });
  await expect(pane).toBeVisible();
  return pane;
}

test("the Comment button shows under the box once it is in use, and Enter sends", async ({
  page,
  request,
  browser,
}) => {
  const project = `pane-${crypto.randomUUID().slice(0, 8)}`;
  const title = "Answer the reviewer";
  const id = await make(request, title, project);
  await goto(page, `/todos?project=${project}`);
  const pane = await openPane(page, id, title);
  const box = pane.getByRole("textbox", { name: `Comment on ${title}` });
  const send = pane.getByRole("button", { name: "Comment", exact: true });
  const history = pane.getByRole("region", { name: "History" });

  // At rest the pane shows the box and no button beside it.
  await expect(box).toBeVisible();
  await expect(send).toBeHidden();
  // Hidden, it keeps its line, so showing it moves nothing (P6).
  const paneHeight = await pane
    .locator(".modal-body")
    .evaluate((node: any) => node.scrollHeight);
  // Focus brings the button, under the box rather than beside it.
  await box.focus();
  await expect(send).toBeVisible();
  const boxRect = (await box.boundingBox())!;
  const sendRect = (await send.boundingBox())!;
  expect(sendRect.y).toBeGreaterThanOrEqual(boxRect.y + boxRect.height);
  expect(Math.abs(sendRect.x - boxRect.x)).toBeLessThan(1);
  expect(
    await pane
      .locator(".modal-body")
      .evaluate((node: any) => node.scrollHeight),
  ).toBe(paneHeight);

  // Shift+Enter is a new line; Enter sends the whole draft.
  await box.pressSequentially("First line");
  await box.press("Shift+Enter");
  await box.pressSequentially("second line");
  await expect(box).toHaveValue("First line\nsecond line");
  await box.press("Enter");
  await expect(box).toHaveValue("");
  await expect(history).toContainText("First line");
  await expect(history).toContainText("second line");
  const fetched = await mcp(request, "fetch", { id });
  expect(JSON.stringify(fetched)).toContain("First line\\nsecond line");

  // Away from the box, an empty box hides the button again.
  await box.blur();
  await expect(send).toBeHidden();

  // With scripting off the button is the next tab stop after the box, and
  // it sends (P11).
  const plain = await browser.newContext({
    javaScriptEnabled: false,
    storageState: await page.context().storageState(),
  });
  try {
    const noScript = await plain.newPage();
    await goto(
      noScript,
      `/todos?project=${project}&open=${encodeURIComponent(id)}`,
      false,
    );
    const plainPane = noScript.getByRole("dialog", { name: title });
    const plainBox = plainPane.getByRole("textbox", {
      name: `Comment on ${title}`,
    });
    const plainSend = plainPane.getByRole("button", {
      name: "Comment",
      exact: true,
    });
    await expect(plainSend).toBeHidden();
    await plainBox.focus();
    await expect(plainSend).toBeVisible();
    await plainBox.fill("Sent without scripts");
    await noScript.keyboard.press("Tab");
    await expect(plainSend).toBeFocused();
    await noScript.keyboard.press("Enter");
    await expect(
      noScript
        .getByRole("dialog", { name: title })
        .getByRole("region", { name: "History" }),
    ).toContainText("Sent without scripts");
  } finally {
    await plain.close();
  }
});

test("a blocked to-do's Unblock sits under the status line, above the history", async ({
  page,
  request,
}) => {
  const project = `pane-${crypto.randomUUID().slice(0, 8)}`;
  const title = "Wait on the vendor";
  const id = await make(request, title, project);
  const { token } = await mcp(request, "claim_todo", { id, ttl_seconds: 600 });
  for (let n = 0; n < 4; n += 1)
    await mcp(request, "update_todo", {
      id,
      token,
      body: `Progress note ${n}\n\n${"A long paragraph of agent progress. ".repeat(12)}`,
    });
  await mcp(request, "update_todo", {
    id,
    token,
    blocked_on: "the vendor's API key",
  });
  await expect(async () => {
    await goto(page, `/todos?project=${project}`);
    await expect(page.locator(".todo-blocked-head")).toHaveText(/1 blocked/, {
      timeout: 500,
    });
  }).toPass();

  const pane = await openPane(page, id, title);
  const status = pane.getByTestId("todo-status");
  const unblock = pane.getByRole("button", { name: `Unblock: ${title}` });
  const history = pane.getByRole("region", { name: "History" });
  await expect(status).toContainText("Blocked");
  await expect(unblock).toBeInViewport();
  const statusRect = (await status.boundingBox())!;
  const unblockRect = (await unblock.boundingBox())!;
  const historyRect = (await history.boundingBox())!;
  // Directly under the status, and well above the history.
  expect(unblockRect.y).toBeGreaterThanOrEqual(
    statusRect.y + statusRect.height - 1,
  );
  expect(unblockRect.y - (statusRect.y + statusRect.height)).toBeLessThan(80);
  expect(unblockRect.y).toBeLessThan(historyRect.y);

  // Unblocking from there turns the same place into Block this, so the
  // reversal is where the click was (P12).
  await unblock.click();
  const blockThis = pane.getByRole("link", { name: "Block this", exact: true });
  await expect(blockThis).toBeVisible();
  expect((await blockThis.boundingBox())!.y).toBeLessThan(historyRect.y);

  // Opening Block covers the lines under it rather than pushing them (P6).
  const body = pane.locator(".todo-body");
  const bodyBefore = (await body.boundingBox())!.y;
  await blockThis.click();
  await expect(pane.getByLabel("Blocked on")).toBeFocused();
  expect(Math.abs((await body.boundingBox())!.y - bodyBefore)).toBeLessThan(1);
  await pane.getByLabel("Blocked on").fill("legal review");
  await pane.getByRole("button", { name: "Block", exact: true }).click();
  await expect(unblock).toBeVisible();
  await expect(cardFor(page, id)).toHaveClass(/\bis-blocked\b/);
});

test("a long blocked-on reason wraps in the pane instead of widening it", async ({
  page,
  request,
}) => {
  const project = `pane-${crypto.randomUUID().slice(0, 8)}`;
  const title = "Wait on the clean account";
  const id = await make(request, title, project);
  const { token } = await mcp(request, "claim_todo", { id, ttl_seconds: 600 });
  const reason =
    "Authorized clean-account/app test target, live Clef/Jev access, and an independent second-person walkthrough are needed to finish acceptance; code is merged and production deployment verified.";
  await mcp(request, "update_todo", { id, token, blocked_on: reason });

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const pane = page.getByRole("dialog", { name: title, exact: true });
    const body = pane.locator(".modal-body");
    const unblock = pane.getByRole("button", { name: `Unblock: ${title}` });
    await expect(async () => {
      await goto(
        page,
        `/todos?project=${project}&open=${encodeURIComponent(id)}`,
      );
      await expect(unblock).toBeVisible({ timeout: 500 });
    }).toPass();
    // The row in the list keeps its one truncated line; the pane, which is
    // a dialog inside that row, shows the reason whole and no wider than
    // itself.
    const overflow = await body.evaluate(
      (node: any) => node.scrollWidth - node.clientWidth,
    );
    expect(overflow, `sideways overflow at ${width}px`).toBeLessThanOrEqual(0);
    const paneRect = (await body.boundingBox())!;
    for (const part of [pane.locator(".todo-blocked-on"), unblock]) {
      const rect = (await part.boundingBox())!;
      expect(rect.x + rect.width).toBeLessThanOrEqual(
        paneRect.x + paneRect.width + 1,
      );
    }
  }
});

test("a long unbroken URL in a history entry wraps inside the pane", async ({
  page,
  request,
}) => {
  const project = `pane-${crypto.randomUUID().slice(0, 8)}`;
  const title = "Record the deploy";
  const id = await make(request, title, project);
  const url = `https://dash.cloudflare.com/cf073c8346e14a9226d271688bb10ee5/workers/services/view/valise/production/deployments/${"94-4dfa-ad36-90e570c76303".repeat(4)}`;
  await mcp(request, "comment_todo", {
    id,
    body: `Workers Builds completed: ${url} and the smoke passed.`,
  });

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await goto(
      page,
      `/todos?project=${project}&open=${encodeURIComponent(id)}`,
    );
    const pane = page.getByRole("dialog", { name: title, exact: true });
    const body = pane.locator(".modal-body");
    await expect(pane.getByRole("region", { name: "History" })).toContainText(
      "smoke passed",
    );
    // Nothing in the pane is wider than the pane.
    const overflow = await body.evaluate(
      (node: any) => node.scrollWidth - node.clientWidth,
    );
    expect(overflow, `sideways overflow at ${width}px`).toBeLessThanOrEqual(0);
    // The entry's text starts inside the pane, not off its left edge.
    const entry = pane.locator(".todo-history li").first();
    const paneRect = (await body.boundingBox())!;
    const entryRect = (await entry.boundingBox())!;
    expect(entryRect.x).toBeGreaterThanOrEqual(paneRect.x);
    expect(entryRect.x + entryRect.width).toBeLessThanOrEqual(
      paneRect.x + paneRect.width + 1,
    );
    await page.screenshot({
      path: `test-results/todo-pane-long-url-${width}.png`,
    });
  }
});

test("done to-dos are hidden by default, ?done=show brings them back, and completing keeps the row", async ({
  page,
  request,
}) => {
  const project = `pane-${crypto.randomUUID().slice(0, 8)}`;
  const finished = await make(request, "Already shipped", project);
  const working = await make(request, "Still to do", project);
  const next = await make(request, "Do it next", project);
  const { token } = await mcp(request, "claim_todo", {
    id: finished,
    ttl_seconds: 600,
  });
  await mcp(request, "complete_todo", {
    id: finished,
    token,
    summary: "Shipped.",
  });

  const list = `/todos?project=${project}`;
  const show = page.getByRole("link", { name: "Show done (1)", exact: true });
  // An agent's completion reaches D1 through the coordinator's mirror alarm.
  await expect(async () => {
    await goto(page, list);
    await expect(show).toBeVisible({ timeout: 500 });
  }).toPass();
  await expect(cardFor(page, finished)).toHaveCount(0);
  await expect(page.locator(".todo-list > .todo-card")).toHaveCount(2);

  await show.click();
  await expect(page).toHaveURL(/done=show/);
  await expect(cardFor(page, finished)).toHaveCount(1);
  await expect(cardFor(page, finished).locator(".pill")).toHaveText("done");
  // The toggle names its way back, and filters keep the choice.
  await page.getByRole("link", { name: "Hide done (1)", exact: true }).click();
  await expect(page).not.toHaveURL(/done=/);
  await expect(cardFor(page, finished)).toHaveCount(0);

  // Completing a row while done rows are hidden leaves it where it was, read
  // as done, with its circle still under the pointer to reopen it (P4, P5,
  // P12). It leaves the list on the next load.
  const card = cardFor(page, working);
  const before = (await card.boundingBox())!.y;
  await card.getByRole("checkbox", { name: "Complete: Still to do" }).click();
  await expect(
    page.getByRole("link", { name: "Show done (2)", exact: true }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(card.locator(".pill")).toHaveText("done");
  expect((await card.boundingBox())!.y).toBe(before);
  await expect(cardFor(page, next)).toHaveCount(1);
  await card.getByRole("checkbox", { name: "Reopen: Still to do" }).click();
  await expect(card.locator(".pill")).toHaveCount(0);
  await expect(show).toBeVisible();
  await expect(card).toHaveCount(1);
  await card.getByRole("checkbox", { name: "Complete: Still to do" }).click();
  await expect(
    page.getByRole("link", { name: "Show done (2)", exact: true }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  await goto(page, list);
  await expect(cardFor(page, working)).toHaveCount(0);
  await expect(page.locator(".todo-list > .todo-card")).toHaveCount(1);
  await page.screenshot({ path: "test-results/todos-done-hidden.png" });
});
