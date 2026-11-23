import { extractArticle } from "./extract.mjs";

/** The name the page's stylesheet rule and the highlight registry share. */
export const HIGHLIGHT = "valise-article";
/** The port the popup holds open; its disconnect clears the highlight. */
export const PREVIEW_PORT = "valise-preview";
// A popup that closed before it connected never disconnects either.
const UNCLAIMED_MS = 5000;

const key = (text) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 60);

/**
 * Ranges over the live page's blocks whose text opens a paragraph of the
 * extracted article. Matching on letters and digits only lets a footnote
 * marker or curly quote differ between the page and the extract.
 */
export function articleRanges(doc, text) {
  const paragraphs = new Set(
    text
      .split(/\n+/)
      .map(key)
      .filter((value) => value.length >= 30),
  );
  const ranges = [];
  const marked = new Set();
  if (!paragraphs.size || !doc.body) return ranges;
  for (const block of doc.body.querySelectorAll(
    "p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,figcaption,dd,td",
  )) {
    if (marked.has(block.parentElement?.closest("p,li,blockquote,pre,dd,td")))
      continue;
    if (!paragraphs.has(key(block.textContent ?? ""))) continue;
    const range = doc.createRange();
    range.selectNodeContents(block);
    ranges.push(range);
    marked.add(block);
  }
  return ranges;
}

/**
 * Extract the article and tint it on the live page with the CSS Custom
 * Highlight API, which paints ranges without touching the DOM, so neither
 * the page nor the snapshot taken from it changes. Cleared when the popup's
 * port disconnects, that is when the popup closes.
 */
export function previewArticle(doc = document, pageUrl = location.href) {
  const article = extractArticle(doc, pageUrl);
  let marked = 0;
  try {
    const registry = globalThis.CSS?.highlights;
    if (article.detected && registry && globalThis.Highlight) {
      const ranges = articleRanges(doc, article.text);
      if (ranges.length) {
        registry.set(HIGHLIGHT, new Highlight(...ranges));
        marked = ranges.length;
        clearWhenPopupCloses(registry);
      }
    }
  } catch {
    marked = 0;
  }
  return { ...article, marked };
}

let unclaimed;
function clearWhenPopupCloses(registry) {
  const clear = () => registry.delete(HIGHLIGHT);
  clearTimeout(unclaimed);
  unclaimed = setTimeout(clear, UNCLAIMED_MS);
  if (globalThis.valisePreviewListening) return;
  globalThis.valisePreviewListening = true;
  globalThis.chrome?.runtime?.onConnect?.addListener((port) => {
    if (port.name !== PREVIEW_PORT) return;
    clearTimeout(unclaimed);
    port.onDisconnect.addListener(clear);
  });
}
