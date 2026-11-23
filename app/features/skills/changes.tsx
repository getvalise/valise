import { useState } from "react";
import { useFetcher } from "react-router";
import { useLanded, ViaFetcher } from "~/components/editable";
import { Button } from "~/components/ui/button";
import { type SkillChange, type SkillChangeReport } from "~/concepts/skills";
import { type UpstreamReport } from "~/concepts/skills-upstream";
import { cn } from "~/lib/utils";

/**
 * One change over the ticked rows. The rows' boxes join this form through
 * `form="skill-changes"`, so it posts with scripting off; hydrated, the
 * buttons wait for a tick and say how many they will touch.
 */
export function SkillChanges({
  ticked,
  hydrated,
  showDeleted,
  onClear,
}: {
  ticked: number;
  hydrated: boolean;
  showDeleted: boolean;
  onClear?: () => void;
}) {
  const fetcher = useFetcher({ key: "skill-changes" });
  const [saving, setSaving] = useState(false);
  const landed = useLanded(fetcher, () => setSaving(false));
  const changes: [SkillChange | "update", string][] = [
    ["enable", "Enable"],
    ["disable", "Disable"],
    ["delete", "Delete"],
    ...(showDeleted ? [["restore", "Restore"] as [SkillChange, string]] : []),
    ["update", "Update"],
    ["auto-on", "Auto-update on"],
    ["auto-off", "Auto-update off"],
  ];
  return (
    <fetcher.Form
      aria-busy={saving}
      aria-label="Change the selected skills"
      // Hydrated, the bar floats over the page's foot while rows are ticked,
      // so showing and hiding it moves no row (P4). Without scripting it is
      // always there, in the flow.
      className={cn(
        "skill-changes flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2",
        hydrated
          ? "fixed bottom-6 left-1/2 z-40 max-w-[calc(100vw-2rem)] -translate-x-1/2 bg-popover shadow-lg"
          : "bg-muted/50",
      )}
      id="skill-changes"
      method="post"
      onSubmit={() => {
        setSaving(true);
        landed();
      }}
      preventScrollReset
    >
      <ViaFetcher />
      <input name="intent" type="hidden" value="change" />
      {hydrated ? (
        <span className="mr-1 text-sm font-medium">
          {saving ? "Saving…" : `${ticked} selected`}
        </span>
      ) : null}
      {changes.map(([change, label]) => (
        <Button
          className="h-7"
          disabled={saving || (hydrated && ticked === 0)}
          key={change}
          name="change"
          size="sm"
          type="submit"
          value={change}
          variant={change === "delete" ? "destructive" : "outline"}
        >
          {label}
        </Button>
      ))}
      {hydrated && onClear ? (
        <Button
          className="ml-auto h-7"
          onClick={onClear}
          size="sm"
          type="button"
          variant="ghost"
        >
          Clear selection
        </Button>
      ) : null}
    </fetcher.Form>
  );
}

const CHANGED: Record<SkillChange, string> = {
  enable: "Enabled",
  disable: "Disabled",
  delete: "Deleted",
  restore: "Restored",
  "auto-on": "Auto-update on for",
  "auto-off": "Auto-update off for",
};

export function ChangeReport({
  change,
  report,
}: {
  change: SkillChange;
  report: SkillChangeReport;
}) {
  const builtins = report.skipped
    .filter((skip) => skip.reason === "builtin")
    .map((skip) => skip.name);
  const local = report.skipped
    .filter((skip) => skip.reason === "no-upstream")
    .map((skip) => skip.name);
  const missing = report.skipped
    .filter((skip) => skip.reason === "missing")
    .map((skip) => skip.name);
  return (
    <p className="skill-change-report" role="status">
      {report.changed.length === 0 && report.skipped.length === 0
        ? "Nothing to change."
        : report.changed.length === 0
          ? ""
          : `${CHANGED[change]} ${report.changed.join(", ")}.`}
      {builtins.length === 0
        ? null
        : ` Kept ${builtins.join(", ")}: ${builtins.length === 1 ? "it ships" : "they ship"} with Valise, so the next deploy would add ${builtins.length === 1 ? "it" : "them"} back. Disable instead.`}
      {local.length === 0
        ? null
        : ` Skipped ${local.join(", ")}: written here or built in, so there is no upstream to follow.`}
      {missing.length === 0
        ? null
        : ` Could not find ${missing.join(", ")}. Reload the list before trying again.`}
    </p>
  );
}

export function UpdateReport({ report }: { report: UpstreamReport }) {
  const quiet =
    report.applied.length === 0 &&
    report.held.length === 0 &&
    report.errors.length === 0;
  return (
    <div className="skill-change-report" role="status">
      {quiet ? <p>No updates for the selected skills.</p> : null}
      {report.applied.length > 0 ? (
        <p>Updated {report.applied.join(", ")}.</p>
      ) : null}
      {report.held.length > 0 ? (
        <p>
          Held {report.held.join(", ")}: edited here, so an update would replace
          that edit. Open {report.held.length === 1 ? "it" : "each"} to review
          the update.
        </p>
      ) : null}
      {report.errors.map((error) => (
        <p key={error}>{error}</p>
      ))}
    </div>
  );
}
