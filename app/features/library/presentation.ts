import type { Asset } from "~/concepts/assets";
import { raindropSource } from "~/concepts/source-text";
import type { Source } from "~/concepts/sources";

/** Import receipts remain authoritative, but they are not reading material. */
export function importBackup(
  asset: Pick<Asset, "tags" | "sourceAgent">,
): boolean {
  return (
    asset.sourceAgent === "raindrop-import" &&
    asset.tags.includes("import-snapshot")
  );
}

/** Editing the reading notes must not accidentally discard the import receipt. */
export function withReadingNotes(
  source: Pick<Source, "notes" | "sourceAgent" | "sourceClient">,
  edited: string,
): string {
  if (!raindropSource(source)) return edited;
  const marker = [
    ...source.notes.matchAll(
      /(?:^|\n\n)Imported from Raindrop\.io bookmark \d+\./g,
    ),
  ].at(-1);
  if (!marker) return edited;
  return `${edited.trim()}\n\n${source.notes.slice(marker.index).trimStart()}`.trimStart();
}

export function libraryTags(
  tags: readonly string[],
  imported = false,
): string[] {
  return imported
    ? tags.filter(
        (tag) =>
          tag !== "raindrop" &&
          tag !== "import-snapshot" &&
          !tag.startsWith("collection:"),
      )
    : [...tags];
}

export function withLibraryTags(
  existing: string[],
  edited: string[],
  imported: boolean,
): string[] {
  if (!imported) return edited;
  const visible = new Set(libraryTags(existing, true));
  return [
    ...new Set([...edited, ...existing.filter((tag) => !visible.has(tag))]),
  ];
}

export function importedCollection(
  source: Pick<Source, "tags" | "sourceAgent" | "sourceClient">,
): string | null {
  if (!raindropSource(source)) return null;
  const path = source.tags
    .find((tag) => tag.startsWith("collection:"))
    ?.slice(11);
  return path && path !== "Unsorted" ? path : null;
}

/** Group only an explicit shared project + reference tag, not inferred content. */
export function referenceGroup(
  asset: Pick<Asset, "project" | "tags" | "contentType">,
): string | null {
  return asset.project &&
    asset.tags.includes("reference") &&
    asset.contentType.startsWith("image/")
    ? asset.project
    : null;
}

export function pageHost(url: string | null): string {
  try {
    return new URL(url ?? "").hostname.replace(/^www\./, "");
  } catch {
    return "Saved note";
  }
}

export function fileKind(contentType: string): string {
  if (contentType === "application/pdf") return "PDF";
  if (contentType === "application/epub+zip") return "EPUB";
  if (contentType.startsWith("image/")) return "Image";
  if (contentType.includes("presentation")) return "Presentation";
  if (contentType.includes("spreadsheet")) return "Spreadsheet";
  if (contentType === "text/html") return "Saved page";
  if (contentType.startsWith("text/")) return "Text";
  return "Document";
}

/**
 * Article images point at the original site. Loading them would tell that
 * site when the owner reads, so each becomes a link the owner can choose.
 */
export function withoutRemoteImages(markdown: string): string {
  return markdown.replace(
    /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g,
    (_, alt: string, url: string) => `[Image${alt ? `: ${alt}` : ""}](${url})`,
  );
}

/** Characters a reader sees: a link's words, not its URL. */
function visibleLength(markdown: string): number {
  return markdown.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim().length;
}

/**
 * An article's opening blocks and the rest, split between blocks so no
 * paragraph, list or fence is cut. The opening runs to at least `lead`
 * visible characters; a remainder shorter than `least` is not worth a
 * "Read more" and stays in the opening.
 */
export function articleExcerpt(
  markdown: string,
  { lead = 400, least = 200 }: { lead?: number; least?: number } = {},
): { opening: string; rest: string } {
  const blocks = markdown.split(/\n{2,}/);
  let fenced = false;
  let seen = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    const fences = blocks[index].match(/^\s*(```|~~~)/gm)?.length ?? 0;
    if (fences % 2) fenced = !fenced;
    seen += visibleLength(blocks[index]);
    if (fenced || seen < lead) continue;
    const opening = blocks.slice(0, index + 1).join("\n\n");
    const rest = blocks.slice(index + 1).join("\n\n");
    return visibleLength(rest) < least
      ? { opening: markdown, rest: "" }
      : { opening, rest };
  }
  return { opening: markdown, rest: "" };
}

export function publishedDate(value: string | null): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value.slice(0, 40);
  return new Date(time).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** The reader view of a source's newest article. */
export function readerHref(sourceId: string): string {
  return `/library/read/${sourceId}`;
}
