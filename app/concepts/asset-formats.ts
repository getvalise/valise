/** Shared display/admission policy; this module imports no parser or provider. */
import {
  FILE_PROMPT_BYTES,
  summaryCostMicrousd,
} from "~/concepts/summary-model";

export const MAX_PROCESSING_BYTES = 25 * 1024 * 1024;
/** Larger files wait for an explicit Process, after their cost estimate is shown. */
export const AUTO_PROCESSING_BYTES = 8 * 1024 * 1024;

export const PROCESSING_FORMATS: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  epub: "application/epub+zip",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  md: "text/markdown",
};

/** Saved names can be truncated or extensionless; a known MIME is sufficient. */
export function processingFormat(
  fileName: string,
  contentType = "",
): string | null {
  const mime = contentType.split(";", 1)[0].trim().toLowerCase();
  const declared = Object.entries(PROCESSING_FORMATS).find(
    ([, type]) => type === mime,
  )?.[0];
  if (declared) return declared;
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  return PROCESSING_FORMATS[extension] ? extension : null;
}

export function processingEligibility(
  fileName: string,
  contentType: string,
  size: number,
): string | null {
  if (!processingFormat(fileName, contentType))
    return "Text extraction is not available for this file type. You can still preview or download the original and search its title, tags and description.";
  if (size > MAX_PROCESSING_BYTES)
    return "This file exceeds the 25 MiB text-extraction limit. The original is saved; its title, tags and description remain searchable.";
  return null;
}

export const PROCESSING_SUPPORT =
  "PDF text with page numbers (not scanned-page OCR), PNG/JPEG/WebP/GIF image descriptions, XLSX cell text, EPUB chapters, PPTX slides, and plain text or Markdown. Up to 25 MiB per file and 1 MiB of extracted text, indexed in passages of about a page; files over 8 MiB wait for you to start them. No macros, formulas, scripts or external links are executed or fetched.";

/** Workers AI list price for bge-m3, USD per million tokens, read 2026-10-29. */
const BGE_M3_INPUT = 0.012;

export type ProcessingEstimate = {
  /** Upper bound on extracted text tokens, from the retained-text cap. */
  tokens: number;
  usd: number;
  /** Image conversion runs a vision model this estimate does not price. */
  unpriced: boolean;
};

/**
 * An upper bound, shown before processing. Text conversion is free; the
 * metadata call reads at most `FILE_PROMPT_BYTES`; embeddings cover at most
 * the retained text. Image description is billed by Workers AI and not priced here.
 */
export function processingEstimate(
  fileName: string,
  contentType: string,
  size: number,
): ProcessingEstimate | null {
  const format = processingFormat(fileName, contentType);
  if (!format || size > MAX_PROCESSING_BYTES) return null;
  // Text is rarely larger than the file; one token per four bytes.
  const tokens = Math.ceil(Math.min(size, 1024 * 1024) / 4);
  // The prompt prefix at four bytes a token, plus instructions and vocabulary.
  const prompt = Math.ceil(Math.min(size, FILE_PROMPT_BYTES) / 4) + 2000;
  const metadata = summaryCostMicrousd({ input: prompt, output: 900 }) / 1e6;
  const embedding = (tokens * BGE_M3_INPUT) / 1e6;
  return {
    tokens,
    usd: metadata + embedding,
    unpriced: ["png", "jpg", "jpeg", "webp", "gif"].includes(format),
  };
}

export function formatEstimate(estimate: ProcessingEstimate): string {
  const cents = estimate.usd * 100;
  const money = cents < 1 ? "under 1 cent" : `about ${Math.ceil(cents)} cents`;
  return estimate.unpriced
    ? `Estimated cost: ${money}, plus the image description model.`
    : `Estimated cost: ${money} (up to ${estimate.tokens.toLocaleString("en-US")} tokens of text).`;
}
