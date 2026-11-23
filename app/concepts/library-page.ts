/** Fixed-size keyset windows: the URL never grows the amount read or rendered. */
export const LIBRARY_PAGE_SIZE = 30;

/** The last row's order key, created_at unless a caller sorts by another. */
type Boundary = { createdAt: number; id: string };
export type LibraryPageOptions = {
  after?: string;
  project?: string;
  tags?: readonly string[];
  durableOnly?: boolean;
  query?: string;
};
export type LibraryPage<T> = { items: T[]; next: string | null };

export function libraryBoundary(value: string | undefined): Boundary | null {
  if (!value) return null;
  try {
    if (value.length > 200) throw new Error();
    const parsed = JSON.parse(
      atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    );
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      !Number.isSafeInteger(parsed[0]) ||
      parsed[0] < 0 ||
      typeof parsed[1] !== "string" ||
      !/^(?:src|ast)_[0-9a-f-]{36}$/.test(parsed[1])
    )
      throw new Error();
    return { createdAt: parsed[0], id: parsed[1] };
  } catch {
    throw new Response("Invalid library cursor. Open the newest page again.", {
      status: 400,
    });
  }
}

export function libraryPage<T>(
  rows: T[],
  boundary: (row: T) => Boundary,
): LibraryPage<T> {
  const items = rows.slice(0, LIBRARY_PAGE_SIZE);
  const last = items.at(-1);
  const key = last ? boundary(last) : null;
  return {
    items,
    next:
      rows.length > LIBRARY_PAGE_SIZE && key
        ? btoa(JSON.stringify([key.createdAt, key.id]))
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replace(/=+$/, "")
        : null,
  };
}

/** SQL identifiers and the order key are caller-owned constants, never URL input. */
export function libraryPageWhere(
  alias: string,
  id: string,
  options: LibraryPageOptions,
  key = `${alias}.created_at`,
): { sql: string; values: (string | number)[] } {
  const clauses: string[] = [];
  const values: (string | number)[] = [];
  if (options.query?.trim()) {
    const text =
      id === "source_id"
        ? `${alias}.title || ' ' || COALESCE(${alias}.url, '') || ' ' || ${alias}.notes || ' ' || ${alias}.tags_json`
        : `${alias}.title || ' ' || ${alias}.file_name || ' ' || ${alias}.description || ' ' || ${alias}.tags_json`;
    clauses.push(`instr(lower(${text}), lower(?)) > 0`);
    values.push(options.query.trim().slice(0, 200));
  }
  if (options.project) {
    clauses.push(`${alias}.project = ?`);
    values.push(options.project);
  }
  for (const tag of options.tags?.slice(0, 20) ?? []) {
    clauses.push(
      `EXISTS (SELECT 1 FROM json_each(${alias}.tags_json) WHERE value = ?)`,
    );
    values.push(tag);
  }
  if (options.durableOnly) clauses.push(`${alias}.expires_at IS NULL`);
  const after = libraryBoundary(options.after);
  if (after) {
    clauses.push(`(${key} < ? OR (${key} = ? AND ${alias}.${id} < ?))`);
    values.push(after.createdAt, after.createdAt, after.id);
  }
  return { sql: clauses.map((clause) => ` AND ${clause}`).join(""), values };
}
