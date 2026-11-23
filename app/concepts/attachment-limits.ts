import { isAdmin, type UserRole } from "~/concepts/users";
import { fileSize } from "~/r2/objects";

/**
 * How many bytes of files a bookmark may hold, by kind of file and by the
 * account's allowance. Billing does not exist: `users.plan` is `free` on
 * every row, so the allowances are the account owner's and everyone else's.
 * `VALISE_MEMBER_ALLOWANCE=owner` gives every member the owner's, for an
 * install whose members are a household or a team rather than strangers.
 * A paid tier is an open question in docs/adr/README.md; when it exists it
 * is one more row here, keyed by its plan name. ADR-0015, ADR-0016.
 */

export type AttachmentKind = "image" | "pdf" | "video" | "other";
export type Allowance = "owner" | "free";

const MiB = 1024 * 1024;
/** An X post carries at most four photos. */
export const MAX_SOURCE_IMAGES = 4;

export const ATTACHMENT_LIMITS: Record<
  Allowance,
  { perBookmark: number; perFile: Record<AttachmentKind, number> }
> = {
  owner: {
    perBookmark: 25 * MiB,
    perFile: {
      image: 10 * MiB,
      pdf: 25 * MiB,
      video: 25 * MiB,
      other: 10 * MiB,
    },
  },
  free: {
    perBookmark: 2 * MiB,
    perFile: { image: 1 * MiB, pdf: 2 * MiB, video: 2 * MiB, other: 1 * MiB },
  },
};

export function attachmentKind(contentType: string): AttachmentKind {
  const type = contentType.toLowerCase().split(";")[0].trim();
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("video/")) return "video";
  return "other";
}

/** The allowance a member without a paid plan gets: the setting, else free. */
export function memberAllowance(setting: string | undefined): Allowance {
  return setting?.trim() === "owner" ? "owner" : "free";
}

export type AllowanceSettings = {
  VALISE_MEMBER_ALLOWANCE?: string;
  VALISE_ADMIN_EMAILS?: string;
};

/** An admin's allowance is the owner's; else the plan's row; else the member setting. */
export async function allowanceOf(
  db: D1Database,
  userId: string,
  settings: AllowanceSettings = {},
): Promise<Allowance> {
  const user = await db
    .prepare(
      "SELECT role, plan, email, email_verified FROM users WHERE user_id = ?",
    )
    .bind(userId)
    .first<{
      role: UserRole;
      plan: string;
      email: string | null;
      email_verified: number;
    }>();
  if (
    user &&
    isAdmin(settings, {
      role: user.role,
      email: user.email,
      emailVerified: user.email_verified === 1,
    })
  )
    return "owner";
  return user?.plan && user.plan !== "free" && user.plan in ATTACHMENT_LIMITS
    ? (user.plan as Allowance)
    : memberAllowance(settings.VALISE_MEMBER_ALLOWANCE);
}

/**
 * Why these files cannot all belong to one bookmark, or null. Each file is
 * held to its kind's limit and the set to the bookmark's.
 */
export function attachmentRefusal(
  allowance: Allowance,
  files: { title: string; contentType: string; size: number }[],
): string | null {
  const limits = ATTACHMENT_LIMITS[allowance];
  for (const file of files) {
    const kind = attachmentKind(file.contentType);
    if (file.size > limits.perFile[kind])
      return `${file.title} is ${fileSize(file.size)}; a bookmark's ${kind === "other" ? "files" : `${kind}s`} are limited to ${fileSize(limits.perFile[kind])} each on this account.`;
  }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  return total > limits.perBookmark
    ? `These files total ${fileSize(total)}; a bookmark holds at most ${fileSize(limits.perBookmark)} of files on this account.`
    : null;
}
