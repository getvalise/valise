import {
  isolateProcessing,
  localSql,
  pendingSuggestions,
} from "./fixtures/asset-processing";
import { addDocuments, closeAddDialog, itemDetails } from "./fixtures/library";
import { expect, goto, test } from "./fixtures/session";

function pdf() {
  const stream = "0.4 g 0 0 200 300 re f";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let text = "%PDF-1.7\n";
  const offsets = [0];
  for (const [i, obj] of objects.entries()) {
    offsets.push(text.length);
    text += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const xref = text.length;
  text += `xref\n0 5\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

test("one PDF is a folder too, with a row-height thumbnail and readable retained output", async ({
  page,
  baseURL,
}, testInfo) => {
  await goto(page, "/library?view=documents");
  const upload = await addDocuments(page);
  const title = `Public PDF ${crypto.randomUUID()}`;
  await upload.getByLabel(/^File, up to/).setInputFiles({
    name: "public.bin",
    mimeType: "application/octet-stream",
    buffer: pdf(),
  });
  await upload.getByLabel("Title", { exact: true }).fill(title);
  await upload.getByRole("button", { name: "Upload", exact: true }).click();
  await closeAddDialog(page);
  const row = page.locator(".library-item", {
    has: page.getByRole("heading", { name: title, exact: true }),
  });
  const id = (await row.locator('input[name="id"]').first().inputValue()).slice(
    6,
  );
  await localSql(
    baseURL!,
    `UPDATE assets SET content_type='application/pdf',file_name='public.pdf' WHERE asset_id='${id}';`,
  );
  await (await pendingSuggestions(baseURL!, id))();
  const failed = `apr_${crypto.randomUUID()}`;
  await localSql(
    baseURL!,
    `INSERT INTO asset_processing(processing_id,user_id,asset_id,generation,processor_version,state,error_code,created_at,finished_at)
    SELECT '${failed}',user_id,asset_id,1+(SELECT MAX(generation) FROM asset_processing WHERE asset_id=a.asset_id),'synthetic-failed-retry','failed','conversion_failed',unixepoch(),unixepoch() FROM assets a WHERE asset_id='${id}';
    INSERT INTO asset_processing_admissions(processing_id,user_id,created_at) SELECT processing_id,user_id,created_at FROM asset_processing WHERE processing_id='${failed}';`,
  );
  await page.reload();
  await expect(row).toContainText("1 file");
  await expect(row.getByRole("status").first()).toContainText(
    "could not read this document",
  );
  await expect(
    row.getByRole("link", { name: "Read file", exact: true }),
  ).toHaveAttribute("href", `/library/read-file/${id}`);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(row.locator(".asset-thumbnail img")).toBeVisible();
    const bounds = await row.boundingBox();
    const thumb = await row.locator(".asset-thumbnail").boundingBox();
    expect(Math.abs(bounds!.height - thumb!.height)).toBeLessThan(3);
    await page.screenshot({
      path: testInfo.outputPath(`documents-default-${width}.png`),
    });
  }
  await itemDetails(row);
  const pane = page.locator("dialog.modal-pane[open]");
  await expect(
    pane.getByLabel("Files in this folder").getByRole("link"),
  ).toHaveCount(1);
  await expect(pane.getByLabel("Extracted text")).toContainText(
    "Synthetic orchard review text.",
  );
  await pane
    .getByRole("link", { name: "Open in the reader", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "File text" })).toContainText(
    "Synthetic orchard review text.",
  );
});

test("the row's Process file button opens the live pane and publishes readable text", async ({
  page,
  baseURL,
}) => {
  await goto(page, "/library?view=documents");
  const upload = await addDocuments(page);
  const title = `Explicit processing ${crypto.randomUUID()}`;
  await upload.getByLabel("Title", { exact: true }).fill(title);
  const original = {
    name: "unprocessed.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(
      "The public fixture discusses compilers and vectorized execution.",
    ),
  };
  await upload.getByLabel(/^File, up to/).setInputFiles(original);
  await upload.getByRole("button", { name: "Upload", exact: true }).click();
  await closeAddDialog(page);
  const row = page.locator(".library-item", {
    has: page.getByRole("heading", { name: title, exact: true }),
  });
  const id = (await row.locator('input[name="id"]').first().inputValue()).slice(
    6,
  );
  await localSql(
    baseURL!,
    `UPDATE assets SET content_type='text/plain',file_name='public.txt' WHERE asset_id='${id}';`,
  );
  await isolateProcessing(baseURL!);
  await page.reload();
  await row.getByRole("button", { name: "Process file", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`processing=${id}`));
  const pane = page.locator("dialog.modal-pane[open]");
  await expect(pane).toHaveCount(1);
  await expect(pane.getByRole("status").first()).toContainText(
    "Extracted content is searchable",
    { timeout: 20000 },
  );
  await expect(pane.getByLabel("Extracted text")).toContainText(
    "compilers and vectorized execution",
  );
});

test("a batch is one folder; its file actions populate one pane and a reader at desktop and mobile widths", async ({
  page,
  baseURL,
}, testInfo) => {
  const name = `Saved page ${crypto.randomUUID()}`;
  await goto(page, "/library?view=documents");
  const upload = await addDocuments(page);
  await upload.getByLabel("Folder name", { exact: true }).fill(name);
  await upload.getByLabel(/^File, up to/).setInputFiles([
    {
      name: "page.html",
      mimeType: "text/html",
      buffer: Buffer.from("<html><body>A saved public page.</body></html>"),
    },
    {
      name: "screen.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("screen original"),
    },
    {
      name: "style.css",
      mimeType: "text/css",
      buffer: Buffer.from("body { margin: 0; }"),
    },
  ]);
  await upload.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(upload.getByLabel("Upload results")).toContainText(
    "style.css: Uploaded",
  );
  await closeAddDialog(page);
  const row = page.locator(".library-item", {
    has: page.getByRole("heading", { name, exact: true }),
  });
  await expect(row).toContainText("3 files");
  await itemDetails(row);
  const pane = page.locator("dialog.modal-pane[open]");
  await expect(pane).toHaveCount(1);
  await expect(
    pane.getByLabel("Files in this folder").getByRole("link"),
  ).toHaveCount(3);
  await pane.getByRole("link", { name: "screen.bin", exact: true }).click();
  await expect(page).toHaveURL(/processing=ast_/);
  await expect(pane).toHaveCount(1);
  await expect(
    pane.getByRole("button", { name: "Process file", exact: true }),
  ).toBeDisabled();
  const id = new URL(page.url()).searchParams.get("processing")!;
  await localSql(
    baseURL!,
    `UPDATE assets SET content_type='text/plain',file_name='screen.txt' WHERE asset_id='${id}';`,
  );
  await isolateProcessing(baseURL!);
  await page.reload();
  await pane.getByRole("button", { name: "Process file", exact: true }).click();
  await expect(pane.getByRole("status").first()).toContainText(
    "Extracted content is searchable",
    { timeout: 20000 },
  );
  await expect(pane.getByLabel("Extracted text")).toContainText(
    "screen original",
  );
  await expect(
    pane.getByRole("link", { name: "Download original", exact: true }),
  ).toBeVisible();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    if (width < 768) await pane.locator(".sheet-grip").click();
    const overflow = await page.evaluate<number>(
      "document.querySelector('dialog.modal-pane[open] > .modal-body').scrollWidth - document.querySelector('dialog.modal-pane[open] > .modal-body').clientWidth",
    );
    expect(overflow).toBeLessThanOrEqual(1);
    const beyondViewport = await page.evaluate<number>(
      "document.querySelector('dialog.modal-pane[open] > .modal-body').getBoundingClientRect().right - innerWidth",
    );
    expect(beyondViewport).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: testInfo.outputPath(`documents-pane-${width}.png`),
    });
    expect(
      await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
    ).toBe(true);
  }
  await pane
    .getByRole("link", { name: "Open in the reader", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "File text" })).toContainText(
    "screen original",
  );
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({
      path: testInfo.outputPath(`documents-reader-${width}.png`),
    });
    expect(
      await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
    ).toBe(true);
  }
  await page
    .getByRole("link", { name: "Back to this file in Library" })
    .click();
  await expect(
    pane.getByLabel("Files in this folder").getByRole("link"),
  ).toHaveCount(3);
  const download = await page.request.get(
    (await pane
      .getByRole("link", { name: "Download original", exact: true })
      .getAttribute("href"))!,
  );
  expect((await download.body()).toString()).toBe("screen original");
  await pane
    .getByRole("link", { name: "+ Add files to this folder", exact: true })
    .click();
  const adding = page.getByRole("dialog", {
    name: "Add files to this folder",
    exact: true,
  });
  await adding.getByLabel(/^File, up to/).setInputFiles({
    name: "extra.css",
    mimeType: "text/css",
    buffer: Buffer.from("/* extra original */"),
  });
  await adding.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(adding.getByLabel("Upload results")).toContainText(
    "extra.css: Uploaded",
  );
  await adding.getByRole("button", { name: "Close", exact: true }).click();
  await expect(
    pane.getByLabel("Files in this folder").getByRole("link"),
  ).toHaveCount(4);
  await pane.getByRole("button", { name: "Close", exact: true }).click();
  const target = `Destination ${crypto.randomUUID()}`;
  const targetUpload = await addDocuments(page);
  await targetUpload.getByLabel("Folder name", { exact: true }).fill(target);
  await targetUpload.getByLabel(/^File, up to/).setInputFiles({
    name: "destination.css",
    mimeType: "text/css",
    buffer: Buffer.from("/* target */"),
  });
  await targetUpload
    .getByRole("button", { name: "Upload", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: target, exact: true }),
  ).toBeVisible();
  await closeAddDialog(page);
  await page.goto(`/library?view=documents&processing=${id}`);
  await pane
    .getByRole("link", {
      name: "Move this file to another folder",
      exact: true,
    })
    .click();
  const moving = page.getByRole("dialog", {
    name: "Move file to a folder",
    exact: true,
  });
  await moving
    .getByRole("combobox", { name: "Destination folder", exact: true })
    .click();
  await page.getByPlaceholder("Search folders").fill(target);
  await page.getByRole("option").filter({ hasText: target }).click();
  await moving.getByRole("button", { name: "Move file", exact: true }).click();
  await expect(moving).toBeHidden();
  await expect(
    pane.getByLabel("Files in this folder").getByRole("link"),
  ).toHaveCount(2);
  await expect(pane.getByLabel("Folder files")).toContainText(target);
  const missing = await page.goto(
    `/library/read-file/ast_${crypto.randomUUID()}`,
  );
  expect(missing?.status()).toBe(404);
});

test("singleton folders and native grouped upload/reader links work without scripting", async ({
  browser,
  baseURL,
}, testInfo) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 900 },
  });
  try {
    const page = await context.newPage();
    await page.goto("/library?view=documents");
    const name = `Native folder ${crypto.randomUUID()}`;
    const upload = await addDocuments(page);
    await upload.getByLabel("Folder name", { exact: true }).fill(name);
    await upload.getByLabel(/^File, up to/).setInputFiles([
      {
        name: "original.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("Original unchanged"),
      },
      {
        name: "notes.css",
        mimeType: "text/css",
        buffer: Buffer.from("/* retained */"),
      },
    ]);
    await upload.getByRole("button", { name: "Upload", exact: true }).click();
    const row = page.locator(".library-item", {
      has: page.getByRole("heading", { name, exact: true }),
    });
    await expect(row).toContainText("2 files");
    const id = (
      await row.locator('input[name="id"]').first().inputValue()
    ).slice(6);
    await (await pendingSuggestions(baseURL!, id))();
    await itemDetails(row);
    const pane = page.locator("dialog[open]");
    await expect(
      pane.getByLabel("Files in this folder").getByRole("link"),
    ).toHaveCount(2);
    await pane
      .getByRole("link", { name: "Open in the reader", exact: true })
      .click();
    await expect(page.getByRole("region", { name: "File text" })).toContainText(
      "Synthetic orchard review text.",
    );
    await page.screenshot({
      path: testInfo.outputPath("documents-native-reader-390.png"),
    });
  } finally {
    await context.close();
  }
});
