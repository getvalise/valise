import { SubNav } from "~/components/ui";

/**
 * The Memories sections, shared by every page under /memories. Review carries
 * the number of questions nightly upkeep left for the person, so they learn
 * something waits without opening Review (J-0); none waiting draws nothing.
 */
export function MemorySections({
  current,
  waiting,
}: {
  current: "all" | "subjects" | "review";
  /** Waiting questions; null when the count could not be read. */
  waiting: number | null;
}) {
  return (
    <SubNav
      label="Memories sections"
      items={[
        {
          href: "/memories",
          label: "All memories",
          current: current === "all",
        },
        {
          href: "/memories/subjects",
          label: "Subjects",
          current: current === "subjects",
        },
        {
          href: "/memories?tab=review",
          label: "Review",
          current: current === "review",
          count: waiting ?? undefined,
          countLabel:
            waiting === 1
              ? "1 question waiting"
              : `${waiting} questions waiting`,
        },
      ]}
    />
  );
}
