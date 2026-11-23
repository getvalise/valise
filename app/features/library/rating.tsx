import { Star } from "lucide-react";
import { useFetcher } from "react-router";
import { ViaFetcher } from "~/components/editable";
import { cn } from "~/lib/utils";

/**
 * One to three stars, set where the item is read or opened: the reader's
 * header and the Library pane, through the same `rate` intent (P7: an enum
 * gets a picker). Clicking the current star clears it, so the reversal is the same
 * control (P12). Each star is a form button, so it works with scripting off;
 * with scripting it posts through a fetcher and paints on the click (P11).
 */
export function RatingControl({
  stars,
  action,
  hidden = {},
  compact = false,
}: {
  stars: number | null;
  /** Where the stars post; the reader posts to itself. */
  action?: string;
  /** Posted beside the stars: the Library pane names its item. */
  hidden?: Record<string, string>;
  /** The pane's size: smaller stars on the same 24px targets (V6). */
  compact?: boolean;
}) {
  const fetcher = useFetcher();
  const pending = fetcher.formData?.get("stars");
  const shown =
    pending === undefined || pending === null ? stars : Number(pending) || null;
  return (
    <fetcher.Form
      action={action}
      method="post"
      preventScrollReset
      className={cn(
        "flex items-center text-muted-foreground",
        compact ? "text-sm" : "mt-3 gap-1",
      )}
      aria-label="Your rating"
    >
      <input type="hidden" name="intent" value="rate" />
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} name={name} type="hidden" value={value} />
      ))}
      <ViaFetcher />
      <span className="mr-2">
        {shown ? `Rated ${shown} of 3` : "Not rated"}
      </span>
      {[1, 2, 3].map((n) => (
        <button
          key={n}
          type="submit"
          name="stars"
          value={n === shown ? 0 : n}
          className="inline-grid min-h-[24px] min-w-[24px] cursor-pointer place-items-center rounded-sm border-0 bg-transparent p-[2px] text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring aria-pressed:text-primary"
          aria-pressed={shown !== null && n <= shown}
          aria-label={
            n === shown
              ? `Clear rating of ${n} of 3 stars`
              : `Rate ${n} of 3 stars`
          }
        >
          <Star
            aria-hidden="true"
            size={compact ? 16 : 20}
            strokeWidth={1.5}
            fill={shown !== null && n <= shown ? "currentColor" : "none"}
          />
        </button>
      ))}
    </fetcher.Form>
  );
}

/** A rating on a list row: read-only and small, absent when unrated. */
export function RatingStars({ stars }: { stars: number | null | undefined }) {
  if (!stars) return null;
  return (
    <span
      className="inline-flex gap-px align-[-1px] [&>svg]:text-primary"
      role="img"
      aria-label={`Rated ${stars} of 3`}
      title={`Rated ${stars} of 3`}
    >
      {[1, 2, 3].map((n) => (
        <Star
          aria-hidden="true"
          key={n}
          size={12}
          strokeWidth={1.5}
          fill={n <= stars ? "currentColor" : "none"}
        />
      ))}
    </span>
  );
}

/** The rating a reader form posted: 1 to 3, 0 to clear; null if malformed. */
export function postedStars(form: FormData): 0 | 1 | 2 | 3 | null {
  const value = form.get("stars");
  return value === "0" || value === "1" || value === "2" || value === "3"
    ? (Number(value) as 0 | 1 | 2 | 3)
    : null;
}
