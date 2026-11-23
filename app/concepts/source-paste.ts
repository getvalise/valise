import type { AllowanceSettings } from "~/concepts/attachment-limits";
import {
  type ArticleInput,
  MAX_ARTICLE_CHARS,
  MIN_ARTICLE_WORDS,
} from "~/concepts/source-articles";
import { articleInput, extractPage } from "~/concepts/source-fetch";
import type { Provenance } from "./memories";
import { type Source, saveSource } from "./sources";

/**
 * Article text a phone took from the page the owner had open: posted by the
 * Shortcut to `/capture`, or pasted on `/save`. ADR-0015, amendments of
 * 2026-10-30 and 2026-11-02.
 */
export const PASTE_EXTRACTOR = "valise-paste-1";
/** The same cap Valise's own fetch reads a page to. */
export const MAX_PASTE_BYTES = 3 * 1024 * 1024;

export type Pasted = {
  /** Null when the clipboard held too few words to be an article. */
  article: ArticleInput | null;
  wordCount: number;
  title: string | null;
  authors: string[];
};

/**
 * HTML goes through the same cut as a fetched page; anything else is the
 * article as plain text. A paywall marker is ignored: the owner's browser
 * already showed them the text, which is what a capture keeps.
 */
export async function pastedArticle(pasted: string): Promise<Pasted> {
  const raw = pasted.trim();
  const page = /^</.test(raw)
    ? (await extractPage(raw)).article
    : plainText(raw);
  return {
    article:
      page.wordCount >= MIN_ARTICLE_WORDS
        ? articleInput(page, PASTE_EXTRACTOR)
        : null,
    wordCount: page.wordCount,
    title: page.title,
    authors: page.authors,
  };
}

export type Capture = {
  url: string;
  title?: string;
  notes?: string;
  tags?: readonly string[];
  /** Article text or page HTML; empty leaves the page to Valise's fetch. */
  pasted?: string;
};

/**
 * Saves a phone capture as a bookmark, so the same URL again revises it. The
 * caller has checked the URL with `savableUrl`. Throws `SourceRefused`.
 */
export async function captureBookmark(
  env: { DB: D1Database } & AllowanceSettings,
  capture: Capture,
  provenance: Provenance,
): Promise<{ source: Source; pasted: Pasted }> {
  const pasted = await pastedArticle(capture.pasted ?? "");
  const source = await saveSource(
    env,
    {
      kind: "bookmark",
      title: capture.title?.trim() || pasted.title || titleOf(capture.url),
      url: capture.url,
      notes: capture.notes ?? "",
      tags: capture.tags ?? [],
      ...(pasted.authors.length ? { authors: pasted.authors } : {}),
      // No article row leaves the page to Valise's own fetch.
      ...(pasted.article ? { article: pasted.article } : {}),
    },
    provenance,
  );
  return { source, pasted };
}

export function savableUrl(value: string): boolean {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

function titleOf(url: string): string {
  const { hostname, pathname } = new URL(url);
  return `${hostname.replace(/^www\./, "")}${pathname === "/" ? "" : pathname}`;
}

function plainText(raw: string) {
  const text = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  const wordCount = (text.match(/\S+/g) ?? []).length;
  return {
    text: text.slice(0, MAX_ARTICLE_CHARS),
    wordCount,
    pageWordCount: wordCount,
    title: null,
    authors: [],
    published: null,
    siteName: null,
    canonicalUrl: null,
    description: null,
    language: null,
  };
}
