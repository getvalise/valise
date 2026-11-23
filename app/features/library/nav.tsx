import { SubNav } from "~/components/ui";

/** The Library's sections, shared by the list, the archive and authors. */
export function LibraryNav({
  current,
  view = "pages",
}: {
  current: "library" | "archived" | "authors";
  /** The tab in force; Library and Archived keep it. */
  view?: "pages" | "documents";
}) {
  const tab = view === "documents" ? "view=documents" : "";
  return (
    <SubNav
      items={[
        {
          href: tab ? `/library?${tab}` : "/library",
          label: "Library",
          current: current === "library",
        },
        {
          href: tab ? `/library?archived=1&${tab}` : "/library?archived=1",
          label: "Archived",
          current: current === "archived",
        },
        {
          href: "/library/authors",
          label: "Authors",
          current: current === "authors",
        },
      ]}
      label="Library"
    />
  );
}
