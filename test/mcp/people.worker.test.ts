import { createExecutionContext, env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { createInvite, listInvites, resolveSignIn } from "~/concepts/users";
import { consoleContext } from "~/console/context.server";
import { createSessionCookie } from "~/lib/auth.server";
import { action, loader } from "~/routes/people";

const settings = {
  ...env,
  SESSION_SECRET: "people-route-test-secret",
  VALISE_ADMIN_EMAILS: "owner@example.com,admin@example.com",
};

async function args(
  fields: Record<string, string>,
  userId = "local",
  origin = "https://valise.test",
) {
  const url = new URL("https://valise.test/people");
  const cookie = await createSessionCookie(settings, new Request(url), userId);
  const request = new Request(url, {
    method: "POST",
    headers: { cookie, origin },
    body: new URLSearchParams(fields),
  });
  const context = new RouterContextProvider();
  context.set(consoleContext, { env: settings, ctx: createExecutionContext() });
  return { context, request, params: {}, url, pattern: "/people" };
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM invites"),
    env.DB.prepare("DELETE FROM users WHERE user_id <> 'local'"),
    env.DB.prepare("DELETE FROM sessions"),
  ]);
});

describe("owner group invite management", () => {
  it("creates a 14-day group link and lists it to the owner", async () => {
    const result = await action(await args({ kind: "group" }));
    expect(result).toMatchObject({
      created: { reusable: true, useCount: 0, status: "open" },
    });
    const [invite] = await listInvites(env.DB);
    expect(invite.expiresAt).toBe(invite.createdAt + 14 * 86_400);
    expect(await loader(await args({}))).toMatchObject({
      invites: [{ reusable: true }],
    });
  });

  it.each([
    { kind: "group", days: "0" },
    { kind: "group", days: "-1" },
    { kind: "group", days: "366" },
    { kind: "group", days: "1.5" },
    { kind: "other", days: "14" },
  ])("rejects invalid invite settings %j", async (fields) => {
    expect(await action(await args(fields))).toHaveProperty("error");
    expect(await listInvites(env.DB)).toHaveLength(0);
  });

  it("keeps legacy form posts single-use, including non-expiring links", async () => {
    expect(await action(await args({ days: "0" }))).toMatchObject({
      created: { reusable: false, expiresAt: null },
    });
  });

  it("withdraws a group link after signup without removing the account", async () => {
    const invite = await createInvite(env.DB, {
      createdBy: "local",
      reusable: true,
    });
    expect(
      await resolveSignIn(env.DB, {
        email: "friend@example.com",
        inviteCode: invite.code,
        adminEmails: [],
      }),
    ).toMatchObject({ ok: true });
    const response = await action(
      await args({ intent: "revoke", id: invite.inviteId }),
    );
    expect(response).toBeInstanceOf(Response);
    expect(await listInvites(env.DB)).toMatchObject([
      { status: "revoked", useCount: 1 },
    ]);
    expect(
      await resolveSignIn(env.DB, {
        email: "friend@example.com",
        adminEmails: [],
      }),
    ).toMatchObject({ ok: true, created: false });
  });

  it("refuses cross-origin creation and withdrawal before mutation", async () => {
    const invite = await createInvite(env.DB, {
      createdBy: "local",
      reusable: true,
    });
    const attempts: Record<string, string>[] = [
      { kind: "group" },
      { intent: "revoke", id: invite.inviteId },
    ];
    for (const fields of attempts) {
      await expect(
        action(await args(fields, "local", "https://evil.example")),
      ).rejects.toMatchObject({ status: 403 });
    }
    expect(await listInvites(env.DB)).toMatchObject([
      { status: "open", useCount: 0 },
    ]);
  });

  it("lets a second admin manage invitations and shows who is an admin", async () => {
    // The owner row records its own address first, as the owner's first
    // Google sign-in does; otherwise the next admin address would adopt it.
    await env.DB.prepare(
      "UPDATE users SET email = 'owner@example.com', email_verified = 1 WHERE user_id = 'local'",
    ).run();
    const admin = await resolveSignIn(env.DB, {
      email: "admin@example.com",
      adminEmails: ["owner@example.com", "admin@example.com"],
    });
    if (!admin.ok) throw new Error("admin sign-in failed");
    expect(admin.user.userId).not.toBe("local");
    expect(
      await action(await args({ kind: "group" }, admin.user.userId)),
    ).toMatchObject({ created: { reusable: true } });
    const listed = await loader(await args({}, admin.user.userId));
    expect(listed.invites).toHaveLength(1);
    expect(
      listed.users.find((user) => user.userId === admin.user.userId),
    ).toMatchObject({ admin: true });
    expect(listed.users.find((user) => user.userId === "local")).toMatchObject({
      admin: true,
    });
  });

  it("does not let members list, create or withdraw invitations", async () => {
    const invite = await createInvite(env.DB, {
      createdBy: "local",
      reusable: true,
    });
    const joined = await resolveSignIn(env.DB, {
      email: "member@example.com",
      inviteCode: invite.code,
      adminEmails: [],
    });
    if (!joined.ok) throw new Error("member signup failed");
    await expect(
      loader(await args({}, joined.user.userId)),
    ).rejects.toMatchObject({ status: 404 });
    const attempts: Record<string, string>[] = [
      { kind: "group" },
      { intent: "revoke", id: invite.inviteId },
    ];
    for (const fields of attempts) {
      await expect(
        action(await args(fields, joined.user.userId)),
      ).rejects.toMatchObject({ status: 404 });
    }
    expect(await listInvites(env.DB)).toMatchObject([
      { status: "open", useCount: 1 },
    ]);
  });
});
