import { Form, redirect, useActionData } from "react-router";
import { z } from "zod";
import { ApplicationShell, Card, Empty, Field, Pill } from "~/components/ui";
import {
  DEFAULT_INVITE_DAYS,
  type InviteRecord,
  MAX_INVITE_DAYS,
} from "~/concepts/users";
import {
  requireConsoleAdmin,
  requireSameOriginAction,
} from "~/console/context.server";
import type { PasswordResetRecord } from "~/lib/password-reset.server";
import type { Route } from "./+types/people";

/**
 * The owner's door. The owner sends the invite link by any channel; password
 * signup separately sends verification mail before admitting the account.
 * A one-time password-reset link for a member goes out the same way.
 * ADR-0016, and its amendment of 2026-10-29 (reset).
 */

export async function loader({ context, request }: Route.LoaderArgs) {
  const owner = await requireConsoleAdmin(context, request);
  const [users, invites, resets] = await Promise.all([
    owner.admin.listUsers(),
    owner.admin.listInvites(),
    owner.admin.listPasswordResets(),
  ]);
  return {
    users,
    invites,
    resets,
    origin: new URL(owner.env.APP_ORIGIN).origin,
    defaultDays: DEFAULT_INVITE_DAYS,
    maxDays: MAX_INVITE_DAYS,
  };
}

const inviteForm = z.object({
  days: z.coerce.number().int().min(0).max(MAX_INVITE_DAYS),
  kind: z.enum(["single", "group"]),
});

export async function action({ context, request }: Route.ActionArgs) {
  requireSameOriginAction(request);
  const owner = await requireConsoleAdmin(context, request);
  const form = await request.formData();
  if (form.get("intent") === "revoke") {
    const inviteId = String(form.get("id") ?? "");
    if (!/^inv_[0-9a-f-]{36}$/.test(inviteId)) {
      throw new Response("Invalid invite id.", { status: 400 });
    }
    await owner.admin.revokeInvite(inviteId);
    return redirect("/people");
  }
  if (form.get("intent") === "reset-password") {
    const userId = String(form.get("user") ?? "");
    if (!/^usr_[\w-]{1,80}$/.test(userId)) {
      throw new Response("Invalid user id.", { status: 400 });
    }
    const reset = await owner.admin.issuePasswordReset(userId);
    if (reset === null) {
      return {
        resetError: {
          userId,
          message: "Only a verified member's password can be reset.",
        },
      };
    }
    return { reset: { userId, ...reset } };
  }
  const parsed = inviteForm.safeParse({
    days: form.get("days") ?? DEFAULT_INVITE_DAYS,
    kind: form.get("kind") ?? "single",
  });
  if (!parsed.success) {
    return {
      error: `Choose an invite type and an expiry from 0 to ${MAX_INVITE_DAYS} whole days.`,
    };
  }
  const { days, kind } = parsed.data;
  if (kind === "group" && days === 0) {
    return { error: "Group invite links must expire. Choose at least 1 day." };
  }
  const invite = await owner.admin.createInvite({
    expiresInDays: days === 0 ? null : days,
    reusable: kind === "group",
  });
  return { created: invite };
}

const TONES: Record<InviteRecord["status"], "pending" | "done" | "blocked"> = {
  open: "pending",
  redeemed: "done",
  revoked: "blocked",
  expired: "blocked",
};

export default function People({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const { users, invites, resets, origin, defaultDays, maxDays } = loaderData;
  const resetOf = new Map(resets.map((r) => [r.userId, r]));
  const issued = actionData && "reset" in actionData ? actionData.reset : null;
  const refused =
    actionData && "resetError" in actionData ? actionData.resetError : null;
  const nameOf = new Map(users.map((u) => [u.userId, u.displayName]));
  const link = (invite: Pick<InviteRecord, "code">) =>
    `${origin}/join/${encodeURIComponent(invite.code)}`;
  return (
    <ApplicationShell
      lede="Invite one person or a group of friends. Each gets a private account, with Google sign-in or a password and email verification."
      title="People"
    >
      <Card className="editor">
        <h2 id="new-invite" tabIndex={-1}>
          Create an invite link
        </h2>
        <Form className="stack" method="post" preventScrollReset>
          <label>
            Invite type
            <select defaultValue="single" name="kind">
              <option value="single">One person — works once</option>
              <option value="group">Group — works for multiple people</option>
            </select>
          </label>
          <Field
            defaultValue={String(defaultDays)}
            label="Expires in days"
            name="days"
            type="number"
          />
          <p className="muted">
            Up to {maxDays}. For one-person invites, 0 means never expires.
            Group links work for anyone who has the link until they expire or
            you withdraw them.
          </p>
          {actionData && "error" in actionData ? (
            <p role="alert">{actionData.error}</p>
          ) : null}
          <div className="row">
            <button type="submit">Create invite</button>
          </div>
        </Form>
        {actionData && "created" in actionData && actionData.created ? (
          <section className="token-reveal">
            <p className="eyebrow">Invite link</p>
            <p>
              {actionData.created.reusable
                ? `Send this to your friends. Multiple people can join until it expires or you withdraw it.`
                : "Send this to them. It works once."}
            </p>
            <code>{link(actionData.created)}</code>
          </section>
        ) : null}
      </Card>

      <section>
        <h2 className="eyebrow">Invites</h2>
        {invites.length === 0 ? (
          <Empty>No invites yet.</Empty>
        ) : (
          <ul className="card-list">
            {invites.map((invite) => (
              <Card as="li" className="todo-card" key={invite.inviteId}>
                <Pill tone={TONES[invite.status]}>{invite.status}</Pill>
                <h3>
                  {invite.reusable ? "Group invite" : "One-person invite"}
                </h3>
                <p className="muted">
                  created {date(invite.createdAt)}
                  {invite.expiresAt === null
                    ? ", never expires"
                    : `, expires ${date(invite.expiresAt)}`}
                  {invite.reusable
                    ? `, ${invite.useCount} ${invite.useCount === 1 ? "account" : "accounts"} created (including pending verification)`
                    : invite.redeemedAt !== null
                      ? `, used ${date(invite.redeemedAt)} by ${
                          nameOf.get(invite.redeemedBy ?? "") ??
                          invite.redeemedBy
                        }`
                      : ""}
                </p>
                {invite.status === "open" ? (
                  <>
                    <code>{link(invite)}</code>
                    <Form method="post" preventScrollReset>
                      <input name="id" type="hidden" value={invite.inviteId} />
                      <input name="intent" type="hidden" value="revoke" />
                      <button className="danger small" type="submit">
                        Withdraw invite
                      </button>
                    </Form>
                  </>
                ) : null}
              </Card>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="eyebrow">People</h2>
        <ul className="card-list">
          {users.map((user) => (
            <Card as="li" className="todo-card" key={user.userId}>
              <Pill tone={user.admin ? "done" : "pending"}>
                {user.role === "owner"
                  ? "owner"
                  : user.admin
                    ? "admin"
                    : "member"}
              </Pill>
              <h3>{user.displayName || user.email || user.userId}</h3>
              <p className="muted">
                {user.email ?? "no email yet"} · {user.plan} plan · joined{" "}
                {date(user.createdAt)}
                {user.lastSeenAt !== null
                  ? `, last seen ${date(user.lastSeenAt)}`
                  : ""}
              </p>
              {user.role === "member" && user.emailVerified ? (
                <PasswordReset
                  issued={issued?.userId === user.userId ? issued : null}
                  last={resetOf.get(user.userId) ?? null}
                  link={(token) =>
                    `${origin}/reset-password/${encodeURIComponent(token)}`
                  }
                  refused={
                    refused?.userId === user.userId ? refused.message : null
                  }
                  userId={user.userId}
                />
              ) : null}
            </Card>
          ))}
        </ul>
      </section>
    </ApplicationShell>
  );
}

/**
 * The owner's way back in for a member who cannot sign in: a one-time link,
 * shown once, that sets a new password and signs the member out everywhere.
 * ADR-0016, amendment of 2026-10-29 (reset).
 */
function PasswordReset({
  userId,
  last,
  issued,
  refused,
  link,
}: {
  userId: string;
  last: PasswordResetRecord | null;
  issued: { token: string; expiresAt: number } | null;
  refused: string | null;
  link: (token: string) => string;
}) {
  return (
    <>
      {issued ? (
        <section className="token-reveal">
          <p className="eyebrow">Password reset link</p>
          <p>
            Send this to them. It works once, until {time(issued.expiresAt)},
            and signs them out of every browser. It is not shown again.
          </p>
          <code>{link(issued.token)}</code>
        </section>
      ) : last ? (
        <p className="muted">
          Reset link {RESET_WORDS[last.state]}{" "}
          {time(
            last.usedAt ??
              (last.state === "open" ? last.expiresAt : last.createdAt),
          )}
        </p>
      ) : null}
      {refused ? <p role="alert">{refused}</p> : null}
      <Form method="post" preventScrollReset>
        <input name="user" type="hidden" value={userId} />
        <input name="intent" type="hidden" value="reset-password" />
        <button className="ghost small" type="submit">
          {last?.state === "open" || issued
            ? "Replace reset link"
            : "Create password reset link"}
        </button>
      </Form>
    </>
  );
}

const RESET_WORDS: Record<PasswordResetRecord["state"], string> = {
  open: "open until",
  used: "used",
  replaced: "replaced, created",
  expired: "expired, created",
};

function time(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function date(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}
