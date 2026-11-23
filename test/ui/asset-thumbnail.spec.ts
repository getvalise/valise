import type { Page } from "@playwright/test";
import { strToU8, unzipSync, zipSync } from "fflate";
import {
  expect,
  serveBrowserModules,
  signedOut,
  test,
} from "./fixtures/session";

const fixture = "/__test-modules/asset-thumbnail.mjs";

// The sign-in page carries the stylesheet and nothing that renders thumbnails.
test.use({ storageState: signedOut });
const file = (
  objectId: string,
  mime: string,
  filename = `${objectId}.bin`,
) => ({ objectId, filename, mime, title: objectId });

async function boot(page: Page) {
  // The real component, built for the test and served only to this page.
  await serveBrowserModules(page);
  await page.goto("/login");
  return page.evaluate(async (path) => (await import(path)).raster(), fixture);
}

async function mount(page: Page, files: ReturnType<typeof file>[]) {
  await page.evaluate(
    async ({ path, files }) => (await import(path)).mount(files),
    { path: fixture, files },
  );
}

function epub(
  cover: Buffer,
  version: 2 | 3,
  href = "images/cover.png",
  wrapper = false,
) {
  return Buffer.from(
    zipSync({
      mimetype: strToU8("application/epub+zip"),
      "META-INF/container.xml": strToU8(
        '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      ),
      "OPS/book.opf": strToU8(
        `<package xmlns="http://www.idpf.org/2007/opf" version="${version}.0"><metadata>${version === 2 ? '<meta name="cover" content="cover"/>' : ""}</metadata><manifest><item id="cover" href="${wrapper ? "cover.xhtml" : href}" media-type="${wrapper ? "application/xhtml+xml" : "image/png"}" ${version === 3 ? 'properties="cover-image"' : ""}/></manifest></package>`,
      ),
      "OPS/cover.xhtml": strToU8(
        `<html xmlns="http://www.w3.org/1999/xhtml"><body><script>fetch('https://evil.invalid/script')</script><img src="${href}"/></body></html>`,
      ),
      "OPS/images/cover.png": cover,
    }),
  );
}

function pdf() {
  const stream = "0.1 0.3 0.7 rg 0 0 200 300 re f";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /OpenAction 5 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 20000 30000] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /S /JavaScript /JS (app.launchURL('https://evil.invalid/pdf')) >>",
  ];
  let text = "%PDF-1.7\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(text.length);
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = text.length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

test("renders bounded image, PDF page one, EPUB2/3 covers without document scripts or external loads", async ({
  page,
}) => {
  const png = Buffer.from(await boot(page), "base64");
  const payloads: Record<string, Buffer> = {
    image: png,
    pdf: pdf(),
    epub2: epub(png, 2),
    epub3: epub(png, 3),
    wrapper: epub(png, 2, "images/cover.png", true),
  };
  const external: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("evil.invalid")) external.push(request.url());
  });
  await page.route("**/files/*", (route) =>
    route.fulfill({
      body: payloads[route.request().url().split("/").pop() ?? ""],
    }),
  );
  await mount(page, [
    file("image", "image/png"),
    file("pdf", "application/pdf"),
    file("epub2", "application/epub+zip"),
    file("epub3", "application/epub+zip"),
    file("wrapper", "application/octet-stream", "book.epub"),
  ]);
  await expect(page.locator(".asset-thumbnail img")).toHaveCount(5);
  for (const img of await page.locator(".asset-thumbnail img").all()) {
    await expect(img).toBeVisible();
    expect(
      await img.evaluate((element) => {
        const image = element as unknown as {
          naturalWidth: number;
          naturalHeight: number;
        };
        return image.naturalWidth * image.naturalHeight;
      }),
    ).toBeLessThanOrEqual(512 * 512);
  }
  expect(external).toEqual([]);
  await expect(
    page.getByRole("img", { name: "Thumbnail of pdf", exact: true }),
  ).toBeVisible();
});

test("keeps geometry, stays lazy, revokes URLs and cancels unmounted queued cards", async ({
  page,
}) => {
  const png = Buffer.from(await boot(page), "base64");
  await page.evaluate(async (path) => {
    const module = await import(path);
    (globalThis as unknown as { thumbnailUrls: unknown }).thumbnailUrls =
      module.trackUrls();
  }, fixture);
  let requests = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/files/*", async (route) => {
    requests++;
    await gate;
    await route.fulfill({ body: png }).catch(() => {});
  });
  await page.evaluate(
    async ({ path, files }) => (await import(path)).mount(files, true),
    { path: fixture, files: [file("offscreen", "image/png")] },
  );
  await expect(page.locator(".asset-thumbnail")).toBeAttached();
  expect(requests).toBe(0);
  await mount(page, [file("first", "image/png")]);
  const before = await page.locator(".asset-thumbnail").boundingBox();
  release();
  await expect(page.locator(".asset-thumbnail img")).toHaveCount(1);
  expect(await page.locator(".asset-thumbnail").boundingBox()).toEqual(before);
  await mount(page, []);
  const urls = await page.evaluate(
    () =>
      (
        globalThis as unknown as {
          thumbnailUrls: { created: string[]; revoked: string[] };
        }
      ).thumbnailUrls,
  );
  expect(urls.created).toHaveLength(1);
  expect(urls.revoked).toEqual(urls.created);

  requests = 0;
  await page.unroute("**/files/*");
  const held: (() => Promise<void>)[] = [];
  await page.route("**/files/*", (route) => {
    requests++;
    held.push(() => route.fulfill({ body: png }).catch(() => {}));
  });
  await mount(
    page,
    Array.from({ length: 8 }, (_, index) =>
      file(`queued-${index}`, "image/png"),
    ),
  );
  await expect.poll(() => requests).toBe(2);
  await mount(page, []);
  await Promise.all(held.map((finish) => finish()));
  expect(requests).toBe(2);
});

test("unsupported, corrupt, external EPUB and excessive inputs keep a named fallback", async ({
  page,
}) => {
  const png = Buffer.from(await boot(page), "base64");
  const huge = Buffer.from(png);
  huge.writeUInt32BE(100_000, 16);
  huge.writeUInt32BE(100_000, 20);
  const payloads: Record<string, Buffer> = {
    corrupt: Buffer.from("broken PDF"),
    external: epub(png, 3, "https://evil.invalid/cover.png"),
    huge,
    svg: epub(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      ),
      3,
    ),
  };
  const fetched: string[] = [];
  await page.route("**/files/*", (route) => {
    const id = route.request().url().split("/").pop() ?? "";
    fetched.push(id);
    return route.fulfill({
      body: payloads[id] ?? png,
      headers:
        id === "oversize" ? { "content-length": String(26 * 1024 * 1024) } : {},
    });
  });
  await mount(page, [
    file("unsupported", "text/html"),
    file("corrupt", "application/pdf"),
    file("external", "application/epub+zip"),
    file("huge", "image/png"),
    file("svg", "application/epub+zip"),
    file("oversize", "image/png"),
  ]);
  await expect.poll(() => fetched.length).toBe(5);
  await expect(page.locator(".asset-thumbnail img")).toHaveCount(0);
  for (const id of [
    "unsupported",
    "corrupt",
    "external",
    "huge",
    "svg",
    "oversize",
  ])
    await expect(
      page.getByRole("img", { name: `No thumbnail for ${id}`, exact: true }),
    ).toBeVisible();
  expect(fetched).not.toContain("unsupported");
});

test("bounds ZIP inventories, actual inflation, XML and archive paths", async ({
  page,
}) => {
  await boot(page);
  const bomb = epub(Buffer.alloc(5 * 1024 * 1024), 3);
  const many = zipSync(
    Object.fromEntries(
      Array.from({ length: 2001 }, (_, index) => [
        `file-${index}`,
        new Uint8Array(),
      ]),
    ),
  );
  const lying = Buffer.from(epub(Buffer.alloc(2 * 1024 * 1024), 3));
  const declared = Buffer.from(epub(Buffer.alloc(1), 3));
  const xmlBook = unzipSync(epub(Buffer.alloc(1), 3));
  xmlBook["META-INF/container.xml"] = strToU8(
    '<!DOCTYPE container SYSTEM "https://evil.invalid/entity"><container/>',
  );
  for (let offset = 0; offset < lying.length - 46; offset++) {
    if (
      lying.readUInt32LE(offset) === 0x02014b50 &&
      lying
        .subarray(offset + 46, offset + 66)
        .toString()
        .startsWith("OPS/images/cover.png")
    )
      lying.writeUInt32LE(32, offset + 24);
  }
  for (let offset = 0; offset < declared.length - 46; offset++) {
    if (declared.readUInt32LE(offset) === 0x02014b50) {
      declared.writeUInt32LE(65 * 1024 * 1024, offset + 24);
      break;
    }
  }
  const results = await page.evaluate(
    async ({ path, archives }) => {
      const module = await import(path);
      const results = [];
      for (const data of archives) {
        try {
          await module.epubCover(
            new Uint8Array(data),
            new AbortController().signal,
          );
          results.push("accepted");
        } catch {
          results.push("rejected");
        }
      }
      for (const href of [
        "../outside",
        "//evil.invalid/image",
        "data:image/png,anything",
        "%2e%2e/escape",
        "a\\b",
        "a?query",
      ]) {
        try {
          module.epubPath("book.opf", href);
          results.push("accepted");
        } catch {
          results.push("rejected");
        }
      }
      return results;
    },
    {
      path: fixture,
      archives: [
        Array.from(bomb),
        Array.from(many),
        Array.from(lying),
        Array.from(declared),
        Array.from(zipSync(xmlBook)),
      ],
    },
  );
  expect(results).toEqual(Array(11).fill("rejected"));
});

test("bounds headerless streams and frees cancelled parser slots without a worker reply", async ({
  page,
}) => {
  await boot(page);
  const result = await page.evaluate(async (path) => {
    const module = await import(path);
    const streamed = await module.streamedLimit();
    const controller = new AbortController();
    let entered = 0;
    const stuck = new Promise(() => {});
    const work = () =>
      module
        .previewSlot(controller.signal, async () => {
          entered++;
          return module.abortable(stuck, controller.signal);
        })
        .catch(() => "cancelled");
    const pending = [work(), work(), work(), work()];
    await Promise.resolve();
    controller.abort();
    const cancelled = await Promise.all(pending);
    const next = await module.previewSlot(
      new AbortController().signal,
      async () => "slot available",
    );
    return { streamed, entered, cancelled, next };
  }, fixture);
  expect(result.streamed.rejected).toBe(true);
  expect(result.streamed.cancelled).toBe(true);
  expect(result.streamed.read).toBeLessThanOrEqual(28);
  expect(result.entered).toBe(2);
  expect(result.cancelled).toEqual(Array(4).fill("cancelled"));
  expect(result.next).toBe("slot available");
});
