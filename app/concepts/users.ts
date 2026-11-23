import { uuid7 } from "~/lib/uuid7";

/**
 * Accounts and the invites that admit them. ADR-0016.
 *
 * `local` is the owner: the one user v1 had, the account every row written
 * before multi-user belongs to, and the one the administrator password still
 * signs in as. Everyone else is a member who arrived through an invite and
 * signs in with Google or an email-verified password. A member's rows are theirs alone; the concept modules
 * scope every read and write by `user_id`.
 *
 * Admin is not a stored role. The owner is always one; any other account is
 * one while `VALISE_ADMIN_EMAILS` names its verified address, so removing an
 * address from the list takes the privilege away at the next request. An
 * admin manages people and invites and opens the workbench, and keeps their
 * own rows. ADR-0016, amendment of 2026-11-04.
 */

export const OWNER_USER_ID = "local";

export type UserRole = "owner" | "member";

export type UserRecord = {
  userId: string;
  email: string | null;
  displayName: string;
  role: UserRole;
  plan: string;
  inviteId: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  emailVerified: boolean;
};

export type InviteStatus = "open" | "redeemed" | "revoked" | "expired";

export type InviteRecord = {
  inviteId: string;
  code: string;
  label: string;
  email: string | null;
  createdBy: string;
  createdAt: number;
  expiresAt: number | null;
  reusable: boolean;
  /** Accounts created through this link, including pending email verification. */
  useCount: number;
  redeemedAt: number | null;
  redeemedBy: string | null;
  revokedAt: number | null;
  status: InviteStatus;
};

export type SignInRefusal =
  | "not-invited"
  | "invite-unknown"
  | "invite-used"
  | "invite-revoked"
  | "invite-expired"
  | "invite-other-email";

export type SignInResolution =
  | { ok: true; user: UserRecord; created: boolean }
  | { ok: false; error: SignInRefusal | "email-unverified" };

const MAX_LABEL_LENGTH = 120;
const MAX_DISPLAY_NAME_LENGTH = 120;
/** A fortnight: long enough to forward, short enough that a stale link dies. */
export const DEFAULT_INVITE_DAYS = 14;
export const MAX_INVITE_DAYS = 365;
export const VERIFICATION_TTL_SECONDS = 7 * 86_400;

type UserRow = {
  user_id: string;
  email: string | null;
  display_name: string;
  role: UserRole;
  plan: string;
  invite_id: string | null;
  created_at: number;
  last_seen_at: number | null;
  password_hash: string | null;
  email_verified: number;
  verification_token: string | null;
  verification_expires_at: number | null;
};

type InviteRow = {
  invite_id: string;
  code: string;
  label: string;
  email: string | null;
  created_by: string;
  created_at: number;
  expires_at: number | null;
  reusable: number;
  use_count?: number;
  redeemed_at: number | null;
  redeemed_by: string | null;
  revoked_at: number | null;
};

const USER_COLUMNS =
  "user_id, email, display_name, role, plan, invite_id, created_at, last_seen_at, password_hash, email_verified, verification_token, verification_expires_at";
const INVITE_COLUMNS =
  "invite_id, code, label, email, created_by, created_at, expires_at, reusable, redeemed_at, redeemed_by, revoked_at";
const INVITE_SELECT_COLUMNS = `${INVITE_COLUMNS},
  (SELECT COUNT(*) FROM users WHERE users.invite_id = invites.invite_id) AS use_count`;

export async function getUser(
  db: D1Database,
  userId: string,
): Promise<UserRecord | null> {
  const row = await db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE user_id = ?`)
    .bind(userId)
    .first<UserRow>();
  return row === null ? null : userRecord(row);
}

export async function getUserByEmail(
  db: D1Database,
  email: string,
): Promise<UserRecord | null> {
  const row = await db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE email = ?`)
    .bind(normalizeEmail(email))
    .first<UserRow>();
  return row === null ? null : userRecord(row);
}

/** Owner first, then members by arrival. */
export async function listUsers(db: D1Database): Promise<UserRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT ${USER_COLUMNS} FROM users
        ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, created_at, user_id`,
    )
    .all<UserRow>();
  return results.map(userRecord);
}

/** `VALISE_ADMIN_EMAILS`, normalized; entries without an `@` are dropped. */
export function adminEmailSet(list: string | undefined): Set<string> {
  return new Set(
    (list ?? "")
      .split(",")
      .map(normalizeEmail)
      .filter((email) => email.includes("@")),
  );
}

/**
 * Whether an account has the owner's privileges: the owner itself, or an
 * account whose verified address `VALISE_ADMIN_EMAILS` lists. The attachment
 * allowance and every owner-only page ask this, not `role`.
 */
export function isAdmin(
  env: { VALISE_ADMIN_EMAILS?: string },
  user: Pick<UserRecord, "role" | "email" | "emailVerified">,
): boolean {
  if (user.role === "owner") return true;
  return (
    user.emailVerified &&
    user.email !== null &&
    adminEmailSet(env.VALISE_ADMIN_EMAILS).has(normalizeEmail(user.email))
  );
}

export async function isOwner(
  db: D1Database,
  userId: string,
): Promise<boolean> {
  const user = await getUser(db, userId);
  return user?.role === "owner";
}

/** Shared by the read helper and in-statement authorization guards. Only pass
 * application-owned SQL aliases, never request input. Invite revocation does
 * not revoke already-admitted accounts; there is no separate account-revoked role.
 */
export function accountAdmissionSql(alias: string): string {
  return `(${alias}.role = 'owner' OR ${alias}.email_verified = 1)`;
}

/** Existing credentials must not admit an unverified or deleted account. */
export async function accountAdmitted(
  db: D1Database,
  userId: string,
): Promise<boolean> {
  return (
    (await db
      .prepare(
        `SELECT 1 FROM users WHERE user_id = ? AND ${accountAdmissionSql("users")}`,
      )
      .bind(userId)
      .first()) !== null
  );
}

export async function touchUser(
  db: D1Database,
  userId: string,
  now = nowSeconds(),
): Promise<void> {
  await db
    .prepare("UPDATE users SET last_seen_at = ? WHERE user_id = ?")
    .bind(now, userId)
    .run();
}

export type CreateInviteInput = {
  createdBy: string;
  /** Who it is for. Defaults to empty; no longer a required field. */
  label?: string;
  /** Lowercased; when set this email must be verified before admission. */
  email?: string | null;
  /** Days until the link stops working; null never expires. */
  expiresInDays?: number | null;
  /** Group links stay open after each signup; they require an expiry and no email binding. */
  reusable?: boolean;
};

export async function createInvite(
  db: D1Database,
  input: CreateInviteInput,
  now = nowSeconds(),
): Promise<InviteRecord> {
  const label = (input.label ?? "").trim().slice(0, MAX_LABEL_LENGTH);
  const email = input.email?.trim() ? normalizeEmail(input.email) : null;
  if (email !== null && !email.includes("@")) {
    throw new Error("An invite email needs an @.");
  }
  const days =
    input.expiresInDays === undefined
      ? DEFAULT_INVITE_DAYS
      : input.expiresInDays;
  if (
    days !== null &&
    !(Number.isInteger(days) && days > 0 && days <= MAX_INVITE_DAYS)
  ) {
    throw new Error(`Invite expiry is 1 to ${MAX_INVITE_DAYS} days, or never.`);
  }
  if (input.reusable && (days === null || email !== null)) {
    throw new Error(
      "Group invites need an expiry and cannot be bound to one email.",
    );
  }
  const row: InviteRow = {
    invite_id: `inv_${uuid7()}`,
    code: inviteCode(),
    label,
    email,
    created_by: input.createdBy,
    created_at: now,
    expires_at: days === null ? null : now + days * 86_400,
    reusable: input.reusable ? 1 : 0,
    redeemed_at: null,
    redeemed_by: null,
    revoked_at: null,
  };
  await db
    .prepare(
      `INSERT INTO invites (${INVITE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
    )
    .bind(
      row.invite_id,
      row.code,
      row.label,
      row.email,
      row.created_by,
      row.created_at,
      row.expires_at,
      row.reusable,
    )
    .run();
  return inviteRecord(row, now);
}

/** Group links can be withdrawn after use; admitted accounts keep their access. */
export async function revokeInvite(
  db: D1Database,
  inviteId: string,
  now = nowSeconds(),
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE invites SET revoked_at = ?
        WHERE invite_id = ? AND (reusable = 1 OR redeemed_at IS NULL) AND revoked_at IS NULL`,
    )
    .bind(now, inviteId)
    .run();
  return result.meta.changes === 1;
}

export async function listInvites(
  db: D1Database,
  now = nowSeconds(),
): Promise<InviteRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT ${INVITE_SELECT_COLUMNS} FROM invites ORDER BY created_at DESC, invite_id`,
    )
    .all<InviteRow>();
  return results.map((row) => inviteRecord(row, now));
}

export async function findInvite(
  db: D1Database,
  code: string,
  now = nowSeconds(),
): Promise<InviteRecord | null> {
  const row = await db
    .prepare(`SELECT ${INVITE_SELECT_COLUMNS} FROM invites WHERE code = ?`)
    .bind(code.trim())
    .first<InviteRow>();
  return row === null ? null : inviteRecord(row, now);
}

export type SignInInput = {
  /** A verified email from Google, any case. */
  email: string;
  /** The code from a `/join/<code>` link, if the sign-in started there. */
  inviteCode?: string | null;
  /**
   * `VALISE_ADMIN_EMAILS`: the address the owner row records signs in as the
   * owner; every other one gets its own admin account without an invite.
   */
  adminEmails: Iterable<string>;
};

/**
 * Who a verified Google email signs in as. An admin address is the owner
 * when the owner row records it, or records none yet and this sign-in adopts
 * it; any other admin address is its own account, created on first sign-in
 * without an invite. Then an existing account, then an invite: the one the
 * link carried, or else an open invite bound to this email. Anything else is
 * refused, with a reason the login page can show and the auth log can keep.
 */
export async function resolveSignIn(
  db: D1Database,
  input: SignInInput,
  now = nowSeconds(),
): Promise<SignInResolution> {
  const email = normalizeEmail(input.email);
  const admin = [...input.adminEmails].some(
    (listed) => normalizeEmail(listed) === email,
  );
  if (admin) {
    const recorded = (await getUser(db, OWNER_USER_ID))?.email ?? null;
    if (recorded === null || recorded === email) {
      // A concurrent first sign-in by another admin address may adopt the
      // row first; then this address is its own account like any other.
      const owner = await adoptOwnerEmail(db, email, now);
      if (owner.email === email)
        return { ok: true, user: owner, created: false };
    }
    if ((await getUserByEmail(db, email)) === null) {
      return createAdminAccount(db, email, now);
    }
  }
  const existing = await getUserByEmail(db, email);
  if (existing !== null) {
    if (!existing.emailVerified)
      return { ok: false, error: "email-unverified" };
    await touchUser(db, existing.userId, now);
    return { ok: true, user: { ...existing, lastSeenAt: now }, created: false };
  }

  let invite: InviteRecord | null = null;
  if (input.inviteCode) {
    invite = await findInvite(db, input.inviteCode, now);
    if (invite === null) return { ok: false, error: "invite-unknown" };
    if (invite.status === "redeemed")
      return { ok: false, error: "invite-used" };
    if (invite.status === "revoked")
      return { ok: false, error: "invite-revoked" };
    if (invite.status === "expired")
      return { ok: false, error: "invite-expired" };
    if (invite.email !== null && invite.email !== email) {
      return { ok: false, error: "invite-other-email" };
    }
  } else {
    const row = await db
      .prepare(
        `SELECT ${INVITE_SELECT_COLUMNS} FROM invites
          WHERE email = ? AND redeemed_at IS NULL AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(email, now)
      .first<InviteRow>();
    if (row === null) return { ok: false, error: "not-invited" };
    invite = inviteRecord(row, now);
  }

  const user: UserRecord = {
    userId: `usr_${uuid7()}`,
    email,
    displayName: (
      (!invite.reusable && invite.label) ||
      email.split("@")[0]
    ).slice(0, MAX_DISPLAY_NAME_LENGTH),
    role: "member",
    plan: "free",
    inviteId: invite.inviteId,
    createdAt: now,
    lastSeenAt: now,
    emailVerified: true,
  };
  // The batch serializes redemption with account creation. Group links update
  // the latest redemption; single-use links still admit exactly one account.
  const [redeemed] = await db.batch([
    redeemInviteStatement(db, invite.inviteId, user.userId, now),
    db
      .prepare(
        `INSERT INTO users (${USER_COLUMNS})
          SELECT ?, ?, ?, 'member', 'free', ?, ?, ?, NULL, 1, NULL, NULL
           WHERE (SELECT redeemed_by FROM invites WHERE invite_id = ?) = ?`,
      )
      .bind(
        user.userId,
        user.email,
        user.displayName,
        user.inviteId,
        now,
        now,
        invite.inviteId,
        user.userId,
      ),
  ]);
  if (redeemed.meta.changes !== 1)
    return { ok: false, error: await redemptionRefusal(db, invite.code, now) };
  return { ok: true, user, created: true };
}

export type PasswordSignInInput = {
  email: string;
  inviteCode: string;
  displayName?: string;
  passwordHash: string;
  verificationToken: string;
};

export type PasswordSignInResult =
  | { ok: true; user: UserRecord; created: true }
  | { ok: false; error: SignInRefusal };

/**
 * Create a member account with a password, redeeming the invite.
 * The email is not yet verified; a verification email is sent separately.
 */
export async function createUserWithPassword(
  db: D1Database,
  input: PasswordSignInInput,
  now = nowSeconds(),
): Promise<PasswordSignInResult> {
  const email = normalizeEmail(input.email);
  const invite = await findInvite(db, input.inviteCode, now);
  if (invite === null) return { ok: false, error: "invite-unknown" };
  if (invite.status === "redeemed") return { ok: false, error: "invite-used" };
  if (invite.status === "revoked")
    return { ok: false, error: "invite-revoked" };
  if (invite.status === "expired")
    return { ok: false, error: "invite-expired" };
  if (invite.email !== null && invite.email !== email) {
    return { ok: false, error: "invite-other-email" };
  }
  const existing = await getUserByEmail(db, email);
  if (existing !== null) return { ok: false, error: "invite-used" };

  const user: UserRecord = {
    userId: `usr_${uuid7()}`,
    email,
    displayName: (
      input.displayName ||
      (!invite.reusable && invite.label) ||
      email.split("@")[0]
    ).slice(0, MAX_DISPLAY_NAME_LENGTH),
    role: "member",
    plan: "free",
    inviteId: invite.inviteId,
    createdAt: now,
    lastSeenAt: now,
    emailVerified: false,
  };

  const [redeemed] = await db.batch([
    redeemInviteStatement(db, invite.inviteId, user.userId, now),
    db
      .prepare(
        `INSERT INTO users (user_id, email, display_name, role, plan, invite_id, created_at, last_seen_at, password_hash, verification_token, verification_expires_at)
          SELECT ?, ?, ?, 'member', 'free', ?, ?, ?, ?, ?, ?
           WHERE (SELECT redeemed_by FROM invites WHERE invite_id = ?) = ?`,
      )
      .bind(
        user.userId,
        user.email,
        user.displayName,
        user.inviteId,
        now,
        now,
        input.passwordHash,
        input.verificationToken,
        now + VERIFICATION_TTL_SECONDS,
        invite.inviteId,
        user.userId,
      ),
  ]);
  if (redeemed.meta.changes !== 1)
    return { ok: false, error: await redemptionRefusal(db, invite.code, now) };
  return { ok: true, user, created: true };
}

function redeemInviteStatement(
  db: D1Database,
  inviteId: string,
  userId: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE invites SET redeemed_at = ?, redeemed_by = ?
        WHERE invite_id = ? AND (reusable = 1 OR redeemed_at IS NULL)
          AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .bind(now, userId, inviteId, now);
}

async function redemptionRefusal(
  db: D1Database,
  code: string,
  now: number,
): Promise<SignInRefusal> {
  const invite = await findInvite(db, code, now);
  if (invite === null) return "invite-unknown";
  if (invite.status === "revoked") return "invite-revoked";
  if (invite.status === "expired") return "invite-expired";
  return "invite-used";
}

/** Look up a user by email, returning password_hash for auth checks. */
export async function getUserForPasswordAuth(
  db: D1Database,
  email: string,
): Promise<(UserRecord & { passwordHash: string | null }) | null> {
  const row = await db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE email = ?`)
    .bind(normalizeEmail(email))
    .first<UserRow>();
  if (row === null) return null;
  return { ...userRecord(row), passwordHash: row.password_hash };
}

/**
 * An admin address's own account, as an invite would leave it but with no
 * invite: a verified member row. Its privileges come from the list, not the
 * row. Two first sign-ins at once insert one row; both sign in to it.
 */
async function createAdminAccount(
  db: D1Database,
  email: string,
  now: number,
): Promise<SignInResolution> {
  const inserted = await db
    .prepare(
      `INSERT INTO users (${USER_COLUMNS})
        VALUES (?, ?, ?, 'member', 'free', NULL, ?, ?, NULL, 1, NULL, NULL)
        ON CONFLICT (email) DO NOTHING`,
    )
    .bind(
      `usr_${uuid7()}`,
      email,
      email.split("@")[0].slice(0, MAX_DISPLAY_NAME_LENGTH),
      now,
      now,
    )
    .run();
  const user = await getUserByEmail(db, email);
  if (user === null) throw new Error("The admin account was not created.");
  return { ok: true, user, created: inserted.meta.changes === 1 };
}

/**
 * The owner row exists from the migration with no email; the first Google
 * sign-in by an allowlisted address records it, so the people page can show
 * who the owner is.
 */
async function adoptOwnerEmail(
  db: D1Database,
  email: string,
  now: number,
): Promise<UserRecord> {
  await db
    .prepare(
      `UPDATE users SET email = COALESCE(email, ?), email_verified = 1, last_seen_at = ?
        WHERE user_id = ? AND NOT EXISTS (
          SELECT 1 FROM users other WHERE other.email = ? AND other.user_id <> ?
        )`,
    )
    .bind(email, now, OWNER_USER_ID, email, OWNER_USER_ID)
    .run();
  const owner = await getUser(db, OWNER_USER_ID);
  if (owner === null) throw new Error("The owner row is missing.");
  return owner;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function inviteStatus(
  row: Pick<
    InviteRow,
    "redeemed_at" | "revoked_at" | "expires_at" | "reusable"
  >,
  now: number,
): InviteStatus {
  if (!row.reusable && row.redeemed_at !== null) return "redeemed";
  if (row.revoked_at !== null) return "revoked";
  if (row.expires_at !== null && row.expires_at <= now) return "expired";
  return "open";
}

/** 128 bits, URL-safe; possession admits signup until use, expiry or withdrawal. */
function inviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function userRecord(row: UserRow): UserRecord {
  return {
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    plan: row.plan,
    inviteId: row.invite_id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    emailVerified: row.email_verified === 1,
  };
}

function inviteRecord(row: InviteRow, now: number): InviteRecord {
  return {
    inviteId: row.invite_id,
    code: row.code,
    label: row.label,
    email: row.email,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    reusable: row.reusable === 1,
    useCount: row.use_count ?? 0,
    redeemedAt: row.redeemed_at,
    redeemedBy: row.redeemed_by,
    revokedAt: row.revoked_at,
    status: inviteStatus(row, now),
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Set or replace a verified member's password, and end every other browser
 * session of theirs in the same batch. The update holds only while the stored
 * hash is still the one the caller checked, so two concurrent changes cannot
 * both succeed. MCP grants and tokens are untouched; /connections revokes
 * those. ADR-0016, amendment of 2026-10-29.
 */
export async function setMemberPassword(
  db: D1Database,
  input: {
    userId: string;
    previousHash: string | null;
    passwordHash: string;
    keepSessionId: string;
  },
): Promise<boolean> {
  const [updated] = await db.batch([
    db
      .prepare(
        `UPDATE users SET password_hash = ?
          WHERE user_id = ? AND role = 'member' AND email_verified = 1
            AND password_hash IS ?`,
      )
      .bind(input.passwordHash, input.userId, input.previousHash),
    db
      .prepare(
        `DELETE FROM sessions
          WHERE user_id = ? AND session_id <> ?
            AND (SELECT password_hash FROM users WHERE user_id = ?) = ?`,
      )
      .bind(
        input.userId,
        input.keepSessionId,
        input.userId,
        input.passwordHash,
      ),
  ]);
  return updated.meta.changes === 1;
}
