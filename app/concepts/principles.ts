import doc from "../../docs/design/principles.md?raw";

/**
 * `docs/design/principles.md`, read as the workbench's own content. The file
 * is the single copy: the Components tab renders it above the specimens and
 * tags each specimen with the rule it carries, so a primitive and its reason
 * are never two documents that can disagree.
 *
 * Vite inlines the Markdown at build time, so this costs a string in the
 * bundle and no runtime read. `/workbench` is development-only.
 */

export type Status = "held" | "owed" | "mixed";

export type Rule = {
  /** `P7` or `visual` — what a specimen names and what the anchor is. */
  id: string;
  title: string;
  /** The prose, with the status line taken off the end. */
  body: string;
  /** Absent on the visual language, which is a description rather than a debt. */
  status?: Status;
  /** The status line's own words: "Measured at 1280×900: …". */
  verdict?: string;
};

const VISUAL_HEADING = "## The visual language";

/** The opening, above the visual language. */
export const lede = doc.slice(0, doc.indexOf(VISUAL_HEADING)).trim();

/**
 * The visual language first, then the twelve, then the collected rejections
 * and the reading list — the whole file, in the order it has them.
 */
export const rules: Rule[] = [
  readVisual(doc),
  ...readPrinciples(doc),
  ...readCoda(doc),
];

/** `P7` → "The affordance has the shape of the data". Unknown ids read null. */
export function titleOf(id: string): string | null {
  return rules.find((rule) => rule.id === id)?.title ?? null;
}

function readVisual(text: string): Rule {
  const start = text.indexOf(VISUAL_HEADING) + VISUAL_HEADING.length;
  return {
    id: "visual",
    title: "The visual language",
    body: text.slice(start, nextSectionAfter(text, start)).trim(),
  };
}

/**
 * Everything after the last principle: "What this rejects" and "Sources".
 * They are sections rather than rules, so they carry no status pill, and
 * their ids are slugs rather than numbers.
 */
function readCoda(text: string): Rule[] {
  const last = [...text.matchAll(/^## P\d+\. /gm)].at(-1);
  if (last === undefined) return [];
  const from = nextSectionAfter(text, (last.index ?? 0) + last[0].length);
  return [...text.slice(from).matchAll(/^## (.+)$/gm)].map(
    (head, index, all) => {
      const start = (head.index ?? 0) + head[0].length;
      const end = all[index + 1]?.index ?? text.length - from;
      return {
        id: slug(head[1]),
        title: head[1],
        body: text.slice(from + start, from + end).trim(),
      };
    },
  );
}

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function readPrinciples(text: string): Rule[] {
  const out: Rule[] = [];
  // Each `## P<n>. <title>` runs to the next one, and the last runs to the
  // collected "What this rejects", which is a section and not a principle.
  const heads = [...text.matchAll(/^## (P\d+)\. (.+)$/gm)];
  for (const [index, head] of heads.entries()) {
    const start = (head.index ?? 0) + head[0].length;
    const next = heads[index + 1]?.index ?? nextSectionAfter(text, start);
    const { body, verdict, status } = splitVerdict(text.slice(start, next));
    out.push({ id: head[1], title: head[2], body, status, verdict });
  }
  return out;
}

function nextSectionAfter(text: string, from: number): number {
  const at = text.slice(from).search(/^## /m);
  return at < 0 ? text.length : from + at;
}

/**
 * The closing paragraph states the status. It is pulled out of the body so
 * the summary can carry a pill and the prose is not read twice.
 */
function splitVerdict(section: string): {
  body: string;
  verdict: string;
  status: Status;
} {
  const paragraphs = section.trim().split("\n\n");
  const last = paragraphs.at(-1) ?? "";
  const held = last.startsWith("**Held");
  const owed = last.startsWith("**Owed");
  if (!held && !owed)
    return { body: section.trim(), verdict: "", status: "owed" };
  const bothNamed = last.includes("**Held") && last.includes("**Owed");
  return {
    body: paragraphs.slice(0, -1).join("\n\n"),
    verdict: last,
    status: bothNamed ? "mixed" : held ? "held" : "owed",
  };
}
