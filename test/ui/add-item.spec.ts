import { expect, goto, seed, test } from "./fixtures/session";

test.beforeEach(async ({ request }) => {
  await seed(request);
});

test("add controls borrow the next item's shape and keep named keyboard targets", async ({
  page,
  request,
  browser,
}) => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    // A list's create control is its first item, an empty row with the
    // action named on it (P8). Its stitched edge is styling; not pinned here.
    await goto(page, "/todos");
    const todos = page.locator("ul.todo-list");
    const todo = todos.getByRole("link", { name: "New to-do", exact: true });
    await expect(todos.locator(":scope > li").first()).toHaveClass(/add-row/);
    await expect(todos.locator(":scope > li").first()).toContainText(
      "New to-do",
    );
    expect((await todo.boundingBox())?.height).toBeGreaterThanOrEqual(24);
    await todo.focus();
    await page.keyboard.press("Enter");
    // The composer opens in the list, where the row was.
    await expect(
      todos.getByRole("combobox", { name: "New to-do", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(todo).toBeFocused();

    await goto(page, "/hooks");
    const cards = page.locator(".add-item-card");
    await expect(cards).toHaveCount(3);
    const hook = page.getByRole("link", {
      name: "Add a Stop entry",
      exact: true,
    });
    await expect(hook).toHaveCSS("border-top-style", "dashed");
    expect((await hook.boundingBox())?.height).toBeGreaterThanOrEqual(100);
    await hook.hover();
    const hookLabel = hook.locator(".add-item-label");
    await expect(hookLabel).toHaveCSS("opacity", "1");
    const cardBox = await hook.boundingBox();
    const labelBox = await hookLabel.boundingBox();
    expect(labelBox!.x).toBeGreaterThanOrEqual(cardBox!.x);
    expect(labelBox!.x + labelBox!.width).toBeLessThanOrEqual(
      cardBox!.x + cardBox!.width,
    );
    await hook.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("textbox", { name: "New Stop text", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");

    await goto(page, "/skills?project=valise");
    const skills = page.getByRole("list", { name: "Skills", exact: true });
    const skill = skills.getByRole("link", { name: "Add skill", exact: true });
    await expect(skills.locator(":scope > li").first()).toContainText(
      "Add skill",
    );
    expect((await skill.boundingBox())?.height).toBeGreaterThanOrEqual(24);
    await skill.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("dialog", { name: "Add skill", exact: true }),
    ).toBeVisible();
  }
  await goto(page, "/connections");
  const token = page.getByRole("link", {
    name: "Create bearer token",
    exact: true,
  });
  await expect(token).toHaveCSS("border-top-style", "dashed");
  await token.click();
  await expect(page).toHaveURL(/#new-token$/);
  const plain = await browser.newContext({
    javaScriptEnabled: false,
  });
  try {
    const tab = await plain.newPage();
    await tab.goto("/hooks");
    await tab
      .getByRole("link", { name: "Add a Stop entry", exact: true })
      .click();
    await expect(
      tab.getByRole("textbox", { name: "New Stop text", exact: true }),
    ).toBeVisible();
    await expect(
      tab.getByRole("button", { name: "Save", exact: true }),
    ).toBeVisible();
  } finally {
    await plain.close();
  }
});

test("create labels stay visible and hover or focus never shifts the list", async ({
  page,
}) => {
  await goto(page, "/todos");
  const name = await page
    .getByRole("navigation", { name: "Workspace" })
    .locator('a[href="/account"]')
    .innerText();
  await expect(page.locator(".page-header p").last()).toContainText(
    `Hello, ${name}.`,
  );
  // An add row names its action at rest; pointing at it or focusing it
  // moves neither the row nor the item after it (P4).
  for (const [path, label] of [
    ["/todos", "New to-do"],
    ["/skills", "Add skill"],
  ]) {
    await goto(page, path);
    const add = page.getByRole("link", { name: label, exact: true });
    await page.mouse.move(0, 0);
    await expect(add).toHaveText(label);
    await expect(add).toHaveCSS("opacity", "1");
    const before = await add.boundingBox();
    const next = page.locator("li.add-row + li");
    const nextBefore = await next.boundingBox();
    await add.hover();
    expect(await add.boundingBox()).toEqual(before);
    expect(await next.boundingBox()).toEqual(nextBefore);
    await page.mouse.move(0, 0);
    await add.focus();
    expect(await add.boundingBox()).toEqual(before);
    expect(await next.boundingBox()).toEqual(nextBefore);
  }
  // An empty card is still the create control on /hooks; its label reveals
  // under the plus without moving it.
  await goto(page, "/hooks");
  const add = page.getByRole("link", { name: "Add a Stop entry", exact: true });
  const text = add.locator(".add-item-label");
  await add.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await expect(text).toHaveCSS("opacity", "0");
  const before = await add.boundingBox();
  const plus = add.locator(".add-item-mark > svg");
  const plusBefore = await plus.boundingBox();
  // The label translates during reveal. Transformed rectangle coordinates
  // can round width by ~0.00006px; compare layout width to detect reflow.
  const labelWidthBefore = await text.evaluate(
    "element => getComputedStyle(element).width",
  );
  await add.hover();
  for (let frame = 0; frame < 12; frame += 1) {
    // Check during the transition too: no width/gap reflow between endpoints.
    await page.evaluate(
      "new Promise(resolve => requestAnimationFrame(resolve))",
    );
    expect(await plus.boundingBox()).toEqual(plusBefore);
    expect(
      await text.evaluate("element => getComputedStyle(element).width"),
    ).toBe(labelWidthBefore);
  }
  await expect(text).toHaveCSS("opacity", "1");
  expect((await text.boundingBox())!.width).toBeGreaterThan(30);
  await page.mouse.move(0, 0);
  await add.focus();
  await expect(text).toHaveCSS("opacity", "1");
  expect(await add.boundingBox()).toEqual(before);
});

test("touch keeps create labels visible and reduced motion disables animation", async ({
  browser,
}) => {
  const touch = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
  });
  try {
    const tab = await touch.newPage();
    await goto(tab, "/todos");
    const row = tab.getByRole("link", { name: "New to-do", exact: true });
    await expect(row).toBeVisible();
    expect((await row.boundingBox())!.width).toBeGreaterThan(30);
    await goto(tab, "/hooks");
    const label = tab
      .getByRole("link", { name: "Add a Stop entry", exact: true })
      .locator(".add-item-label");
    await expect(label).toHaveCSS("opacity", "1");
    await expect(label).toHaveCSS("transition-duration", "0s");
    expect((await label.boundingBox())!.width).toBeGreaterThan(30);
  } finally {
    await touch.close();
  }
});
