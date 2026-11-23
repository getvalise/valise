import { ItemList, ItemRow } from "~/components/item-list";
import { ApplicationShell, Empty } from "~/components/ui";
import { requireConsoleActor } from "~/console/context.server";
import { LibraryNav } from "~/features/library/nav";
import type { Route } from "./+types/library-authors";

export async function loader({ context, request }: Route.LoaderArgs) {
  const actor = await requireConsoleActor(context, request);
  return { authors: await actor.store.library.authors() };
}

export default function Authors({ loaderData }: Route.ComponentProps) {
  const { authors } = loaderData;
  return (
    <ApplicationShell
      title="Library"
      lede="Everyone whose work you saved, most saved first. Open an author to see their items and your highlights from them."
      sections={<LibraryNav current="authors" />}
    >
      {authors.length === 0 ? (
        <Empty>
          No authors yet. The Chrome extension reads the byline when it saves an
          article, and you can add authors to any saved page under Notes and
          details.
        </Empty>
      ) : (
        <ItemList className="author-index" label="Authors">
          {authors.map((author) => {
            const others = author.spellings.filter(
              (name) => name !== author.name,
            );
            return (
              <ItemRow
                description={
                  others.length ? `Also saved as ${others.join(", ")}` : null
                }
                href={`/library/authors/${author.slug}`}
                key={author.slug}
                meta={
                  <span className="author-count">
                    {author.sources} {author.sources === 1 ? "item" : "items"}
                  </span>
                }
                title={author.name}
              />
            );
          })}
        </ItemList>
      )}
    </ApplicationShell>
  );
}
