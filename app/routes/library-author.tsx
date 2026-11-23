import { Link } from "react-router";
import { ItemList, ItemRow } from "~/components/item-list";
import { ApplicationShell, Empty, TagLinks } from "~/components/ui";
import { highlightQuote } from "~/concepts/authors";
import { sourceRef } from "~/concepts/sources";
import { requireConsoleActor } from "~/console/context.server";
import { LibraryNav } from "~/features/library/nav";
import type { Route } from "./+types/library-author";

export async function loader({ context, request, params }: Route.LoaderArgs) {
  const actor = await requireConsoleActor(context, request);
  const view = await actor.store.library.author(params.slug);
  if (!view)
    throw new Response("No saved item names this author.", { status: 404 });
  return view;
}

const day = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

/** A saved item, opened in Library's detail pane. */
const itemHref = (title: string, sourceId: string) =>
  `/library?${new URLSearchParams({ q: title.slice(0, 200), details: sourceRef(sourceId) })}`;

/** On a phone, a row's facts wrap under its title instead of squeezing it. */
const stackOnPhone =
  "max-sm:flex-wrap max-sm:gap-y-1 max-sm:[&>.item-meta]:basis-full max-sm:[&>.item-meta]:justify-start";

const tagHref = (tag: string) => `/library?${new URLSearchParams({ tag })}`;

function host(siteName: string | null, url: string | null): string | null {
  if (siteName) return siteName;
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export default function AuthorPage({ loaderData }: Route.ComponentProps) {
  const { author, items, highlights, firstSavedAt, lastSavedAt } = loaderData;
  return (
    <ApplicationShell
      title="Library"
      lede={<Link to="/library/authors">All authors</Link>}
      sections={<LibraryNav current="authors" />}
    >
      <section aria-labelledby="author-name" className="author-page">
        <h2 id="author-name">{author.name}</h2>
        <p className="muted">
          {items.length} saved {items.length === 1 ? "item" : "items"} and{" "}
          {highlights.length}{" "}
          {highlights.length === 1 ? "highlight" : "highlights"}
          {firstSavedAt !== null && lastSavedAt !== null
            ? firstSavedAt === lastSavedAt
              ? `, saved ${day(lastSavedAt)}`
              : `, saved between ${day(firstSavedAt)} and ${day(lastSavedAt)}`
            : ""}
          .
          {author.spellings.length > 1
            ? ` Also saved as ${author.spellings
                .filter((name) => name !== author.name)
                .join(", ")}.`
            : ""}
        </p>
      </section>

      <section aria-labelledby="author-items">
        <h2 className="eyebrow" id="author-items">
          Saved items
        </h2>
        <ItemList className="author-items" label="Saved items">
          {items.map((item) => (
            <ItemRow
              description={item.description || item.notes.slice(0, 240) || null}
              href={itemHref(item.title, item.sourceId)}
              className={stackOnPhone}
              key={item.sourceId}
              meta={
                <>
                  <span>
                    {[item.kind, host(item.siteName, item.url)]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {item.tags.length > 0 ? (
                    <TagLinks href={tagHref} tags={item.tags} />
                  ) : null}
                  <time
                    dateTime={new Date(item.createdAt * 1000).toISOString()}
                  >
                    {day(item.createdAt)}
                  </time>
                </>
              }
              title={item.title}
            />
          ))}
        </ItemList>
      </section>

      <section aria-labelledby="author-highlights">
        <h2 className="eyebrow" id="author-highlights">
          Highlights
        </h2>
        {highlights.length ? (
          <ItemList className="author-highlights" label="Highlights">
            {highlights.map((highlight) => {
              const quote = highlightQuote(highlight.notes);
              return (
                <ItemRow
                  description={`From ${highlight.title.replace(/ — Highlight$/, "")}`}
                  href={itemHref(highlight.title, highlight.sourceId)}
                  className={stackOnPhone}
                  key={highlight.sourceId}
                  meta={
                    <time
                      dateTime={new Date(
                        highlight.createdAt * 1000,
                      ).toISOString()}
                    >
                      {day(highlight.createdAt)}
                    </time>
                  }
                  title={<q title={quote}>{quote}</q>}
                />
              );
            })}
          </ItemList>
        ) : (
          <Empty>
            No highlights from {author.name} yet. Select a passage on one of
            their pages and choose Save selection as highlight in the extension.
          </Empty>
        )}
      </section>
    </ApplicationShell>
  );
}
