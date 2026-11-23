/** Review URLs stay under Memories, including legacy queries and no-script edits (P3). */
export function memoryReviewHref(
  params: URLSearchParams = new URLSearchParams(),
  changes: Record<string, string | null> = {},
): string {
  const next = new URLSearchParams(params);
  next.set("tab", "review");
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) next.delete(key);
    else next.set(key, value);
  }
  return `/memories?${next}`;
}
