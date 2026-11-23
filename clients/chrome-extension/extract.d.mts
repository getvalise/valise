import type { ExtractedArticle } from "./capture.mjs";
export const MIN_ARTICLE_WORDS: number;
export const MIN_ARTICLE_SHARE: number;
export const MAX_ARTICLE_CHARS: number;
export function splitAuthors(value: unknown): string[];
export function extractArticle(
  doc?: Document,
  pageUrl?: string,
): ExtractedArticle;
