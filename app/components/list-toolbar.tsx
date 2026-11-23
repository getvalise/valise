import { Popover as PopoverPrimitive } from "radix-ui";
import { type ReactNode, useState } from "react";
import { Form, Link, useLocation, useNavigate } from "react-router";
import { useHydrated } from "~/components/editable";
import { Icon } from "~/components/icon";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "~/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "~/components/ui/input-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { Separator } from "~/components/ui/separator";
import type { FacetCount } from "~/concepts/facets";
import { type ListFilters, listHref } from "~/concepts/list-filters";
import type { Vocabulary } from "~/concepts/vocabulary";
import { cn } from "~/lib/utils";

export type FacetOption = { value: string; label: string; count?: number };

/**
 * Every item list's filter row, in shadcn's data-table toolbar shape: a
 * search box, one faceted filter per column worth narrowing, and a reset.
 *
 * It is still a GET form over the list's URL (P3). Each facet option is a
 * navigation to the list with that value toggled, and the facets in force are
 * hidden inputs, so a search keeps them. Before hydration a facet is a native
 * select or a text box under the same name, so filtering works with
 * scripting off (P11).
 */
export function ListToolbar({
  path,
  filters,
  live,
  types,
  vocabulary,
  tagCounts,
  projects,
  projectCounts,
  facets,
  facetsActive = false,
  children,
  extra = {},
}: {
  /** The list's own path; `.` on /memories would resolve to /. */
  path: string;
  filters: ListFilters;
  live?: { query: string; onQueryChange: (value: string) => void };
  /** The type column's values as written, with counts. Memories only. */
  types?: { type: string; count: number }[];
  vocabulary?: Vocabulary;
  /** How many rows carry each tag, shown beside it. ADR-0009. */
  tagCounts?: FacetCount[];
  /** Projects to offer when the vocabulary is not the source. */
  projects?: readonly string[];
  /** How many rows each project holds, shown beside it. */
  projectCounts?: { project: string; count: number }[];
  /**
   * The list's own filters beyond project, tag and type, after them on the
   * left. Their parameters belong in `extra`, so a search keeps them.
   */
  facets?: ReactNode;
  /**
   * Whether one of `facets` is in force, so Reset shows. Reset then drops
   * `extra` too, so `extra` should hold only those filters' parameters.
   */
  facetsActive?: boolean;
  /** The list's own view controls, on the right: order, done, deleted. */
  children?: ReactNode;
  /** A page's own parameters that every filter link keeps, e.g. a tab. */
  extra?: Record<string, string | undefined>;
}) {
  const href = (next: ListFilters) =>
    listHref(path, { ...next, page: undefined }, extra);
  const counts = new Map(tagCounts?.map((one) => [one.tag, one.count]));
  const perProject = new Map(
    projectCounts?.map((one) => [one.project, one.count]),
  );
  const projectValues =
    projects ??
    projectCounts?.map((one) => one.project) ??
    vocabulary?.projects ??
    [];
  const filtered =
    facetsActive ||
    Boolean(filters.query) ||
    Boolean(filters.project) ||
    Boolean(filters.type) ||
    (filters.tags?.length ?? 0) > 0;
  return (
    <div className="list-toolbar flex flex-wrap items-center gap-2">
      <Form
        action={path}
        className="contents"
        method="get"
        preventScrollReset
        role="search"
      >
        <SearchInput filters={filters} live={live} />
        {filters.project ? (
          <input name="project" type="hidden" value={filters.project} />
        ) : null}
        {filters.type ? (
          <input name="type" type="hidden" value={filters.type} />
        ) : null}
        {filters.tags?.map((tag) => (
          <input key={tag} name="tag" type="hidden" value={tag} />
        ))}
        {filters.showDone ? (
          <input name="done" type="hidden" value="show" />
        ) : null}
        {filters.blocked ? (
          <input name="state" type="hidden" value="blocked" />
        ) : null}
        {filters.showDeleted ? (
          <input name="deleted" type="hidden" value="show" />
        ) : null}
        {filters.sort ? (
          <input name="sort" type="hidden" value={filters.sort} />
        ) : null}
        {Object.entries(extra).map(([name, value]) =>
          value ? (
            <input key={name} name={name} type="hidden" value={value} />
          ) : null,
        )}
      </Form>
      {projectValues.length > 0 || filters.project ? (
        <FacetFilter
          hrefFor={([project]) => href({ ...filters, project })}
          name="project"
          options={projectValues.map((value) => ({
            value,
            label: value,
            count: perProject.get(value),
          }))}
          path={path}
          selected={filters.project ? [filters.project] : []}
          title="Project"
        />
      ) : null}
      {(vocabulary?.tags.length ?? 0) > 0 || filters.tags ? (
        <FacetFilter
          hrefFor={(tags) =>
            href({ ...filters, tags: tags.length ? tags : undefined })
          }
          multiple
          name="tag"
          options={(vocabulary?.tags ?? []).map((value) => ({
            value,
            label: value,
            count: counts.get(value),
          }))}
          path={path}
          selected={filters.tags ?? []}
          title="Tag"
        />
      ) : null}
      {types ? (
        <FacetFilter
          hrefFor={([type]) => href({ ...filters, type })}
          name="type"
          options={types.map((row) => ({
            value: row.type,
            label: row.type,
            count: row.count,
          }))}
          path={path}
          selected={filters.type ? [filters.type] : []}
          title="Type"
        />
      ) : null}
      {facets}
      {filtered ? (
        <Button asChild className="h-8 px-2" size="sm" variant="ghost">
          <Link
            preventScrollReset
            to={listHref(
              path,
              {
                showDone: filters.showDone,
                blocked: filters.blocked,
                showDeleted: filters.showDeleted,
                sort: filters.sort,
              },
              facetsActive ? {} : extra,
            )}
          >
            Reset
            <Icon name="close" />
          </Link>
        </Button>
      ) : null}
      {children ? (
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function SearchInput({
  filters,
  live,
}: {
  filters: ListFilters;
  live?: { query: string; onQueryChange: (value: string) => void };
}) {
  return (
    <InputGroup className="h-8 w-full sm:w-64">
      <InputGroupAddon>
        <Icon name="search" />
      </InputGroupAddon>
      <InputGroupInput
        aria-label="Search"
        defaultValue={live ? undefined : filters.query}
        name="q"
        onChange={
          live
            ? (event) =>
                live.onQueryChange(
                  (event.currentTarget as unknown as { value: string }).value,
                )
            : undefined
        }
        placeholder="Search…"
        type="search"
        value={live?.query}
      />
    </InputGroup>
  );
}

/**
 * One column's filter: a dashed button naming the column and what is chosen,
 * opening a searchable list of its values with their counts. A pick navigates;
 * the URL is the state.
 */
export function FacetFilter({
  title,
  name,
  path,
  options,
  selected,
  multiple = false,
  hrefFor,
}: {
  title: string;
  /** The query parameter, for the scriptless fallback. */
  name: string;
  path: string;
  options: FacetOption[];
  selected: string[];
  multiple?: boolean;
  /** The list's URL with exactly these values chosen. */
  hrefFor: (values: string[]) => string;
}) {
  const hydrated = useHydrated();
  const navigate = useNavigate();
  const location = useLocation();
  if (!hydrated) return <ScriptlessFacet {...{ title, name, path, options }} />;
  const chosen = new Set(selected);
  const pick = (value: string) => {
    const next = multiple
      ? chosen.has(value)
        ? selected.filter((one) => one !== value)
        : [...selected, value]
      : chosen.has(value)
        ? []
        : [value];
    navigate(hrefFor(next), {
      preventScrollReset: true,
      state: location.state,
    });
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          className="h-8 border-dashed"
          data-facet={name}
          size="sm"
          variant="outline"
        >
          <Icon name="add" />
          {title}
          {selected.length > 0 ? (
            <>
              <Separator className="mx-1 h-4" orientation="vertical" />
              {selected.length > 2 ? (
                <Badge
                  className="rounded-sm px-1 font-normal"
                  variant="secondary"
                >
                  {selected.length} selected
                </Badge>
              ) : (
                selected.map((value) => (
                  <Badge
                    className="rounded-sm px-1 font-normal"
                    key={value}
                    variant="secondary"
                  >
                    {value}
                  </Badge>
                ))
              )}
            </>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder={title} />
          <CommandList>
            <CommandEmpty>No {title.toLowerCase()} matches.</CommandEmpty>
            <CommandGroup>
              {options.map((option) => {
                const on = chosen.has(option.value);
                return (
                  <CommandItem
                    key={option.value}
                    onSelect={() => pick(option.value)}
                    value={option.label}
                  >
                    <span
                      className={cn(
                        "flex size-4 items-center justify-center border border-primary",
                        multiple ? "rounded-sm" : "rounded-full",
                        on
                          ? "bg-primary text-primary-foreground"
                          : "opacity-50 [&_svg]:invisible",
                      )}
                    >
                      <Icon name="check" size={12} />
                    </span>
                    <span className="truncate">{option.label}</span>
                    {option.count !== undefined ? (
                      <span className="ml-auto font-mono text-xs text-muted-foreground">
                        {option.count}
                      </span>
                    ) : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
            {selected.length > 0 ? (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    className="justify-center text-center"
                    onSelect={() =>
                      navigate(hrefFor([]), { preventScrollReset: true })
                    }
                  >
                    Clear filter
                  </CommandItem>
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Before hydration: a GET form of one field, which adds to the URL. */
function ScriptlessFacet({
  title,
  name,
  path,
  options,
}: {
  title: string;
  name: string;
  path: string;
  options: FacetOption[];
}) {
  return (
    <Form action={path} className="flex items-center gap-1" method="get">
      <label className="sr-only" htmlFor={`facet-${name}`}>
        {title}
      </label>
      <select className="h-8 w-auto" id={`facet-${name}`} name={name}>
        <option value="">{title}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <button className="small" type="submit">
        Filter
      </button>
    </Form>
  );
}

export type DateRange = { from?: string; to?: string };

/**
 * A date range filter, in the facet's shape: a dashed button naming what is
 * chosen, opening presets and two date fields. `from` and `to` are UTC days,
 * `YYYY-MM-DD`, both inclusive; they are GET parameters like every other
 * filter (P3). Before hydration the two fields and a button stand in the
 * toolbar as their own form (P11).
 */
export function DateRangeFilter({
  path,
  range,
  presets,
  keep,
  hrefFor,
}: {
  path: string;
  range: DateRange;
  presets: (DateRange & { label: string })[];
  /** The list's other parameters, carried through the form as hidden fields. */
  keep: [string, string][];
  hrefFor: (range: DateRange) => string;
}) {
  const hydrated = useHydrated();
  const [open, setOpen] = useState(false);
  const chosen = Boolean(range.from || range.to);
  const fields = (
    <>
      {keep.map(([name, value]) => (
        <input
          key={`${name}=${value}`}
          name={name}
          type="hidden"
          value={value}
        />
      ))}
      <label className="date-range-field">
        <span>From</span>
        <input
          className="h-8"
          defaultValue={range.from}
          max={range.to}
          name="from"
          type="date"
        />
      </label>
      <label className="date-range-field">
        <span>To</span>
        <input
          className="h-8"
          defaultValue={range.to}
          min={range.from}
          name="to"
          type="date"
        />
      </label>
    </>
  );
  if (!hydrated)
    return (
      <Form action={path} className="date-range scriptless" method="get">
        {fields}
        <button className="small" type="submit">
          Filter
        </button>
      </Form>
    );
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          className="h-8 border-dashed"
          data-facet="date"
          size="sm"
          variant="outline"
        >
          <Icon name="add" />
          Date
          {chosen ? (
            <>
              <Separator className="mx-1 h-4" orientation="vertical" />
              <Badge
                className="rounded-sm px-1 font-normal"
                variant="secondary"
              >
                {rangeLabel(range, presets)}
              </Badge>
            </>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <nav aria-label="Date presets" className="date-range-presets">
          {presets.map((preset) => {
            const on = preset.from === range.from && preset.to === range.to;
            return (
              <PopoverPrimitive.Close asChild key={preset.label}>
                <Link
                  aria-current={on ? "true" : undefined}
                  preventScrollReset
                  to={hrefFor(preset)}
                >
                  {preset.label}
                </Link>
              </PopoverPrimitive.Close>
            );
          })}
        </nav>
        <Separator />
        <Form
          action={path}
          className="date-range"
          method="get"
          onSubmit={() => setOpen(false)}
          preventScrollReset
        >
          {fields}
          <div className="date-range-actions">
            {chosen ? (
              <PopoverPrimitive.Close asChild>
                <Link preventScrollReset to={hrefFor({})}>
                  Clear
                </Link>
              </PopoverPrimitive.Close>
            ) : null}
            <Button size="sm" type="submit">
              Apply
            </Button>
          </div>
        </Form>
      </PopoverContent>
    </Popover>
  );
}

const SHORT_DAY = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

function shortDay(day: string) {
  return SHORT_DAY.format(new Date(`${day}T00:00:00Z`));
}

/** The preset's name when the range is one, otherwise its days. */
export function rangeLabel(
  range: DateRange,
  presets: (DateRange & { label: string })[] = [],
): string {
  const preset = presets.find(
    (one) => one.from === range.from && one.to === range.to,
  );
  if (preset) return preset.label;
  if (range.from && range.to)
    return range.from === range.to
      ? shortDay(range.from)
      : `${shortDay(range.from)} – ${shortDay(range.to)}`;
  if (range.from) return `From ${shortDay(range.from)}`;
  return range.to ? `Until ${shortDay(range.to)}` : "";
}

/**
 * A list's order, as a menu on the toolbar's right. Each order is a link, so
 * before hydration the same links render as a row (P11).
 */
export function SortMenu({
  label,
  options,
}: {
  /** Names the menu, e.g. "Sort memories". */
  label: string;
  options: { label: string; href: string; current: boolean }[];
}) {
  const hydrated = useHydrated();
  const current = options.find((one) => one.current) ?? options[0];
  if (!hydrated)
    return (
      <nav aria-label={label} className="sorts">
        {options.map((option) => (
          <Link
            aria-current={option.current ? "true" : undefined}
            key={option.href}
            to={option.href}
          >
            {option.label}
          </Link>
        ))}
      </nav>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label={label} className="h-8" size="sm" variant="outline">
          <Icon name="sort" />
          {current?.label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {options.map((option) => (
          <DropdownMenuItem asChild key={option.href}>
            <Link preventScrollReset to={option.href}>
              <span
                className={cn(
                  "size-4",
                  option.current ? "text-primary" : "[&_svg]:invisible",
                )}
              >
                <Icon name="check" />
              </span>
              {option.label}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
