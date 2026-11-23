import { SubNav } from "~/components/ui";

/** Activity's sections: what changed in the case, and the sessions behind it. */
export function ActivityNav({
  current,
}: {
  current: "changes" | "transcripts";
}) {
  return (
    <SubNav
      items={[
        { href: "/activity", label: "Changes", current: current === "changes" },
        {
          href: "/activity/transcripts",
          label: "Transcripts",
          current: current === "transcripts",
        },
      ]}
      label="Activity sections"
    />
  );
}
