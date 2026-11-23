import { uuid7 } from "~/lib/uuid7";

/**
 * Owner-issued, one-time password-reset links for members. The owner makes
 * one on /people and sends it by any channel; the member opens
 * /reset-password/<token> signed out and sets a new password. Only the
 * token's SHA-256 is stored. A newer link for the same member withdraws the
 * older one. ADR-0016, amendment of 2026-10-29 (reset).
 */

export const PASSWORD_RESET_TTL_SECONDS = 60 * 60;

export type PasswordResetState = "open" | "used" | "replaced" | "expired";

export type PasswordResetRecord = {
  resetId: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  state: PasswordResetState;
};

type ResetRow = {
  reset_id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
};

const OPEN = "used_at IS NULL AND revoked_at IS NULL AND expires_at > ?";

/** Members only: the owner signs in with the administrator password. */
const RESETTABLE = `SELECT 1 FROM users
  WHERE user_id = ? AND role = 'member' AND email_verified = 1 AND email IS NOT NULL`;

export async function issuePasswordReset(
  db: D1Database,
  input: { userId: string; createdBy: string },
  now = nowSeconds(),
): Promise<{ token: string; expiresAt: number } | null> {
  const token = randomToken();
  const expiresAt = now + PASSWORD_RESET_TTL_SECONDS;
  const [, inserted] = await db.batch([
    db
      .prepare(
        `UPDATE password_resets SET revoked_at = ?
          WHERE user_id = ? AND ${OPEN} AND EXISTS (${RESETTABLE})`,
      )
      .bind(now, input.userId, now, input.userId),
    db
      .prepare(
        `INSERT INTO password_resets
           (reset_id, user_id, token_hash, created_by, created_at, expires_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (${RESETTABLE})`,
      )
      .bind(
        `pwr_${uuid7()}`,
        input.userId,
        await tokenHash(token),
        input.createdBy,
        now,
        expiresAt,
        input.userId,
      ),
  ]);
  if (inserted.meta.changes !== 1) return null;
  console.log({
    event: "password_reset_issued",
    userId: input.userId,
    by: input.createdBy,
    expiresAt,
  });
  return { token, expiresAt };
}

/** The member an open link is for, or null for an unknown, used, replaced or expired one. */
export async function openPasswordReset(
  db: D1Database,
  token: string,
  now = nowSeconds(),
): Promise<{ userId: string; email: string; expiresAt: number } | null> {
  return db
    .prepare(
      `SELECT r.user_id AS userId, u.email AS email, r.expires_at AS expiresAt
         FROM password_resets r JOIN users u ON u.user_id = r.user_id
        WHERE r.token_hash = ? AND r.used_at IS NULL AND r.revoked_at IS NULL
          AND r.expires_at > ? AND u.role = 'member' AND u.email_verified = 1 AND u.email IS NOT NULL`,
    )
    .bind(await tokenHash(token), now)
    .first();
}

/**
 * Spends the link and sets the password in one batch, and ends every browser
 * session of that member. D1 runs a batch as one transaction, so of two
 * submissions of the same link only the first finds it open.
 */
export async function redeemPasswordReset(
  db: D1Database,
  input: { token: string; passwordHash: string },
  now = nowSeconds(),
): Promise<string | null> {
  const hash = await tokenHash(input.token);
  const target = `(SELECT user_id FROM password_resets WHERE token_hash = ? AND ${OPEN})`;
  const [updated, used, ended] = await db.batch<{ user_id: string }>([
    db
      .prepare(
        `UPDATE users SET password_hash = ?
          WHERE user_id = ${target}
            AND role = 'member' AND email_verified = 1 AND email IS NOT NULL`,
      )
      .bind(input.passwordHash, hash, now),
    db
      .prepare(
        `UPDATE password_resets SET used_at = ?
          WHERE token_hash = ? AND ${OPEN}
            AND (SELECT password_hash FROM users
                  WHERE users.user_id = password_resets.user_id) = ?
          RETURNING user_id`,
      )
      .bind(now, hash, now, input.passwordHash),
    db
      .prepare(
        `DELETE FROM sessions
          WHERE user_id = (SELECT user_id FROM password_resets
                            WHERE token_hash = ? AND used_at = ?)
            AND (SELECT password_hash FROM users
                  WHERE users.user_id = sessions.user_id) = ?`,
      )
      .bind(hash, now, input.passwordHash),
  ]);
  const userId = used.results[0]?.user_id;
  if (updated.meta.changes !== 1 || userId === undefined) return null;
  console.log({
    event: "password_reset_used",
    userId,
    sessionsEnded: ended.meta.changes,
  });
  return userId;
}

/** The newest link per member, for the owner's view on /people. */
export async function latestPasswordResets(
  db: D1Database,
  now = nowSeconds(),
): Promise<PasswordResetRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT reset_id, user_id, created_at, expires_at, used_at, revoked_at
         FROM password_resets ORDER BY created_at DESC, reset_id DESC`,
    )
    .all<ResetRow>();
  const seen = new Set<string>();
  return results.flatMap((row) => {
    if (seen.has(row.user_id)) return [];
    seen.add(row.user_id);
    return [
      {
        resetId: row.reset_id,
        userId: row.user_id,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        usedAt: row.used_at,
        state:
          row.used_at !== null
            ? "used"
            : row.revoked_at !== null
              ? "replaced"
              : row.expires_at <= now
                ? "expired"
                : "open",
      },
    ];
  });
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token.trim()),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
