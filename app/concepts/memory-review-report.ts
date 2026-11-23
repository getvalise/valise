import type { ReviewPassReport } from "./memory-review";
import { rankingFailureLabel } from "./memory-review-ranking";

/**
 * A check's report in the words a person reads after pressing the button.
 * The same sentence answers a fetcher and, through `?ran=`, a no-script
 * redirect, so the outcome survives the navigation (P3, P11).
 */
export type ReviewOutcome = {
  scanned: number;
  /** Questions: results left for the person to decide. */
  found: number;
  /** Summaries nightly upkeep applied itself. */
  applied: number;
  failed: number;
  stop:
    | "none"
    | "off"
    | "budget"
    | "cost"
    | "busy"
    | "limit"
    | "ranking"
    | "other";
  /** The ranking failure code when `stop` is "ranking". */
  reason?: string;
};

const RANKING_STOP = /^(ranking|embedding)-[a-z0-9-]{1,40}$/;

export function reviewOutcome(report: ReviewPassReport): ReviewOutcome {
  const stop =
    report.stopped === null
      ? "none"
      : report.stopped === "off"
        ? "off"
        : report.stopped === "daily budget"
          ? "budget"
          : report.stopped === "cost limit"
            ? "cost"
            : report.stopped === "already running"
              ? "busy"
              : report.stopped.endsWith("pass limit")
                ? "limit"
                : RANKING_STOP.test(report.stopped)
                  ? "ranking"
                  : "other";
  return {
    scanned: report.scanned,
    found: report.proposed,
    applied: report.applied,
    failed: report.failed,
    stop,
    ...(stop === "ranking" ? { reason: report.stopped! } : {}),
  };
}

/** Four fields as before; a fifth when something was applied or a sixth is needed, and a sixth naming a ranking stop, so older links still read. */
export const encodeOutcome = (o: ReviewOutcome) =>
  [
    o.scanned,
    o.found,
    o.failed,
    o.stop,
    ...(o.applied || o.reason ? [o.applied] : []),
    ...(o.reason ? [o.reason] : []),
  ].join(".");

export function decodeOutcome(raw: string | null): ReviewOutcome | null {
  const [scanned, found, failed, stop, applied = "0", reason] = (
    raw ?? ""
  ).split(".");
  if (
    ![scanned, found, failed, applied].every((n) =>
      /^\d{1,3}$/.test(n ?? ""),
    ) ||
    ![
      "none",
      "off",
      "budget",
      "cost",
      "busy",
      "limit",
      "ranking",
      "other",
    ].includes(stop ?? "") ||
    (stop === "ranking") !== RANKING_STOP.test(reason ?? "")
  )
    return null;
  return {
    scanned: Number(scanned),
    found: Number(found),
    applied: Number(applied),
    failed: Number(failed),
    stop: stop as ReviewOutcome["stop"],
    ...(stop === "ranking" ? { reason } : {}),
  };
}

export function outcomeText(o: ReviewOutcome): string {
  const parts: string[] = [];
  if (o.applied)
    parts.push(
      `Added ${o.applied} summar${o.applied === 1 ? "y" : "ies"} automatically; see Applied automatically.`,
    );
  if (o.found)
    parts.push(
      `${o.found} new question${o.found === 1 ? "" : "s"} for you, listed below.`,
    );
  if (o.failed)
    parts.push(
      `${o.failed} check${o.failed === 1 ? "" : "s"} could not finish; the row says why.`,
    );
  const stop = {
    none: "",
    off: "Reviews are off, so nothing was sent.",
    budget:
      "Today's memory checks are used up. They reset at midnight UTC, or raise memories checked a day under Advanced.",
    cost: "Today's review cost cap is used up. It resets at midnight UTC; an admin sets the cap.",
    busy: "Another check is already running. Try again in a few minutes.",
    limit:
      "A check stops after two model calls, or two memories ranked. Check again to continue.",
    ranking: `The check stopped before drafting.${o.applied ? "" : " Nothing was applied."} ${rankingFailureLabel(o.reason ?? "")}`,
    other: o.applied
      ? "The check stopped early."
      : "The check stopped early. Nothing was applied.",
  }[o.stop];
  if (stop) parts.push(stop);
  if (!parts.length)
    parts.push(
      o.scanned
        ? "No new suggestion. Nothing new to combine or flag."
        : "No memories are waiting for a check.",
    );
  return parts.join(" ");
}
