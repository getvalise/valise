import { transcriptTurnPath, transcriptTurnRef } from "./transcript-ref";

/** The console route that opens one item of a kind by `?open=<id>`. P3. */
const ITEM_ROUTES = {
  memory: "/memories",
  todo: "/todos",
  skill: "/skills",
} as const;

/**
 * Where a Valise id opens in the console, or null for anything else. The logs
 * pane links ids with it, and `create_todo` and `fetch` return it as a URL,
 * so a model can hand a person a link instead of a bare id.
 */
export function itemPath(id: string): string | null {
  // A subject has its own page rather than a pane on a list.
  const subject = /^subject:(sub_[\w-]+)$/.exec(id);
  if (subject) return `/memories/subjects/${subject[1]}`;
  // A session opens in Activity's transcripts pane, at a message if named.
  const transcript = transcriptTurnRef(id);
  if (transcript)
    return transcriptTurnPath(transcript.transcriptId, transcript.position);
  const match = /^(memory|todo|skill):[\w-]+$/.exec(id);
  if (!match) return null;
  const route = ITEM_ROUTES[match[1] as keyof typeof ITEM_ROUTES];
  return `${route}?open=${encodeURIComponent(id)}`;
}
