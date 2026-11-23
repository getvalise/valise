import type { APIRequestContext, Page } from "@playwright/test";
import { expect, goto, hydrated, mcp, test } from "./fixtures/session";

/**
 * A folder's own tags and notes: a group kept as a whole, beside each
 * file's. One field per commit (P2), tags as a chip set (P7), an empty value
 * is the control that fills it (P8). ADR-0015, amendment of 2026-11-02.
 * Synthetic files.
 */

async function file(request: APIRequestContext, name: string) {
  const bytes = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg">${name}</svg>`,
  );
  const begun = await mcp(request, "upload_asset", {
    file_name: name,
    content_type: "image/svg+xml",
    size: bytes.byteLength,
  });
  expect((await request.put(begun.upload.url, { data: bytes })).status()).toBe(
    200,
  );
  return begun.id as string;
}

async function folder(request: APIRequestContext) {
  const run = crypto.randomUUID().slice(0, 8);
  const light = await file(request, `icon-light-${run}.svg`);
  const dark = await file(request, `icon-dark-${run}.svg`);
  await mcp(request, "update_asset", {
    id: dark,
    folder: light,
    folder_name: `Icons ${run}`,
  });
  return { run, light };
}

const section = (page: Page) =>
  page.getByRole("region", { name: "Folder files" });

test("tags and notes a folder as a whole, and the Library filter finds it by its tag", async ({
  page,
  request,
}) => {
  const { run, light } = await folder(request);
  await goto(
    page,
    `/library?view=documents&details=${encodeURIComponent(light)}`,
  );
  await hydrated(page);
  const here = section(page);
  await here.getByRole("link", { name: "Add folder tags" }).click();
  const box = here.getByRole("combobox", { name: "Add folder tag" });
  await box.fill(`brand-${run}`);
  await box.press("Enter");
  await expect(here).toContainText(`brand-${run}`);
  await here.getByRole("link", { name: "Add folder notes" }).click();
  await here
    .getByRole("textbox", { name: "Folder notes" })
    .fill(`Exported from the style guide ${run}.`);
  await here.getByRole("button", { name: "Save" }).click();
  await expect(here).toContainText(`Exported from the style guide ${run}.`);

  await page.reload();
  await expect(section(page)).toContainText(`brand-${run}`);
  await expect(section(page)).toContainText(
    `Exported from the style guide ${run}.`,
  );

  // No file carries the tag; the folder does, and the filter finds it.
  await goto(page, `/library?view=documents&tag=brand-${run}`);
  await expect(
    page.getByRole("heading", { name: `Icons ${run}`, exact: true }),
  ).toBeVisible();

  const fetched = await mcp<{
    metadata: { folder: { tags: string[]; notes: string; count: number } };
  }>(request, "fetch", { id: light });
  expect(fetched.metadata.folder).toMatchObject({
    tags: [`brand-${run}`],
    notes: `Exported from the style guide ${run}.`,
    count: 2,
  });
});

test.describe("with scripting off", () => {
  test.use({ javaScriptEnabled: false });
  test("writes folder notes through a plain form post", async ({
    page,
    request,
  }) => {
    const { run, light } = await folder(request);
    await page.goto(
      `/library?view=documents&details=${encodeURIComponent(light)}`,
    );
    await section(page).getByRole("link", { name: "Add folder notes" }).click();
    await section(page)
      .getByRole("textbox", { name: "Folder notes" })
      .fill(`Plain post ${run}`);
    await section(page).getByRole("button", { name: "Save" }).click();
    await expect(section(page)).toContainText(`Plain post ${run}`);
  });
});

for (const [name, viewport] of [
  ["desktop", { width: 1280, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
] as const)
  test(`the folder pane shows its tags and notes at ${name} width`, async ({
    page,
    request,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const { run, light } = await folder(request);
    await mcp(request, "update_asset", {
      id: light,
      folder_name: `Icons ${run}`,
    });
    await goto(
      page,
      `/library?view=documents&details=${encodeURIComponent(light)}`,
    );
    await hydrated(page);
    const here = section(page);
    await expect(
      here.getByRole("link", { name: "Add folder tags" }),
    ).toBeVisible();
    await expect(
      here.getByRole("link", { name: "Add folder notes" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        "document.documentElement.scrollWidth <= window.innerWidth",
      ),
    ).toBe(true);
    await testInfo.attach(`folder-pane-${name}`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
