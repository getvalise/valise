import { unzipSync } from "fflate";
import {
  PROCESSING_FORMATS as FORMATS,
  MAX_PROCESSING_BYTES,
  processingFormat,
} from "~/concepts/asset-formats";
import { capBody } from "~/search/project";

export {
  MAX_PROCESSING_BYTES,
  PROCESSING_SUPPORT,
  processingFormat,
} from "~/concepts/asset-formats";

/** Application budgets, not claims about a provider's maximum file size.
 * One MiB holds a 400-page book and stays well under D1's 2 MB row limit. */
export const MAX_EXTRACTED_BYTES = 1024 * 1024;
export const PROCESSOR_VERSION = "valise-extract-3";

export class ProcessingRefused extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type ExtractedAsset = {
  text: string;
  truncated: boolean;
  extractor: string;
};

/** Only owned original bytes enter here; never a caller-supplied URL. */
export async function extractAssetText(
  ai: Pick<Ai, "toMarkdown"> | undefined,
  fileName: string,
  bytes: ArrayBuffer,
  contentType = "",
): Promise<ExtractedAsset> {
  const format = processingFormat(fileName, contentType);
  if (format === null)
    throw new ProcessingRefused(
      "unsupported_format",
      "This file format is not supported for processing. The original is still available.",
    );
  if (bytes.byteLength > MAX_PROCESSING_BYTES)
    throw new ProcessingRefused(
      "processing_size_limit",
      "Processing is limited to 25 MiB. The original is still available.",
    );
  let text: string;
  let extractor: string;
  if (format === "txt" || format === "md") {
    text = new TextDecoder().decode(bytes);
    extractor = "utf8-text-1";
  } else if (format === "epub" || format === "pptx") {
    text = extractArchiveText(new Uint8Array(bytes), format);
    extractor = `bounded-${format}-text-2`;
  } else {
    if (!ai)
      throw new ProcessingRefused(
        "ai_unavailable",
        "Workers AI conversion is unavailable. Retry later; the original is still available.",
      );
    let converted: ConversionResponse;
    try {
      converted = await deadline(
        ai.toMarkdown({
          name: `original.${format}`,
          blob: new Blob([bytes], { type: FORMATS[format] }),
        }),
        12000,
      );
    } catch (error) {
      if (error instanceof ProcessingRefused) throw error;
      throw new ProcessingRefused(
        "conversion_unconfirmed",
        "Conversion did not confirm completion. The provider may still be working; refresh after the cooldown before retrying.",
      );
    }
    if (converted.format === "error" || typeof converted.data !== "string")
      throw new ProcessingRefused(
        "conversion_failed",
        "File conversion failed. Encrypted, scanned or damaged files may not yield text.",
      );
    text = converted.data;
    extractor =
      format === "pdf" || format === "xlsx"
        ? "workers-ai-toMarkdown-text"
        : "workers-ai-toMarkdown-image-description";
  }
  text = text.replaceAll("\0", "").trim();
  if (!text)
    throw new ProcessingRefused(
      "no_text",
      "No usable text was extracted. Scanned PDFs need OCR, which is not supported here.",
    );
  const bounded = capBody(text, MAX_EXTRACTED_BYTES);
  return { text: bounded, truncated: bounded !== text, extractor };
}

/** Reject ZIP bombs before inflation. Only selected text entries are inflated. */
function extractArchiveText(
  bytes: Uint8Array,
  format: "epub" | "pptx",
): string {
  let entries = 0;
  let total = 0;
  let selectedBytes = 0;
  const files = unzipSync(bytes, {
    filter(file) {
      entries++;
      total += file.originalSize;
      if (
        entries > 2048 ||
        total > 64 * 1024 * 1024 ||
        file.originalSize > 4 * 1024 * 1024 ||
        /(^|\/)\.\.?(\/|$)|\\|^\//.test(file.name)
      )
        throw new ProcessingRefused(
          "archive_limit",
          "The archive exceeds the safe entry or expanded-size budget.",
        );
      const selected =
        format === "pptx"
          ? /^ppt\/slides\/slide\d+\.xml$/.test(file.name)
          : /\.(?:opf|xhtml|html|htm)$/i.test(file.name) ||
            file.name === "mimetype" ||
            file.name === "META-INF/container.xml";
      if (selected) {
        selectedBytes += file.originalSize;
        if (selectedBytes > 12 * 1024 * 1024)
          throw new ProcessingRefused(
            "archive_limit",
            "Selected archive text exceeds the safe 12 MiB expansion budget.",
          );
      }
      return selected;
    },
  });
  const read = (name: string) => new TextDecoder().decode(files[name]);
  if (format === "pptx") {
    return Object.keys(files)
      .sort(
        (a, b) =>
          Number(a.match(/slide(\d+)/)?.[1]) -
          Number(b.match(/slide(\d+)/)?.[1]),
      )
      .map(
        (name) =>
          `§ slide ${name.match(/slide(\d+)/)?.[1]}\n${plainText(read(name).replace(/<\/a:p>/g, "\n"))}`,
      )
      .join("\n\n");
  }
  if (
    read("mimetype") !== "application/epub+zip" ||
    !files["META-INF/container.xml"]
  )
    throw new ProcessingRefused(
      "invalid_epub",
      "The EPUB is missing its mimetype or container manifest.",
    );
  const container = read("META-INF/container.xml");
  const rootfile = container.match(/<(?:\w+:)?rootfile\b([^>]*)>/);
  const packageName = rootfile
    ? attributes(rootfile[1])["full-path"]
    : undefined;
  if (
    !packageName ||
    !files[packageName] ||
    /(^|\/)\.\.?($|\/)|\\|^\//.test(packageName)
  )
    throw new ProcessingRefused(
      "invalid_epub",
      "The EPUB has no readable package manifest.",
    );
  const manifest = read(packageName);
  const items = new Map<string, string>();
  for (const match of manifest.matchAll(/<(?:\w+:)?item\b([^>]*)>/g)) {
    const attrs = attributes(match[1]);
    if (attrs.id && attrs.href && !/^[\w+.-]+:|^\/\//.test(attrs.href)) {
      const url = new URL(attrs.href, `https://epub.invalid/${packageName}`);
      items.set(attrs.id, decodeURIComponent(url.pathname.slice(1)));
    }
  }
  const chapters = [...manifest.matchAll(/<(?:\w+:)?itemref\b([^>]*)>/g)]
    .map((match) => items.get(attributes(match[1]).idref))
    .filter((name): name is string => Boolean(name && files[name]));
  if (!chapters.length)
    throw new ProcessingRefused(
      "invalid_epub",
      "The EPUB spine has no readable chapters (DRM is not supported).",
    );
  const creator = manifest.match(
    /<dc:creator\b[^>]*>([\s\S]{1,400}?)<\/dc:creator>/,
  )?.[1];
  const author = creator ? plainText(creator).replace(/\s+/g, " ") : "";
  return [
    ...(author ? [`§ author: ${author}`] : []),
    ...chapters.map((name, i) => {
      const html = read(name);
      const heading =
        html.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1] ??
        html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ??
        "";
      const title = plainText(heading).replace(/\s+/g, " ").slice(0, 120);
      return `§ chapter ${i + 1}${title ? `: ${title}` : ""}\n${plainText(html)}`;
    }),
  ].join("\n\n");
}

function attributes(text: string): Record<string, string> {
  return Object.fromEntries(
    [...text.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map((match) => [
      match[1],
      entities(match[3]),
    ]),
  );
}

/** Text only, never HTML insertion or entity/DTD expansion. */
function plainText(xml: string): string {
  return entities(
    xml
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<!--[^]*?-->/g, "")
      .replace(/<\/(?:p|div|h[1-6]|li|tr|section)>/gi, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/[\t ]+/g, " ")
    .trim();
}

function entities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return text.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (whole, entity: string) => {
      if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? whole;
      const code =
        entity[1].toLowerCase() === "x"
          ? Number.parseInt(entity.slice(2), 16)
          : Number(entity.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : "";
    },
  );
}

export async function deadline<T>(
  work: Promise<T>,
  milliseconds: number,
): Promise<T> {
  // Bound our wait, not provider execution. A late result is discarded; the
  // caller retains its durable cooldown and spent attempt on this error.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ProcessingRefused(
                "provider_timeout",
                "Processing timed out. Retry later; the original is still available.",
              ),
            ),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
