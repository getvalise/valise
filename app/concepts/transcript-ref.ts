/**
 * References to a session or one message in it, shared by the server (fetch)
 * and the console (links), with nothing else imported so the browser bundle
 * stays small.
 */

/**
 * Turns per page of the console's transcript pane. A message's link names
 * the page it is on, so the link and the pane agree on this number.
 */
export const TRANSCRIPT_PAGE_TURNS = 400;

/**
 * One message, or a whole session: `transcript:<id>`,
 * `transcript:<id>#t-<position>`, or the console link the pane copies,
 * `…/activity/transcripts?open=transcript:<id>&turns=<page>#t-<position>`.
 */
export function transcriptTurnRef(
  id: string,
): { transcriptId: string; position: number | null } | null {
  let ref = id.trim();
  if (/^https?:\/\//.test(ref)) {
    let url: URL;
    try {
      url = new URL(ref);
    } catch {
      return null;
    }
    const open = url.searchParams.get("open");
    if (!url.pathname.endsWith("/activity/transcripts") || !open) return null;
    ref = `${open}${url.hash}`;
  }
  const match = /^transcript:(trn_[\w-]+)(?:#t-(\d+))?$/.exec(ref);
  if (!match) return null;
  return {
    transcriptId: match[1],
    position: match[2] === undefined ? null : Number(match[2]),
  };
}

/** The pane's address for one message, on the page that holds it. */
export function transcriptTurnPath(
  transcriptId: string,
  position: number | null,
): string {
  const params = new URLSearchParams({ open: `transcript:${transcriptId}` });
  if (position === null) return `/activity/transcripts?${params}`;
  const page = Math.floor(position / TRANSCRIPT_PAGE_TURNS);
  if (page) params.set("turns", String(page));
  return `/activity/transcripts?${params}#t-${position}`;
}
