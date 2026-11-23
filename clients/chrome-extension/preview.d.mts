import type { ExtractedArticle } from "./capture.mjs";
export const HIGHLIGHT: string;
export const PREVIEW_PORT: string;
export function articleRanges(doc: Document, text: string): Range[];
export function previewArticle(
  doc?: Document,
  pageUrl?: string,
): ExtractedArticle & { marked: number };
