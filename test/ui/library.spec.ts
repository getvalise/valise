import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import {
  addBookmark,
  addDocuments,
  closeAddDialog,
  itemDetails,
  pickDocument,
  showView,
} from "./fixtures/library";
import {
  expect,
  goto,
  hydrated,
  mcp,
  seed,
  serveBrowserModules,
  test,
} from "./fixtures/session";

/**
 * The library console, ADR-0015: a file uploaded here is the asset an agent
 * downloads by id, a source cites it, and the citation protects it.
 */

// A 1×1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const unique = (label: string) => `${label}-${crypto.randomUUID().slice(0, 8)}`;
const textFile = (name: string, body = name) => ({
  name,
  mimeType: "text/plain",
  buffer: Buffer.from(body),
});

test.beforeEach(async ({ request }) => {
  await seed(request);
});

async function openLibrary(page: Page, scripting = true) {
  await goto(page, "/library", scripting);
  await addDocuments(page);
  if (scripting)
    await expect(page.locator(".file-dropzone.is-enhanced")).toBeVisible();
}

function item(page: Page, title: string) {
  return page.locator(".library-item", {
    has: page.getByRole("heading", { name: title, exact: true }),
  });
}

async function dropFiles(target: Locator, names: string[]) {
  const dataTransfer = await target.page().evaluateHandle(`(() => {
    const transfer = new DataTransfer();
    for (const name of ${JSON.stringify(names)}) transfer.items.add(new File([name], name, { type: 'text/plain' }));
    return transfer;
  })()`);
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });
}

async function createTodo(
  request: APIRequestContext,
  title: string,
): Promise<string> {
  return (await mcp(request, "create_todo", { title, project: "valise" }))
    .id as string;
}

test("uploads a file, cites it from a source, and refuses to delete it while cited", async ({
  page,
  request,
}) => {
  await goto(page, "/library");
  await page.locator(".library-help > summary").click();
  await expect(
    page.getByText(
      "Unsupported or unprocessed files have metadata-only search.",
    ),
  ).toBeVisible();
  const upload = await addDocuments(page);
  await expect(upload.locator(".file-dropzone.is-enhanced")).toBeVisible();

  const title = unique("Ptarmigan screenshot");
  await upload.getByLabel(/^File, up to/).setInputFiles({
    name: "ptarmigan.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await upload.getByLabel("Title", { exact: true }).fill(title);
  await upload.getByRole("button", { name: "Upload", exact: true }).click();
  const card = page.locator(".library-item", {
    has: page.getByRole("heading", { name: title }),
  });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Image");
  await closeAddDialog(page);

  // The preview fetches the bytes through the owner's /files route.
  await card
    .getByRole("link", { name: `Preview ${title}`, exact: true })
    .click();
  await expect(page.getByRole("dialog").locator("img")).toBeVisible();
  await page.keyboard.press("Escape");

  // The empty description is the control that fills it. P8.
  await itemDetails(card);
  await card.getByRole("link", { name: "Add a description" }).click();
  await card
    .getByRole("textbox", { name: "Description" })
    .fill("The login form, before the fix");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card).toContainText("The login form, before the fix");

  // Another client consumes the same bytes by id, over MCP.
  const assetId =
    (await card.locator('input[name="id"]').first().inputValue()) ?? "";
  expect(assetId).toMatch(/^asset:ast_/);
  const download = await mcp(
    request,
    "get_asset_download",
    { id: assetId },
    { agent: "library-ui-machine-b", client: "playwright" },
  );
  const url = new URL(download.url);
  const bytes = await request.get(`${url.pathname}${url.search}`);
  expect(Buffer.from(await bytes.body())).toEqual(PNG);

  // A source cites the file.
  const sourceTitle = unique("Ptarmigan login bug");
  const form = await addBookmark(page, true);
  await form.getByLabel("Title", { exact: true }).fill(sourceTitle);
  await form
    .getByLabel("Notes", { exact: true })
    .fill("The submit button sat under the cookie banner.");
  await pickDocument(form, "Attach a saved document (optional)", title);
  await form.getByRole("button", { name: "Save bookmark" }).click();
  const source = page.locator(".library-item", {
    has: page.getByRole("heading", { name: sourceTitle }),
  });
  await expect(source).toBeVisible();
  // A saved bookmark closes its dialog and empties the form, so it cannot be
  // saved twice.
  await expect(
    page.getByRole("dialog", { name: "Add a bookmark" }),
  ).toBeHidden();
  await addBookmark(page);
  await expect(form.getByLabel("Title", { exact: true })).toHaveValue("");
  await expect(form.getByLabel("Notes", { exact: true })).toHaveValue("");
  await closeAddDialog(page);
  await expect(source.getByText(/^Revision \d+$/)).toHaveCount(0);

  // A field save is a revision.
  await itemDetails(source);
  await expect(
    source.getByRole("button", { name: `Unlink ${title}`, exact: true }),
  ).toBeVisible();
  await source.getByRole("link", { name: "Edit notes" }).click();
  await source
    .getByRole("textbox", { name: "Notes" })
    .fill("The submit button sat under the cookie banner on mobile.");
  await source.getByRole("button", { name: "Save" }).click();
  await expect(source.locator('input[name="revision"]').first()).toHaveValue(
    "2",
  );

  // The citation protects the file, and says who holds it.
  await showView(page, "Documents");
  await itemDetails(card);
  await card
    .getByRole("button", { name: `Delete permanently: ${title}` })
    .click();
  await expect(card.getByRole("alert")).toContainText(sourceTitle);
  await expect(card).toBeVisible();

  // Archiving the source moves it, it does not delete it. P5. Only one
  // item's details are open at a time, so open the source's again.
  await showView(page, "Bookmarks");
  await itemDetails(source);
  await source.getByRole("button", { name: `Archive ${sourceTitle}` }).click();
  await expect(page.getByRole("heading", { name: sourceTitle })).toHaveCount(0);
  await page.getByRole("link", { name: "Archived" }).click();
  await expect(page.getByRole("heading", { name: sourceTitle })).toBeVisible();
});

test("uploads files, sets retention, saves a bookmark and attaches to a to-do with scripting off", async ({
  browser,
  request,
}, testInfo) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await openLibrary(page, false);
  const title = unique("Godwit chart");
  const dialog = page.getByRole("dialog", { name: "Upload documents" });
  await dialog.getByLabel(/^File, up to/).setInputFiles({
    name: "godwit.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await dialog.getByLabel("Title", { exact: true }).fill(title);
  await dialog
    .getByLabel("Retention")
    .selectOption({ label: "Delete after 1 day" });
  await dialog.getByRole("button", { name: "Upload", exact: true }).click();
  const card = page.locator(".library-item", {
    has: page.getByRole("heading", { name: title }),
  });
  await itemDetails(card);
  await expect(card).toContainText("Deleted after");

  const bookmark = unique("Godwit migration map");
  const form = await addBookmark(page, true);
  await form.getByLabel("Title", { exact: true }).fill(bookmark);
  await form
    .getByLabel("URL", { exact: true })
    .fill("https://example.com/godwit");
  await form.getByRole("button", { name: "Save bookmark" }).click();
  await expect(page.getByRole("heading", { name: bookmark })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({
    path: testInfo.outputPath("library-bookmark-noscript-390.png"),
    fullPage: true,
  });
  // An expiring file is not offered to a source: it would vanish under it.
  await expect(
    page.locator('select[name="asset"] option').filter({ hasText: title }),
  ).toHaveCount(0);

  // Several picked files upload independently, each with its own result.
  await addDocuments(page);
  const upload = page.locator(".library-upload");
  await expect(upload.locator('input[type="file"]')).toBeVisible();
  await expect(
    upload.getByRole("button", { name: "Choose files" }),
  ).toHaveCount(0);
  const names = [unique("noscript-one.txt"), unique("noscript-two.txt")];
  const empty = unique("noscript-empty.txt");
  await upload
    .locator('input[type="file"]')
    .setInputFiles([
      textFile(names[0]),
      textFile(empty, ""),
      textFile(names[1]),
    ]);
  await upload.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(item(page, names[0])).toContainText("2 files");
  await expect(
    upload.getByRole("list", { name: "Upload results" }),
  ).toContainText(`${empty}: Not uploaded — That file is empty.`);
  const retained = item(page, names[0]);
  await itemDetails(retained);
  await retained
    .getByRole("combobox", { name: "Retention", exact: true })
    .selectOption("86400");
  await retained.getByRole("button", { name: "Set", exact: true }).click();
  await expect(
    retained.getByRole("combobox", { name: "Retention", exact: true }),
  ).toHaveValue("current");
  const todoTitle = unique("No script attachment");
  const id = await createTodo(request, todoTitle);
  await page.goto(`/todos?open=${encodeURIComponent(id)}`);
  const files = page.getByRole("region", { name: `Files on ${todoTitle}` });
  await files.getByRole("link", { name: "Add files" }).click();
  const adding = page.getByRole("dialog", { name: "Add files" });
  await expect(adding.locator('input[type="file"]')).toBeVisible();
  await adding
    .locator('input[type="file"]')
    .setInputFiles(textFile("noscript-attached.txt"));
  await adding.getByRole("button", { name: "Attach", exact: true }).click();
  await expect(
    files.getByRole("link", { name: "noscript-attached.txt", exact: true }),
  ).toBeVisible();
  await context.close();
});

test("uploads picked files into one folder, preserves a typed title, and reports each failure", async ({
  page,
}) => {
  await openLibrary(page);
  const upload = page.locator(".library-upload");
  const customTitle = unique("User title");
  const first = unique("first.txt");
  const last = unique("last.txt");
  const empty = unique("empty.txt");
  await upload.getByLabel("Title", { exact: true }).fill(customTitle);
  await upload
    .locator('input[type="file"]')
    .setInputFiles([textFile(first), textFile(empty, ""), textFile(last)]);
  await expect(upload.getByLabel("Title", { exact: true })).toBeDisabled();
  await upload.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(item(page, first)).toBeVisible();
  await expect(item(page, first)).toContainText("2 files");
  await expect(item(page, last)).toHaveCount(0);
  await expect(item(page, empty)).toHaveCount(0);
  await expect(
    upload.getByRole("list", { name: "Upload results" }),
  ).toContainText(`${empty}: Not uploaded — That file is empty.`);
  await expect(
    upload.getByRole("list", { name: "Upload results" }),
  ).toContainText(`${last}: Uploaded`);
  await expect(upload.getByLabel("Title", { exact: true })).toBeEnabled();
  await expect(upload.getByLabel("Title", { exact: true })).toHaveValue(
    customTitle,
  );
  await upload
    .locator('input[type="file"]')
    .setInputFiles(textFile(unique("single.txt")));
  await upload.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(item(page, customTitle)).toBeVisible();
});

test("offers a keyboard picker and a large multi-file Library drop area", async ({
  page,
}) => {
  await openLibrary(page);
  const zone = page.locator(".library-upload .file-dropzone");
  expect((await zone.boundingBox())?.height).toBeGreaterThanOrEqual(130);
  const picker = zone.getByRole("button", { name: "Choose files" });
  await picker.focus();
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await chooser).setFiles(textFile(unique("picked.txt")));
  const names = [unique("drop-one.txt"), unique("drop-two.txt")];
  await dropFiles(zone, names);
  await expect(zone.getByRole("status")).toContainText(names[1]);
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(item(page, names[0])).toContainText("2 files");
});

test("edits asset and source tags, preserves expiry, and keeps Archive distinct from Delete", async ({
  page,
}) => {
  await openLibrary(page);
  const name = unique("tagged.txt");
  await page
    .locator('.library-upload input[type="file"]')
    .setInputFiles(textFile(name));
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  const card = item(page, name);
  await expect(card).toBeVisible();
  await itemDetails(card);
  await expect(card.locator(".library-id")).toHaveCount(0);
  const actions = card.locator(".library-actions");
  await expect(actions.getByRole("link")).toHaveCount(1);
  await expect(actions.getByRole("button")).toHaveCount(3);
  const actionBoxes = await Promise.all(
    (await actions.locator("a, button").all()).map((action) =>
      action.boundingBox(),
    ),
  );
  for (const box of actionBoxes) {
    expect(Math.abs(box!.y - actionBoxes[0]!.y)).toBeLessThanOrEqual(1);
    expect(box!.height).toBeGreaterThanOrEqual(24);
  }
  await card.getByRole("link", { name: "Add tags", exact: true }).click();
  const tag = unique("reference");
  await card.getByRole("combobox", { name: "Add tag" }).fill(tag);
  const savedTag = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/library.data",
  );
  await page.keyboard.press("Enter");
  expect((await savedTag).ok()).toBe(true);
  await expect(
    card.getByRole("button", { name: `Remove ${tag}` }),
  ).toBeVisible();
  await page.reload();
  await itemDetails(card);
  await expect(
    card.getByRole("button", { name: `Remove ${tag}` }),
  ).toBeVisible();
  await card
    .getByRole("combobox", { name: "Retention", exact: true })
    .selectOption("86400");
  await card.getByRole("button", { name: "Set", exact: true }).click();
  await expect(
    card.getByRole("combobox", { name: "Retention", exact: true }),
  ).toHaveValue("current");
  await card.getByRole("button", { name: "Set", exact: true }).click();
  await expect(
    card.getByRole("combobox", { name: "Retention", exact: true }),
  ).toHaveValue("current");
  await card
    .getByRole("combobox", { name: "Retention", exact: true })
    .selectOption("");
  await card.getByRole("button", { name: "Set", exact: true }).click();
  await expect(
    card.getByRole("combobox", { name: "Retention", exact: true }),
  ).toHaveValue("");

  const sourceTitle = unique("Source");
  const form = await addBookmark(page, true);
  await form.getByLabel("Title", { exact: true }).fill(sourceTitle);
  await form.getByLabel("Notes").fill("Keep this source and its original.");
  await pickDocument(form, "Attach a saved document (optional)", name);
  await form.getByRole("button", { name: "Save bookmark" }).click();
  const source = item(page, sourceTitle);
  // Wait for the save to finish closing its dialog before itemDetails tries
  // to close creation UI. Otherwise it can race an already-closing dialog.
  await expect(form).toBeHidden();
  await itemDetails(source);
  await source.getByRole("link", { name: "Add tags", exact: true }).click();
  await source.getByRole("combobox", { name: "Add tag" }).fill(tag);
  await page.keyboard.press("Enter");
  await expect(
    source.getByRole("button", { name: `Remove ${tag}` }),
  ).toBeVisible();
  await expect(source.locator('input[name="revision"]').first()).toHaveValue(
    "2",
  );
  await showView(page, "Documents");
  await itemDetails(card);
  await card
    .getByRole("button", { name: `Delete permanently: ${name}`, exact: true })
    .click();
  await expect(card.getByRole("alert")).toContainText(sourceTitle);
  await card
    .getByRole("combobox", { name: "Retention", exact: true })
    .selectOption("86400");
  await card.getByRole("button", { name: "Set", exact: true }).click();
  await expect(card.getByRole("alert")).toBeVisible();
  const original =
    (await card.getByRole("link", { name: "Download" }).getAttribute("href")) ??
    "";
  const archive = card.getByRole("button", {
    name: `Archive ${name}`,
    exact: true,
  });
  await expect(archive).toHaveText("Archive");
  await expect(archive).toHaveAccessibleDescription(
    /original and links stay available/,
  );
  await expect(
    card.getByRole("button", {
      name: `Delete permanently: ${name}`,
      exact: true,
    }),
  ).toHaveText("Delete permanently");
  await archive.click();
  await expect(item(page, name)).toHaveCount(0);
  expect((await page.request.get(original)).status()).toBe(200);
  await page.getByRole("link", { name: "Archived", exact: true }).click();
  await showView(page, "Documents");
  await expect(item(page, name)).toBeVisible();
  await itemDetails(item(page, name));
  await item(page, name)
    .getByRole("button", { name: `Restore ${name}`, exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Library", exact: true })
    .getByRole("link", { name: "Library", exact: true })
    .click();
  await showView(page, "Documents");
  await expect(item(page, name)).toBeVisible();
});

test("Library cards fill their grid and wrap long content at desktop, 390px and 320px", async ({
  page,
}, testInfo) => {
  await openLibrary(page);
  const name = `${unique("long")}${"unbroken".repeat(18)}.txt`;
  await page
    .locator('.library-upload input[type="file"]')
    .setInputFiles(textFile(name));
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  const card = item(page, name);
  await expect(card).toBeVisible();
  await closeAddDialog(page);
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const bounds = await card.boundingBox();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(
      width + 1,
    );
    expect(
      await page.evaluate(
        "document.documentElement.scrollWidth <= window.innerWidth",
      ),
    ).toBe(true);
    expect(
      await card.evaluate((node) => {
        const element = node as unknown as {
          scrollWidth: number;
          clientWidth: number;
        };
        return element.scrollWidth <= element.clientWidth;
      }),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`recording-library-${width}.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  const grid = page
    .getByRole("region", { name: "Documents", exact: true })
    .locator(".library-grid");
  const cards = grid.locator(":scope > .library-item");
  const first = await cards.first().boundingBox();
  const gridBox = await grid.boundingBox();
  if ((await cards.count()) === 1) {
    const padding = await grid.evaluate((node) => {
      const { getComputedStyle } = globalThis as unknown as {
        getComputedStyle(element: unknown): {
          paddingLeft: string;
          paddingRight: string;
          borderLeftWidth: string;
          borderRightWidth: string;
        };
      };
      const style = getComputedStyle(node);
      // The list is one bordered box; a row fills it inside the border.
      return (
        Number.parseFloat(style.paddingLeft) +
        Number.parseFloat(style.paddingRight) +
        Number.parseFloat(style.borderLeftWidth) +
        Number.parseFloat(style.borderRightWidth)
      );
    });
    expect(first?.width).toBeCloseTo((gridBox?.width ?? 0) - padding, 0);
  }
});

test("attachment drop targets work without replacing whole-modal multi-file drops", async ({
  page,
  request,
}) => {
  const title = unique("Attachment drop");
  const id = await createTodo(request, title);
  await page.goto(`/todos?open=${encodeURIComponent(id)}`);
  await hydrated(page);
  const dialog = page.getByRole("dialog", { name: title });
  const adding = page.getByRole("dialog", { name: "Add files" });
  await dialog.getByRole("link", { name: "Add files" }).click();
  const zone = adding.locator(".file-dropzone");
  await expect(
    zone.getByRole("button", { name: "Choose files" }),
  ).toBeVisible();
  await zone
    .locator('input[type="file"]')
    .setInputFiles([
      textFile("picked-attachment.txt"),
      textFile("second-picked.txt"),
    ]);
  // A hydrated pick uploads at once, as a drop does; there is no Attach.
  await expect(adding).toBeHidden();
  await expect(adding.getByRole("button", { name: "Attach" })).toHaveCount(0);
  await expect(
    dialog.getByRole("link", { name: "picked-attachment.txt", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "second-picked.txt", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("link", { name: "Add files" }).click();
  await dropFiles(zone, ["zone-drop.txt", "zone-second.txt"]);
  await expect(adding).toBeHidden();
  await expect(
    dialog.getByRole("link", { name: "zone-drop.txt", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "zone-second.txt", exact: true }),
  ).toBeVisible();
  await dropFiles(dialog.locator(".facts"), ["modal-one.txt", "modal-two.txt"]);
  await expect(
    dialog.getByRole("link", { name: "modal-one.txt", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "modal-two.txt", exact: true }),
  ).toBeVisible();
});

test("memory multi-file picker and drop preserve every file, report failures, and keep attachment undo", async ({
  page,
  request,
}) => {
  const title = unique("Memory multi-file");
  const saved = await mcp(request, "save_memory", {
    type: "fact",
    title,
    body: "Original memory body remains unchanged.",
    tags: ["attachments"],
  });
  const id = saved.id as string;
  const before = await mcp(request, "fetch", { id });
  await page.goto(`/memories?open=${encodeURIComponent(id)}`);
  await hydrated(page);
  const dialog = page.getByRole("dialog", { name: title });
  const history = await dialog.locator(".revisions").allTextContents();
  const files = dialog.getByRole("region", { name: `Files on ${title}` });
  await files.getByRole("link", { name: "Add files" }).click();
  const picked = ["memory-picked-one.txt", "memory-picked-two.txt"];
  await files
    .locator('input[type="file"]')
    .setInputFiles([
      textFile(picked[0]),
      textFile("memory-empty.txt", ""),
      textFile(picked[1]),
    ]);
  for (const name of picked)
    await expect(files.getByRole("link", { name, exact: true })).toBeVisible();
  await expect(files.getByRole("alert")).toHaveText(
    "Attached 2 of 3 files. memory-empty.txt: That file is empty.",
  );
  await expect(
    files.getByRole("link", { name: "memory-empty.txt", exact: true }),
  ).toHaveCount(0);
  // The failed pick keeps the modal open, ready for the next files.
  await expect(files.locator(".file-dropzone")).toBeVisible();
  const dropped = ["memory-drop-one.txt", "memory-drop-two.txt"];
  await dropFiles(files.locator(".file-dropzone"), dropped);
  for (const name of dropped)
    await expect(files.getByRole("link", { name, exact: true })).toBeVisible();
  await expect(files.getByRole("alert")).toHaveCount(0);
  for (const name of [...picked, ...dropped]) {
    const href =
      (await files
        .getByRole("link", { name, exact: true })
        .getAttribute("href")) ?? "";
    expect(await (await page.request.get(href)).text()).toBe(name);
  }
  await files
    .getByRole("button", { name: `Remove file ${picked[1]}`, exact: true })
    .click();
  await expect(
    files.getByRole("button", {
      name: `Restore file ${picked[1]}`,
      exact: true,
    }),
  ).toBeVisible();
  await files
    .getByRole("button", { name: `Restore file ${picked[1]}`, exact: true })
    .click();
  await expect(
    files.getByRole("button", {
      name: `Remove file ${picked[1]}`,
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await hydrated(page);
  for (const name of [...picked, ...dropped])
    await expect(files.getByRole("link", { name, exact: true })).toBeVisible();
  expect(await dialog.locator(".revisions").allTextContents()).toEqual(history);
  const after = await mcp(request, "fetch", { id });
  const { files: _beforeFiles, ...beforeMetadata } = before.metadata as Record<
    string,
    unknown
  >;
  const { files: afterFiles, ...afterMetadata } = after.metadata as Record<
    string,
    unknown
  >;
  expect(afterMetadata).toEqual(beforeMetadata);
  expect(after.title).toEqual(before.title);
  expect(after.text).toEqual(before.text);
  expect(afterFiles).toHaveLength(4);
});

test("memory multi-file uploads preserve successes and named failures with scripting off", async ({
  browser,
  request,
}) => {
  const title = unique("Memory no-script batch");
  const saved = await mcp(request, "save_memory", {
    type: "fact",
    title,
    body: "Original no-script memory.",
    tags: ["attachments"],
  });
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`/memories?open=${encodeURIComponent(saved.id as string)}`);
  const files = page.getByRole("region", { name: `Files on ${title}` });
  await files.getByRole("link", { name: "Add files" }).click();
  await expect(files.locator('input[type="file"]')).toBeVisible();
  const names = ["memory-noscript-one.txt", "memory-noscript-two.txt"];
  await files
    .locator('input[type="file"]')
    .setInputFiles([
      textFile(names[0]),
      textFile("empty-noscript.txt", ""),
      textFile(names[1]),
    ]);
  await files.getByRole("button", { name: "Attach", exact: true }).click();
  for (const name of names)
    await expect(files.getByRole("link", { name, exact: true })).toBeVisible();
  await expect(files.getByRole("alert")).toHaveText(
    "Attached 2 of 3 files. empty-noscript.txt: That file is empty.",
  );
  await files.getByRole("link", { name: "Add files" }).click();
  await files
    .locator('input[type="file"]')
    .setInputFiles([
      textFile("memory-noscript-three.txt"),
      textFile("memory-noscript-four.txt"),
    ]);
  await files.getByRole("button", { name: "Attach", exact: true }).click();
  for (const name of [
    ...names,
    "memory-noscript-three.txt",
    "memory-noscript-four.txt",
  ])
    await expect(files.getByRole("link", { name, exact: true })).toBeVisible();
  await files
    .getByRole("button", { name: `Remove file ${names[1]}`, exact: true })
    .click();
  await expect(
    files.getByRole("button", {
      name: `Restore file ${names[1]}`,
      exact: true,
    }),
  ).toBeVisible();
  await files
    .getByRole("button", { name: `Restore file ${names[1]}`, exact: true })
    .click();
  await expect(
    files.getByRole("button", { name: `Remove file ${names[1]}`, exact: true }),
  ).toBeVisible();
  await context.close();
});

test("memory multi-file uploads reject combined sizes over the limit before attaching any file", async ({
  page,
  request,
}) => {
  const title = unique("Memory bounded batch");
  const saved = await mcp(request, "save_memory", {
    type: "fact",
    title,
    body: "An oversized batch must not attach partially.",
    tags: ["attachments"],
  });
  await page.goto(`/memories?open=${encodeURIComponent(saved.id as string)}`);
  await hydrated(page);
  const files = page.getByRole("region", { name: `Files on ${title}` });
  await files.getByRole("link", { name: "Add files" }).click();
  const response = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/memories.data",
  );
  // Each file is legal alone; combined bytes exceed 10 MiB by two bytes,
  // beneath the Content-Length guard's multipart allowance. Test the sum too.
  await files.locator('input[type="file"]').setInputFiles(
    ["large-one.bin", "large-two.bin"].map((name) => ({
      name,
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
    })),
  );
  expect((await response).status()).toBe(413);
  await expect(files.getByRole("alert")).toHaveText(
    "Selected files must total at most 10 MB per upload. No files were attached.",
  );
  await expect(files.locator(".attachments > li")).toHaveCount(0);
  const fetched = await mcp(request, "fetch", { id: saved.id });
  expect((fetched.metadata as Record<string, unknown>).files).toEqual([]);
});

test("Library uploads display real image, PDF and EPUB thumbnails beside their titles", async ({
  page,
  request,
}) => {
  await serveBrowserModules(page);
  await goto(page, "/library");
  const png = Buffer.from(
    await page.evaluate(
      async (path) => (await import(path)).raster(),
      "/__test-modules/asset-thumbnail.mjs",
    ),
    "base64",
  );
  const stream = "0 0 1 rg 0 0 100 150 re f";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 150] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.7\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const epub = Buffer.from(
    zipSync({
      mimetype: strToU8("application/epub+zip"),
      "META-INF/container.xml": strToU8(
        '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      ),
      "book.opf": strToU8(
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest><item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/></manifest></package>',
      ),
      "cover.png": png,
    }),
  );
  const prefix = `preview-${crypto.randomUUID().slice(0, 8)}`;
  const files = [
    { name: `${prefix}.png`, mimeType: "image/png", buffer: png },
    {
      name: `${prefix}.pdf`,
      mimeType: "application/pdf",
      buffer: Buffer.from(pdf),
    },
    { name: `${prefix}.epub`, mimeType: "application/epub+zip", buffer: epub },
  ];
  for (const file of files) {
    const upload = await addDocuments(page);
    await upload.getByLabel(/^File, up to/).setInputFiles(file);
    await upload.getByRole("button", { name: "Upload", exact: true }).click();
    const card = page.locator(".library-item").filter({
      has: page.getByRole("heading", { name: file.name, exact: true }),
    });
    await expect(card).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    await expect(
      card.getByRole("img", { name: `Thumbnail of ${file.name}`, exact: true }),
    ).toBeVisible({ timeout: 20000 });
    // The download link is with the file's details, not on the summary card.
    await itemDetails(card);
    await expect(
      card.getByRole("link", { name: "Download", exact: true }),
    ).toHaveAttribute("href", /^\/files\//);
  }
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate("document.documentElement.scrollWidth"),
    ).toBeLessThanOrEqual(width);
  }
});
