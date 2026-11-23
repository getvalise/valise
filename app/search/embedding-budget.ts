/**
 * Per-owner daily embedding metering and, once configured, its budget.
 *
 * Every provider embedding call reserves its input bytes before it is made:
 * memory, asset-passage and bookmark-passage deliveries in the minute drains,
 * and search-time query embeddings. The day is `date('now')`, so the window resets at 00:00 UTC.
 * Failed attempts and retries count, because the provider charges for them;
 * deletes and errors before the provider call cost nothing.
 *
 * `VALISE_EMBEDDING_DAILY_BYTES` unset or invalid meters without refusing.
 * Set, a reservation is refused once the owner's day total has reached it, so
 * one call can overshoot by at most its own input (8 KiB per asset passage,
 * 16 KiB per memory body). ADR-0017, 2026-11-01.
 */

import { PRICES, spendStatement } from "~/concepts/spend";

export type EmbeddingKind = "memory" | "asset" | "source" | "query";

export type EmbeddingBudgetEnv = { VALISE_EMBEDDING_DAILY_BYTES?: string };

/** The error code a drain stamps on a job it moved to the next UTC day. */
export const DAILY_BUDGET_ERROR = "daily_budget";

/** Seconds since the epoch at the next 00:00 UTC, evaluated by D1. */
export const NEXT_UTC_DAY_SQL = "unixepoch(date('now', '+1 day'))";

export function embeddingDailyBudget(env: EmbeddingBudgetEnv): number | null {
  const bytes = Number(env.VALISE_EMBEDDING_DAILY_BYTES);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Atomically checks the owner's UTC-day total and records the call. Returns
 * false, recording nothing, when a configured budget is already spent.
 */
export async function reserveEmbedding(
  env: { DB: D1Database } & EmbeddingBudgetEnv,
  userId: string,
  kind: EmbeddingKind,
  bytes: number,
): Promise<boolean> {
  const budget = embeddingDailyBudget(env);
  const reservation = env.DB.prepare(`INSERT INTO embedding_usage_daily
      (user_id, day, kind, calls, failures, input_bytes)
    SELECT ?, date('now'), ?, 1, 0, ?
    WHERE ? IS NULL OR COALESCE((SELECT SUM(input_bytes) FROM embedding_usage_daily
      WHERE user_id = ? AND day = date('now')), 0) < ?
    ON CONFLICT(user_id, day, kind) DO UPDATE SET calls = calls + 1,
      input_bytes = input_bytes + excluded.input_bytes
    RETURNING calls`).bind(userId, kind, bytes, budget, userId, budget);
  // A refused reservation is never sent, so it records no spend either.
  const [granted] = await env.DB.batch<{ calls: number }>([
    reservation,
    spendStatement(
      env.DB,
      userId,
      "embedding",
      { units: bytes, microusd: bytes * PRICES.embedding.microusdPerUnit },
      { afterWrite: true },
    ),
  ]);
  return granted.results.length > 0;
}

/** A reserved call that threw. Never throws itself: metering must not mask the failure. */
export async function recordEmbeddingFailure(
  db: D1Database,
  userId: string,
  kind: EmbeddingKind,
): Promise<void> {
  try {
    await db
      .prepare(`UPDATE embedding_usage_daily SET failures = failures + 1
        WHERE user_id = ? AND day = date('now') AND kind = ?`)
      .bind(userId, kind)
      .run();
  } catch (error) {
    console.error("embedding failure metering failed", error);
  }
}

/** Kept for a quarter, then trimmed by the nightly cron. */
export const EMBEDDING_USAGE_RETENTION_DAYS = 90;

export function trimEmbeddingUsageStatement(db: D1Database) {
  return db
    .prepare("DELETE FROM embedding_usage_daily WHERE day < date('now', ?)")
    .bind(`-${EMBEDDING_USAGE_RETENTION_DAYS} days`);
}
