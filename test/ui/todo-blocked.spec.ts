import type { APIRequestContext, Page } from "@playwright/test";
import { expect, goto, mcp, test } from "./fixtures/session";

const cardFor = (page: Page, id: string) =>
  page.locator(".todo-list > .todo-card", {
    has: page.locator(`input[name="id"][value="${id}"]`),
  });

/** The list's rows, top to bottom, as the ids they post. */
const order = (page: Page) =>
  page
    .locator(".todo-list > .todo-card")
    .evaluateAll((rows) =>
      rows.map((row: any) => row.querySelector('input[name="id"]')?.value),
    );

async function block(request: APIRequestContext, id: string, on: string) {
  const { token } = await mcp(request, "claim_todo", { id, ttl_seconds: 600 });
  await mcp(request, "update_todo", { id, token, blocked_on: on });
}

test("blocked rows lead the list under a header, and hold their place until it reopens", async ({
  page,
  request,
}) => {
  const project = `blocked-${crypto.randomUUID().slice(0, 8)}`;
  const make = async (title: string) =>
    (await mcp(request, "create_todo", { title, project })).id as string;
  const older = await make("Waiting on the vendor");
  const middle = await make("Write the release notes");
  const newest = await make("Tidy the changelog");
  await block(request, older, "the vendor's API key");

  const list = `/todos?project=${project}`;
  const header = page.locator(".todo-blocked-head");
  // An agent's block reaches D1 through the coordinator's mirror alarm.
  await expect(async () => {
    await goto(page, list);
    await expect(header).toHaveText(/1 blocked/, { timeout: 500 });
  }).toPass();

  // The oldest row leads because it is blocked, and says on what.
  expect(await order(page)).toEqual([older, newest, middle]);
  await expect(cardFor(page, older)).toHaveClass(/\bin-blocked\b/);
  await expect(cardFor(page, newest)).not.toHaveClass(/\bin-blocked\b/);
  await expect(
    cardFor(page, older).getByText("Blocked on the vendor's API key."),
  ).toBeVisible();
  const headerBox = await header.boundingBox();
  const firstBox = await cardFor(page, older).boundingBox();
  expect(headerBox!.y).toBeLessThan(firstBox!.y);

  // Unblock repaints the row where it is; it does not jump down the list
  // from under the pointer (P4, P12). The first-run checklist can push the
  // button below the fold, and the click would scroll it in, so measure from
  // where the click will find it.
  const unblock = cardFor(page, older).getByRole("button", {
    name: "Unblock: Waiting on the vendor",
  });
  await unblock.scrollIntoViewIfNeeded();
  const before = await cardFor(page, older).boundingBox();
  await unblock.click();
  await expect(cardFor(page, older).locator(".pill")).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  expect(await order(page)).toEqual([older, newest, middle]);
  expect((await cardFor(page, older).boundingBox())!.y).toBe(before!.y);
  // It keeps its place in the section, but not the alert's red: the strap
  // and the wash follow the state, not the section.
  await expect(cardFor(page, older)).toHaveClass(/\bin-blocked\b/);
  await expect(cardFor(page, older)).not.toHaveClass(/\bis-blocked\b/);
  await page.mouse.move(0, 0);
  await expect(cardFor(page, older)).toHaveCSS("box-shadow", "none");
  await expect(cardFor(page, older)).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  // The header stays over the section too, and says nothing is blocked now.
  await expect(header).toHaveClass(/\bis-clear\b/);
  await expect(header).toHaveText(/None blocked now/);
  await expect(header).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

  // Reopened, the list sorts it back among the rest.
  await goto(page, list);
  await expect(header).toHaveCount(0);
  expect(await order(page)).toEqual([newest, middle, older]);

  // Blocking from the pane leaves the row in place too.
  await cardFor(page, middle).locator(".todo-open").click();
  await page.getByRole("link", { name: "Block this" }).click();
  await page.getByLabel("Blocked on").fill("legal review");
  await page.getByRole("button", { name: "Block", exact: true }).click();
  // The line says what it waits on; no pill repeats the state.
  // The pane is open inside the card and says it too, so read the row's own.
  await expect(
    cardFor(page, middle).locator(":scope > .todo-blocked"),
  ).toHaveText("Blocked on legal review.Unblock");
  await expect(
    cardFor(page, middle).locator(":scope > .todo-head .pill"),
  ).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  expect(await order(page)).toEqual([newest, middle, older]);
  await expect(cardFor(page, middle)).not.toHaveClass(/\bin-blocked\b/);
  // Blocked where it stands, it takes the alert's strap there.
  await expect(cardFor(page, middle)).toHaveClass(/\bis-blocked\b/);

  await goto(page, list);
  await expect(header).toHaveText(/1 blocked/);
  expect(await order(page)).toEqual([middle, newest, older]);
  await expect(cardFor(page, middle)).toHaveClass(/\bin-blocked\b/);
});

test("a row unblocked past the loaded window stays where it was, read as pending", async ({
  page,
  request,
}) => {
  test.slow();
  const project = `blocked-window-${crypto.randomUUID().slice(0, 8)}`;
  const ids: string[] = [];
  for (let index = 0; index < 31; index += 1)
    ids.push(
      (await mcp(request, "create_todo", { title: `Window ${index}`, project }))
        .id as string,
    );
  const oldest = ids[0];
  await block(request, oldest, "an outside answer");
  const list = `/todos?project=${project}`;
  await expect(async () => {
    await goto(page, list);
    await expect(page.locator(".todo-blocked-head")).toHaveText(/1 blocked/, {
      timeout: 500,
    });
  }).toPass();
  expect((await order(page))[0]).toBe(oldest);

  // Unblocked, it sorts 31st of 31, past the 30-row window the server sends.
  // Measured where the click will find it, as above.
  const unblock = cardFor(page, oldest).getByRole("button", {
    name: "Unblock: Window 0",
  });
  await unblock.scrollIntoViewIfNeeded();
  const before = await cardFor(page, oldest).boundingBox();
  await unblock.click();
  await expect(cardFor(page, oldest).locator(".pill")).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  expect((await order(page))[0]).toBe(oldest);
  await expect(cardFor(page, oldest).getByText(/^Blocked on/)).toHaveCount(0);
  expect((await cardFor(page, oldest).boundingBox())!.y).toBe(before!.y);
});
