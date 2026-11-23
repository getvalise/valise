import { type ReactNode, useState } from "react";
import { Link, useFetcher, useNavigate, useSearchParams } from "react-router";
import { AsyncPicker } from "~/components/async-picker";
import { BeltSwitch } from "~/components/belt-switch";
import { Choice, Combobox } from "~/components/combobox";
import { Editable } from "~/components/editable";
import { FileDropzone } from "~/components/file-dropzone";
import { ICON_NAMES, Icon } from "~/components/icon";
import { AddRow, ItemList, ItemRow } from "~/components/item-list";
import {
  DateRangeFilter,
  ListToolbar,
  SortMenu,
} from "~/components/list-toolbar";
import { Markdown } from "~/components/markdown";
import { Modal } from "~/components/modal";
import { TagInput } from "~/components/tag-input";
import { TodoPicker } from "~/components/todo-picker";
import {
  Card,
  Empty,
  Field,
  FieldRow,
  Pill,
  ProjectChip,
  SectionTabs,
  Select,
  Tag,
  TagLinks,
} from "~/components/ui";
import { Button } from "~/components/ui/button";
import { type ListFilters, listHref } from "~/concepts/list-filters";
import { lede, type Rule, rules, titleOf } from "~/concepts/principles";
import { TodoRow } from "~/features/todos/row";
import type { Todo, TodoCardView } from "~/features/todos/types";

const HERE = "/workbench?tab=components";

/** The theme's roles, as `styles/valise.css` declares them for both themes. */
const ROLES = [
  ["--primary", "fill: primary button, switch on, checkbox, mark"],
  ["--primary-hover", "a primary fill under the pointer"],
  ["--primary-foreground", "text on a fill"],
  ["--brand-ink", "purple as text: labels, claimed, done"],
  ["--background", "page ground"],
  ["--foreground", "body text, titles"],
  ["--card", "list, cards, fields"],
  ["--pane-ground", "the detail pane"],
  ["--muted", "wells: file drop"],
  ["--muted-foreground", "secondary text"],
  ["--accent", "hover, selection, active item"],
  ["--saddle", "tag fill"],
  ["--saddle-foreground", "tag text"],
  ["--sand", "trim"],
  ["--border", "hairlines"],
  ["--input", "field borders"],
  ["--strong-rule", "control outlines"],
  ["--ring", "focus"],
] as const;

const SIGNALS = [
  ["--ok", "success"],
  ["--warn", "partial, warning"],
  ["--destructive", "destructive, error"],
  ["--scrim", "behind a centred modal"],
] as const;

/** Enough rows that the combobox has something to filter down. */
const DEMO_OPTIONS = [
  {
    value: "anthropic/claude-sonnet-5.5",
    label: "Claude Sonnet 5.5",
    hint: "$2 / $10 per Mtok",
  },
  {
    value: "anthropic/claude-haiku-5.5",
    label: "Claude Haiku 5.5",
    hint: "$0.10 / $0.50 per Mtok",
  },
  {
    value: "openai/gpt-6-luna",
    label: "GPT-6 Luna",
    hint: "$0.10 / $0.50 per Mtok",
  },
  {
    value: "openai/gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    hint: "$0.75 / $4.50 per Mtok",
  },
  {
    value: "google/gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    hint: "$0.83 / $4.13 per Mtok",
  },
  { value: "x-ai/grok-4.3", label: "Grok 4.3", hint: "$1.25 / $2.50 per Mtok" },
  {
    value: "moonshotai/kimi-k2.6",
    label: "Kimi K2.6",
    hint: "$0.65 / $3.41 per Mtok",
  },
];

type SpecimenItem = {
  id: string;
  title: string;
  description: string;
  project: string;
  tags: string[];
  state?: "claimed" | "blocked" | "done";
  muted?: boolean;
};

/** The rows the toolbar filters and the item list shows. */
const ITEMS: SpecimenItem[] = [
  {
    id: "wb-capture",
    title: "capture-this",
    description: "Save a typed, tagged memory to Valise from any MCP client.",
    project: "valise",
    tags: ["mcp", "memory"],
  },
  {
    id: "wb-ranking",
    title: "Calibrate cross-concept BM25 weights",
    description: "Seed a corpus, read ten rankings, then try a boost.",
    project: "valise",
    tags: ["search", "duckdb"],
    state: "claimed",
  },
  {
    id: "wb-warehouse",
    title: "Query the warehouse through its MCP",
    description: "Prefer the MCP or CLI to an ad hoc script.",
    project: "docs",
    tags: ["duckdb"],
  },
  {
    id: "wb-archived",
    title: "Expose enabled skills as MCP prompts",
    description: "Done, archived or deleted: listed, read as inactive.",
    project: "docs",
    tags: ["mcp"],
    state: "done",
    muted: true,
  },
];

const PROJECTS = [...new Set(ITEMS.map((item) => item.project))];
const TAGS = [...new Set(ITEMS.flatMap((item) => item.tags))];

const SORTS = [
  ["", "Newest"],
  ["title", "Title"],
] as const;

/** `V3` → "Two accents, two jobs", read from the visual language's rules. */
const VISUAL_RULES = new Map(
  [
    ...(rules.find((rule) => rule.id === "visual")?.body ?? "").matchAll(
      /^(V\d+)\. ([^.]+)\./gm,
    ),
  ].map((match) => [match[1], match[2]]),
);

/** A specimen's rule chip: where it links and what it says. */
function ruleChip(id: string): { href: string; label: string } | null {
  if (id === "frame")
    return { href: "#visual", label: "Frame · The console's frame" };
  const visual = VISUAL_RULES.get(id);
  if (visual) return { href: "#visual", label: `${id} · ${visual}` };
  const title = titleOf(id);
  return title
    ? { href: `#${id.toLowerCase()}`, label: `${id} · ${title}` }
    : null;
}

/**
 * The principles, from the file that is their only copy. Each is a disclosure
 * so the specimens below stay reachable, and each carries the id a specimen
 * links to.
 */
function Principles() {
  return (
    <section
      aria-label="Design principles"
      className="px-6 pt-7 pb-2 [&>.prose]:mb-5"
    >
      <Markdown>{lede}</Markdown>
      {rules.map((rule) => (
        <RuleCard key={rule.id} rule={rule} />
      ))}
    </section>
  );
}

const STATUS_TONE = {
  held: "done",
  owed: "blocked",
  mixed: "claimed",
} as const;

function RuleCard({ rule }: { rule: Rule }) {
  return (
    <details
      className="group/rule border-t border-border last-of-type:border-b [&>.prose]:pt-3 [&>.prose]:pb-4 [&>.prose]:pl-18 max-[52rem]:[&>.prose]:pl-0"
      id={rule.id.toLowerCase()}
    >
      <summary className="grid cursor-pointer list-none grid-cols-[3.5rem_minmax(0,1fr)_auto] items-center gap-4 py-3 text-[0.875rem] text-foreground group-open/rule:border-b group-open/rule:border-border max-[52rem]:grid-cols-[2.5rem_minmax(0,1fr)_auto] max-[52rem]:gap-2 hover:text-(--trunk) [&::-webkit-details-marker]:hidden">
        <span className="font-mono text-[0.75rem] text-(--ink-3)">
          {rule.id === "visual" ? "V" : rule.id}
        </span>
        <span className="decoration-(--trunk) underline-offset-3 group-target/rule:text-(--trunk) [summary:hover>&]:underline">
          {rule.title}
        </span>
        {rule.status ? (
          <Pill tone={STATUS_TONE[rule.status]}>{rule.status}</Pill>
        ) : null}
      </summary>
      <Markdown>{rule.body}</Markdown>
      {rule.verdict ? (
        <div
          role="note"
          aria-label="Status"
          className="pb-4 pl-18 max-[52rem]:pl-0 [&_.prose]:border-l-(length:--strap) [&_.prose]:border-(--brass) [&_.prose]:pl-3 [&_.prose]:text-muted-foreground"
        >
          <Markdown>{rule.verdict}</Markdown>
        </div>
      ) : null}
    </details>
  );
}

export function Components() {
  const [params] = useSearchParams();
  const filters: ListFilters = {
    query: params.get("q") || undefined,
    project: params.get("project") || undefined,
    tags: params.getAll("tag").length ? params.getAll("tag") : undefined,
    sort: params.get("sort") || undefined,
  };
  const open = params.get("open");
  const range = {
    from: params.get("from") || undefined,
    to: params.get("to") || undefined,
  };
  const section = params.get("section") ?? "linked";
  const sectionHref = (next: string) =>
    listHref("/workbench", filters, { tab: "components", section: next });
  return (
    <Card>
      <Principles />

      <Specimen name="Theme" rules={["V1", "V2", "V3"]} selector=":root .dark">
        <Swatches />
      </Specimen>

      <Specimen
        name="Typography"
        rules={["V5"]}
        selector="h1 .masthead-word body code"
      >
        <TypeSpecimens />
      </Specimen>

      <Specimen name="Icons" rules={["V7", "V5"]} selector=".icon">
        <div className="flex items-center gap-3">
          <span className="masthead-mark">
            <Icon name="valise" size={20} />
          </span>
          <span className="masthead-word">Valise</span>
        </div>
        <ul className="icons">
          {ICON_NAMES.map((name) => (
            <li key={name}>
              <Icon name={name} />
              {name}
            </li>
          ))}
        </ul>
        <p className="muted">
          The closed set in <code>app/components/icon.tsx</code>: lucide for the
          verbs, Valise glyphs for the nouns lucide has no drawing of, at 16 on
          a 1.5 line. The mark is solid.
        </p>
      </Specimen>

      <Specimen
        name="Buttons"
        rules={["V1", "V4", "P10"]}
        selector="[data-slot=button] button .ghost .danger .small"
      >
        <ButtonSpecimens />
      </Specimen>

      <Specimen
        name="Switch"
        rules={["V1", "V6", "P10"]}
        selector=".belt-switch[role=switch]"
      >
        <SwitchSpecimens />
      </Specimen>

      <Specimen
        name="Tags and project"
        rules={["V3", "V8", "P7"]}
        selector=".tag .project-chip .pill .tag-input"
      >
        <TagSpecimens />
      </Specimen>

      <Specimen
        name="List toolbar"
        rules={["frame", "P3", "P9", "P11"]}
        selector=".list-toolbar [data-facet]"
      >
        <ListToolbar
          extra={{ tab: "components" }}
          filters={filters}
          path="/workbench"
          projectCounts={PROJECTS.map((project) => ({
            project,
            count: ITEMS.filter((item) => item.project === project).length,
          }))}
          tagCounts={TAGS.map((tag) => ({
            tag,
            key: "",
            value: tag,
            count: ITEMS.filter((item) => item.tags.includes(tag)).length,
          }))}
          facets={
            <DateRangeFilter
              hrefFor={(next) =>
                listHref("/workbench", filters, { tab: "components", ...next })
              }
              keep={[["tab", "components"]]}
              path="/workbench"
              presets={[
                { label: "1 November", from: "2026-11-01", to: "2026-11-01" },
                { label: "First week", from: "2026-11-01", to: "2026-11-07" },
              ]}
              range={range}
            />
          }
          vocabulary={{ projects: PROJECTS, tags: TAGS }}
        >
          <SortMenu
            label="Sort specimens"
            options={SORTS.map(([value, label]) => ({
              label,
              current: (filters.sort ?? "") === value,
              href: listHref(
                "/workbench",
                { ...filters, sort: value || undefined },
                { tab: "components" },
              ),
            }))}
          />
        </ListToolbar>
        <p className="muted">
          Search, a faceted filter per column, a date range, Reset, and the
          list&rsquo;s own view controls on the right. Every pick is a URL; the
          item list below reads it.
        </p>
      </Specimen>

      <Specimen
        name="Item list"
        rules={["frame", "P8", "P13", "P5"]}
        selector=".item-list .add-row .item-row .todo-list"
      >
        <SpecimenItems filters={filters} open={open} />
        <SpecimenTodos />
      </Specimen>

      <Specimen
        name="Detail pane"
        rules={["frame", "P4", "V4"]}
        selector="dialog.modal-pane .modal-sheet"
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild size="sm" variant="outline">
            <Link preventScrollReset to={`${HERE}&open=wb-ranking`}>
              Open the pane
            </Link>
          </Button>
        </div>
        <p className="muted">
          A row opens its item in a pane docked on the right, opened with{" "}
          <code>show()</code> so the list beside it stays live. Its left edge is
          the resize grip, drawn as a column of stitches. Below 48rem it is a
          bottom sheet with a drawer handle. The pane belongs to its row in the
          item list above, which holds the row in place while it opens.
        </p>
      </Specimen>

      <Specimen
        name="Section tabs"
        rules={["P3", "P11", "V1"]}
        selector=".section-tabs [aria-current]"
      >
        <SectionTabs
          items={[
            { key: "linked", label: "To-dos", count: 3 },
            { key: "files", label: "Files", count: 12 },
            { key: "details", label: "Details" },
          ].map((one) => ({
            href: sectionHref(one.key),
            label: one.label,
            count: one.count,
            current: one.key === section,
          }))}
          label="Specimen sections"
        >
          <p className="muted">
            The {section} section. A pane&rsquo;s sections as small tabs over
            one panel: each tab is a link to <code>?section=</code>, so it works
            without scripts and the open section survives a reload. A section
            with nothing in it is left out.
          </p>
        </SectionTabs>
      </Specimen>

      <Specimen
        name="Centred modal"
        rules={["frame", "P3"]}
        selector="dialog.modal:modal"
      >
        <CentredModal />
      </Specimen>

      <Specimen
        name="Pickers"
        rules={["P9", "P11"]}
        selector=".combobox select .field [data-slot=popover-trigger]"
      >
        <form className="stack">
          <Combobox
            label="Model"
            name="wb-model"
            options={DEMO_OPTIONS}
            placeholder="Type to filter"
          />
          <Select
            label="Window"
            name="wb-window"
            options={[
              { value: "24", label: "Last day" },
              { value: "168", label: "Last week" },
            ]}
          />
          <AsyncPicker
            emptyLabel="No document"
            endpoint="/library/documents"
            fallback={[]}
            label="Document"
            name="wb-document"
            placeholder="Search documents"
          />
        </form>
        <p className="muted">
          A native select for a short list, a combobox past about fifty options,
          and an async picker over a resource route when the set is too large to
          send with the page. Each posts a plain form field.
        </p>
      </Specimen>

      <Specimen
        name="Forms"
        rules={["P2", "P6", "P10", "V4"]}
        selector=".stack label .field-row .file-dropzone"
      >
        <FormSpecimens />
      </Specimen>

      <Specimen
        name="Stitch"
        rules={["V4"]}
        selector=".add-row-link .modal-pane"
      >
        <ItemList label="Stitched add row">
          <AddRow label="New to-do" preventScrollReset to={HERE} />
        </ItemList>
        <p className="muted">
          One slanted thread, repeated as whole stitches and mirrored per edge.
          It runs around the add row and down the open pane&rsquo;s left edge on
          desktop, and nowhere else. Every other rule is a solid hairline; the
          small create controls are dashed.
        </p>
      </Specimen>

      <Specimen name="Empty state" rules={["P8"]} selector=".empty">
        <ItemList label="Empty list">
          <AddRow label="Add bookmark" preventScrollReset to={HERE} />
        </ItemList>
        <Empty>No bookmarks match those filters.</Empty>
      </Specimen>
    </Card>
  );
}

function Specimen({
  name,
  selector,
  rules: ids,
  children,
}: {
  name: string;
  selector: string;
  /**
   * The rules this part exists to keep, by id: `V3`, `P7`, or `frame`. Each
   * renders as a link to its disclosure above, so a primitive is never shown
   * without its reason.
   */
  rules: string[];
  children: ReactNode;
}) {
  return (
    <section
      data-testid="specimen"
      className="grid grid-cols-[var(--label-column)_minmax(0,1fr)] gap-6 border-t border-border px-6 py-7 first-of-type:border-t-0 max-[52rem]:grid-cols-1 max-[52rem]:gap-3.5"
    >
      <h2 className="m-0 grid content-start gap-1.5 font-sans text-[0.6875rem] font-medium tracking-[0.14em] text-(--ink-3) uppercase">
        {name}
        <code className="text-[0.6875rem] tracking-normal text-(--ink-3) normal-case">
          {selector}
        </code>
        {ids.map((id) => {
          const chip = ruleChip(id);
          return chip ? (
            <a
              className="text-[0.6875rem] tracking-normal text-muted-foreground normal-case no-underline underline-offset-3 hover:text-(--trunk) hover:underline"
              href={chip.href}
              key={id}
            >
              {chip.label}
            </a>
          ) : null;
        })}
      </h2>
      <div className="grid content-start gap-4">{children}</div>
    </section>
  );
}

/**
 * Every role in both themes. `.dark` and `.theme-light` redeclare the roles,
 * so each half shows its own values whichever theme the page is in.
 */
function Swatches() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {(["theme-light", "dark"] as const).map((theme) => (
        <div
          className={`${theme} rounded-lg border bg-background p-3 text-foreground`}
          data-theme-swatches={theme === "dark" ? "dark" : "light"}
          key={theme}
        >
          <p className="eyebrow m-0 mb-2 text-(--brand-ink)">
            {theme === "dark" ? "Dark" : "Light"}
          </p>
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-px p-px">
            {[...ROLES, ...SIGNALS].map(([role, use]) => (
              <li
                className="grid gap-1 bg-card p-2.5 font-mono text-[0.6875rem] text-foreground outline outline-border"
                key={role}
              >
                <i
                  className="block h-12 rounded-sm border"
                  style={{ background: `var(${role})` }}
                />
                <b className="font-medium">{role}</b>
                <span className="text-muted-foreground">{use}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function TypeSpecimens() {
  return (
    <>
      <div className="grid gap-1">
        <p className="eyebrow m-0">Display, page title</p>
        <h1>One case, every model</h1>
      </div>
      <div className="grid gap-1">
        <p className="eyebrow m-0">Display, masthead</p>
        <span className="masthead-word">Valise</span>
      </div>
      <div className="grid gap-1">
        <p className="eyebrow m-0">Grotesque</p>
        <h2>Item title in the grotesque</h2>
        <p className="m-0">
          Body copy at the reading size, with an{" "}
          <a href="#visual">inline link</a>.
        </p>
        <p className="muted m-0">
          Muted copy for the sentence under a heading.
        </p>
      </div>
      <div className="grid gap-1">
        <p className="eyebrow m-0">Mono</p>
        <p className="m-0">
          <code>todo:tdo_seed_rank_calibration</code>
        </p>
        <pre className="m-0">{"---\nname: capture-this\n---"}</pre>
      </div>
    </>
  );
}

function ButtonSpecimens() {
  return (
    <>
      <p className="eyebrow m-0">shadcn Button</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button>Primary</Button>
        <Button className="bg-(--primary-hover)">Primary, hover</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button disabled>Disabled</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs">Extra small</Button>
        <Button size="sm">Small</Button>
        <Button>Default</Button>
        <Button size="lg">Large</Button>
        <Button aria-label="Add" size="icon">
          <Icon name="add" />
        </Button>
        <Button aria-label="Edit" size="icon-sm" variant="outline">
          <Icon name="edit" />
        </Button>
      </div>
      <p className="eyebrow m-0">Native button</p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button">Primary</button>
        <button className="ghost" type="button">
          Ghost
        </button>
        <button className="danger" type="button">
          Destructive
        </button>
        <button className="small" type="button">
          Small
        </button>
        <button className="ghost small" type="button">
          Ghost small
        </button>
        <Link className="button ghost" to="#visual">
          Ghost link
        </Link>
      </div>
      <p className="muted">
        Purple only as a fill; under the pointer a primary turns near-black
        brown. Ghost and outline keep a solid hairline. The native set is what
        the older forms still post with.
      </p>
    </>
  );
}

function SwitchSpecimens() {
  const [renew, setRenew] = useState(true);
  const [automatic, setAutomatic] = useState(false);
  const [row, setRow] = useState(true);
  return (
    <>
      <div className="stack">
        <BeltSwitch
          checked={renew}
          label="Renew lease"
          onClick={() => setRenew(!renew)}
        />
        <BeltSwitch
          checked={automatic}
          label="Auto-complete"
          onClick={() => setAutomatic(!automatic)}
        />
        <BeltSwitch checked disabled label="Managed by policy" />
        <BeltSwitch checked={false} disabled label="Locked off" />
      </div>
      <ItemList label="Switch in a row">
        <ItemRow
          description="In a row the row names the setting; the label is for readers."
          href={HERE}
          media={
            <BeltSwitch
              checked={row}
              hideLabel
              label="Enable capture-this"
              onClick={() => setRow(!row)}
            />
          }
          title="capture-this"
        />
      </ItemList>
    </>
  );
}

function TagSpecimens() {
  const tagHref = (tag: string) =>
    listHref("/workbench", { tags: [tag] }, { tab: "components" });
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <ProjectChip project="valise" />
        <TagLinks href={tagHref} tags={["search", "duckdb", "mcp"]} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <ProjectChip
          href={listHref(
            "/workbench",
            { project: "docs" },
            { tab: "components" },
          )}
          project="docs"
        />
        <ProjectChip count={2} href={HERE} project="valise" selected />
        <Tag>plain tag</Tag>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="pending">pending</Pill>
        <Pill tone="claimed">claimed</Pill>
        <Pill tone="blocked">blocked</Pill>
        <Pill tone="done">done</Pill>
        <Pill tone="label">label</Pill>
        <Pill tone="accent">accent</Pill>
      </div>
      <TagInput
        defaultValue={["search", "design"]}
        name="preview-tags"
        options={["search", "design", "duckdb"]}
      />
      <div
        className="flex flex-wrap items-center gap-3"
        data-tag-size="compact"
      >
        <ProjectChip project="valise" />
        <TagLinks href={tagHref} tags={["search", "duckdb", "mcp"]} />
        <TagInput
          defaultValue={["search", "design"]}
          name="preview-tags-compact"
          options={["search", "design", "duckdb"]}
        />
      </div>
      <p className="muted">
        A tag is saddle leather with sand text. A project is a folder and a name
        with no box, ahead of the tags, so the shape tells them apart before the
        text does. The last row is the compact size every list row uses: the
        same chip on a shorter line with tighter gaps. Its + unfolds to "+ Add
        tags" in line.
      </p>
    </>
  );
}

/**
 * The toolbar's filters applied to the specimen rows, so a pick above changes
 * what is listed here. Each row opens the same pane through `?open=`.
 */
function SpecimenItems({
  filters,
  open,
}: {
  filters: ListFilters;
  open: string | null;
}) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const query = filters.query?.toLowerCase();
  const rows = ITEMS.filter(
    (item) =>
      (!query || item.title.toLowerCase().includes(query)) &&
      (!filters.project || item.project === filters.project) &&
      (filters.tags ?? []).every((tag) => item.tags.includes(tag)),
  ).sort((a, b) =>
    filters.sort === "title" ? a.title.localeCompare(b.title) : 0,
  );
  const withParam = (name: string, value?: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    return `/workbench?${next}`;
  };
  const tagHref = (tag: string) =>
    listHref(
      "/workbench",
      { ...filters, tags: [...new Set([...(filters.tags ?? []), tag])] },
      { tab: "components" },
    );
  return (
    <ItemList label="Specimen items">
      <AddRow label="Add skill" preventScrollReset to={HERE} />
      {rows.map((item) => (
        <ItemRow
          description={item.description}
          href={withParam("open", item.id)}
          key={item.id}
          meta={
            <>
              {item.state ? <Pill tone={item.state}>{item.state}</Pill> : null}
              <ProjectChip
                href={listHref(
                  "/workbench",
                  { ...filters, project: item.project },
                  { tab: "components" },
                )}
                project={item.project}
              />
              <TagLinks href={tagHref} tags={item.tags} />
            </>
          }
          muted={item.muted}
          open={open === item.id}
          title={item.title}
        >
          <Modal
            mobileSheet
            onClose={() =>
              navigate(withParam("open"), {
                replace: true,
                preventScrollReset: true,
              })
            }
            open={open === item.id}
            size="pane"
            title={item.title}
          >
            <SpecimenPane item={item} />
          </Modal>
        </ItemRow>
      ))}
    </ItemList>
  );
}

function SpecimenPane({ item }: { item: SpecimenItem }) {
  return (
    <div className="stack">
      <div className="flex flex-wrap items-center gap-3">
        {item.state ? <Pill tone={item.state}>{item.state}</Pill> : null}
        <ProjectChip project={item.project} />
        <TagLinks
          href={(tag) =>
            listHref("/workbench", { tags: [tag] }, { tab: "components" })
          }
          tags={item.tags}
        />
      </div>
      <Editable
        action={HERE}
        cancelHref={HERE}
        defaultValue={item.description}
        editHref={HERE}
        editing={false}
        hidden={{}}
        label="Description"
        multiline
      >
        <p>{item.description}</p>
      </Editable>
      <dl className="facts">
        <div>
          <dt>Claim holder</dt>
          <dd>codex-cli</dd>
        </div>
        <div>
          <dt>Fencing token</dt>
          <dd>3</dd>
        </div>
      </dl>
    </div>
  );
}

/** The to-do list's own row, the real `TodoRow`, with completion kept local. */
function SpecimenTodos() {
  return (
    <ul className="card-list todo-list">
      <SpecimenTodo
        body={"Seed a corpus, read ten rankings.\n\n- [x] Seed\n- [ ] Read"}
        state="claimed"
        tags={["search", "duckdb"]}
        title="Calibrate cross-concept BM25 weights"
      />
      <SpecimenTodo
        body="Merged and deployed."
        state="done"
        tags={["mcp"]}
        title="Expose enabled skills as MCP prompts"
      />
    </ul>
  );
}

function SpecimenTodo({
  title,
  body,
  state,
  tags,
}: {
  title: string;
  body: string;
  state: "claimed" | "done";
  tags: string[];
}) {
  const stateFetcher = useFetcher();
  const tickFetcher = useFetcher();
  const [done, setDone] = useState(state === "done");
  const [subtasks, setSubtasks] = useState(false);
  const now = Math.floor(Date.UTC(2026, 9, 29, 9) / 1000);
  const todo: Todo = {
    id: `tdo_specimen_${state}`,
    title,
    body,
    project: "valise",
    tags,
    refs: [],
    state: done ? "done" : state === "done" ? "pending" : state,
    leaseHolder: null,
    leaseExpiresAt: null,
    fencingToken: 1,
    blockedOn: null,
    sourceAgent: "workbench",
    sourceClient: "workbench",
    sourceSession: null,
    sourceSessionName: null,
    createdAt: now - 3600,
    updatedAt: now - 600,
    completedAt: done ? now : null,
    updates: [
      {
        id: `upd_specimen_${state}`,
        kind: "progress",
        author: "codex-cli",
        sessionName: null,
        token: 1,
        body: "Reindexed; the ranking reads sane.",
        summary: "Reindexed; the ranking reads sane.",
        createdAt: now - 600,
      },
    ],
    files: [],
    relations: {
      parent: null,
      children: [],
      depends_on: [],
      blocks: [],
      child_progress: { done: 0, total: 0 },
      children_truncated: false,
      blocks_truncated: false,
      note: "",
    },
  };
  const filters: ListFilters = {};
  const view: TodoCardView = {
    todo,
    filters,
    now,
    title,
    body,
    project: todo.project,
    state: todo.state,
    done,
    here: HERE,
    closed: HERE,
    tags: (
      <TagLinks
        href={(tag) =>
          listHref("/workbench", { tags: [tag] }, { tab: "components" })
        }
        tags={tags}
      />
    ),
    field: () => ({
      action: HERE,
      cancelHref: HERE,
      editHref: HERE,
      editing: false,
      hidden: {},
    }),
    open: null,
    stateForm: stateFetcher.Form,
    stateAnswer: undefined,
    relationOptions: [],
    tickForm: tickFetcher.Form,
    sendState: (event) => {
      event.preventDefault();
      setDone(!done);
    },
    blockNote: undefined,
    shown: body,
    vocabulary: { projects: [], tags: [], facets: [] },
  };
  const tasks = { done: 1, total: body.includes("- [") ? 2 : 0 };
  return (
    <li className={`todo-card${done ? " is-done" : ""}`}>
      <TodoRow
        opened={false}
        subtasks={subtasks}
        subtasksId={`${todo.id}-tasks`}
        tasks={tasks}
        toggleSubtasks={() => setSubtasks(!subtasks)}
        view={view}
      />
    </li>
  );
}

function CentredModal() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setOpen(true)} type="button">
          Open modal
        </button>
      </div>
      <Modal
        footer={
          <button
            className="ghost"
            onClick={() => setOpen(false)}
            type="button"
          >
            Close
          </button>
        }
        onClose={() => setOpen(false)}
        open={open}
        title="Specimen modal"
      >
        <p>
          For creating or editing: Add skill, Upload, the SKILL.md editor.
          Native <code>&lt;dialog&gt;</code>, so focus, Escape and the inert
          background are the platform&rsquo;s. The backdrop is a flat{" "}
          <code>--scrim</code>.
        </p>
      </Modal>
      <p className="muted">
        A centred modal is for creating or editing, never for reading an item.
      </p>
    </>
  );
}

function FormSpecimens() {
  const [files, setFiles] = useState<string[]>([]);
  return (
    <>
      <form className="stack">
        <Field label="Title" name="wb-title" placeholder="A short title" />
        <Field
          label="Body"
          name="wb-body"
          placeholder="Monospaced, because this is usually markdown."
          rows={3}
        />
        <fieldset>
          <legend>Scopes</legend>
          {["search:read", "memories:write"].map((scope) => (
            <label className="check" key={scope}>
              <input name="wb-scope" type="checkbox" value={scope} />
              {scope}
            </label>
          ))}
        </fieldset>
        <p role="alert">An error, the way a publish failure reads.</p>
      </form>
      <form className="stack">
        <FieldRow>
          <div className="field-narrow">
            <Choice
              defaultValue="blocked-by"
              label="Relation"
              name="wb-relation"
              options={[
                { value: "blocked-by", label: "Blocked by" },
                { value: "parent", label: "Parent" },
              ]}
            />
          </div>
          <TodoPicker label="To-do" name="wb-todo" seed={[]} />
          <button type="button">Add relation</button>
        </FieldRow>
      </form>
      <FileDropzone
        hint={files.length ? undefined : "Nothing is uploaded from here."}
        label="Choose a file"
        multiple
        onFiles={(chosen) => setFiles(chosen.map((file) => file.name))}
      />
      <p className="muted">
        A form that ends in a button is a FieldRow: three units between the
        controls. A file drop is a sand well, not a dotted frame.
      </p>
    </>
  );
}
