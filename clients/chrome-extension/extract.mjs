import { Readability } from "@mozilla/readability";
import Defuddle, { createMarkdownContent } from "defuddle/full";

/** Below either bound the page is kept but no article is claimed. */
export const MIN_ARTICLE_WORDS = 150;
export const MIN_ARTICLE_SHARE = 0.1;
/** Bounds what one save sends; the server refuses anything larger. */
export const MAX_ARTICLE_CHARS = 200_000;

const words = (text) => (text.match(/\S+/g) ?? []).length;
const clean = (value, max) => {
  const text =
    typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text ? text.slice(0, max) : null;
};
function httpUrl(value, base) {
  if (!value) return null;
  try {
    const url = new URL(value, base);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password)
      return null;
    url.hash = "";
    return url.href.length <= 2048 ? url.href : null;
  } catch {
    return null;
  }
}

/** "A, B and C" or "A; B" → ["A", "B", "C"]; a lone "Last, First" stays whole. */
export function splitAuthors(value) {
  const text = clean(value, 1000);
  if (!text) return [];
  const parts = text
    .replace(/^by\s+/i, "")
    .split(/\s*(?:;|\||&|\band\b|,)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 2 && !/\s/.test(parts[0]) && !/\s/.test(parts[1]))
    return [`${parts[1]} ${parts[0]}`];
  return [...new Set(parts)].slice(0, 20).map((part) => part.slice(0, 200));
}

/** Words of link text in extracted HTML: a list of links is not an article. */
function linkWords(html) {
  const body = new DOMParser().parseFromString(html, "text/html").body;
  let total = 0;
  for (const link of body.querySelectorAll("a"))
    total += words(link.textContent);
  return total;
}

function htmlToText(html) {
  const body = new DOMParser().parseFromString(html, "text/html").body;
  for (const block of body.querySelectorAll(
    "p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,tr,figcaption,br",
  ))
    block.append("\n");
  return body.textContent
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

/**
 * Reads the article out of a document at capture time. Works on clones so the
 * live page is never modified: Defuddle normalizes attributes and strips
 * scripts from the document it is given, and Readability empties it. No
 * extractor here fetches anything.
 */
export function extractArticle(doc = document, pageUrl = location.href) {
  const pageText = doc.body?.innerText ?? doc.body?.textContent ?? "";
  const pageWords = words(pageText);
  let defuddled = null;
  try {
    defuddled = new Defuddle(doc.cloneNode(true), {
      url: pageUrl,
      useAsync: false,
    }).parse();
  } catch {
    defuddled = null;
  }
  let content = defuddled?.content ?? "";
  let extractor = "defuddle-0.19";
  let text = content ? htmlToText(content) : "";
  if (words(text) < MIN_ARTICLE_WORDS) {
    try {
      const readable = new Readability(doc.cloneNode(true)).parse();
      const readableText = readable?.content
        ? htmlToText(readable.content)
        : "";
      if (words(readableText) > words(text)) {
        content = readable.content;
        text = readableText;
        extractor = "readability-0.6";
      }
    } catch {
      /* Keep Defuddle's result, however small. */
    }
  }
  const wordCount = words(text);
  // Prose, not link text, has to clear the bar: an extractor that falls back
  // to a page of navigation returns plenty of words and no article.
  const proseWords = wordCount - (content ? linkWords(content) : 0);
  const detected =
    proseWords >= MIN_ARTICLE_WORDS &&
    proseWords >= MIN_ARTICLE_SHARE * Math.max(pageWords, wordCount);
  let markdown = "";
  if (detected) {
    try {
      markdown = createMarkdownContent(content, pageUrl).trim();
    } catch {
      markdown = "";
    }
    if (!markdown) markdown = text;
  }
  const truncated = markdown.length > MAX_ARTICLE_CHARS;
  const canonical = doc
    .querySelector('link[rel~="canonical"]')
    ?.getAttribute("href");
  return {
    detected,
    extractor,
    wordCount,
    pageWordCount: pageWords,
    markdown: detected ? markdown.slice(0, MAX_ARTICLE_CHARS) : "",
    text: detected ? text.slice(0, MAX_ARTICLE_CHARS) : "",
    truncated: detected && truncated,
    authors: splitAuthors(defuddled?.author),
    published: clean(defuddled?.published, 100),
    siteName: clean(defuddled?.site, 200),
    canonicalUrl: httpUrl(canonical, pageUrl),
    leadImage: httpUrl(defuddled?.image, pageUrl),
    description: clean(defuddled?.description, 1000),
    language: clean(defuddled?.language || doc.documentElement.lang, 35),
  };
}
