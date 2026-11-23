// Synthetic originals only; loopback D1/R2 and an explicitly disposable index.
// Does not provision resources, deploy, or alter production.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { strToU8, zipSync } from "fflate";

const origin = process.env.VALISE_DEV_ORIGIN ?? "http://localhost:4214";
assert(["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
const namespace = process.env.VALISE_VECTOR_EVAL_NAMESPACE;
const index = process.env.VALISE_VECTOR_EVAL_INDEX;
assert(namespace?.startsWith("rollout-eval-"));
assert(index?.startsWith("valise-rollout-eval-"));
const output = process.env.VALISE_ASSET_PROBE_OUTPUT;
assert(output, "explicit evidence path required");
const report = {
  startedAt: new Date().toISOString(),
  namespace,
  index,
  files: [],
  deliveries: [],
  queries: [],
  publicHybridRequired: process.env.VALISE_ASSET_REQUIRE_HYBRID === "1",
  complete: false,
};
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
});
const page = await context.newPage();
const request = context.request;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const zip = (files) =>
  Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(files).map(([name, text]) => [name, strToU8(text)]),
      ),
    ),
  );
async function json(path, data) {
  const response = await request.fetch(origin + path, {
    method: data === undefined ? "GET" : "POST",
    ...(data === undefined ? {} : { data }),
    timeout: 120000,
  });
  assert(response.ok(), `${path}: HTTP ${response.status()}`);
  return response.json();
}
async function mcp(name, args) {
  const response = await request.post(`${origin}/mcp`, {
    headers: {
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      "x-valise-agent": "asset-live-proof",
      "x-valise-client": "asset-live-proof",
    },
    data: {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    },
  });
  const raw = await response.text();
  const value = JSON.parse(
    raw
      .split("\n")
      .find((line) => line.startsWith("data:"))
      ?.slice(5) ?? raw,
  );
  assert(!value.error && !value.result?.isError, JSON.stringify(value));
  return (
    value.result.structuredContent ?? JSON.parse(value.result.content[0].text)
  );
}
function pdf(text) {
  const stream = `BT /F1 12 Tf 30 160 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 900 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let data = "%PDF-1.4\n";
  const offsets = [];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(data));
    data += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = Buffer.byteLength(data);
  data += `xref\n0 6\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(data);
}
try {
  assert.equal((await json("/__dev/vector-status")).namespace, namespace);
  await request.get(`${origin}/__dev/seed`);
  await request.post(`${origin}/login`, {
    headers: { origin },
    form: {
      password: process.env.VALISE_TEST_PASSWORD ?? "asset-probe-password-0001",
      next: "/library",
    },
  });
  const picture = await context.newPage();
  await picture.setContent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="skyblue"/><rect y="250" width="300" height="50" fill="lightgreen"/><rect x="137" y="150" width="25" height="110" fill="saddlebrown"/><circle cx="150" cy="115" r="90" fill="forestgreen"/><g fill="red"><circle cx="100" cy="100" r="14"/><circle cx="180" cy="70" r="14"/><circle cx="190" cy="140" r="14"/><circle cx="130" cy="160" r="14"/></g></svg>',
  );
  const png = await picture.locator("svg").screenshot();
  await picture.close();
  const fixtures = [
    {
      format: "pdf",
      bytes: pdf(
        "Coral bleaching accelerates when seawater temperatures rise, expelling symbiotic algae.",
      ),
      term: "symbiotic",
      query: "heat-stressed tropical reefs turning pale",
    },
    {
      format: "epub",
      bytes: zip({
        mimetype: "application/epub+zip",
        "META-INF/container.xml":
          '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
        "OEBPS/content.opf":
          '<package><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
        "OEBPS/chapter.xhtml":
          "<html><body><p>Rainwater harvesting from rooftops stores runoff in underground cisterns for drought irrigation.</p></body></html>",
      }),
      term: "cisterns",
      query: "droughtproofing household gardens with captured precipitation",
    },
    {
      format: "pptx",
      bytes: zip({
        "ppt/slides/slide1.xml":
          "<p:sld><a:p><a:t>Reusable rockets land vertically, allowing launch vehicles to fly repeatedly and reduce spaceflight costs.</a:t></a:p></p:sld>",
      }),
      term: "spaceflight",
      query: "economical orbital transportation using recovered boosters",
    },
    {
      format: "xlsx",
      bytes: zip({
        "[Content_Types].xml":
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        "_rels/.rels":
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml":
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Photovoltaic" sheetId="1" r:id="rId1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels":
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        "xl/worksheets/sheet1.xml":
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Quarter</t></is></c><c r="B1" t="inlineStr"><is><t>Photovoltaic solar electricity generation MWh</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Q1</t></is></c><c r="B2"><v>42</v></c></row></sheetData></worksheet>',
      }),
      term: "Photovoltaic",
      query: "renewable power output by fiscal period",
    },
    {
      format: "png",
      bytes: png,
      term: "tree",
      query: "orchard fruit ready for picking",
    },
  ];
  for (const [i, fixture] of fixtures.entries()) {
    await page.goto(`${origin}/library`);
    const name = `opaque-${i}.${fixture.format}`;
    await page.getByLabel(/^File, up to/).setInputFiles({
      name,
      mimeType: "application/octet-stream",
      buffer: fixture.bytes,
    });
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    const card = page.locator(".library-item", {
      has: page.getByRole("heading", { name, exact: true }),
    });
    await card.waitFor();
    const id = await card.locator('input[name="id"]').first().inputValue();
    assert(id?.startsWith("asset:"));
    let fetched;
    for (let n = 0; n < 30; n++) {
      fetched = await mcp("fetch", { id });
      if (fetched.metadata.extracted_content_indexed) break;
      await pause(1000);
    }
    const record = {
      format: fixture.format,
      id,
      sha256: sha(fixture.bytes),
      extraction: fetched.metadata.extraction,
      query: fixture.query,
    };
    report.files.push(record);
    assert.equal(
      fetched.metadata.extracted_content_indexed,
      true,
      `${name}: automatic extraction failed`,
    );
    assert.equal(fetched.title, name);
    assert.deepEqual(fetched.metadata.tags, []);
    const exact = await mcp("search", { query: fixture.term, type: "asset" });
    assert(
      exact.results.some((hit) => hit.id === id),
      `${name}: exact retrieval missed`,
    );
    const download = await mcp("get_asset_download", { id });
    assert.equal(new URL(download.url).origin, origin);
    assert.equal(
      sha(await (await request.get(download.url)).body()),
      record.sha256,
    );
    console.log(JSON.stringify({ event: "automatic-extraction", ...record }));
  }
  await page.goto(`${origin}/library`);
  const review = page
    .getByRole("link", { name: "Review suggestions", exact: true })
    .first();
  await review.waitFor({ timeout: 15000 });
  await review.click();
  const dialog = page.getByRole("dialog");
  const acceptTitle = dialog.getByRole("button", {
    name: "Accept suggested title",
    exact: true,
  });
  await acceptTitle.waitFor();
  await page.screenshot({
    path: output.replace(/\.json$/, "-review-390.png"),
    fullPage: true,
  });
  await acceptTitle.click();
  await acceptTitle.waitFor({ state: "hidden" });
  report.explicitRealTitleAcceptance = true;
  await page.keyboard.press("Escape");
  for (const file of report.files)
    assert.deepEqual((await mcp("fetch", { id: file.id })).metadata.tags, []);
  for (let n = 0; n < 4; n++) {
    const result = await json("/__dev/asset-vectors", {});
    report.deliveries.push({ at: new Date().toISOString(), ...result });
    assert(!result.failed, "failed delivery; no unbounded paid retries");
    if (!result.delivered) break;
  }
  const acknowledgedAt = Date.now();
  // Record empty ANN observations rather than interpreting acknowledgements as visibility.
  report.visibility = [];
  for (let n = 0; n < 24; n++) {
    const candidate = await json(
      `/__dev/asset-vector-candidates?user=local&q=${encodeURIComponent(report.files[0].query)}`,
    );
    const visible = candidate.heads.some(
      (head) => `asset:${head.conceptId}` === report.files[0].id,
    );
    report.visibility.push({ elapsedMs: Date.now() - acknowledgedAt, visible });
    if (visible) break;
    assert(
      n < 23,
      "fresh ANN not visible within bounded four-minute observation",
    );
    await pause(10000);
  }
  for (const file of report.files) {
    const candidate = await json(
      `/__dev/asset-vector-candidates?user=local&q=${encodeURIComponent(file.query)}`,
    );
    const rank =
      1 +
      candidate.heads.findIndex(
        (head) => `asset:${head.conceptId}` === file.id,
      );
    const publicResult = await mcp("search", {
      query: file.query,
      type: "asset",
    });
    report.queries.push({
      format: file.format,
      rank: rank || null,
      publicIds: publicResult.results.map((hit) => hit.id),
    });
    assert.equal(rank, 1, `${file.format}: semantic rank`);
    if (report.publicHybridRequired)
      assert.equal(
        publicResult.results[0]?.id,
        file.id,
        `${file.format}: public hybrid rank`,
      );
  }
  report.complete = true;
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
