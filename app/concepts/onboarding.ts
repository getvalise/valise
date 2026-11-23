import { CURATED_SKILLS, curatedMatches, curatedName } from "./curated-skills";

/**
 * The first-run checklist: connect a client, add a first skill, and three
 * starter skills to preview. Each step is ticked by something the store can
 * see, never by the person saying so, and nothing is installed for them.
 *
 * `connected` is a recorded MCP call from any client. An OAuth grant or a
 * token with no call yet does not count: until a client calls, nothing proves
 * it reached the server, so the step says it ticks on the first call.
 *
 * `firstSkill` is a live skill the person added. Built-ins (`builtin:` source)
 * are published for every account and are not theirs.
 */

/** Three starters, in the order offered. Each is a curated suggestion. */
export const STARTER_SOURCES = [
  "mattpocock/skills/grill-me",
  "https://github.com/getvalise/valise/tree/HEAD/skills/conversation-history",
  "mattpocock/skills/tdd",
] as const;

export type Onboarding = {
  /** Unix seconds; null while the checklist is showing. */
  dismissedAt: number | null;
  connected: boolean;
  firstSkill: boolean;
  starters: { source: string; name: string; reason: string; added: boolean }[];
  /** Every step done: the checklist has nothing left to say. */
  complete: boolean;
};

export async function readOnboarding(
  data: D1Database,
  control: D1Database,
  userId: string,
): Promise<Onboarding> {
  const [user, called, skills] = await Promise.all([
    control
      .prepare("SELECT onboarding_dismissed_at FROM users WHERE user_id = ?")
      .bind(userId)
      .first<{ onboarding_dismissed_at: number | null }>(),
    data
      .prepare("SELECT 1 AS one FROM mcp_calls WHERE user_id = ? LIMIT 1")
      .bind(userId)
      .first<{ one: number }>(),
    data
      .prepare(
        `SELECT source FROM skills
          WHERE user_id = ? AND deleted_at IS NULL
            AND (source IS NULL OR source NOT LIKE 'builtin:%')`,
      )
      .bind(userId)
      .all<{ source: string | null }>(),
  ]);
  const sources = skills.results
    .map((row) => row.source)
    .filter((source): source is string => source !== null);
  const starters = STARTER_SOURCES.map((source) => {
    const entry = CURATED_SKILLS.find((one) => one.source === source);
    if (entry === undefined)
      throw new Error(`Starter skill ${source} is not a curated suggestion.`);
    return {
      source,
      name: curatedName(entry),
      reason: entry.reason,
      added: sources.some((one) => curatedMatches(entry, one)),
    };
  });
  const connected = called !== null;
  const firstSkill = skills.results.length > 0;
  return {
    dismissedAt: user?.onboarding_dismissed_at ?? null,
    connected,
    firstSkill,
    starters,
    complete: connected && firstSkill,
  };
}

/** Hide the checklist for this account on every browser, or bring it back. */
export async function setOnboardingDismissed(
  control: D1Database,
  userId: string,
  dismissed: boolean,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  await control
    .prepare("UPDATE users SET onboarding_dismissed_at = ? WHERE user_id = ?")
    .bind(dismissed ? now : null, userId)
    .run();
}
