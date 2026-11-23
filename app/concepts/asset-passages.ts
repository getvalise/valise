/**
 * Passages of one immutable extraction output. They hold offsets into that
 * output's text, not copies of it, so a 1 MiB book costs one text column and a
 * small index. Offsets count Unicode code points, which is what SQLite's
 * `substr()` counts, so the projection can cut a passage inside D1.
 */

export type PassageKind = "page" | "slide" | "chapter";

export type Passage = {
  /** 0-based code point offset into the output text. */
  start: number;
  /** Length in code points. */
  length: number;
  /** "p. 12", "pp. 12–13", "slide 4", "ch. 3: Title", or null before the first marker. */
  label: string | null;
  /** First and last page or slide number, when the format has them. */
  first: number | null;
  last: number | null;
};

export type PassageIndex = {
  version: 1;
  kind: PassageKind | null;
  /** The document's own author metadata, when the format carries it. */
  author: string | null;
  passages: Passage[];
};

/** About 1k tokens: one printed page, or two short ones. */
export const PASSAGE_TARGET_CHARS = 4000;
export const MAX_PASSAGES = 2000;

/** Our archive extractors write `§ slide 3` / `§ chapter 2: Title`; PDF conversion writes `### Page 3`. */
const MARKER =
  /^(?:#{2,3} Page (\d+)|§ (slide|chapter) (\d+)(?:: (.{0,200}))?)[ \t]*$/gm;

type Segment = {
  start: number;
  end: number;
  kind: PassageKind | null;
  number: number | null;
  title: string | null;
  /** A page whose own text carries its printed number, e.g. "212" as its last line. */
  printed: boolean;
};

export function passageIndex(text: string): PassageIndex {
  const segments: Segment[] = [];
  let kind: PassageKind | null = null;
  let cursor = 0;
  let current: Omit<Segment, "start" | "end"> = {
    kind: null,
    number: null,
    title: null,
    printed: false,
  };
  for (const match of text.matchAll(MARKER)) {
    const index = match.index ?? 0;
    if (index > cursor)
      segments.push({ ...current, start: cursor, end: index });
    const markerKind: PassageKind = match[1]
      ? "page"
      : (match[2] as PassageKind);
    kind ??= markerKind;
    current = {
      kind: markerKind,
      number: Number(match[1] ?? match[3]),
      title: match[4]?.trim() || null,
      printed: false,
    };
    cursor = index;
  }
  if (cursor < text.length)
    segments.push({ ...current, start: cursor, end: text.length });
  printedPages(segments, text);

  const pieces = segments.flatMap((segment) => splitSegment(text, segment));
  const packed: { start: number; end: number; from: Segment; to: Segment }[] =
    [];
  for (const piece of pieces) {
    const last = packed.at(-1);
    // Pages pack together when short; chapters and slides never merge, since
    // their label names one of them.
    if (
      last &&
      piece.segment.kind === "page" &&
      last.to.kind === "page" &&
      // Never one label across file positions and printed numbers.
      last.to.printed === piece.segment.printed &&
      last.end === piece.start &&
      piece.end - last.start <= PASSAGE_TARGET_CHARS
    ) {
      last.end = piece.end;
      last.to = piece.segment;
      continue;
    }
    packed.push({
      start: piece.start,
      end: piece.end,
      from: piece.segment,
      to: piece.segment,
    });
  }
  const meaningful = packed
    .filter((p) => text.slice(p.start, p.end).trim().length > 0)
    .slice(0, MAX_PASSAGES);
  const points = codePointOffsets(
    text,
    meaningful.flatMap((p) => [p.start, p.end]),
  );
  return {
    version: 1,
    kind,
    author: documentAuthor(text),
    passages: meaningful.map((p, i) => ({
      start: points[2 * i],
      length: points[2 * i + 1] - points[2 * i],
      label: label(p.from, p.to),
      first: p.from.number,
      last: p.to.number,
    })),
  };
}

/**
 * PDF conversion numbers pages by position in the file, which is not the
 * number printed on a book's page once front matter is counted. The printed
 * number sits at the start or end of a page's text, often glued to the first
 * word ("48meaning"). Any one page is ambiguous, since text can start with a
 * year, so the pages vote: the offset between file position and a candidate
 * number that most pages agree on wins, and only pages that carry the
 * number at that offset are relabelled.
 */
function printedPages(segments: Segment[], text: string) {
  const pages = segments.filter(
    (segment) => segment.kind === "page" && segment.number !== null,
  );
  const candidates = pages.map((segment) => {
    const body = text
      .slice(segment.start, segment.end)
      .replace(/^[^\n]*\n/, "")
      .trim();
    const found = new Set<number>();
    const leading = body.match(/^\d{1,4}/)?.[0] ?? "";
    for (let i = 1; i <= leading.length; i++)
      found.add(Number(leading.slice(0, i)));
    const trailing = body.match(/\d{1,4}$/)?.[0] ?? "";
    for (let i = 0; i < trailing.length; i++)
      found.add(Number(trailing.slice(i)));
    found.delete(0);
    return found;
  });
  const votes = new Map<number, number>();
  pages.forEach((segment, i) => {
    for (const number of candidates[i]) {
      const offset = (segment.number ?? 0) - number;
      votes.set(offset, (votes.get(offset) ?? 0) + 1);
    }
  });
  let best: [number, number] | null = null;
  for (const entry of votes) if (!best || entry[1] > best[1]) best = entry;
  if (!best || best[1] < Math.max(3, pages.length / 2)) return;
  const [offset] = best;
  pages.forEach((segment, i) => {
    const printed = (segment.number ?? 0) - offset;
    if (candidates[i].has(printed)) {
      segment.number = printed;
      segment.printed = true;
    }
  });
}

function label(from: Segment, to: Segment): string | null {
  if (from.kind === null || from.number === null) return null;
  if (from.kind === "page") {
    // Printed numbers when both ends have them; the file position otherwise.
    const prefix = from.printed && to.printed ? "" : "PDF ";
    return from.number === to.number
      ? `${prefix}p. ${from.number}`
      : `${prefix}pp. ${from.number}–${to.number}`;
  }
  if (from.kind === "slide") return `slide ${from.number}`;
  return from.title
    ? `ch. ${from.number}: ${from.title}`
    : `ch. ${from.number}`;
}

/** Cut on paragraph, then line, then sentence boundaries, never mid-word when avoidable. */
function splitSegment(
  text: string,
  segment: Segment,
): { start: number; end: number; segment: Segment }[] {
  const out: { start: number; end: number; segment: Segment }[] = [];
  let start = segment.start;
  while (segment.end - start > PASSAGE_TARGET_CHARS) {
    const window = text.slice(start, start + PASSAGE_TARGET_CHARS);
    const floor = PASSAGE_TARGET_CHARS / 2;
    let cut = -1;
    for (const boundary of ["\n\n", "\n", ". ", " "]) {
      const at = window.lastIndexOf(boundary);
      if (at >= floor) {
        cut = at + boundary.length;
        break;
      }
    }
    if (cut < 0) cut = PASSAGE_TARGET_CHARS;
    // Never split a surrogate pair.
    const code = text.charCodeAt(start + cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
    out.push({ start, end: start + cut, segment });
    start += cut;
  }
  out.push({ start, end: segment.end, segment });
  return out;
}

/** Ascending UTF-16 indices to code point offsets, in one pass. */
function codePointOffsets(text: string, indices: number[]): number[] {
  const order = indices
    .map((index, i) => [index, i] as const)
    .sort((a, b) => a[0] - b[0]);
  const result = new Array<number>(indices.length);
  let unit = 0;
  let point = 0;
  for (const [index, i] of order) {
    while (unit < index) {
      const code = text.charCodeAt(unit);
      unit +=
        code >= 0xd800 && code <= 0xdbff && unit + 1 < text.length ? 2 : 1;
      point++;
    }
    result[i] = point;
  }
  return result;
}

/** PDF conversion lists `- Author=…` under its metadata; EPUB extraction writes `§ author: …`. */
function documentAuthor(text: string): string | null {
  const head = text.slice(0, 4000);
  const match =
    head.match(/^- Author=(.+)$/m) ?? head.match(/^§ author: (.+)$/m);
  const author = match?.[1].trim();
  return author ? author.slice(0, 200) : null;
}

/** "Vaclav Smil, Energy and Civilization, p. 212": what an agent pastes. */
export function passageCitation(
  author: string | null,
  title: string,
  locator: string | null,
): string {
  return [author, title, locator].filter(Boolean).join(", ");
}

/** The text of each passage, cutting code point offsets in one pass. */
export function passageTexts(text: string, passages: Passage[]): string[] {
  const units = new Map<number, number>();
  for (const p of passages) {
    units.set(p.start, 0);
    units.set(p.start + p.length, 0);
  }
  const wanted = [...units.keys()].sort((a, b) => a - b);
  let unit = 0;
  let point = 0;
  for (const target of wanted) {
    while (point < target && unit < text.length) {
      const code = text.charCodeAt(unit);
      unit +=
        code >= 0xd800 && code <= 0xdbff && unit + 1 < text.length ? 2 : 1;
      point++;
    }
    units.set(target, unit);
  }
  return passages.map((p) =>
    text.slice(units.get(p.start), units.get(p.start + p.length)),
  );
}

/** A stored index, or null for outputs from before passages or a damaged row. */
export function parsePassageIndex(json: string | null | undefined) {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as PassageIndex;
    return Array.isArray(parsed?.passages) ? parsed : null;
  } catch {
    return null;
  }
}
