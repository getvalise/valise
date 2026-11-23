import { type ShouldRevalidateFunctionArgs } from "react-router";
import { type ListFilters, listHref } from "~/concepts/list-filters";

/**
 * Opening or closing a to-do only rewrites `?open=`, closing a field the
 * URL opened only drops `?edit=`, and flipping a history's order only sets
 * `?history=`; the list any of them names is already on
 * screen. Re-running the loader for that would re-query every row and scroll
 * to the one just opened, moving the list under the reader (P4). Which field
 * is open is read from the URL on the client, not from loader data, for the
 * same reason.
 */
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (formMethod || currentUrl.pathname !== nextUrl.pathname) {
    return defaultShouldRevalidate;
  }
  const rest = (url: URL) => {
    const params = new URLSearchParams(url.search);
    params.delete("open");
    params.delete("edit");
    params.delete("history");
    return params.toString();
  };
  return rest(currentUrl) === rest(nextUrl) ? false : defaultShouldRevalidate;
}

/** The list filtered to this project, or unfiltered if it already is. */
export function projectHref(filters: ListFilters, project: string): string {
  return listHref("/todos", {
    ...filters,
    page: undefined,
    project: filters.project === project ? undefined : project,
  });
}

/** What `?edit=` says when the add row at the top of the list is open. */
export const ADDING = "new";
