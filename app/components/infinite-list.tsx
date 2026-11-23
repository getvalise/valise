import { useEffect, useRef, useState } from "react";
import {
  Link,
  useFetchers,
  useLocation,
  useNavigate,
  useNavigation,
  useNavigationType,
} from "react-router";
import { type ListFilters, listHref } from "~/concepts/list-filters";
import type { infiniteWindow } from "~/concepts/pagination";

/** A growing prefix, not cached pages: revalidation refreshes every visible row. */
export function InfiniteList({
  path,
  filters,
  window,
  paused = false,
  extra = {},
  noun = "items",
  besidePane = false,
}: {
  path: string;
  filters: ListFilters;
  window: ReturnType<typeof infiniteWindow>;
  paused?: boolean;
  /** A page's own parameters the next page keeps, as on ListToolbar. */
  extra?: Record<string, string | undefined>;
  /** What the list holds, for its progress line. */
  noun?: string;
  /**
   * The open item is a pane beside the list rather than a dialog over it, so
   * the list keeps loading while it is open. `extra` must then carry the
   * pane's parameters, or the next page would close it.
   */
  besidePane?: boolean;
}) {
  const anchor = useRef<HTMLAnchorElement>(null);
  const navigate = useNavigate();
  const navigation = useNavigation();
  const location = useLocation();
  const fetchers = useFetchers();
  const busy =
    navigation.state !== "idle" ||
    fetchers.some((fetcher) => fetcher.state !== "idle");
  const more = window.page < window.pages;
  const href = listHref(path, filters, {
    ...extra,
    page: String(window.page + 1),
  });
  const params = new URLSearchParams(location.search);
  const modal =
    !besidePane && ["open", "edit", "add"].some((key) => params.has(key));
  useEffect(() => {
    // Worker types deliberately omit lib.dom; name only this browser API.
    const Observer = (
      globalThis as {
        IntersectionObserver?: new (
          callback: (entries: { isIntersecting: boolean }[]) => void,
          options: { rootMargin: string },
        ) => { observe(target: HTMLAnchorElement): void; disconnect(): void };
      }
    ).IntersectionObserver;
    if (!more || busy || paused || modal || !anchor.current || !Observer)
      return;
    const observer = new Observer(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void navigate(href, { replace: true, preventScrollReset: true });
      },
      { rootMargin: "200px" },
    );
    observer.observe(anchor.current);
    return () => observer.disconnect();
  }, [more, busy, paused, modal, href, navigate]);
  return (
    <div className="infinite-list" aria-label="List progress">
      <span aria-live="polite" aria-atomic="true">
        {paused
          ? "Searching all items…"
          : `Showing ${Math.min(window.limit, window.total)} of ${window.total} ${noun}`}
      </span>
      {more ? (
        <Link
          ref={anchor}
          to={href}
          replace
          preventScrollReset
          aria-disabled={busy || paused}
          onClick={(event) => {
            if (busy || paused) event.preventDefault();
          }}
        >
          {busy ? "Loading…" : "Load more"}
        </Link>
      ) : null}
    </div>
  );
}

/** Filter loaded rows on the keystroke, then search the whole store after a pause. */
export function useLiveList<T>(
  rows: T[],
  text: (row: T) => string,
  filters: ListFilters,
) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const navigate = useNavigate();
  const source = filters.query ?? "";
  const [query, setQuery] = useState(source);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(query);
  const previous = useRef(location.key);
  useEffect(() => {
    if (previous.current === location.key) return;
    previous.current = location.key;
    // A response to an older keystroke must not overwrite a newer draft.
    if (
      navigationType !== "POP" &&
      location.state?.liveSearch &&
      source !== latest.current.trim()
    )
      return;
    clearTimeout(timer.current);
    latest.current = source;
    setQuery(source);
  }, [location.key, location.state, navigationType, source]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const changeQuery = (value: string) => {
    latest.current = value;
    setQuery(value);
    clearTimeout(timer.current);
    const params = new URLSearchParams(location.search);
    for (const key of ["q", "page", "open", "edit"]) params.delete(key);
    if (value.trim()) params.set("q", value.trim());
    const href = `${location.pathname}?${params}`;
    timer.current = setTimeout(() => {
      void navigate(href, {
        replace: true,
        preventScrollReset: true,
        state: { liveSearch: true },
      });
    }, 250);
  };
  const pending = query.trim() !== source;
  const needle = query.trim().toLowerCase();
  return {
    rows: pending
      ? rows.filter((row) => text(row).toLowerCase().includes(needle))
      : rows,
    query,
    onQueryChange: changeQuery,
    pending,
  };
}
