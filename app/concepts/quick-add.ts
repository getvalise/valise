import {
  type FacetCount,
  parseFacet,
  routeReservedTags,
} from "~/concepts/facets";

/**
 * The composer's one-line grammar. A word that parses as a facet
 * (`priority:1`, `area:search`) is a tag, `#duckdb` is a bare tag, and every
 * other word is the title. `project:` routes to the column, the way it does
 * on `create_todo`. ADR-0009.
 *
 * `@valise` is the short form of `project:valise`, the sigil Superlist and
 * Todoist readers reach for first; it routes to the column the same way, and
 * a word that only contains an `@`, such as an address, stays in the title.
 *
 * Bare tags take a `#` because a bare word in a title is a title word: without
 * a sigil "Fix search ranking" would file a `search` tag. Facets need none,
 * because the facet rule already refuses ordinary prose (`TODO:fix`, `note:`).
 * This runs on the server, so the grammar holds with scripting off; the
 * suggestion list below is the enhancement on top.
 */
export type QuickAdd = {
  title: string;
  project: string | null;
  tags: string[];
};

/**
 * `@` then a project name that starts and ends on a letter or digit, so a
 * sentence's closing `@valise.` does not file the project `valise.`.
 */
const AT_PROJECT = /^@([a-z0-9](?:[a-z0-9._-]*[a-z0-9_])?)$/i;

const MAX_TITLE = 500;
const MAX_TAG = 100;
const MAX_TAGS = 20;

export function parseQuickAdd(
  text: string,
  /** The project filter in view, used when the line names none. */
  defaultProject?: string,
): QuickAdd | { error: string } {
  const title: string[] = [];
  const tags: string[] = [];
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    const at = AT_PROJECT.exec(word);
    if (at) {
      const tag = `project:${at[1]}`;
      if (!tags.includes(tag)) tags.push(tag);
      continue;
    }
    const tag = word.startsWith("#") ? word.slice(1) : word;
    if ((word.startsWith("#") && tag !== "") || parseFacet(word)) {
      if (!tags.includes(tag)) tags.push(tag);
    } else {
      title.push(word);
    }
  }

  // The column is empty here on purpose: what the line says beats the filter.
  const routed = routeReservedTags(tags, { project: undefined });
  if ("error" in routed) return routed;

  const joined = title.join(" ");
  if (joined === "") {
    return { error: "Give the to-do a title as well as its tags." };
  }
  if (joined.length > MAX_TITLE) {
    return { error: `Keep the title under ${MAX_TITLE} characters.` };
  }
  if (routed.tags.length > MAX_TAGS) {
    return { error: `A to-do takes at most ${MAX_TAGS} tags.` };
  }
  const long = routed.tags.find((one) => one.length > MAX_TAG);
  if (long) return { error: `Tag "${long}" is over ${MAX_TAG} characters.` };

  return {
    title: joined,
    project: routed.routed.project ?? defaultProject ?? null,
    tags: routed.tags,
  };
}

export type QuickAddVocabulary = {
  tags: readonly string[];
  projects: readonly string[];
  facets: readonly FacetCount[];
};

export type Suggestion = {
  /** What replaces the word at the caret. */
  insert: string;
  hint?: string;
};

const LIMIT = 8;
const KEY = /^([a-z][a-z0-9_-]*):(.*)$/;

/**
 * What to offer for the word under the caret, from the store's own
 * vocabulary. `#du` offers tags, `@va` projects, `priority:` the values
 * written under that key with their counts, and a bare word both the keys
 * and the tags it starts. The counts are the drift: `priority:1 (12)` beside
 * `priority:high (1)`.
 */
export function suggestQuickAdd(
  word: string,
  vocabulary: QuickAddVocabulary,
): Suggestion[] {
  const bareTags = vocabulary.tags.filter((tag) => parseFacet(tag) === null);

  if (word.startsWith("@")) {
    const needle = word.slice(1).toLowerCase();
    return vocabulary.projects
      .filter((project) => project.toLowerCase().startsWith(needle))
      .slice(0, LIMIT)
      .map((project) => ({ insert: `@${project} ` }));
  }

  if (word.startsWith("#")) {
    const needle = word.slice(1).toLowerCase();
    return bareTags
      .filter((tag) => tag.toLowerCase().startsWith(needle))
      .slice(0, LIMIT)
      .map((tag) => ({ insert: `#${tag} ` }));
  }

  const keyed = KEY.exec(word);
  if (keyed) {
    const [, key, partial] = keyed;
    const values: Suggestion[] =
      key === "project"
        ? vocabulary.projects.map((project) => ({
            insert: `project:${project} `,
          }))
        : vocabulary.facets
            .filter((facet) => facet.key === key)
            .map((facet) => ({
              insert: `${facet.tag} `,
              hint: count(facet.count, "to-do"),
            }));
    const needle = `${key}:${partial.toLowerCase()}`;
    return values
      .filter((one) => one.insert.toLowerCase().startsWith(needle))
      .slice(0, LIMIT);
  }

  // One letter is every key and half the tags; two is a word being written.
  if (!/^[a-z]/i.test(word) || word.length < 2) return [];
  const needle = word.toLowerCase();
  const keys = new Map<string, number>();
  for (const facet of vocabulary.facets) {
    keys.set(facet.key, (keys.get(facet.key) ?? 0) + 1);
  }
  if (vocabulary.projects.length > 0) {
    keys.set("project", vocabulary.projects.length);
  }
  const keyOptions = [...keys]
    .filter(([key]) => key.startsWith(needle))
    .map(([key, values]) => ({
      insert: `${key}:`,
      hint: count(values, "value"),
    }));
  const tagOptions = bareTags
    .filter((tag) => tag.toLowerCase().startsWith(needle))
    .map((tag) => ({ insert: `#${tag} ` }));
  return [...keyOptions, ...tagOptions].slice(0, LIMIT);
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
