import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { allowanceOf } from "~/concepts/attachment-limits";
import {
  createInvite,
  createUserWithPassword,
  findInvite,
  getUser,
  isAdmin,
  listInvites,
  listUsers,
  OWNER_USER_ID,
  resolveSignIn,
  revokeInvite,
} from "~/concepts/users";

const NOW = 1_800_000_000;
const admins = ["Owner@Example.com"];

async function reset() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM invites"),
    env.DB.prepare("DELETE FROM users WHERE user_id <> ?").bind(OWNER_USER_ID),
    env.DB.prepare("UPDATE users SET email = NULL WHERE user_id = ?").bind(
      OWNER_USER_ID,
    ),
  ]);
}

describe("accounts and invites (ADR-0016)", () => {
  beforeEach(reset);

  it("ships the owner row from the migration", async () => {
    const owner = await getUser(env.DB, OWNER_USER_ID);
    expect(owner).toMatchObject({
      userId: "local",
      role: "owner",
      email: null,
    });
  });

  it("signs an allowlisted email in as the owner and records the email once", async () => {
    const first = await resolveSignIn(
      env.DB,
      { email: "owner@example.com", adminEmails: admins },
      NOW,
    );
    expect(first).toMatchObject({
      ok: true,
      created: false,
      user: { userId: "local", email: "owner@example.com" },
    });
    expect(await listUsers(env.DB)).toHaveLength(1);
  });

  it("gives an admin the owner's file allowance while it is listed, and a member the setting's", async () => {
    const list = "owner@example.com,second@example.com";
    await resolveSignIn(
      env.DB,
      { email: "owner@example.com", adminEmails: list.split(",") },
      NOW,
    );
    const second = await resolveSignIn(
      env.DB,
      { email: "second@example.com", adminEmails: list.split(",") },
      NOW,
    );
    if (!second.ok) throw new Error(second.error);
    const id = second.user.userId;
    expect(await allowanceOf(env.DB, id, { VALISE_ADMIN_EMAILS: list })).toBe(
      "owner",
    );
    expect(
      await allowanceOf(env.DB, id, {
        VALISE_ADMIN_EMAILS: "owner@example.com",
      }),
    ).toBe("free");
    expect(
      await allowanceOf(env.DB, id, {
        VALISE_ADMIN_EMAILS: "owner@example.com",
        VALISE_MEMBER_ALLOWANCE: "owner",
      }),
    ).toBe("owner");
    expect(await allowanceOf(env.DB, OWNER_USER_ID)).toBe("owner");
  });

  it("gives every other admin address its own admin account, without an invite", async () => {
    const list = ["owner@example.com", "Second@Example.com"];
    await resolveSignIn(
      env.DB,
      { email: "owner@example.com", adminEmails: list },
      NOW,
    );
    const second = await resolveSignIn(
      env.DB,
      { email: "second@example.com", adminEmails: list },
      NOW,
    );
    if (!second.ok) throw new Error(second.error);
    expect(second.created).toBe(true);
    expect(second.user).toMatchObject({
      email: "second@example.com",
      role: "member",
      emailVerified: true,
      inviteId: null,
    });
    expect(second.user.userId).not.toBe(OWNER_USER_ID);
    expect(isAdmin({ VALISE_ADMIN_EMAILS: list.join(",") }, second.user)).toBe(
      true,
    );

    // The owner row keeps its own address; the second one never lands on it.
    expect(await getUser(env.DB, OWNER_USER_ID)).toMatchObject({
      email: "owner@example.com",
    });
    const again = await resolveSignIn(
      env.DB,
      { email: "second@example.com", adminEmails: list },
      NOW + 60,
    );
    expect(again).toMatchObject({
      ok: true,
      created: false,
      user: { userId: second.user.userId },
    });
    const owner = await resolveSignIn(
      env.DB,
      { email: "owner@example.com", adminEmails: list },
      NOW + 60,
    );
    expect(owner).toMatchObject({ ok: true, user: { userId: OWNER_USER_ID } });
    expect(await listUsers(env.DB)).toHaveLength(2);
  });

  it("lets the first admin address adopt an owner row that has none", async () => {
    const list = ["first@example.com", "owner@example.com"];
    const first = await resolveSignIn(
      env.DB,
      { email: "first@example.com", adminEmails: list },
      NOW,
    );
    expect(first).toMatchObject({
      ok: true,
      user: { userId: OWNER_USER_ID, email: "first@example.com" },
    });
  });

  it("is admin only while the list names a verified address, and the owner always", () => {
    const listed = { VALISE_ADMIN_EMAILS: " A@example.com , b@example.com" };
    const member = {
      role: "member" as const,
      email: "a@example.com",
      emailVerified: true,
    };
    expect(isAdmin(listed, member)).toBe(true);
    expect(isAdmin({}, member)).toBe(false);
    expect(isAdmin(listed, { ...member, emailVerified: false })).toBe(false);
    expect(isAdmin(listed, { ...member, email: "c@example.com" })).toBe(false);
    expect(
      isAdmin({}, { role: "owner", email: null, emailVerified: false }),
    ).toBe(true);
  });

  it("refuses a stranger with no invite", async () => {
    await expect(
      resolveSignIn(
        env.DB,
        { email: "stranger@example.com", adminEmails: admins },
        NOW,
      ),
    ).resolves.toEqual({ ok: false, error: "not-invited" });
    expect(await listUsers(env.DB)).toHaveLength(1);
  });

  it("creates a member from a link's invite, once, and signs them in afterwards", async () => {
    const invite = await createInvite(
      env.DB,
      { createdBy: OWNER_USER_ID, label: "Alice" },
      NOW,
    );
    expect(invite.status).toBe("open");
    expect(invite.expiresAt).toBe(NOW + 14 * 86_400);
    expect(invite.code).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const joined = await resolveSignIn(
      env.DB,
      {
        email: "Alice@Example.com",
        inviteCode: invite.code,
        adminEmails: admins,
      },
      NOW + 10,
    );
    expect(joined).toMatchObject({
      ok: true,
      created: true,
      user: {
        email: "alice@example.com",
        displayName: "Alice",
        role: "member",
        plan: "free",
        inviteId: invite.inviteId,
      },
    });
    if (!joined.ok) throw new Error("unreachable");
    expect(joined.user.userId).toMatch(/^usr_/);
    expect(await findInvite(env.DB, invite.code, NOW + 10)).toMatchObject({
      status: "redeemed",
      redeemedBy: joined.user.userId,
    });

    // The same link again, from someone else: used.
    await expect(
      resolveSignIn(
        env.DB,
        {
          email: "bob@example.com",
          inviteCode: invite.code,
          adminEmails: admins,
        },
        NOW + 20,
      ),
    ).resolves.toEqual({ ok: false, error: "invite-used" });

    // Alice again, with or without the link: her account.
    const again = await resolveSignIn(
      env.DB,
      { email: "alice@example.com", adminEmails: admins },
      NOW + 30,
    );
    expect(again).toMatchObject({
      ok: true,
      created: false,
      user: { userId: joined.user.userId, lastSeenAt: NOW + 30 },
    });
    expect(await listUsers(env.DB)).toHaveLength(2);
  });

  it("holds an email-bound invite to that email, and finds it without the link", async () => {
    const invite = await createInvite(
      env.DB,
      { createdBy: OWNER_USER_ID, label: "Carol", email: "Carol@Example.com" },
      NOW,
    );
    await expect(
      resolveSignIn(
        env.DB,
        {
          email: "dave@example.com",
          inviteCode: invite.code,
          adminEmails: admins,
        },
        NOW,
      ),
    ).resolves.toEqual({ ok: false, error: "invite-other-email" });
    await expect(
      resolveSignIn(
        env.DB,
        { email: "carol@example.com", adminEmails: admins },
        NOW,
      ),
    ).resolves.toMatchObject({ ok: true, created: true });
  });

  it("admits concurrent friends through a group link and counts distinct accounts", async () => {
    const invite = await createInvite(
      env.DB,
      { createdBy: OWNER_USER_ID, reusable: true, label: "Friends" },
      NOW,
    );
    expect(invite).toMatchObject({
      reusable: true,
      useCount: 0,
      expiresAt: NOW + 14 * 86_400,
    });
    const joined = await Promise.all(
      ["alice", "bob", "carol"].map((name) =>
        resolveSignIn(
          env.DB,
          {
            email: `${name}@example.com`,
            inviteCode: invite.code,
            adminEmails: admins,
          },
          NOW + 10,
        ),
      ),
    );
    expect(joined.every((result) => result.ok && result.created)).toBe(true);
    expect(
      new Set(joined.map((result) => result.ok && result.user.userId)).size,
    ).toBe(3);
    expect(joined[0]).toMatchObject({
      user: { displayName: "alice", role: "member" },
    });
    expect(await findInvite(env.DB, invite.code, NOW + 11)).toMatchObject({
      status: "open",
      useCount: 3,
    });
    await resolveSignIn(
      env.DB,
      {
        email: "alice@example.com",
        inviteCode: invite.code,
        adminEmails: admins,
      },
      NOW + 20,
    );
    expect(await listInvites(env.DB, NOW + 20)).toMatchObject([
      { useCount: 3 },
    ]);
  });

  it("keeps password signups pending without consuming a group link", async () => {
    const invite = await createInvite(
      env.DB,
      { createdBy: OWNER_USER_ID, reusable: true },
      NOW,
    );
    for (const name of ["dave", "eve"]) {
      const result = await createUserWithPassword(
        env.DB,
        {
          email: `${name}@example.com`,
          inviteCode: invite.code,
          passwordHash: "test-hash",
          verificationToken: `test-${name}`,
        },
        NOW + 1,
      );
      expect(result).toMatchObject({
        ok: true,
        user: { emailVerified: false },
      });
    }
    expect(await findInvite(env.DB, invite.code, NOW + 2)).toMatchObject({
      status: "open",
      useCount: 2,
    });
    expect(
      await resolveSignIn(
        env.DB,
        {
          email: "dave@example.com",
          inviteCode: invite.code,
          adminEmails: admins,
        },
        NOW + 2,
      ),
    ).toEqual({ ok: false, error: "email-unverified" });
    expect(
      await createUserWithPassword(
        env.DB,
        {
          email: "dave@example.com",
          inviteCode: invite.code,
          passwordHash: "replacement",
          verificationToken: "replacement",
        },
        NOW + 2,
      ),
    ).toEqual({ ok: false, error: "invite-used" });
    expect(
      await resolveSignIn(
        env.DB,
        {
          email: "frank@example.com",
          inviteCode: invite.code,
          adminEmails: admins,
        },
        NOW + 3,
      ),
    ).toMatchObject({ ok: true, created: true });
    expect(await findInvite(env.DB, invite.code, NOW + 3)).toMatchObject({
      useCount: 3,
    });
  });

  it.each(["google", "password"])(
    "stops %s group signups at expiry and after withdrawal, not existing sign-in",
    async (method) => {
      const signup = (code: string, name: string, now: number) =>
        method === "google"
          ? resolveSignIn(
              env.DB,
              {
                email: `${name}@example.com`,
                inviteCode: code,
                adminEmails: admins,
              },
              now,
            )
          : createUserWithPassword(
              env.DB,
              {
                email: `${name}@example.com`,
                inviteCode: code,
                passwordHash: "test-hash",
                verificationToken: name,
              },
              now,
            );
      const expiring = await createInvite(
        env.DB,
        { createdBy: OWNER_USER_ID, reusable: true, expiresInDays: 1 },
        NOW,
      );
      expect(await signup(expiring.code, "first", NOW)).toMatchObject({
        ok: true,
      });
      expect(await signup(expiring.code, "late", NOW + 86_400)).toEqual({
        ok: false,
        error: "invite-expired",
      });
      expect(
        await findInvite(env.DB, expiring.code, NOW + 86_400),
      ).toMatchObject({ status: "expired", useCount: 1 });
      const withdrawn = await createInvite(
        env.DB,
        { createdBy: OWNER_USER_ID, reusable: true },
        NOW,
      );
      expect(await signup(withdrawn.code, "second", NOW)).toMatchObject({
        ok: true,
      });
      expect(await revokeInvite(env.DB, withdrawn.inviteId, NOW + 1)).toBe(
        true,
      );
      expect(await signup(withdrawn.code, "third", NOW + 2)).toEqual({
        ok: false,
        error: "invite-revoked",
      });
      expect(await findInvite(env.DB, withdrawn.code, NOW + 2)).toMatchObject({
        status: "revoked",
        useCount: 1,
      });
      if (method === "google") {
        expect(
          await resolveSignIn(
            env.DB,
            { email: "second@example.com", adminEmails: admins },
            NOW + 3,
          ),
        ).toMatchObject({ ok: true, created: false });
      }
    },
  );

  it.each([
    ["google", "withdrawal"],
    ["password", "withdrawal"],
    ["google", "expiry"],
    ["password", "expiry"],
  ])(
    "rechecks %s signup %s in the write batch after an open lookup",
    async (method, change) => {
      const invite = await createInvite(
        env.DB,
        { createdBy: OWNER_USER_ID, reusable: true },
        NOW,
      );
      const batch = env.DB.batch.bind(env.DB);
      const spy = vi
        .spyOn(env.DB, "batch")
        .mockImplementationOnce(async (statements) => {
          if (change === "withdrawal") {
            await revokeInvite(env.DB, invite.inviteId, NOW);
          } else {
            await env.DB.prepare(
              "UPDATE invites SET expires_at = ? WHERE invite_id = ?",
            )
              .bind(NOW, invite.inviteId)
              .run();
          }
          return batch(statements);
        });
      try {
        const result =
          method === "google"
            ? await resolveSignIn(
                env.DB,
                {
                  email: "race@example.com",
                  inviteCode: invite.code,
                  adminEmails: admins,
                },
                NOW,
              )
            : await createUserWithPassword(
                env.DB,
                {
                  email: "race@example.com",
                  inviteCode: invite.code,
                  passwordHash: "test-hash",
                  verificationToken: "test",
                },
                NOW,
              );
        expect(result).toEqual({
          ok: false,
          error: change === "withdrawal" ? "invite-revoked" : "invite-expired",
        });
        expect(await listUsers(env.DB)).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("keeps single-use links single-use under concurrent signup", async () => {
    const invite = await createInvite(
      env.DB,
      { createdBy: OWNER_USER_ID },
      NOW,
    );
    const results = await Promise.all(
      ["one", "two"].map((name) =>
        resolveSignIn(
          env.DB,
          {
            email: `${name}@example.com`,
            inviteCode: invite.code,
            adminEmails: admins,
          },
          NOW,
        ),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: "invite-used" },
    ]);
    expect(await findInvite(env.DB, invite.code, NOW)).toMatchObject({
      reusable: false,
      useCount: 1,
      status: "redeemed",
    });
    expect(await revokeInvite(env.DB, invite.inviteId, NOW)).toBe(false);
  });

  it("requires finite, valid group expiry and no email binding", async () => {
    for (const expiresInDays of [null, 0, -1, 1.5, 366]) {
      await expect(
        createInvite(
          env.DB,
          { createdBy: OWNER_USER_ID, reusable: true, expiresInDays },
          NOW,
        ),
      ).rejects.toThrow();
    }
    await expect(
      createInvite(
        env.DB,
        { createdBy: OWNER_USER_ID, reusable: true, email: "one@example.com" },
        NOW,
      ),
    ).rejects.toThrow();
    expect(await listInvites(env.DB, NOW)).toHaveLength(0);
  });

  it("refuses expired, revoked and unknown invites by name", async () => {
    const expiring = await createInvite(
      env.DB,
      { createdBy: OWNER_USER_ID, label: "Late", expiresInDays: 1 },
      NOW,
    );
    await expect(
      resolveSignIn(
        env.DB,
        {
          email: "late@example.com",
          inviteCode: expiring.code,
          adminEmails: admins,
        },
        NOW + 2 * 86_400,
      ),
    ).resolves.toEqual({ ok: false, error: "invite-expired" });

    const withdrawn = await createInvite(
      env.DB,
      { createdBy: OWNER_USER_ID, label: "Gone" },
      NOW,
    );
    expect(await revokeInvite(env.DB, withdrawn.inviteId, NOW + 1)).toBe(true);
    expect(await revokeInvite(env.DB, withdrawn.inviteId, NOW + 2)).toBe(false);
    await expect(
      resolveSignIn(
        env.DB,
        {
          email: "gone@example.com",
          inviteCode: withdrawn.code,
          adminEmails: admins,
        },
        NOW + 3,
      ),
    ).resolves.toEqual({ ok: false, error: "invite-revoked" });

    await expect(
      resolveSignIn(
        env.DB,
        { email: "x@example.com", inviteCode: "nope", adminEmails: admins },
        NOW,
      ),
    ).resolves.toEqual({ ok: false, error: "invite-unknown" });

    const statuses = (await listInvites(env.DB, NOW + 2 * 86_400)).map(
      (i) => i.status,
    );
    expect(statuses.sort()).toEqual(["expired", "revoked"]);
  });
});
