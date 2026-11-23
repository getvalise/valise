import { parseGithubSource, parseSkillUrl } from "./skills-github";

/**
 * Skills the Valise maintainers recommend, and why, the same on every
 * install. A file rather than a table: one person curates, a review is the edit history, and a deploy ships it. It
 * moves to a table only if someone else curates; `docs/adr/README.md` holds
 * that as an open question.
 *
 * `source` is what the Add skill dialog opens: a skills.sh `owner/repo/skill`
 * id, or a GitHub folder URL. A GitHub entry is not pinned to a commit, so
 * the preview reads the default branch on the day it is opened.
 */

export type CuratedSkill = {
  source: string;
  /** Markdown, in the maintainers' words. */
  reason: string;
  tags?: string[];
};

// What each skill does, until the maintainers write why they recommend it.
// A member reads these, so they never carry a note to a maintainer.
export const CURATED_SKILLS: CuratedSkill[] = [
  {
    source: "vercel-labs/skills/find-skills",
    reason:
      "Lets an agent search skills.sh itself when it hits a task it has no skill for.",
    tags: ["discovery"],
  },
  {
    source: "mattpocock/skills/grill-me",
    reason:
      "Has the agent question a plan until the gaps show, before any code.",
    tags: ["planning"],
  },
  {
    source: "mattpocock/skills/tdd",
    reason: "A red, green, refactor loop the agent actually follows.",
    tags: ["testing"],
  },
  {
    source:
      "https://github.com/getvalise/valise/tree/HEAD/skills/conversation-history",
    reason:
      "Searches the Claude Code, Codex, OpenCode and ChatGPT conversations stored on this machine.",
    tags: ["history"],
  },
];

/** The short name a suggestion goes by: the last path segment. */
export function curatedName(entry: CuratedSkill): string {
  return entry.source.replace(/\/+$/, "").split("/").at(-1) ?? entry.source;
}

/**
 * Whether a stored `skills.source` is this suggestion. A skills.sh id
 * matches itself; a GitHub folder matches any commit of the same folder.
 */
export function curatedMatches(entry: CuratedSkill, source: string): boolean {
  const target = parseSkillUrl(entry.source);
  if ("errors" in target) return false;
  if (target.kind === "skills.sh") return source === target.id;
  const pinned = parseGithubSource(source);
  return (
    pinned !== null &&
    pinned.owner === target.owner &&
    pinned.repo === target.repo &&
    pinned.path === target.path
  );
}

/** The suggestion an open preview is showing, by skills.sh id or GitHub URL. */
export function curatedFor(opened: string): CuratedSkill | null {
  return CURATED_SKILLS.find((entry) => entry.source === opened) ?? null;
}
