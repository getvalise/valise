import type { APIRequestContext, Page } from "@playwright/test";
import { expect, goto, hydrated, mcp, test } from "./fixtures/session";

/**
 * Grouping files the person already saved: tick folder rows and put them in
 * one folder, or take one file out into a new folder. Owner, 2026-11-02.
 * ADR-0015, amendment of 2026-11-02 (grouping). Synthetic files.
 */

async function file(request: APIRequestContext, name: string) {
  const bytes = Buffer.from(`synthetic ${name}`);
  const begun = await mcp(request, "upload_asset", {
    file_name: name,
    content_type: "text/plain",
    size: bytes.byteLength,
    title: name,
  });
  expect((await request.put(begun.upload.url, { data: bytes })).status()).toBe(
    200,
  );
  return begun.id as string;
}

async function three(request: APIRequestContext) {
  const run = crypto.randomUUID().slice(0, 8);
  const names = ["light", "dark", "mono"].map((n) => `${n}-${run}.txt`);
  const ids = [];
  for (const name of names) ids.push(await file(request, name));
  return { run, names, ids };
}

const bar = (page: Page) => page.getByRole("form", { name: "Group folders" });

test("ticks folder rows and groups them into one named folder", async ({
  page,
  request,
}) => {
  const { run, names, ids } = await three(request);
  await goto(page, `/library?view=documents&q=${run}`);
  await hydrated(page);
  await expect(bar(page)).toHaveCount(0);
  await page.getByRole("checkbox", { name: `Select ${names[0]}` }).check();
  await expect(bar(page)).toContainText("1 folder selected");
  await expect(
    bar(page).getByRole("button", { name: "Group into one folder" }),
  ).toBeDisabled();
  await page.getByRole("checkbox", { name: `Select ${names[1]}` }).check();
  await bar(page).getByLabel("New folder name (optional)").fill(`Icons ${run}`);
  await bar(page)
    .getByRole("button", { name: "Group into one folder" })
    .click();
  const folder = page.getByRole("region", { name: "Folder files" });
  await expect(folder).toContainText(`Folder: Icons ${run}`);
  await expect(
    folder.getByLabel("Files in this folder").getByRole("link"),
  ).toHaveCount(2);
  const fetched = await mcp<{ metadata: { folder: { count: number } } }>(
    request,
    "fetch",
    { id: ids[2] },
  );
  expect(fetched.metadata.folder.count).toBe(1);
});

test("takes one file out into a new folder from the move dialog", async ({
  page,
  request,
}) => {
  const { run, ids } = await three(request);
  await mcp(request, "update_asset", { id: ids[1], folder: ids[0] });
  await goto(
    page,
    `/library?view=documents&details=${encodeURIComponent(ids[1])}&move=1`,
  );
  await hydrated(page);
  const dialog = page.getByRole("dialog", { name: "Move file to a folder" });
  await dialog
    .getByLabel("Or move it to a new folder named")
    .fill(`Split ${run}`);
  await dialog.getByRole("button", { name: "Move to a new folder" }).click();
  // The post redirects out of the dialog once the move is written.
  await expect(page).not.toHaveURL(/move=1/);
  const fetched = await mcp<{
    metadata: { folder: { name: string; count: number } };
  }>(request, "fetch", { id: ids[1] });
  expect(fetched.metadata.folder).toMatchObject({
    name: `Split ${run}`,
    count: 1,
  });
});

test.describe("with scripting off", () => {
  test.use({ javaScriptEnabled: false });
  test("the bar is always there, groups through a plain post, and refuses one folder", async ({
    page,
    request,
  }) => {
    const { run, names } = await three(request);
    await page.goto(`/library?view=documents&q=${run}`);
    await expect(bar(page)).toContainText("Tick two or more folders");
    await page.getByRole("checkbox", { name: `Select ${names[0]}` }).check();
    await bar(page)
      .getByRole("button", { name: "Group into one folder" })
      .click();
    await expect(bar(page).getByRole("alert")).toContainText(
      "at least two folders",
    );
    await page.getByRole("checkbox", { name: `Select ${names[0]}` }).check();
    await page.getByRole("checkbox", { name: `Select ${names[2]}` }).check();
    await bar(page)
      .getByRole("button", { name: "Group into one folder" })
      .click();
    await expect(
      page
        .getByRole("region", { name: "Folder files" })
        .getByLabel("Files in this folder")
        .getByRole("link"),
    ).toHaveCount(2);
  });
});

for (const [name, viewport] of [
  ["desktop", { width: 1280, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
] as const)
  test(`the selection boxes and bar fit at ${name} width with 24px targets`, async ({
    page,
    request,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const { run, names } = await three(request);
    await goto(page, `/library?view=documents&q=${run}`);
    await hydrated(page);
    for (const n of names.slice(0, 2))
      await page.getByRole("checkbox", { name: `Select ${n}` }).check();
    await expect(bar(page)).toBeVisible();
    await expect(
      bar(page).getByRole("button", { name: "Group into one folder" }),
    ).toBeEnabled();
    for (const n of names) {
      const box = await page
        .locator(".library-select", {
          has: page.getByRole("checkbox", { name: `Select ${n}` }),
        })
        .boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(24);
      expect(box?.height).toBeGreaterThanOrEqual(24);
    }
    expect(
      await page.evaluate(
        "document.documentElement.scrollWidth <= window.innerWidth",
      ),
    ).toBe(true);
    await testInfo.attach(`grouping-${name}`, {
      // Finish the enable transition so the shot shows the settled button.
      body: await page.screenshot({ animations: "disabled" }),
      contentType: "image/png",
    });
  });
