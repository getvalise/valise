/**
 * The one line that stands for a to-do update or comment wherever the whole
 * thread is too much: list_ready, search, the startup brief, older entries in
 * a default `fetch`, and the console row. Deterministic on purpose: a model
 * call on every write would add latency and a failure path to the write.
 *
 * The author may supply one (`summary` on update_todo and comment_todo).
 * Otherwise it is the whole sentences that open the body's first line and fit
 * in 160 characters, stripped of Markdown; a first sentence longer than that
 * is cut at a word boundary. A progress note usually says what is done first
 * and what remains second, and a cut at the first sentence dropped the saved
 * next step from every list (ADR-0003, amendment of 2026-10-29). Rows written
 * before the column existed get the same cut at read time.
 */

export const SUMMARY_LENGTH = 160;

/** The stored or shown summary: the supplied one, else the body's cut. */
export function updateSummary(
  body: string,
  supplied?: string | null,
): string | null {
  const own = supplied ? clamp(plain(supplied)) : "";
  if (own) return own;
  const cut = summarize(body);
  return cut || null;
}

/** Opening sentences of `body`'s first line, as plain text, at most 160. */
export function summarize(body: string, max = SUMMARY_LENGTH): string {
  const lines = withoutFences(body)
    .split("\n")
    .map((line) => ({
      heading: /^\s{0,3}#{1,6}\s/.test(line),
      text: plain(line),
    }))
    .filter((line) => line.text.length > 0);
  const first = lines[0];
  if (!first) return "";
  // A heading names a section; the line under it says what happened in it.
  const lead =
    first.heading && lines[1] ? `${first.text}: ${lines[1].text}` : first.text;
  return clamp(openingSentences(lead, max), max);
}

/** Cut at a word boundary to at most `max` characters, with an ellipsis. */
export function clamp(text: string, max = SUMMARY_LENGTH): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const room = line.slice(0, max - 1);
  const space = room.lastIndexOf(" ");
  // One word longer than the whole line, a URL usually, is cut inside itself:
  // the alternative is an empty summary.
  const kept = space > 0 ? room.slice(0, space) : room;
  return `${kept.replace(/[\s,;:.–—-]+$/, "")}…`;
}

/**
 * The first sentence, then each following one while the whole stays within
 * `max`. A full stop, question or exclamation mark followed by a space and a
 * capital, digit, or opening quote ends a sentence; `e.g. foo` and `v1.2` do
 * not.
 */
function openingSentences(text: string, max: number): string {
  const ends = /[.!?](?=\s+["'“(]?[A-Z0-9])/g;
  let kept = "";
  for (let end = ends.exec(text); end; end = ends.exec(text)) {
    const upTo = text.slice(0, end.index + 1);
    if (kept && upTo.length > max) return kept;
    kept = upTo;
  }
  return kept && text.length > max ? kept : text;
}

/** Code blocks say how, never what happened, so they are skipped whole. */
function withoutFences(body: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const marker = /^\s*(```|~~~)/.exec(line)?.[1] ?? null;
    if (fence !== null) {
      if (marker === fence) fence = null;
    } else if (marker !== null) {
      fence = marker;
    } else {
      kept.push(line);
    }
  }
  return kept.join("\n");
}

/** One line of Markdown as plain text. */
export function plain(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*>+\s?/, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The shortest piece of a run-on worth refusing. A word run into its
 * neighbours is usually past this; an identifier piece rarely is.
 */
const RUN_ON_LENGTH = 16;

/**
 * The first word in `text` that reads as words and numbers run together with
 * the spaces stripped out, such as `Haikufocused52f812a70D1+4realbackupPASS`,
 * or null when every word is readable. Such a line is useless as a status:
 * nobody can tell what happened from it, and it reaches every list.
 *
 * A word is split at punctuation, so ids, versions, ISO times and file names
 * fall apart into short pieces. A piece is refused when it is at least 16
 * characters, is not a hex hash, switches between letters and digits at least
 * three times, and holds a run of four lowercase letters, which is where the
 * stripped words show. URLs, paths and inline code are never judged. The
 * cases it must pass and refuse are in test/mcp/todo-status.worker.test.ts.
 */
export function runOnWord(text: string): string | null {
  const prose = text.replace(/`[^`\n]*`/g, " ");
  for (const word of prose.split(/\s+/)) {
    if (word.includes("://") || word.includes("/")) continue;
    if (word.split(/[^A-Za-z0-9]+/).some(runsOn)) return word;
  }
  return null;
}

function runsOn(piece: string): boolean {
  if (piece.length < RUN_ON_LENGTH || /^[0-9a-f]+$/i.test(piece)) return false;
  const switches = piece.match(/[A-Za-z](?=\d)|\d(?=[A-Za-z])/g)?.length ?? 0;
  return switches >= 3 && /[a-z]{4}/.test(piece);
}

/**
 * Why the one line an MCP write would store is unreadable, as the error the
 * agent reads, or null. The line is the supplied summary, else the body's
 * opening sentences, the same line `updateSummary` stores.
 */
export function unreadableSummary(
  body: string | null | undefined,
  supplied?: string | null,
): string | null {
  const line = supplied
    ? supplied
    : body
      ? summarize(body.replace(/`[^`\n]*`/g, " "))
      : "";
  const word = runOnWord(line);
  if (word === null) return null;
  const source = supplied ? "summary" : "summary taken from the body";
  return `The ${source} is unreadable: "${word}" runs words and numbers together without spaces. Write it as a plain sentence with spaces between words, for example "Backup restore passed on D1 at 52f812a."`;
}
