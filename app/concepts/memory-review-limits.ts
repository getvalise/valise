import { z } from "zod";

/** Memories a person may have checked a day, by hand and by the nightly run. */
export const MAX_MANUAL_MEMORIES = 100;
export const MAX_UPKEEP_MEMORIES = 200;
/** Ranking spends an embedding and a Jev request on each memory it checks. */
export const RANKING_REQUESTS_PER_MEMORY = 2;

/**
 * The daily money caps on memory review and candidate ranking (ADR-0012,
 * 2026-11-04 limits). A person sets how many memories get checked; an admin
 * sets what a day may cost, per account, on /workbench. No row in
 * `memory_review_cost_caps` means these operator defaults.
 *
 * At Haiku's largest reservation, $0.003168 a call, $0.50 covers the default
 * 75 checks a day (25 by hand, 50 at night) with room to spare. A Jev request
 * reserves at most $0.001008 and an embedding far less, so $0.20 covers the
 * 150 ranking requests those checks can use.
 */
export const DEFAULT_REVIEW_MICROUSD = 500_000;
export const DEFAULT_RANKING_MICROUSD = 200_000;
/** What an admin may set: $0.001 to $5.00 a day. */
export const CAP_MIN_MICROUSD = 1_000;
export const CAP_MAX_MICROUSD = 5_000_000;

const capSchema = z.number().int().min(CAP_MIN_MICROUSD).max(CAP_MAX_MICROUSD);

/** Dollars as typed, to whole micro-dollars, or null when it is not a cap an admin may set. */
export function parseCapUsd(value: string): number | null {
  const text = value.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const microusd = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"));
  return capSchema.safeParse(microusd).success ? microusd : null;
}

export type ReviewCaps = {
  reviewMicrousd: number;
  rankingMicrousd: number;
  /** The admin who set them, or null for the operator defaults. */
  setBy: string | null;
};

/** The effective review cap, as SQL, for the account the expression names. */
export const reviewCapSql = (userId: string) =>
  `COALESCE((SELECT review_microusd FROM memory_review_cost_caps cap WHERE cap.user_id = ${userId}), ${DEFAULT_REVIEW_MICROUSD})`;
/** The effective ranking cap, as SQL, for the account the expression names. */
export const rankingCapSql = (userId: string) =>
  `COALESCE((SELECT ranking_microusd FROM memory_review_cost_caps cap WHERE cap.user_id = ${userId}), ${DEFAULT_RANKING_MICROUSD})`;

export async function readReviewCaps(
  db: D1Database,
  userId: string,
): Promise<ReviewCaps> {
  const row = await db
    .prepare(
      "SELECT review_microusd, ranking_microusd, set_by FROM memory_review_cost_caps WHERE user_id = ?",
    )
    .bind(userId)
    .first<{
      review_microusd: number;
      ranking_microusd: number;
      set_by: string;
    }>();
  return row
    ? {
        reviewMicrousd: row.review_microusd,
        rankingMicrousd: row.ranking_microusd,
        setBy: row.set_by,
      }
    : {
        reviewMicrousd: DEFAULT_REVIEW_MICROUSD,
        rankingMicrousd: DEFAULT_RANKING_MICROUSD,
        setBy: null,
      };
}

/**
 * Set one account's caps. Admin-only: the only caller is the workbench action
 * behind `requireConsoleAdmin`. Setting both to the defaults removes the row,
 * so a later change of default reaches the account.
 */
export async function writeReviewCaps(
  db: D1Database,
  userId: string,
  caps: { reviewMicrousd: number; rankingMicrousd: number },
  setBy: string,
): Promise<void> {
  const review = capSchema.parse(caps.reviewMicrousd);
  const ranking = capSchema.parse(caps.rankingMicrousd);
  if (
    review === DEFAULT_REVIEW_MICROUSD &&
    ranking === DEFAULT_RANKING_MICROUSD
  ) {
    await db
      .prepare("DELETE FROM memory_review_cost_caps WHERE user_id = ?")
      .bind(userId)
      .run();
    return;
  }
  await db
    .prepare(`INSERT INTO memory_review_cost_caps(user_id, review_microusd, ranking_microusd, set_by, updated_at)
    VALUES (?, ?, ?, ?, unixepoch()) ON CONFLICT(user_id) DO UPDATE SET
    review_microusd = excluded.review_microusd, ranking_microusd = excluded.ranking_microusd,
    set_by = excluded.set_by, updated_at = excluded.updated_at`)
    .bind(userId, review, ranking, setBy)
    .run();
}

export type AccountReviewCost = ReviewCaps & {
  userId: string;
  email: string | null;
  displayName: string | null;
  /** Reserved today, review and ranking, in micro-USD. */
  reviewSpent: number;
  rankingSpent: number;
};

/** Every account with its caps and today's reservations, for the workbench. */
export async function listReviewCosts(
  db: D1Database,
): Promise<AccountReviewCost[]> {
  const { results } = await db
    .prepare(`SELECT u.user_id, u.email, u.display_name,
      cap.review_microusd, cap.ranking_microusd, cap.set_by,
      COALESCE(b.reserved_microusd, 0) AS review_spent,
      COALESCE(r.reserved_microusd, 0) AS ranking_spent
    FROM users u
    LEFT JOIN memory_review_cost_caps cap ON cap.user_id = u.user_id
    LEFT JOIN memory_review_budgets b ON b.user_id = u.user_id AND b.day = CAST(unixepoch() / 86400 AS INTEGER)
    LEFT JOIN memory_review_ranking_budgets r ON r.user_id = u.user_id AND r.day = CAST(unixepoch() / 86400 AS INTEGER)
    ORDER BY u.created_at, u.user_id LIMIT 200`)
    .all<{
      user_id: string;
      email: string | null;
      display_name: string | null;
      review_microusd: number | null;
      ranking_microusd: number | null;
      set_by: string | null;
      review_spent: number;
      ranking_spent: number;
    }>();
  return results.map((row) => ({
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    reviewMicrousd: row.review_microusd ?? DEFAULT_REVIEW_MICROUSD,
    rankingMicrousd: row.ranking_microusd ?? DEFAULT_RANKING_MICROUSD,
    setBy: row.set_by,
    reviewSpent: row.review_spent,
    rankingSpent: row.ranking_spent,
  }));
}
