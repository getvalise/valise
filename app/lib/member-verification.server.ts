import { getUser, type UserRecord } from "~/concepts/users";
import { verifyPassword } from "~/lib/password.server";

/** Both mailbox possession and the original password are required to activate.
 * A link alone must not activate a password an attacker chose for this email.
 * Legacy tokens without an expiry deliberately fail closed. Keep password
 * verification out of the shared account module used by client-side labels.
 */
export async function verifyUserEmail(
  db: D1Database,
  token: string,
  password: string,
  now = Math.floor(Date.now() / 1000),
): Promise<UserRecord | null> {
  const row = await db
    .prepare(`SELECT user_id, password_hash FROM users
    WHERE verification_token = ? AND verification_expires_at > ? AND email_verified = 0`)
    .bind(token, now)
    .first<{ user_id: string; password_hash: string | null }>();
  if (
    !row?.password_hash ||
    !(await verifyPassword(password, row.password_hash))
  )
    return null;
  const result = await db
    .prepare(`UPDATE users SET email_verified = 1, verification_token = NULL,
      verification_expires_at = NULL, last_seen_at = ?
    WHERE user_id = ? AND verification_token = ? AND email_verified = 0
      AND verification_expires_at > ? AND password_hash = ?`)
    .bind(now, row.user_id, token, now, row.password_hash)
    .run();
  return result.meta.changes === 1 ? getUser(db, row.user_id) : null;
}
