import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { useHydrated } from "~/components/editable";
import { Icon } from "~/components/icon";
import { Button } from "~/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "~/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { cn } from "~/lib/utils";

export type PickerOption = { value: string; label: string; hint?: string };

/** What a picker's resource route answers: one page and the next cursor. */
export type PickerPage = { options: PickerOption[]; next: string | null };

/**
 * A choice from a set too large to send with the page: documents, memories.
 * Typing searches on the server and a page holds 30, with Load more for the
 * rest, so nothing loads the whole set. The value posts as a hidden input
 * under `name`.
 *
 * Before hydration it is a native select over `fallback`, the page the
 * loader already sent, so the form still works with scripting off (P11).
 */
export function AsyncPicker({
  name,
  label,
  endpoint,
  placeholder,
  emptyLabel,
  fallback,
  exclude = [],
  defaultValue = "",
  onPick,
}: {
  name: string;
  label: string;
  /** A resource route answering `?q=&after=` with a `PickerPage`. */
  endpoint: string;
  placeholder: string;
  /** The "nothing chosen" option, e.g. "No document". */
  emptyLabel?: string;
  fallback: PickerOption[];
  /** Values already chosen elsewhere, left out of the list. */
  exclude?: string[];
  defaultValue?: string;
  onPick?: (option: PickerOption | null) => void;
}) {
  const hydrated = useHydrated();
  const fetcher = useFetcher<PickerPage>();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<PickerOption | null>(
    fallback.find((option) => option.value === defaultValue) ?? null,
  );
  const [pages, setPages] = useState<PickerPage[]>([]);
  // Each answer is taken once: a new search replaces the list, Load more
  // appends to it. The fetcher keeps its last answer until the next lands,
  // so an answer is new only when it is not the one already taken.
  const taken = useRef<PickerPage | undefined>(undefined);
  const mode = useRef<"replace" | "append">("replace");
  // The dialog this picker sits in, if any, so its list opens above it.
  const root = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useEffect(() => {
    // No DOM lib in this repo, so the one call is named rather than typed.
    const dialog = (
      root.current as unknown as {
        closest(selector: string): HTMLElement | null;
      } | null
    )?.closest("dialog");
    setContainer(dialog ?? null);
    // The server render is a native select with no root: look again once
    // hydrated, or a picker rendered on the server portals under its dialog.
  }, [hydrated]);

  // Debounced: a search per pause in typing, not per keystroke.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      mode.current = "replace";
      taken.current = fetcher.data;
      fetcher.load(pageUrl(endpoint, { q: query }));
    }, 200);
    return () => clearTimeout(timer);
  }, [open, query, endpoint]);

  useEffect(() => {
    const answer = fetcher.data;
    if (fetcher.state !== "idle" || !answer || answer === taken.current) return;
    taken.current = answer;
    setPages((before) =>
      mode.current === "append" ? [...before, answer] : [answer],
    );
  }, [fetcher.state, fetcher.data]);

  if (!hydrated)
    return (
      <label className="field">
        {label}
        <select defaultValue={defaultValue} name={name}>
          {emptyLabel ? <option value="">{emptyLabel}</option> : null}
          {fallback
            .filter((option) => !exclude.includes(option.value))
            .map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
        </select>
      </label>
    );

  const hidden = new Set(exclude);
  const options = pages
    .flatMap((page) => page.options)
    .filter((option) => !hidden.has(option.value));
  const next = pages.at(-1)?.next ?? null;
  const loading = fetcher.state !== "idle";
  const pick = (option: PickerOption | null) => {
    setChosen(option);
    setOpen(false);
    onPick?.(option);
  };
  return (
    <div className="field" ref={root}>
      <span>{label}</span>
      <input name={name} type="hidden" value={chosen?.value ?? ""} />
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <Button
            aria-label={label}
            className="w-full justify-between font-sans font-normal normal-case tracking-normal"
            role="combobox"
            type="button"
            variant="outline"
          >
            <span
              className={cn("truncate", !chosen && "text-muted-foreground")}
            >
              {chosen?.label ?? placeholder}
            </span>
            <Icon name="expanded" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          container={container ?? undefined}
          className="w-(--radix-popover-trigger-width) min-w-72 p-0"
        >
          <Command shouldFilter={false}>
            <CommandInput
              onValueChange={setQuery}
              placeholder={placeholder}
              value={query}
            />
            <CommandList>
              <CommandEmpty>
                {loading ? "Searching…" : "Nothing matches."}
              </CommandEmpty>
              {emptyLabel && chosen ? (
                <CommandGroup>
                  <CommandItem onSelect={() => pick(null)} value="__none">
                    {emptyLabel}
                  </CommandItem>
                </CommandGroup>
              ) : null}
              {options.length > 0 ? (
                <CommandGroup>
                  {options.map((option) => (
                    <CommandItem
                      key={option.value}
                      onSelect={() => pick(option)}
                      value={option.value}
                    >
                      <span className="truncate">{option.label}</span>
                      {option.hint ? (
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                          {option.hint}
                        </span>
                      ) : null}
                      {chosen?.value === option.value ? (
                        <Icon name="check" />
                      ) : null}
                    </CommandItem>
                  ))}
                  {next ? (
                    <CommandItem
                      className="justify-center text-muted-foreground"
                      disabled={loading}
                      onSelect={() => {
                        mode.current = "append";
                        taken.current = fetcher.data;
                        fetcher.load(
                          pageUrl(endpoint, { q: query, after: next }),
                        );
                      }}
                      value="__more"
                    >
                      {loading ? "Loading…" : "Load more"}
                    </CommandItem>
                  ) : null}
                </CommandGroup>
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** The endpoint with the search and cursor added, keeping its own params. */
function pageUrl(endpoint: string, params: Record<string, string>): string {
  const [path, own = ""] = endpoint.split("?", 2);
  const merged = new URLSearchParams(own);
  for (const [key, value] of Object.entries(params)) merged.set(key, value);
  return `${path}?${merged}`;
}
