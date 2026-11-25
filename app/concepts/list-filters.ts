import { parseFacet } from "~/concepts/facets";
import { pageNumber } from "~/concepts/pagination";

export type ListFilters = {
  page?: number;
  query?: string;
  project?: string;
  /**
   * Every tag a row must carry, as repeated `?tag=` parameters. AND, because
   * a second tag narrows a list, the way the project and the tag already
   * combine, and the way `search` reads its `tags`.
   */
  tags?: string[];
  /** A concept's own type column. Only the memories page offers it. */
  type?: string;
  /**
   * Bring done rows into the list, as `?done=show`. Absent, the to-dos page
   * leaves them out, so the working list is what is left to do. Only the
   * to-dos page reads it.
   */
  showDone?: boolean;
  /** Only blocked rows. The to-dos page's other toggle. */
  blocked?: boolean;
  /** Bring deleted rows back into the list. Only the skills page offers it. */
  showDeleted?: boolean;
  /**
   * A list's named order. Only the memories page offers them: `last-fetched`,
   * `fetched` and `in-results`, from the call log. Absent is newest update.
   */
  sort?: string;
};

export function filtersFromRequest(request: Request): ListFilters {
  const params = new URL(request.url).searchParams;
  const filters: ListFilters = {
    page: pageNumber(params.get("page")),
    query: optionalParam(params.get("q")),
    project: optionalParam(params.get("project")),
    type: optionalParam(params.get("type")),
    showDone: params.get("done") === "show" || undefined,
    blocked: params.get("state") === "blocked" || undefined,
    showDeleted: params.get("deleted") === "show" || undefined,
    sort: optionalParam(params.get("sort")),
  };
  const tags: string[] = [];
  for (const raw of params.getAll("tag")) {
    const tag = optionalParam(raw);
    if (tag === undefined) continue;
    // `project:valise` typed into the tag box filters the project column,
    // the way the same facet routes on a write. ADR-0009.
    const facet = parseFacet(tag);
    if (facet?.key === "project" || facet?.key === "type") {
      filters[facet.key] = facet.value;
    } else if (facet?.key === "state" && facet.value === "blocked") {
      // `state:blocked` is the one state a person filters to by name.
      filters.blocked = true;
    } else if (!tags.some((one) => one.toLowerCase() === tag.toLowerCase())) {
      tags.push(tag);
    }
  }
  if (tags.length > 0) filters.tags = tags;
  return filters;
}

/**
 * A list's own URL with something changed on it. The filters are the page's
 * state, so every link out of a row — a facet, a pen, a cancel — has to carry
 * them or clicking it silently resets the list. `undefined` drops a key,
 * which is how an editor closes.
 */
export function listHref(
  path: string,
  filters: ListFilters,
  extra: Record<string, string | undefined> = {},
): string {
  const params = new URLSearchParams();
  const merged: Record<string, string | undefined> = {
    q: filters.query,
    type: filters.type,
    project: filters.project,
    done: filters.showDone ? "show" : undefined,
    state: filters.blocked ? "blocked" : undefined,
    deleted: filters.showDeleted ? "show" : undefined,
    sort: filters.sort,
    page: filters.page ? String(filters.page) : undefined,
    ...extra,
  };
  for (const [key, value] of Object.entries(merged)) {
    if (value) params.set(key, value);
    // The tags sit after the project, where the single `tag` used to.
    if (key === "project") {
      for (const tag of filters.tags ?? []) params.append("tag", tag);
    }
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

/**
 * The filters with one more tag, for a tag chip: a click narrows the list
 * rather than swapping one tag for another.
 */
export function withTag(filters: ListFilters, tag: string): ListFilters {
  const tags = filters.tags ?? [];
  return tags.some((one) => one.toLowerCase() === tag.toLowerCase())
    ? filters
    : { ...filters, page: undefined, tags: [...tags, tag] };
}

/**
 * A row passes when no wanted tag is missing from `column`, a JSON array.
 * One placeholder, bound to `tagsParam(filters)`; an empty list passes all.
 * A statement that numbers its parameters passes its own, such as `?9`.
 */
export function everyTagSql(column: string, placeholder = "?"): string {
  return `NOT EXISTS (
            SELECT 1 FROM json_each(${placeholder}) AS wanted
             WHERE NOT EXISTS (
               SELECT 1 FROM json_each(${column}) AS have
                WHERE lower(have.value) = lower(wanted.value)
             )
          )`;
}

export function tagsParam(filters: ListFilters): string {
  return JSON.stringify(filters.tags ?? []);
}

function optionalParam(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
