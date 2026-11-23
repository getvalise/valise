/** The text block mirrors the structured result, for clients that read text. */
export function textResult<T>(structuredContent: T) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(structuredContent) },
    ],
    structuredContent,
  };
}

export function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/**
 * Leaves out every key whose value says nothing: null, undefined, an empty
 * array, or an object with nothing left after the same. `false` and `0` stay,
 * since they can be the answer. Only for objects an output schema leaves
 * open, such as `fetch`'s metadata; a key a schema requires stays even when
 * null. ADR-0003, amendment of 2026-11-15.
 */
export function withoutEmpty<T extends Record<string, unknown>>(
  value: T,
): Partial<T> {
  const kept: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const compact =
      entry !== null && typeof entry === "object" && !Array.isArray(entry)
        ? withoutEmpty(entry as Record<string, unknown>)
        : entry;
    if (compact === null || compact === undefined) continue;
    if (Array.isArray(compact) && compact.length === 0) continue;
    if (
      typeof compact === "object" &&
      !Array.isArray(compact) &&
      Object.keys(compact).length === 0
    )
      continue;
    kept[key] = compact;
  }
  return kept as Partial<T>;
}
