import {
  listReviewCosts,
  writeReviewCaps,
} from "~/concepts/memory-review-limits";
import { readSpend } from "~/concepts/spend";
import {
  type CreateInviteInput,
  createInvite,
  getUser,
  isAdmin,
  listInvites,
  listUsers,
  revokeInvite,
} from "~/concepts/users";
import { requireUser, type SessionEnv } from "~/lib/auth.server";
import {
  issuePasswordReset,
  latestPasswordResets,
} from "~/lib/password-reset.server";
import { controlDatabase } from "./routing.server";

/** Cross-tenant account administration is never a method on a tenant store. */
export async function requireAdminStore(
  env: SessionEnv & { VALISE_ADMIN_EMAILS?: string },
  request: Request,
) {
  const db = controlDatabase(env);
  const principal = await requireUser({ ...env, DB: db }, request);
  const identity = await getUser(db, principal.userId);
  if (identity === null || !isAdmin(env, identity)) {
    throw new Response("Not found", { status: 404 });
  }
  return {
    identity,
    admin: Object.freeze({
      listUsers: async () =>
        (await listUsers(db)).map((user) => ({
          ...user,
          admin: isAdmin(env, user),
        })),
      listInvites: () => listInvites(db),
      createInvite: (input: Omit<CreateInviteInput, "createdBy">) =>
        createInvite(db, { ...input, createdBy: principal.userId }),
      revokeInvite: (id: string) => revokeInvite(db, id),
      listPasswordResets: () => latestPasswordResets(db),
      issuePasswordReset: (userId: string) =>
        issuePasswordReset(db, { userId, createdBy: principal.userId }),
      /** Estimated spend per account over 30 days. docs/design/spend.md. */
      readSpend: () => readSpend(db),
      /** Every account's memory review money caps and today's reservations. */
      listReviewCosts: () => listReviewCosts(db),
      /** Set one account's daily review and ranking caps (ADR-0012, 2026-11-04 limits). */
      setReviewCaps: async (
        userId: string,
        caps: { reviewMicrousd: number; rankingMicrousd: number },
      ) => {
        if ((await getUser(db, userId)) === null) return false;
        await writeReviewCaps(db, userId, caps, principal.userId);
        return true;
      },
    }),
  };
}

export type AdminStore = Awaited<ReturnType<typeof requireAdminStore>>["admin"];
