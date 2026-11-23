import type { ComponentProps, ReactNode } from "react";
import { Link } from "react-router";
import { Icon } from "~/components/icon";
import { cn } from "~/lib/utils";

/**
 * Every item list in the console: one bordered group of rows. To-dos,
 * memories, skills and library items differ in what a row carries, not in
 * how the list is drawn or how a row opens.
 */
export function ItemList({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <ul
      aria-label={label}
      className={cn(
        "item-list m-0 list-none divide-y divide-border overflow-hidden rounded-lg border bg-card p-0",
        className,
      )}
    >
      {children}
    </ul>
  );
}

/**
 * One item: what it is on the left, the facts about it on the right. The
 * title is the link that opens the item in the right-hand pane, and its hit
 * area covers the row; controls in `media` and `meta` sit above it, so a
 * checkbox or a tag link is still its own target. `children` is where the
 * open item's pane renders, so the pane can hold this row in place (P4).
 */
export function ItemRow({
  href,
  title,
  description,
  media,
  meta,
  open = false,
  muted = false,
  stacked = false,
  dense = false,
  lead,
  className,
  children,
}: {
  href: string;
  title: ReactNode;
  description?: ReactNode;
  media?: ReactNode;
  meta?: ReactNode;
  open?: boolean;
  /** Done, archived or deleted: still listed, read as inactive. */
  muted?: boolean;
  /**
   * The facts go on their own line under the text instead of beside it, and
   * the title wraps instead of truncating. For a list whose titles are
   * sentences, so the whole claim reads and each fact sits in the same place
   * on every row.
   */
  stacked?: boolean;
  /**
   * One line per item, shorter than a list of things to open and read: the
   * description runs on the title's line instead of under it. For a log of
   * events, such as the activity trail, where many rows are scanned at once.
   */
  dense?: boolean;
  /** Words before the title and outside its link, such as an event's verb. */
  lead?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  if (dense) {
    return (
      <li
        className={cn(
          "item-row item-row-dense relative flex items-center gap-x-2.5 px-4 py-1.5 text-sm transition-colors hover:bg-accent/40",
          open && "bg-accent/70 hover:bg-accent/70",
          className,
        )}
        data-open={open || undefined}
      >
        {media ? (
          <div className="relative z-10 flex shrink-0 text-muted-foreground">
            {media}
          </div>
        ) : null}
        <div className="flex min-w-0 flex-1 items-baseline gap-x-1">
          {lead ? (
            <span className="shrink-0 text-muted-foreground">{lead}</span>
          ) : null}
          {/* Spaces between the parts, for the line's text; flex drops them. */}
          {lead ? " " : null}
          <Link
            aria-current={open ? "true" : undefined}
            className={cn(
              "item-title min-w-0 shrink truncate text-foreground no-underline after:absolute after:inset-0 after:content-['']",
              muted && "text-muted-foreground line-through",
            )}
            preventScrollReset
            to={href}
          >
            {title}
          </Link>
          {description ? " " : null}
          {description ? (
            <span className="item-description min-w-0 flex-1 truncate text-muted-foreground">
              {description}
            </span>
          ) : null}
        </div>
        {meta ? (
          <div className="item-meta relative z-10 flex shrink-0 items-center gap-x-3 text-xs text-muted-foreground">
            {meta}
          </div>
        ) : null}
        {children}
      </li>
    );
  }
  return (
    <li
      className={cn(
        "item-row relative flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3 transition-colors hover:bg-accent/40",
        open && "bg-accent/70 hover:bg-accent/70",
        className,
      )}
      data-open={open || undefined}
    >
      {media ? (
        <div className="relative z-10 shrink-0 pt-0.5">{media}</div>
      ) : null}
      <div className="min-w-0 flex-1 basis-56">
        <Link
          aria-current={open ? "true" : undefined}
          className={cn(
            "item-title block font-medium text-foreground no-underline after:absolute after:inset-0 after:content-['']",
            stacked ? "text-pretty" : "truncate",
            muted && "text-muted-foreground line-through",
          )}
          preventScrollReset
          to={href}
        >
          {title}
        </Link>
        {description ? (
          <p className="item-description m-0 mt-0.5 line-clamp-1 max-w-none text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {meta ? (
        <div
          className={cn(
            "item-meta relative z-10 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-xs text-muted-foreground",
            // The facts' line spans the row; its gaps still open the item.
            stacked
              ? "pointer-events-none basis-full *:pointer-events-auto"
              : "justify-end sm:max-w-[40%]",
          )}
        >
          {meta}
        </div>
      ) : null}
      {children}
    </li>
  );
}

/**
 * The list's create control, as its first item: an empty row with a
 * stitched leather edge and the action named on it (P8). A link, so it
 * works before hydration; `onClick` lets a page open its composer in place.
 */
export function AddRow(props: AddLinkProps) {
  return (
    <li className="add-row">
      <AddRowLink {...props} />
    </li>
  );
}

type AddLinkProps = Omit<
  ComponentProps<typeof Link>,
  "children" | "className"
> & {
  label: string;
};

/** The stitched link alone, for a row that swaps it for a composer. */
export function AddRowLink({ label, ...link }: AddLinkProps) {
  return (
    <Link className="add-row-link" preventScrollReset {...link}>
      <span aria-hidden="true" className="stitch-chip">
        <Icon name="add" />
      </span>
      {label}
    </Link>
  );
}
