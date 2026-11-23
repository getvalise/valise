import type { SourceArticle } from "~/concepts/source-articles";
import type { Source } from "~/concepts/sources";

/** Text shorter than this is read whole rather than summarised. */
export const SHORT_TEXT_CHARS = 500;

export function raindropSource(
  source: Pick<Source, "sourceAgent" | "sourceClient">,
): boolean {
  return (
    source.sourceAgent === "raindrop-import" &&
    source.sourceClient === "raindrop.io"
  );
}

/** The notes a person reads: a Raindrop import receipt is provenance, not
 * reading material. Never strip, rewrite or reindex the stored notes. */
export function readingNotes(
  source: Pick<Source, "notes" | "sourceAgent" | "sourceClient">,
): string {
  if (!raindropSource(source)) return source.notes;
  const marker = [
    ...source.notes.matchAll(
      /(?:^|\n\n)Imported from Raindrop\.io bookmark \d+\./g,
    ),
  ].at(-1);
  return (marker ? source.notes.slice(0, marker.index) : source.notes).trim();
}

/**
 * What a saved page says, as captured: the detected article, else the notes
 * the person or their client saved. A summary reads this; text under
 * SHORT_TEXT_CHARS is shown as itself instead.
 */
export type SourceText =
  | { from: "article" | "notes"; text: string; short: boolean }
  | { from: null };

export function sourceText(
  source: Pick<Source, "notes" | "sourceAgent" | "sourceClient">,
  article: Pick<SourceArticle, "detected" | "text"> | null,
): SourceText {
  const articleText = article?.detected ? article.text.trim() : "";
  const notes = readingNotes(source).trim();
  const [from, text] = articleText
    ? (["article", articleText] as const)
    : notes
      ? (["notes", notes] as const)
      : ([null, ""] as const);
  if (!from) return { from: null };
  return { from, text, short: text.length < SHORT_TEXT_CHARS };
}
