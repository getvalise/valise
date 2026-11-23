import type { Concept } from "~/db/schema";

/**
 * Key-value facets are tags with a colon in them, per ADR-0009. There is no
 * facets table: `tags_json` holds `priority:1` like any other tag, and this
 * module is the one place that reads the convention back out of it.
 */

export type Facet = { key: string; value: string };

/**
 * A lowercase key, then a colon, then a value that is not a URL's `//`.
 * `TODO:fix` and a pasted `https://…` stay plain tags; without this the
 * vocabulary fills with keys nobody meant.
 */
const FACET = /^([a-z][a-z0-9_-]*):(?!\/\/)(\S.*)$/;

export function parseFacet(tag: string): Facet | null {
  const match = FACET.exec(tag.trim());
  if (!match) return null;
  // Split on the first colon only, so `url:https://x` keeps its value whole.
  return { key: match[1], value: match[2].trim() };
}

/**
 * Keys that already have a column. They are written to that column and never
 * stored as tags, so a value cannot live in two places that disagree.
 */
export const RESERVED_KEYS = ["project", "type", "state"] as const;
export type ReservedKey = (typeof RESERVED_KEYS)[number];

function isReserved(key: string): key is ReservedKey {
  return (RESERVED_KEYS as readonly string[]).includes(key);
}

export type RoutedTags<K extends ReservedKey> = {
  tags: string[];
  routed: Partial<Record<K, string>>;
};

/**
 * Pull reserved facets out of a tag list. `columns` is what this write or
 * filter can route to, with the value the caller already passed for each. A
 * reserved key with nowhere to go, or one that contradicts its explicit
 * argument, is an error rather than a tag: falling back to a tag is how the
 * two-sources-of-truth case gets in anyway.
 */
export function routeReservedTags<K extends ReservedKey>(
  tags: readonly string[],
  columns: Partial<Record<K, string | undefined>>,
): RoutedTags<K> | { error: string } {
  const kept: string[] = [];
  const routed: Partial<Record<K, string>> = {};
  for (const tag of tags) {
    const facet = parseFacet(tag);
    if (!facet || !isReserved(facet.key)) {
      kept.push(tag);
      continue;
    }
    const key = facet.key as K;
    if (!(key in columns)) {
      return {
        error: `${facet.key}: is reserved and has no column here; drop the tag "${tag}".`,
      };
    }
    const given = columns[key] ?? routed[key];
    if (given !== undefined && given !== facet.value) {
      return {
        error: `tag "${tag}" contradicts ${facet.key} "${given}"; pass one ${facet.key}.`,
      };
    }
    routed[key] = facet.value;
  }
  return { tags: kept, routed };
}

export type FacetCount = Facet & { tag: string; count: number };

/** The live rows of each concept; json_each runs over their tags. */
const FACET_SOURCES: Record<Concept, string> = {
  memory:
    "memories AS c, json_each(c.tags_json) WHERE c.user_id = ? AND c.deleted_at IS NULL",
  skill:
    "skills AS c, json_each(c.tags_json) WHERE c.user_id = ? AND c.deleted_at IS NULL",
  todo: "todos AS c, json_each(c.tags_json) WHERE c.user_id = ?",
};

/**
 * Every facet one concept's rows carry, with how many rows carry it. The
 * vocabulary as written, drift included: `priority:1 (12)` next to
 * `priority:high (1)` is what shows someone the fork before they widen it.
 * A scan over `json_each`, which ADR-0009 accepts until it shows up slow.
 */
export async function listFacets(
  db: D1Database,
  userId: string,
  concept: Concept,
): Promise<FacetCount[]> {
  const { results } = await db
    .prepare(
      `SELECT value AS tag, COUNT(*) AS count
         FROM ${FACET_SOURCES[concept]}
          AND instr(value, ':') > 1
        GROUP BY value
        ORDER BY value`,
    )
    .bind(userId)
    .all<{ tag: string; count: number }>();
  return results.flatMap(({ tag, count }) => {
    const facet = parseFacet(tag);
    return facet ? [{ ...facet, tag, count }] : [];
  });
}
