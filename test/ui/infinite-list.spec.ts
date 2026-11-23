import type { APIRequestContext } from "@playwright/test";
import { z } from "zod";
import { expect, goto, mcp, seed, signIn, test } from "./fixtures/session";

test.beforeEach(async ({ request }) => {
  await seed(request);
});

async function waitForState(
  request: APIRequestContext,
  id: string,
  state: string,
) {
  await expect
    .poll(
      async () => {
        const fetched = await mcp(request, "fetch", { id });
        return z.object({ state: z.string() }).parse(fetched.metadata).state;
      },
      { timeout: 10_000 },
    )
    .toBe(state);
}

test("keeps blocked actions in an off-page dialog with and without scripting", async ({
  page,
  request,
  browser,
}) => {
  test.slow();
  const project = `blocked-page-${crypto.randomUUID().slice(0, 8)}`;
  let id = "";
  for (let index = 0; index < 31; index += 1) {
    const made = await mcp(request, "create_todo", {
      title: `Off-page ${index}`,
      project,
    });
    if (index === 0) id = z.string().parse(made.id);
  }
  const claim = await mcp(request, "claim_todo", { id });
  await mcp(request, "update_todo", {
    id,
    token: claim.token,
    blocked_on: "Await external input",
  });
  await waitForState(request, id, "blocked");
  await signIn(page);
  const href = `/todos?${new URLSearchParams({ project, open: id })}`;
  await goto(page, href);
  const dialog = page.getByRole("dialog", { name: "Off-page 0", exact: true });
  await expect(dialog).toContainText("Await external input");
  await dialog
    .getByRole("button", { name: "Unblock: Off-page 0", exact: true })
    .click();
  await expect(
    dialog.getByRole("link", { name: "Block this", exact: true }),
  ).toBeVisible();
  await waitForState(request, id, "pending");
  // Unblocked, it sorts past the 30-row window, and stays where it was beside
  // the 30 the server now sends until the list is reopened (P4).
  await expect(page.locator(".todo-list > .todo-card")).toHaveCount(31);
  await dialog.getByRole("link", { name: "Block this", exact: true }).click();
  await dialog
    .getByLabel("Blocked on", { exact: true })
    .fill("Another blocker");
  await dialog.getByRole("button", { name: "Block", exact: true }).click();
  await expect(dialog).toContainText("Another blocker");
  await waitForState(request, id, "blocked");
  const plainContext = await browser.newContext({
    javaScriptEnabled: false,
  });
  try {
    const plain = await plainContext.newPage();
    await plain.goto(href);
    const plainDialog = plain.getByRole("dialog", {
      name: "Off-page 0",
      exact: true,
    });
    await expect(plainDialog).toContainText("Another blocker");
    await plainDialog
      .getByRole("button", { name: "Unblock: Off-page 0", exact: true })
      .click();
    await expect(plainDialog).toBeVisible();
    await expect(
      plainDialog.getByRole("link", { name: "Block this", exact: true }),
    ).toBeVisible();
    expect(new URL(plain.url()).searchParams.get("open")).toBe(id);
    await expect(plain.locator(".todo-card")).toHaveCount(30);
  } finally {
    await plainContext.close();
  }
});

test("appends every filtered to-do once, keeps global counts, and supports no-script loading", async ({
  page,
  request,
  browser,
}) => {
  test.slow();
  const project = `paging-${crypto.randomUUID().slice(0, 8)}`;
  const ids: string[] = [];
  for (let index = 0; index < 65; index += 1) {
    const made = await mcp(request, "create_todo", {
      title: `Needle ${index}`,
      project,
      tags: ["page-a", "page-b"],
    });
    ids.push(z.string().parse(made.id));
  }
  const claimed = await mcp(request, "claim_todo", { id: ids[0] });
  await mcp(request, "complete_todo", {
    id: ids[0],
    token: claimed.token,
    summary: "Done",
  });
  const blocked = await mcp(request, "claim_todo", { id: ids[1] });
  await mcp(request, "update_todo", {
    id: ids[1],
    token: blocked.token,
    blocked_on: "Await input",
  });
  await waitForState(request, ids[0], "done");
  await waitForState(request, ids[1], "blocked");
  await signIn(page);
  const query = new URLSearchParams({ q: "Needle", project });
  query.append("tag", "page-a");
  query.append("tag", "page-b");
  // Done rows are hidden by default; this list counts the done one too.
  query.set("done", "show");
  const href = `/todos?${query}`;
  await goto(page, href);
  await page.setViewportSize({ width: 390, height: 844 });
  const pager = page.locator(".infinite-list");
  const nextTarget = await pager
    .getByRole("link", { name: "Load more", exact: true })
    .boundingBox();
  expect(nextTarget?.width ?? 0).toBeGreaterThanOrEqual(24);
  expect(nextTarget?.height ?? 0).toBeGreaterThanOrEqual(24);
  const pagerBox = await pager.boundingBox();
  expect((pagerBox?.x ?? 0) + (pagerBox?.width ?? 0)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/infinite-todos-phone.png" });
  await page.setViewportSize({ width: 1280, height: 900 });
  const rows = page.locator(".todo-card .todo-open");
  for (let current = 1; current <= 3; current += 1) {
    await expect(rows).toHaveCount(Math.min(current * 30, 65));
    await expect(pager).toContainText(
      `Showing ${Math.min(current * 30, 65)} of 65 items`,
    );
    await expect(
      page.getByRole("link", { name: "Hide done (1)" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Only blocked (1)" }),
    ).toBeVisible();
    if (current < 3) await pager.scrollIntoViewIfNeeded();
  }
  const seen = await rows.evaluateAll((links) =>
    links.map((link) =>
      new URL((link as unknown as { href: string }).href).searchParams.get(
        "open",
      ),
    ),
  );
  // The blocked row leads; the rest stay newest first.
  expect(seen).toEqual([
    ids[1],
    ...[...ids].reverse().filter((id) => id !== ids[1]),
  ]);
  expect(new Set(seen).size).toBe(65);
  const plainContext = await browser.newContext({
    javaScriptEnabled: false,
  });
  try {
    const plain = await plainContext.newPage();
    await plain.goto(href);
    await expect(plain.locator(".todo-card")).toHaveCount(30);
    await plain.getByRole("link", { name: "Load more", exact: true }).focus();
    await plain.keyboard.press("Enter");
    await expect(plain.locator(".todo-card")).toHaveCount(60);
    await expect(plain.locator(".infinite-list")).toContainText(
      "Showing 60 of 65",
    );
  } finally {
    await plainContext.close();
  }
  await goto(page, `${href}&open=${encodeURIComponent(ids[0])}`);
  await expect(
    page.getByRole("dialog", { name: "Needle 0", exact: true }),
  ).toBeVisible();
  await expect(rows).toHaveCount(30);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(rows).toHaveCount(30);
  await goto(page, `${href}&edit=${encodeURIComponent(`${ids[0]}.tags`)}`);
  await expect(
    page
      .getByRole("dialog", { name: "Needle 0", exact: true })
      .getByRole("button", { name: "Remove page-a", exact: true }),
  ).toBeVisible();
  await expect(rows).toHaveCount(30);
  await goto(page, href);
  await pager.scrollIntoViewIfNeeded();
  await expect(rows).toHaveCount(60);
  await page.evaluate("window.scrollTo(0, 0)");
  await page.getByRole("link", { name: "Hide done (1)" }).click();
  await expect(page).not.toHaveURL(/page=/);
  await expect(pager).toContainText("64 items");
  await page.getByRole("link", { name: "Only blocked (1)" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveText("Needle 1");
  await expect(pager).toContainText("Showing 1 of 1");
  await goto(page, `${href}&page=2`);
  await page.getByRole("link", { name: "New to-do", exact: true }).click();
  await page
    .getByRole("combobox", { name: "New to-do", exact: true })
    .fill("Needle added #page-a #page-b");
  await page.getByRole("button", { name: "Add to-do", exact: true }).click();
  await expect(page.getByRole("status")).toContainText('Added "Needle added"');
  await expect(pager).toContainText("Showing 60 of 66 items");
  await page.getByRole("status").getByRole("link", { name: "Open it" }).click();
  await expect(
    page.getByRole("dialog", { name: "Needle added", exact: true }),
  ).toBeVisible();
  await expect(rows).toHaveCount(60);
});

test("filters loaded rows before the network answers and finds unloaded matches while typing", async ({
  page,
  request,
}) => {
  test.slow();
  const project = `live-${crypto.randomUUID().slice(0, 8)}`;
  for (let index = 0; index < 35; index += 1) {
    await mcp(request, "create_todo", { title: `Live row ${index}`, project });
  }
  await signIn(page);
  const href = `/todos?${new URLSearchParams({ project })}`;
  await goto(page, href);
  const rows = page.locator(".todo-card .todo-open");
  const search = page.getByRole("searchbox", { name: "Search", exact: true });
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/todos\.data/, async (route) => {
    await held;
    await route.continue();
  });
  try {
    await search.fill("Live row 34");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveText("Live row 34");
    await expect(search).toBeFocused();
  } finally {
    release();
  }
  await expect(page).toHaveURL(/q=Live\+row\+34/);
  await page.unroute(/\/todos\.data/);
  // The oldest row was outside the original prefix, but the server finds it.
  await search.fill("Live row 0");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveText("Live row 0");
  await expect(search).toBeFocused();
  await search.fill("no such row");
  await expect(
    page.getByText("No to-dos match those filters.", { exact: true }),
  ).toBeVisible();
  await search.fill("");
  await expect(rows).toHaveCount(30);
  await expect(search).toBeFocused();
  // A real navigation and Back restore the URL's query, not the last draft.
  await search.fill("Live row 0");
  await expect(page).toHaveURL(/q=Live\+row\+0/);
  await page.getByRole("link", { name: "Memories", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Memories", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(search).toHaveValue("Live row 0");
  await expect(rows.first()).toHaveText("Live row 0");
});

test("extends memories after filters and fetched sorting, and opens unloaded details", async ({
  page,
  request,
}) => {
  test.slow();
  const project = `paging-${crypto.randomUUID().slice(0, 8)}`;
  const ids: string[] = [];
  for (let index = 0; index < 35; index += 1) {
    const made = await mcp(request, "save_memory", {
      title: `Memory ${index}`,
      body: "Paging evidence",
      type: "fact",
      project,
      tags: ["page-a", "page-b"],
    });
    ids.push(z.string().parse(made.id));
  }
  await signIn(page);
  const query = new URLSearchParams({
    q: "Paging evidence",
    project,
    type: "fact",
    tag: "page-a",
  });
  query.append("tag", "page-b");
  const href = `/memories?${query}`;
  await goto(page, href);
  const rows = page.locator("ul.memories a.item-title");
  await expect(rows).toHaveCount(30);
  const first = await rows.allTextContents();
  await page.locator(".infinite-list").scrollIntoViewIfNeeded();
  await expect(rows).toHaveCount(35);
  const last = (await rows.allTextContents()).slice(30);
  expect(new Set([...first, ...last]).size).toBe(35);
  expect([...first, ...last].sort()).toEqual(
    Array.from({ length: 35 }, (_, index) => `Memory ${index}`).sort(),
  );
  const offPage = await rows.nth(30).getAttribute("href");
  const id = new URL(offPage ?? "", page.url()).searchParams.get("open");
  await goto(page, `${href}&open=${encodeURIComponent(id ?? "")}`);
  await expect(
    page.getByRole("dialog", { name: last[0], exact: true }),
  ).toBeVisible();
  await expect(rows).toHaveCount(30);
  await page.keyboard.press("Escape");
  await mcp(request, "fetch", { id });
  await mcp(request, "fetch", { id });
  await goto(page, `${href}&page=2`);
  await page
    .getByRole("button", { name: "Sort memories", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Most fetched" }).click();
  await expect(page).not.toHaveURL(/page=/);
  await expect(rows).toHaveCount(30);
  await expect(rows.first()).toHaveText(last[0]);
  await page.locator(".infinite-list").scrollIntoViewIfNeeded();
  await expect(rows).toHaveCount(35);
  await page
    .getByRole("searchbox", { name: "Search", exact: true })
    .fill("Memory 0");
  await expect(page).not.toHaveURL(/page=/);
  await expect(rows).toHaveCount(1);
  await expect(
    page.getByRole("searchbox", { name: "Search", exact: true }),
  ).toBeFocused();
  await page.getByRole("searchbox", { name: "Search", exact: true }).fill("");
  await expect(rows).toHaveCount(30);
});

test("extends skills without duplicates and opens a skill id outside the loaded rows", async ({
  page,
  request,
}) => {
  test.slow();
  const project = `paging-${crypto.randomUUID().slice(0, 8)}`;
  const names: string[] = [];
  const ids: string[] = [];
  for (let index = 0; index < 35; index += 1) {
    const name = `${project}-${String(index).padStart(2, "0")}`;
    names.push(name);
    const made = await mcp(request, "publish_skill", {
      body: `---\nname: ${name}\ndescription: Paging evidence\n---\nBody`,
      project,
      tags: ["page-a", "page-b"],
    });
    ids.push(z.string().parse(made.id));
  }
  await signIn(page);
  const query = new URLSearchParams({
    q: "Paging evidence",
    project,
    tag: "page-a",
  });
  query.append("tag", "page-b");
  const href = `/skills?${query}`;
  await goto(page, href);
  const rows = page.locator("ul.skill-list a.item-title");
  await expect(rows).toHaveCount(30);
  await page.locator(".infinite-list").scrollIntoViewIfNeeded();
  await expect(rows).toHaveCount(35);
  expect(await rows.allTextContents()).toEqual(names);
  await goto(page, `${href}&open=${encodeURIComponent(ids[34])}`);
  await expect(
    page.getByRole("dialog", { name: names[34], exact: true }),
  ).toBeVisible();
  await expect(rows).toHaveCount(30);
  await page.keyboard.press("Escape");
  await page.locator(".infinite-list").scrollIntoViewIfNeeded();
  await expect(rows).toHaveCount(35);
  await goto(page, `${href}&page=999`);
  await expect(rows).toHaveCount(35);
  await expect(page.locator(".infinite-list")).toContainText(
    "Showing 35 of 35 items",
  );
  await goto(page, href);
  const search = page.getByRole("searchbox", { name: "Search", exact: true });
  await search.fill(names[34]);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveText(names[34]);
  await expect(search).toBeFocused();
  await expect(page).not.toHaveURL(/page=/);
  await search.fill("missing-skill");
  await search.fill(names[0]);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveText(names[0]);
});
