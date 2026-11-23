import { Inflate } from "fflate";
import { checkAbort, PREVIEW_LIMITS } from "./limits";

type Entry = {
  name: string;
  offset: number;
  compressed: number;
  size: number;
  method: number;
};

/** Central-directory inventory first; reject ZIP64, encryption and oversized books. */
function inventory(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (
    end >= Math.max(0, bytes.length - 65557) &&
    view.getUint32(end, true) !== 0x06054b50
  )
    end--;
  if (end < 0 || end < bytes.length - 65557)
    throw new Error("Invalid EPUB ZIP");
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  if (
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    count > PREVIEW_LIMITS.zipEntries ||
    count !== view.getUint16(end + 8, true)
  )
    throw new Error("EPUB ZIP limit");
  const entries = new Map<string, Entry>();
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50)
      throw new Error("Invalid EPUB directory");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const next =
      offset +
      46 +
      nameLength +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    total += size;
    if (
      next > end ||
      total > PREVIEW_LIMITS.zipBytes ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      local + 30 > offset ||
      view.getUint32(local, true) !== 0x04034b50
    )
      throw new Error("Unsupported EPUB ZIP");
    const start =
      local +
      30 +
      view.getUint16(local + 26, true) +
      view.getUint16(local + 28, true);
    if (start + compressed > offset) throw new Error("Invalid EPUB entry");
    const name = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (entries.has(name)) throw new Error("Duplicate EPUB entry");
    entries.set(name, { name, offset: start, compressed, size, method });
    offset = next;
  }
  return entries;
}

/** Resolve only archive-local names; URL, data, root paths and escaping .. never load. */
export function epubPath(base: string, href: string) {
  const path = decodeURIComponent(href);
  if (
    !path ||
    /^[a-z][\w+.-]*:/i.test(path) ||
    path.startsWith("/") ||
    /[\\?#\x00]/.test(path)
  )
    throw new Error("External EPUB reference");
  const parts = base.split("/").slice(0, -1);
  for (const part of path.split("/")) {
    if (part === "..") {
      if (!parts.length) throw new Error("EPUB path escapes archive");
      parts.pop();
    } else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

function xml(bytes: Uint8Array) {
  const text = new TextDecoder().decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    throw new Error("EPUB XML declarations disabled");
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length)
    throw new Error("Invalid EPUB XML");
  return doc;
}

const elements = (doc: PreviewXmlDocument, name: string) =>
  Array.from(doc.getElementsByTagNameNS("*", name));

/** Inflate only container, package, optional cover wrapper and raster cover. */
export async function epubCover(
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const entries = inventory(bytes);
  async function read(name: string, limit: number) {
    checkAbort(signal);
    const entry = entries.get(name);
    if (!entry || entry.size > limit)
      throw new Error("EPUB cover unavailable or too large");
    const compressed = bytes.subarray(
      entry.offset,
      entry.offset + entry.compressed,
    );
    if (!entry.method) {
      if (compressed.length !== entry.size)
        throw new Error("Invalid stored EPUB entry");
      return compressed;
    }
    let size = 0;
    const chunks: Uint8Array[] = [];
    // Bounded input chunks also bound transient decompressor allocations when
    // a hostile stream lies about its uncompressed size in the ZIP directory.
    const inflate = new Inflate((chunk) => {
      size += chunk.length;
      if (size > limit || size > entry.size)
        throw new Error("EPUB inflation limit");
      chunks.push(chunk);
    });
    for (let offset = 0; offset < compressed.length; offset += 1024) {
      checkAbort(signal);
      inflate.push(
        compressed.subarray(offset, offset + 1024),
        offset + 1024 >= compressed.length,
      );
      if (offset % 65536 === 0)
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (size !== entry.size) throw new Error("Invalid EPUB entry size");
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }
  const container = xml(
    await read("META-INF/container.xml", PREVIEW_LIMITS.xmlBytes),
  );
  const root =
    elements(container, "rootfile").find(
      (element) =>
        element.getAttribute("media-type") === "application/oebps-package+xml",
    ) ?? elements(container, "rootfile")[0];
  const packagePath = epubPath("", root?.getAttribute("full-path") ?? "");
  const packageDoc = xml(await read(packagePath, PREVIEW_LIMITS.xmlBytes));
  const items = elements(packageDoc, "item");
  const coverId = elements(packageDoc, "meta")
    .find((element) => element.getAttribute("name") === "cover")
    ?.getAttribute("content");
  const cover =
    items.find((item) =>
      item.getAttribute("properties")?.split(/\s+/).includes("cover-image"),
    ) ?? items.find((item) => coverId && item.getAttribute("id") === coverId);
  const guide = elements(packageDoc, "reference").find(
    (element) => element.getAttribute("type") === "cover",
  );
  const href = cover?.getAttribute("href") ?? guide?.getAttribute("href");
  if (!href) throw new Error("No EPUB cover");
  let coverPath = epubPath(packagePath, href);
  if (
    cover?.getAttribute("media-type") === "application/xhtml+xml" ||
    (!cover && guide)
  ) {
    const wrapper = xml(await read(coverPath, PREVIEW_LIMITS.xmlBytes));
    const image = elements(wrapper, "img")[0] ?? elements(wrapper, "image")[0];
    const source =
      image?.getAttribute("src") ??
      image?.getAttribute("href") ??
      image?.getAttributeNS("http://www.w3.org/1999/xlink", "href");
    coverPath = epubPath(coverPath, source ?? "");
  }
  // SVG/HTML covers are not rendered. rasterThumbnail checks the magic bytes.
  return read(coverPath, PREVIEW_LIMITS.coverBytes);
}
