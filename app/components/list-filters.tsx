import { Form, useLocation } from "react-router";
import { Combobox } from "~/components/combobox";
import { SearchField } from "~/components/search-bar";
import { TagFilter } from "~/components/tag-filter";
import type { FacetCount } from "~/concepts/facets";
import { type ListFilters, listHref } from "~/concepts/list-filters";
import type { Vocabulary } from "~/concepts/vocabulary";
import type { Concept } from "~/db/schema";

export function ListFilterForm({
  filters,
  types,
  vocabulary,
  facets,
  live,
}: {
  filters: ListFilters;
  live?: { query: string; onQueryChange: (value: string) => void };
  /**
   * The distinct type values actually in the store, so the filter shows the
   * vocabulary as written — drift included — rather than a constant.
   */
  types?: { type: string; count: number }[];
  /** Projects and tags as written, offered on the two text filters. P9. */
  vocabulary?: Vocabulary;
  /**
   * This page's facets with how many rows carry each, shown under the tag
   * option, so `priority:1` (12 to-dos) beside `priority:high` (1 to-do)
   * shows the fork. ADR-0009.
   */
  facets?: { concept: Concept; counts: FacetCount[] };
}) {
  const { pathname, search } = useLocation();
  const key = new URLSearchParams(search);
  for (const name of ["q", "page", "open", "edit", "add"]) key.delete(name);
  return (
    // Facet changes remount their uncontrolled pickers. Search and revealed
    // depth do not: a server answer must not steal focus from the search box.
    <Form
      action={pathname}
      className="filters"
      key={key.toString()}
      method="get"
      preventScrollReset
    >
      {/* No one fills this in, but it is the list's state all the same: a
          filter that drops it brings the hidden done rows back. */}
      {filters.showDone ? (
        <input name="done" type="hidden" value="show" />
      ) : null}
      {filters.blocked ? (
        <input name="state" type="hidden" value="blocked" />
      ) : null}
      {filters.sort ? (
        <input name="sort" type="hidden" value={filters.sort} />
      ) : null}
      <SearchField
        label="Search"
        defaultValue={live ? undefined : filters.query}
        value={live?.query}
        onValueChange={live?.onQueryChange}
        name="q"
      />
      {types ? (
        <label>
          Type
          <select defaultValue={filters.type ?? ""} name="type">
            <option value="">All types</option>
            {types.map((row) => (
              <option key={row.type} value={row.type}>
                {row.type} ({row.count})
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {vocabulary ? (
        <Combobox
          creatable
          defaultValue={filters.project ?? ""}
          label="Project"
          name="project"
          options={offer(vocabulary.projects)}
          submitOnPick
        />
      ) : (
        <label>
          Project
          <input defaultValue={filters.project} name="project" />
        </label>
      )}
      <TagFilter
        defaultValue={filters.tags ?? []}
        label="Tag"
        name="tag"
        options={tagOptions(vocabulary?.tags ?? [], facets)}
        removeHref={(tag) =>
          listHref(pathname, {
            ...filters,
            page: undefined,
            tags: filters.tags?.filter((one) => one !== tag),
          })
        }
      />
      <div className="filter-actions">
        <button type="submit">Filter</button>
        {/* The list's own path: a relative "." on /memories resolves to /.
            Showing done rows and the order are the list's, not filters, so
            they stay. */}
        <a
          href={listHref(pathname, {
            showDone: filters.showDone,
            sort: filters.sort,
          })}
        >
          Clear
        </a>
      </div>
    </Form>
  );
}

/** A vocabulary as combobox options: the label is the value. */
export function offer(values: readonly string[]) {
  return values.map((value) => ({ value, label: value }));
}

const NOUNS: Record<Concept, [string, string]> = {
  todo: ["to-do", "to-dos"],
  memory: ["memory", "memories"],
  skill: ["skill", "skills"],
};

function tagOptions(
  tags: readonly string[],
  facets: { concept: Concept; counts: FacetCount[] } | undefined,
) {
  if (!facets) return offer(tags);
  const counts = new Map(
    facets.counts.map((facet) => [facet.tag, facet.count]),
  );
  const [one, many] = NOUNS[facets.concept];
  return tags.map((tag) => {
    const count = counts.get(tag);
    const hint =
      count === undefined ? undefined : `${count} ${count === 1 ? one : many}`;
    return { value: tag, label: tag, hint };
  });
}
