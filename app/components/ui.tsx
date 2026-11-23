import { type ComponentProps, type ReactNode, useId } from "react";
import { Link, useLocation, useRouteLoaderData } from "react-router";
import { AppSidebar, pageIcon } from "~/components/app-sidebar";
import { Icon } from "~/components/icon";
import { Button } from "~/components/ui/button";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "~/components/ui/sidebar";
import { identityLabel } from "~/concepts/identity-label";
import type { ConsoleIdentity } from "~/console/context.server";
import { cn } from "~/lib/utils";

/**
 * The console's shared parts. Every route composes these rather than repeating
 * class names, so `/workbench` showing each one in each state is a complete
 * review of the console's visual surface.
 */

export function PageHeader({
  title,
  lede,
  actions,
  children,
}: {
  title: string;
  lede?: ReactNode;
  /** The page's primary action, on the right of the title: Add, New. */
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const { pathname } = useLocation();
  const icon = pageIcon(pathname);
  return (
    <header className="page-header">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="page-title">
            {icon ? (
              <span aria-hidden="true" className="page-title-icon">
                <Icon name={icon} size={26} />
              </span>
            ) : null}
            {title}
          </h1>
          {lede ? <p>{lede}</p> : null}
        </div>
        {actions ? (
          <div className="page-actions flex shrink-0 items-center gap-2">
            {actions}
          </div>
        ) : null}
      </div>
      {children}
    </header>
  );
}

/**
 * Every console page: the sidebar on the left, the page's heading and
 * sections, then its content. A detail pane docks on the right edge on its
 * own (`Modal size="pane"`), so the layout is three columns when one is open.
 */
export function ApplicationShell({
  title,
  lede,
  actions,
  sections,
  measure,
  children,
}: {
  title: string;
  lede?: ReactNode;
  actions?: ReactNode;
  sections?: ReactNode;
  /** "reading": the header and the content share one centred column at the
   * reader's measure, so a page that is one article has one left edge. */
  measure?: "reading";
  children: ReactNode;
}) {
  const root = useRouteLoaderData("root") as
    | { sidebarOpen?: boolean }
    | undefined;
  return (
    <SidebarProvider defaultOpen={root?.sidebarOpen ?? false}>
      <AppSidebar />
      <SidebarInset className="workspace-inset">
        <div className="workspace-bar md:hidden">
          <SidebarTrigger />
          <span className="masthead-word">Valise</span>
        </div>
        <section
          className={cn(
            "workspace",
            measure === "reading" && "mx-auto w-full max-w-[68ch]",
          )}
        >
          <PageHeader actions={actions} lede={lede} title={title}>
            {sections}
          </PageHeader>
          <div className="workspace-content grid min-w-0 grid-cols-1 gap-section">
            {children}
          </div>
        </section>
      </SidebarInset>
    </SidebarProvider>
  );
}

/** Filters, contextual navigation and list actions belong to one band. */
export function ListControls({ children }: { children: ReactNode }) {
  return (
    <section aria-label="List controls" className="list-controls">
      {children}
    </section>
  );
}

export function DetailSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="detail-section">
      <h3 className="eyebrow">{title}</h3>
      {children}
    </section>
  );
}

/** Greeting and navigation read the same root account identity (P11). */
export function AccountGreeting() {
  const root = useRouteLoaderData("root") as
    | { identity: ConsoleIdentity | null }
    | undefined;
  return root?.identity ? <>Hello, {identityLabel(root.identity)}.</> : null;
}

/**
 * The sections of one page, under the workspace strap and subordinate to it.
 * The strap is the console's first level and carries the purple rule; this
 * is the second and carries none, so the two never read as one row twice.
 * Which section is open is in the URL (P3), so `current` is the caller's to
 * say: NavLink matches paths and the sections of a page share one.
 */
export function SubNav({
  label,
  items,
}: {
  /** Names the landmark, so a screen reader can tell the two navs apart. */
  label: string;
  items: {
    href: string;
    label: string;
    current: boolean;
    /**
     * Something waiting in that section, drawn after the label only above
     * zero. The figure is hidden from the accessible name, which stays the
     * label, and `countLabel` says it in words as the link's description.
     */
    count?: number;
    countLabel?: string;
  }[];
}) {
  const id = useId();
  return (
    <nav aria-label={label} className="subnav">
      {items.map((item, index) => {
        const counted = item.count !== undefined && item.count > 0;
        const describedBy = counted ? `${id}-${index}` : undefined;
        return (
          <Link
            aria-current={item.current ? "page" : undefined}
            aria-describedby={describedBy}
            key={item.href}
            to={item.href}
          >
            <span className="subnav-label">{item.label}</span>
            {counted ? (
              <>
                <span aria-hidden="true" className="subnav-count">
                  {item.count}
                </span>
                <span hidden id={describedBy}>
                  {item.countLabel ?? String(item.count)}
                </span>
              </>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * The sections of one pane, as small tabs over a single panel: the third
 * level, below the strap and the page's SubNav, so it is smaller still and
 * sits on a hairline rather than a rule. Which section is open is in the URL
 * (P3), so each tab is a link and works before hydration (P11). The links
 * replace the history entry, because flipping sections is not a place to go
 * back to; a route that already holds every section's data should skip its
 * loader for the change in `shouldRevalidate`. A section with nothing in it
 * is left out by the caller rather than drawn empty.
 */
export function SectionTabs({
  label,
  items,
  children,
}: {
  /** Names the tab row and the panel, e.g. "Session sections". */
  label: string;
  items: { href: string; label: string; count?: number; current: boolean }[];
  /** The current section's content. */
  children: ReactNode;
}) {
  const current = items.find((item) => item.current);
  return (
    <div className="section-tabs">
      <nav aria-label={label} className="section-tabs-list">
        {items.map((item) => (
          <Link
            aria-current={item.current ? "true" : undefined}
            key={item.href}
            preventScrollReset
            replace
            to={item.href}
          >
            {item.label}
            {item.count !== undefined ? (
              <span className="section-tabs-count">{item.count}</span>
            ) : null}
          </Link>
        ))}
      </nav>
      <section
        aria-label={current ? `${current.label}` : label}
        className="section-tabs-panel"
      >
        {children}
      </section>
    </div>
  );
}

export function Card({
  as: Element = "section",
  className = "",
  children,
}: {
  as?: "section" | "li" | "div";
  className?: string;
  children: ReactNode;
}) {
  return <Element className={`card ${className}`.trim()}>{children}</Element>;
}

/**
 * A page's create action, in the header's action slot: a primary button that
 * is a link, so it works before hydration (P3, P11). P8.
 */
export function AddButton({
  label,
  ...props
}: Omit<ComponentProps<typeof Link>, "children"> & { label: string }) {
  return (
    <Button asChild size="sm">
      <Link {...props}>
        <Icon name="add" />
        {label}
      </Link>
    </Button>
  );
}

/** An empty item is the create control; its outline borrows the item's shape. P8. */
export function AddItemLink({
  label,
  className = "",
  ...props
}: Omit<ComponentProps<typeof Link>, "children"> & { label: string }) {
  return (
    <Link title={label} {...props} className={`add-item ${className}`}>
      <AddItemMark label={label} />
    </Link>
  );
}

export function AddItemMark({ label }: { label: string }) {
  return (
    <span className="add-item-mark">
      <Icon name="add" size={20} />
      <span className="add-item-label">{label}</span>
    </span>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="tag">{children}</span>;
}

/**
 * The one project an item belongs to. It is a different kind of thing from a
 * tag, so it has a different shape: a folder and a name in the grotesque, with
 * no box, where a tag is a mono word in a hairline box. With `href` it is the
 * filter for that project; `selected` marks the filter in force, whose href
 * is then the way back out. `count` is how many rows the filter would show.
 */
export function ProjectChip({
  project,
  href,
  preventScrollReset,
  selected = false,
  count,
}: {
  project: string;
  href?: string;
  preventScrollReset?: boolean;
  selected?: boolean;
  count?: number;
}) {
  const body = (
    <>
      <Icon name="folder" size={13} />
      {project}
      {count === undefined ? null : (
        <span className="project-count">{count}</span>
      )}
    </>
  );
  return href ? (
    <Link
      aria-current={selected ? "true" : undefined}
      className="project-chip"
      preventScrollReset={preventScrollReset}
      title={selected ? `Clear the ${project} filter` : `Project ${project}`}
      to={href}
    >
      {body}
    </Link>
  ) : (
    <span className="project-chip" title={`Project ${project}`}>
      {body}
    </span>
  );
}

export function TagRow({
  project,
  tags,
}: {
  project?: string | null;
  tags?: string[];
}) {
  if (!project && !tags?.length) return null;
  return (
    <ul className="tags">
      {project ? (
        <li>
          <ProjectChip project={project} />
        </li>
      ) : null}
      {(tags ?? []).map((tag) => (
        <li key={tag}>
          <Tag>{tag}</Tag>
        </li>
      ))}
    </ul>
  );
}

/**
 * Tags that are each the filter for their value: one chip per tag, linking to
 * the list narrowed to it. The list rows and the memory modal share it, so a
 * tag reads the same wherever it appears.
 */
export function TagLinks({
  tags,
  href,
  preventScrollReset,
}: {
  tags: string[];
  href: (tag: string) => string;
  preventScrollReset?: boolean;
}) {
  return (
    <ul className="tags">
      {tags.map((tag) => (
        <li key={tag}>
          <Link
            className="tag"
            preventScrollReset={preventScrollReset}
            to={href(tag)}
          >
            {tag}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** A to-do state, a token's liveness, or anything else with a small vocabulary. */
export function Pill({
  tone = "pending",
  children,
}: {
  tone?: "pending" | "claimed" | "blocked" | "done" | "label" | "accent";
  children: ReactNode;
}) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function Field({
  label,
  name,
  defaultValue,
  type = "text",
  rows,
  required,
  placeholder,
  autoComplete,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  type?: string;
  rows?: number;
  required?: boolean;
  placeholder?: string;
  autoComplete?: string;
}) {
  return (
    <label>
      {label}
      {rows ? (
        <textarea
          defaultValue={defaultValue}
          name={name}
          placeholder={placeholder}
          required={required}
          rows={rows}
        />
      ) : (
        <input
          autoComplete={autoComplete}
          defaultValue={defaultValue}
          name={name}
          placeholder={placeholder}
          required={required}
          type={type}
        />
      )}
    </label>
  );
}

/**
 * The short list. Past about fifty options a native select stops being usable
 * and the answer is `Combobox`, which takes the same label-and-name shape.
 */
export function Select({
  label,
  name,
  options,
  defaultValue,
  placeholder,
}: {
  label: string;
  name: string;
  options: { value: string; label: string }[];
  defaultValue?: string;
  placeholder?: string;
}) {
  return (
    <label>
      {label}
      <select defaultValue={defaultValue} name={name}>
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

/**
 * Fields and the one button that commits them, three units apart on one row,
 * the button on the fields' baseline; it wraps under them when the row runs
 * out. Use it wherever a form ends in a button, so the button never sits
 * against the field above it. A field that should stay short takes
 * `className="field-narrow"` on its wrapper.
 */
export function FieldRow({ children }: { children: ReactNode }) {
  return <div className="field-row">{children}</div>;
}
