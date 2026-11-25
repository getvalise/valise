import { z } from "zod";

/**
 * A keyset cursor over `created_at DESC, id ASC` with an insertion
 * high-water mark (`MAX(rowid)` when the listing began), the shape
 * `queryTodos` uses. `created_at` never changes after insert, so an edit
 * cannot move a row across pages; a row inserted after the first page, even
 * one backdated, waits for a fresh listing. `filter` is the listing's filters
 * as a string, so a cursor reused with other filters is refused rather than
 * silently paging a different list.
 */
const cursorSchema = z.object({
  version: z.literal(1),
  filter: z.string(),
  high: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  id: z.string().min(1).max(200),
});

export type ListCursor = z.infer<typeof cursorSchema>;

export class ListCursorError extends Error {}

export function readListCursor(
  raw: string | null | undefined,
  filter: string,
  filterNames: string,
): ListCursor | null {
  if (!raw) return null;
  try {
    const cursor = cursorSchema.parse(
      JSON.parse(
        new TextDecoder().decode(
          Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)),
        ),
      ),
    );
    if (cursor.filter !== filter) throw new Error("different filters");
    return cursor;
  } catch {
    throw new ListCursorError(
      `Invalid cursor; reuse it with the same ${filterNames}, or start a fresh listing.`,
    );
  }
}

export function writeListCursor(cursor: Omit<ListCursor, "version">): string {
  return btoa(
    Array.from(
      new TextEncoder().encode(JSON.stringify({ version: 1, ...cursor })),
      (byte) => String.fromCharCode(byte),
    ).join(""),
  );
}

/** Tags as a filter signature: trimmed, lowercased, sorted, deduplicated. */
export function tagSignature(tags: readonly string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((tag) => tag.trim().toLowerCase()))]
    .filter(Boolean)
    .sort();
}
