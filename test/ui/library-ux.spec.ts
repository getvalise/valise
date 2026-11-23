import { localSql } from "./fixtures/asset-processing";
import {
  addBookmark,
  addDocuments,
  itemDetails,
  pickDocument,
  showView,
} from "./fixtures/library";
import { expect, goto, seed, test } from "./fixtures/session";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

test("browses reading material, keeps reference folders explicit, discloses provenance, and keeps processing beside the Library", async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  test.setTimeout(90_000);
  await seed(request);
  await goto(page, "/library");
  // Adding is a dialog opened on request, not a form above the list.
  await expect(
    page.getByRole("dialog", { name: "Upload documents" }),
  ).toBeHidden();
  await expect(
    page.getByRole("dialog", { name: "Add a bookmark" }),
  ).toBeHidden();
  const run = `reading-${crypto.randomUUID()}`;
  const assets: string[] = [];
  const sourceId = `src_${crypto.randomUUID()}`;
  const title = "Why I saved this design article";
  async function upload(label: string, bytes: Buffer) {
    const dialog = await addDocuments(page);
    await dialog.getByLabel(/^File, up to/).setInputFiles({
      name: `${run}-${assets.length}.bin`,
      mimeType: "application/octet-stream",
      buffer: bytes,
    });
    await dialog.getByLabel("Title", { exact: true }).fill(label);
    await dialog.getByRole("button", { name: "Upload", exact: true }).click();
    const card = page.locator(".library-item", {
      has: page.getByRole("heading", { name: label, exact: true }),
    });
    await expect(card).toBeVisible();
    const id = (
      await card.locator('input[name="id"]').first().inputValue()
    ).slice(6);
    assets.push(id);
    return id;
  }
  try {
    // Upload inert generic originals, then set fixture MIME metadata locally.
    // No processing action or real provider call is part of this browser proof.
    const first = await upload("Buckle reference", png);
    const second = await upload("Case reference", png);
    const backup = await upload(
      "Original Raindrop import receipt",
      Buffer.from('{"synthetic":true}'),
    );
    const pdf = await upload(
      "An extensionless PDF",
      Buffer.from("%PDF-1.7\nSynthetic fixture only\n%%EOF"),
    );
    const notes =
      "A saved observation worth returning to.\n\nImported from Raindrop.io bookmark 42.\n\nCollection: Unsorted\n\nPage and file contents are not indexed.";
    const sqlNotes = notes.replaceAll("'", "''");
    await localSql(
      baseURL ?? "",
      `
      UPDATE assets SET content_type='image/png',project='valise',tags_json='["reference","iconography"]' WHERE asset_id IN ('${first}','${second}');
      UPDATE assets SET content_type='application/json',source_agent='raindrop-import',project='raindrop',tags_json='["raindrop","import-snapshot"]' WHERE asset_id='${backup}';
      UPDATE assets SET content_type='application/pdf',file_name='A saved book title with no filename extension --' WHERE asset_id='${pdf}';
      INSERT INTO sources(source_id,user_id,kind,title,url,notes,project,tags_json,revision,source_agent,source_client,created_at,updated_at)
      SELECT '${sourceId}',user_id,'bookmark','${title}','https://example.test/design','${sqlNotes}','raindrop','["raindrop","collection:Unsorted","design"]',2,'raindrop-import','raindrop.io',unixepoch(),unixepoch() FROM assets WHERE asset_id='${first}';
      INSERT INTO source_revisions(revision_id,source_id,revision,kind,title,url,notes,project,tags_json,source_agent,source_client,created_at)
      SELECT 'fixture-history-${run}-'||history.revision,s.source_id,history.revision,s.kind,s.title,s.url,CASE WHEN history.revision=1 THEN 'Earlier saved observation.' ELSE s.notes END,s.project,s.tags_json,s.source_agent,s.source_client,s.created_at FROM sources s,
        (SELECT 1 AS revision UNION ALL SELECT 2) AS history WHERE s.source_id='${sourceId}';
      INSERT INTO source_revision_assets(source_id,revision,asset_id,position) VALUES
        ('${sourceId}',1,'${first}',0),('${sourceId}',2,'${first}',0),('${sourceId}',2,'${backup}',1);`,
    );
    await page.goto("/library");
    const card = page.locator(".library-item", {
      has: page.getByRole("heading", { name: title, exact: true }),
    });
    await expect(card).toBeVisible();
    const readingText = await card.innerText();
    expect(readingText).not.toMatch(
      /source:src_|Revision\s+\d|collection:|Collection:|import receipt|Unlink|Delete permanently/,
    );
    expect(
      readingText.match(/A saved observation worth returning to\./g),
    ).toHaveLength(1);
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await expect(page.locator('select[name="asset"]')).toHaveCount(0);
    // The import receipt is a document; it is not listed as a reading item.
    await showView(page, "Documents");
    await expect(
      page.getByRole("heading", {
        name: "Original Raindrop import receipt",
        exact: true,
      }),
    ).toHaveCount(0);
    const references = page.locator(".library-reference-group");
    // A shared project/tag is not folder membership. Existing files each
    // acquire a singleton container until the owner explicitly groups them.
    await expect(references).toHaveCount(0);
    await expect(
      page.getByRole("heading", {
        name: "Buckle reference",
        exact: true,
      }),
    ).toBeVisible();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          "document.documentElement.scrollWidth <= innerWidth",
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`library-reading-${width}.png`),
        fullPage: true,
      });
    }
    await page
      .getByRole("link", { name: "Preview Buckle reference", exact: true })
      .click();
    await expect(page.getByRole("dialog").locator("img")).toBeVisible();
    const download = page
      .getByRole("dialog")
      .getByRole("link", { name: "Download", exact: true });
    expect(
      Buffer.from(
        await (
          await page.request.get((await download.getAttribute("href")) ?? "")
        ).body(),
      ),
    ).toEqual(png);
    await page.keyboard.press("Escape");
    const pdfCard = page.locator(".library-item", {
      has: page.getByRole("heading", {
        name: "An extensionless PDF",
        exact: true,
      }),
    });
    await expect(
      pdfCard.getByRole("button", { name: "Process file", exact: true }),
    ).toBeEnabled();
    await pdfCard
      .getByRole("link", { name: "Processing details", exact: true })
      .click();
    expect(new URL(page.url()).pathname).toBe("/library");
    await expect(page).toHaveURL(new RegExp(`processing=${pdf}`));
    const pane = page.getByRole("dialog", {
      name: "Processing An extensionless PDF",
      exact: true,
    });
    await expect(pane).toBeVisible();
    await expect(pane).toHaveClass(/modal-pane/);
    expect(await page.locator("dialog:modal").count()).toBe(0);
    await expect(
      pane.getByRole("button", { name: "Process file", exact: true }),
    ).toBeEnabled();
    await expect(pane.getByRole("status").first()).toContainText(
      "Not processed",
    );
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({
        path: testInfo.outputPath(`library-processing-pane-${width}.png`),
      });
    }
    await pane.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(page).not.toHaveURL(/processing=/);
    await showView(page, "Bookmarks");
    await itemDetails(card);
    await card.getByRole("link", { name: "Edit notes", exact: true }).click();
    await expect(
      card.getByRole("textbox", { name: "Notes", exact: true }),
    ).toHaveValue("A saved observation worth returning to.");
    await card
      .getByRole("textbox", { name: "Notes", exact: true })
      .fill("A clearer personal note.");
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await expect(card).toContainText("A clearer personal note.");
    await card.screenshot({
      path: testInfo.outputPath("library-notes-saved-390.png"),
    });
    await card.getByRole("link", { name: "Add tag", exact: true }).click();
    await card
      .getByRole("combobox", { name: "Add tag", exact: true })
      .fill("annotation");
    await page.keyboard.press("Enter");
    // Open details show the editable tag set in the pane; the row keeps its
    // summary labels, so opening it moves nothing below.
    const tagSet = card.locator(".tagset");
    await expect(tagSet.locator(".chip")).toContainText([
      "design",
      "annotation",
    ]);
    await expect(tagSet).toHaveAttribute("aria-busy", "false");
    await expect(card.locator(":scope > .library-organization")).toHaveCount(1);
    // History is one line, the count of saved versions, opening a table. P14.
    const revision = await card
      .locator('input[name="revision"]')
      .first()
      .inputValue();
    const historyLine = card.getByRole("link", { name: /saved versions/ });
    await expect(historyLine).toHaveText(
      new RegExp(`^${revision} saved versions · last \\d{4}-\\d{2}-\\d{2}$`),
    );
    await historyLine.click();
    await expect(page).toHaveURL(/history=source/);
    const history = page.getByRole("dialog", { name: `History of ${title}` });
    await expect(history).toBeVisible();
    const rows = history.locator("tbody tr");
    await expect(rows).toHaveCount(Number(revision));
    await expect(rows.first()).toContainText(`v${revision}`);
    await expect(rows.first()).toContainText("current");
    await expect(rows.last()).toContainText("First version");
    // Selecting a row shows that version below the table; reading changes nothing.
    await history.getByRole("button", { name: "v1", exact: true }).click();
    await expect(
      history.getByRole("region", { name: /^v1 as saved/ }),
    ).toContainText("Earlier saved observation.");
    await page.keyboard.press("Escape");
    await expect(history).toBeHidden();
    await expect(page).not.toHaveURL(/history=/);
    await expect(card.locator('input[name="revision"]').first()).toHaveValue(
      revision,
    );
    await expect(
      card.getByRole("button", {
        name: "Unlink Original Raindrop import receipt",
      }),
    ).toHaveCount(0);
    await card
      .getByRole("button", { name: "Unlink Buckle reference", exact: true })
      .click();
    await expect(
      card.getByRole("button", {
        name: "Unlink Buckle reference",
        exact: true,
      }),
    ).toHaveCount(0);
    await showView(page, "Documents");
    await expect(
      page.getByRole("heading", {
        name: "Buckle reference",
        exact: true,
      }),
    ).toBeVisible();
    // Unlink does not destroy the original or historical retention evidence.
    await itemDetails(
      page.locator(".library-item", {
        has: page.getByRole("heading", {
          name: "Buckle reference",
          exact: true,
        }),
      }),
    );
    const image = page.locator(".library-item", {
      has: page.getByRole("heading", { name: "Buckle reference", exact: true }),
    });
    await image
      .getByRole("button", {
        name: "Delete permanently: Buckle reference",
        exact: true,
      })
      .click();
    await expect(image.getByRole("alert")).toContainText(
      "including saved history",
    );
    const result = await page.request.post("/mcp", {
      headers: {
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
        "x-valise-agent": "library-reading-proof",
        "x-valise-client": "playwright",
      },
      data: {
        jsonrpc: "2.0",
        id: "read-notes",
        method: "tools/call",
        params: { name: "fetch", arguments: { id: `source:${sourceId}` } },
      },
    });
    const raw = await result.text();
    const payload = JSON.parse(
      raw
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5) ?? raw,
    );
    expect(payload.result.structuredContent.text).toContain(
      "A clearer personal note.",
    );
    expect(payload.result.structuredContent.text).toContain(
      "Imported from Raindrop.io bookmark 42.",
    );
    expect(payload.result.structuredContent.metadata.tags).toEqual(
      expect.arrayContaining([
        "design",
        "annotation",
        "raindrop",
        "collection:Unsorted",
      ]),
    );
  } finally {
    await page.request.post("/library", {
      headers: { origin: baseURL ?? "" },
      form: { intent: "source-delete", id: `source:${sourceId}` },
    });
    for (const id of assets)
      await page.request.post("/library", {
        headers: { origin: baseURL ?? "" },
        form: { intent: "asset-delete", id: `asset:${id}` },
      });
  }
});

test("attaches a document from a modal opened by one control, lists it, unlinks it, and attaches with scripting off", async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  const run = crypto.randomUUID().slice(0, 8);
  const document = `Attach modal document ${run}`;
  const title = `Attach modal bookmark ${run}`;
  await goto(page, "/library");
  const upload = await addDocuments(page);
  await upload.getByLabel(/^File, up to/).setInputFiles({
    name: `attach-${run}.png`,
    mimeType: "image/png",
    buffer: png,
  });
  await upload.getByLabel("Title", { exact: true }).fill(document);
  await upload.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: document, exact: true }),
  ).toBeVisible();
  const form = await addBookmark(page);
  await form.getByLabel("Title", { exact: true }).fill(title);
  await form
    .getByLabel("URL", { exact: true })
    .fill(`https://example.test/attach-${run}`);
  await form
    .getByLabel("Notes", { exact: true })
    .fill("A page to keep an original with.");
  await form.getByRole("button", { name: "Save bookmark" }).click();
  const card = page.locator(".library-item", {
    has: page.getByRole("heading", { name: title, exact: true }),
  });
  await expect(card).toBeVisible();
  await itemDetails(card);
  const section = card.getByRole("region", { name: "Attached documents" });
  // No form until asked: one control, which opens the picker.
  await expect(section.getByRole("combobox")).toHaveCount(0);
  await expect(section.locator(".attachments")).toHaveCount(0);
  await section.getByRole("link", { name: "Attach a document" }).click();
  await expect(page).toHaveURL(/attach=source/);
  const dialog = page.getByRole("dialog", {
    name: `Attach a document to ${title}`,
  });
  await expect(dialog).toBeVisible();
  await pickDocument(dialog, "Document", document);
  await dialog.getByRole("button", { name: "Attach", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page).not.toHaveURL(/attach=/);
  await expect(section.locator(".attachments > li")).toHaveText([
    `${document}Unlink`,
  ]);
  await section
    .getByRole("button", { name: `Unlink ${document}`, exact: true })
    .click();
  await expect(section.locator(".attachments")).toHaveCount(0);

  // With scripting off the modal is the URL: ?attach= renders it open.
  const id = await card.locator('input[name="id"]').first().inputValue();
  const context = await browser.newContext({ javaScriptEnabled: false });
  const plain = await context.newPage();
  await plain.goto(
    `/library?details=${encodeURIComponent(id)}&attach=${encodeURIComponent(id)}`,
  );
  const plainDialog = plain.getByRole("dialog", {
    name: `Attach a document to ${title}`,
  });
  await expect(plainDialog).toBeVisible();
  await pickDocument(plainDialog, "Document", document);
  await plainDialog
    .getByRole("button", { name: "Attach", exact: true })
    .click();
  await expect(plain).not.toHaveURL(/attach=/);
  await expect(plainDialog).toBeHidden();
  const plainSection = plain.getByRole("region", {
    name: "Attached documents",
  });
  await expect(
    plainSection.getByRole("button", {
      name: `Unlink ${document}`,
      exact: true,
    }),
  ).toBeVisible();
  // Closing without scripting is a link that drops the parameter.
  await plainSection.getByRole("link", { name: "Attach a document" }).click();
  await expect(plainDialog).toBeVisible();
  await plainDialog.getByRole("link", { name: "Close" }).click();
  await expect(plain).not.toHaveURL(/attach=/);
  await expect(plainDialog).toBeHidden();
  await context.close();
});

test("uploads new files into the attach modal, links them to the source, lists them under Documents, and refuses a stale revision", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const run = crypto.randomUUID().slice(0, 8);
  const title = `Attach upload bookmark ${run}`;
  const file = (name: string) => ({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from(`${name} ${run}`),
  });
  await goto(page, "/library");
  const form = await addBookmark(page);
  await form.getByLabel("Title", { exact: true }).fill(title);
  await form
    .getByLabel("URL", { exact: true })
    .fill(`https://example.test/attach-upload-${run}`);
  await form.getByRole("button", { name: "Save bookmark" }).click();
  const card = page.locator(".library-item", {
    has: page.getByRole("heading", { name: title, exact: true }),
  });
  await expect(card).toBeVisible();
  await itemDetails(card);
  const id = await card.locator('input[name="id"]').first().inputValue();
  const section = card.getByRole("region", { name: "Attached documents" });
  const dialog = page.getByRole("dialog", {
    name: `Attach a document to ${title}`,
  });
  const choose = async () => {
    await section.getByRole("link", { name: "Attach a document" }).click();
    await expect(dialog).toBeVisible();
    // Two ways in, in this order: the library first, then a new upload.
    await expect(dialog.locator(".detail-section > .eyebrow")).toHaveText([
      "From your library",
      "Upload new",
    ]);
    return dialog.getByRole("region", { name: "Upload new" });
  };

  // Scripted: one request per file, each linked at the revision the last left.
  const first = `attach-upload-a-${run}.txt`;
  const second = `attach-upload-b-${run}.txt`;
  let upload = await choose();
  await upload
    .locator('input[type="file"]')
    .setInputFiles([file(first), file(second)]);
  await upload
    .getByRole("button", { name: "Upload and attach", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(page).not.toHaveURL(/attach=/);
  await expect(section.locator(".attachments > li")).toHaveText([
    `${first}Unlink`,
    `${second}Unlink`,
  ]);

  // A change made elsewhere while the modal is open: nothing is uploaded.
  upload = await choose();
  const revision = await card
    .locator('input[name="revision"]')
    .first()
    .inputValue();
  const edited = await page.request.post(
    `/library?details=${encodeURIComponent(id)}`,
    {
      headers: { origin: baseURL ?? "" },
      form: {
        intent: "source-field",
        id,
        field: "notes",
        value: `Changed elsewhere ${run}.`,
        revision,
      },
      maxRedirects: 0,
    },
  );
  expect(edited.status()).toBeLessThan(400);
  const stale = `attach-upload-stale-${run}.txt`;
  await upload.locator('input[type="file"]').setInputFiles([file(stale)]);
  await upload
    .getByRole("button", { name: "Upload and attach", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "changed since this dialog opened. Nothing was uploaded.",
  );
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).first().click();
  await expect(dialog).toBeHidden();

  // With scripting off: one multipart post to the modal's URL.
  const context = await browser.newContext({ javaScriptEnabled: false });
  const plain = await context.newPage();
  await plain.goto(
    `/library?details=${encodeURIComponent(id)}&attach=${encodeURIComponent(id)}`,
  );
  const plainDialog = plain.getByRole("dialog", {
    name: `Attach a document to ${title}`,
  });
  await expect(plainDialog).toBeVisible();
  const third = `attach-upload-c-${run}.txt`;
  const plainUpload = plainDialog.getByRole("region", { name: "Upload new" });
  await plainUpload.getByLabel(/^File, up to/).setInputFiles([file(third)]);
  await plainUpload
    .getByRole("button", { name: "Upload and attach", exact: true })
    .click();
  await expect(plain).not.toHaveURL(/attach=/);
  await expect(plainDialog).toBeHidden();
  await expect(
    plain
      .getByRole("region", { name: "Attached documents" })
      .locator(".attachments > li"),
  ).toHaveText([`${first}Unlink`, `${second}Unlink`, `${third}Unlink`]);
  // The stale attempt stored nothing.
  await expect(plain.getByText(stale)).toHaveCount(0);
  await context.close();

  // One folder per upload batch; the two scripted attachments stay together.
  await goto(page, `/library?view=documents&q=${run}`);
  for (const name of [first, third])
    await expect(
      page.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
  await expect(
    page.locator(".library-item", {
      has: page.getByRole("heading", { name: first, exact: true }),
    }),
  ).toContainText("2 files");
  await expect(
    page.getByRole("heading", { name: second, exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("heading", { name: stale })).toHaveCount(0);
});
