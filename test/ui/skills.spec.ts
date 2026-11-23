import type { APIRequestContext } from "@playwright/test";
import { expect, hydrated, mcp, seed, test } from "./fixtures/session";

async function publish(
  request: APIRequestContext,
  name: string,
  version = 1,
  project?: string,
) {
  await mcp(request, "publish_skill", {
    body: `---\nname: ${name}\ndescription: Summary for version ${version}.\nlicense: license-${version}\ncompatibility: runtime-${version}\n---\n\n# Instructions\n\nFollow version ${version}.`,
    files: [],
    project,
  });
}

test.beforeEach(async ({ request }) => {
  await seed(request);
});

test("list switches reverse by pointer and keyboard without navigating or changing versions", async ({
  page,
  request,
}) => {
  const name = `toggle-${crypto.randomUUID()}`;
  await publish(request, name);
  await page.goto(`/skills?q=${name}`);
  await hydrated(page);
  const row = page.locator(".skill-list li.item-row", { hasText: name });
  const control = row.getByRole("switch", {
    name: `${name} enabled`,
    exact: true,
  });
  await expect(control).toBeChecked();
  const target = await control.boundingBox();
  expect(target!.width).toBeGreaterThanOrEqual(24);
  expect(target!.height).toBeGreaterThanOrEqual(24);
  const title = await row
    .getByRole("link", { name, exact: true })
    .boundingBox();
  expect(target!.y).toBeLessThan(title!.y + title!.height);
  expect(target!.y + target!.height).toBeGreaterThan(title!.y);
  // The switch sits with the row's facts on the right, clear of the title
  // whose hit area covers the row, so a toggle never opens the pane.
  expect(target!.x).toBeGreaterThanOrEqual(title!.x + title!.width);
  const description = await row.locator(".item-description").boundingBox();
  expect(description!.y).toBeGreaterThanOrEqual(title!.y + title!.height);
  const here = page.url();
  const before = await row.boundingBox();
  await control.click();
  await expect(control).not.toBeChecked();
  await expect(control).toBeEnabled();
  expect(page.url()).toBe(here);
  expect(
    Math.abs((await row.boundingBox())!.y - before!.y),
  ).toBeLessThanOrEqual(1);
  await control.focus();
  await control.press("Space");
  await expect(control).toBeChecked();
  await expect(control).toBeEnabled();
  await control.press("Enter");
  await expect(control).not.toBeChecked();
  await expect(control).toBeEnabled();
  await control.click();
  await expect(control).toBeChecked();
  await row.getByRole("link", { name, exact: true }).click();
  const dialog = page.getByRole("dialog", { name, exact: true });
  await expect(
    dialog.getByRole("button", { name: /^v\d+$/, exact: true }),
  ).toHaveCount(1);
  await expect(
    dialog.getByRole("switch", { name: "Skill enabled", exact: true }),
  ).toBeChecked();
});

test("list switches remain reversible with scripting off", async ({
  browser,
  baseURL,
  request,
}) => {
  const name = `noscript-${crypto.randomUUID()}`;
  await publish(request, name);
  const context = await browser.newContext({
    baseURL,
    javaScriptEnabled: false,
  });
  try {
    const page = await context.newPage();
    await page.goto(`/skills?q=${name}`);
    const control = page.getByRole("switch", {
      name: `${name} enabled`,
      exact: true,
    });
    await expect(control).toBeChecked();
    await control.press("Space");
    await expect(control).not.toBeChecked();
    await control.press("Enter");
    await expect(control).toBeChecked();
    await expect(page).toHaveURL(`/skills?q=${name}`);
  } finally {
    await context.close();
  }
});

test("selected-version summary and metadata stay accurate without duplicate frontmatter", async ({
  page,
  request,
}) => {
  const name = `history-${crypto.randomUUID()}`;
  await publish(request, name, 1);
  await publish(request, name, 2);
  await page.setViewportSize({ width: 1280, height: 900 });
  // The detail must also load when its row is excluded from the visible list.
  await page.goto(`/skills?q=not-this-skill&open=${name}`);
  await hydrated(page);
  const dialog = page.getByRole("dialog", { name, exact: true });
  // Details open in the right-hand pane, docked on the window's edge.
  const pane = (await dialog.boundingBox())!;
  expect(Math.abs(pane.x + pane.width - 1280)).toBeLessThanOrEqual(1);
  expect(pane.width).toBeGreaterThanOrEqual(360);
  await expect(dialog.locator(".skill-summary")).toHaveText(
    "Summary for version 2.",
  );
  await expect(
    dialog.getByText("Summary for version 2.", { exact: true }),
  ).toHaveCount(1);
  const metadata = dialog.getByRole("table", { name: "SKILL.md frontmatter" });
  await expect(
    metadata.getByRole("rowheader", { name: "description", exact: true }),
  ).toHaveCount(0);
  await expect(metadata).toContainText("license-2");
  await dialog.getByRole("button", { name: "v1", exact: true }).click();
  await expect(dialog.locator(".skill-summary")).toHaveText(
    "Summary for version 1.",
  );
  await expect(dialog.locator(".skill-summary")).not.toContainText("version 2");
  await expect(metadata).toContainText("license-1");
  await expect(metadata).toContainText("runtime-1");
  await expect(metadata).not.toContainText("license-2");
  await expect(dialog.locator(".prose")).toContainText("Follow version 1.");
  await expect(dialog.getByText(/Viewing v1/)).toContainText(
    "edits the head, v2",
  );
  await dialog
    .getByRole("link", { name: "Edit SKILL.md", exact: true })
    .click();
  await expect(
    dialog.getByRole("textbox", { name: "SKILL.md", exact: true }),
  ).toHaveValue(/description: Summary for version 2/);
});

test("Add skill keeps curated previews beside registry search on narrow screens and without scripts", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const path = "/skills?project=valise&add=search";
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(path);
    await hydrated(page);
    const dialog = page.getByRole("dialog", { name: "Add skill", exact: true });
    await expect(
      dialog.getByRole("searchbox", { name: "Find a skill on skills.sh" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("region", { name: "Suggested skills" }),
    ).toBeVisible();
    await expect(
      dialog
        .getByRole("region", { name: "Suggested skills" })
        .getByRole("link", { name: "find-skills", exact: true }),
    ).toHaveAttribute(
      "href",
      /project=valise&add=search&find=find-skills&preview=/,
    );
    expect(
      await dialog.locator(".modal-body").evaluate((element) => {
        const node = element as unknown as {
          scrollWidth: number;
          clientWidth: number;
        };
        return node.scrollWidth - node.clientWidth;
      }),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: testInfo.outputPath(`add-skill-suggestions-${width}.png`),
    });
  }
  const context = await browser.newContext({
    baseURL,
    javaScriptEnabled: false,
  });
  try {
    const plain = await context.newPage();
    await plain.goto(path);
    const dialog = plain.getByRole("dialog", {
      name: "Add skill",
      exact: true,
    });
    await expect(
      dialog.getByRole("searchbox", { name: "Find a skill on skills.sh" }),
    ).toBeVisible();
    await expect(
      dialog
        .getByRole("region", { name: "Suggested skills" })
        .getByRole("link", { name: "conversation-history", exact: true }),
    ).toHaveAttribute("href", /project=valise&add=url&url=https/);
  } finally {
    await context.close();
  }
});

test("skill detail contains long metadata on narrow screens with reduced motion", async ({
  page,
  request,
}) => {
  const name = `narrow-${crypto.randomUUID()}`;
  await publish(request, name, 1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/skills?open=${name}`);
    await hydrated(page);
    const dialog = page.getByRole("dialog", { name, exact: true });
    await dialog
      .getByText("Skill settings and activity", { exact: true })
      .click();
    const box = await dialog.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(width);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(
      await page.evaluate<number>(`document.documentElement.scrollWidth`),
    ).toBeLessThanOrEqual(width);
    expect(
      await dialog.locator(".modal-body").evaluate((element) => {
        const node = element as unknown as {
          scrollWidth: number;
          clientWidth: number;
        };
        return node.scrollWidth - node.clientWidth;
      }),
    ).toBeLessThanOrEqual(1);
  }
});
