import { createExecutionContext, env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { getUserForPasswordAuth } from "~/concepts/users";
import { consoleContext } from "~/console/context.server";
import { createSessionCookie } from "~/lib/auth.server";
import { hashPassword, verifyPassword } from "~/lib/password.server";
import {
  issuePasswordReset,
  latestPasswordResets,
  PASSWORD_RESET_TTL_SECONDS,
  redeemPasswordReset,
} from "~/lib/password-reset.server";
import { action as people } from "~/routes/people";
import { action as reset, loader as resetPage } from "~/routes/reset-password";

/**
 * Owner-issued password-reset links. ADR-0016, amendment of 2026-10-29
 * (reset).
 */

const settings = { ...env, SESSION_SECRET: "password-reset-test-secret" };
const ORIGIN = "https://valise.test";

async function member(email: string, verified = 1, password = "old-password") {
  const userId = `usr_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO users (user_id, email, display_name, role, plan, created_at, email_verified, password_hash)
       VALUES (?, ?, ?, 'member', 'free', 0, ?, ?)`,
  )
    .bind(userId, email, email, verified, await hashPassword(password))
    .run();
  return userId;
}

function context() {
  const provider = new RouterContextProvider();
  provider.set(consoleContext, {
    env: settings,
    ctx: createExecutionContext(),
  });
  return provider;
}

async function peopleAction(fields: Record<string, string>, as = "local") {
  const url = new URL(`${ORIGIN}/people`);
  const cookie = await createSessionCookie(settings, new Request(url), as);
  const request = new Request(url, {
    method: "POST",
    headers: { cookie, origin: ORIGIN },
    body: new URLSearchParams(fields),
  });
  return people({
    context: context(),
    request,
    params: {},
    url,
    pattern: "/people",
  });
}

function resetAction(token: string, password: string, confirm = password) {
  const url = new URL(`${ORIGIN}/reset-password/${token}`);
  const request = new Request(url, {
    method: "POST",
    headers: { origin: ORIGIN },
    body: new URLSearchParams({ password, confirm_password: confirm }),
  });
  return reset({
    context: context(),
    request,
    params: { token },
    url,
    pattern: "/reset-password/:token",
  });
}

function resetLoader(token: string) {
  const url = new URL(`${ORIGIN}/reset-password/${token}`);
  return resetPage({
    context: context(),
    request: new Request(url),
    params: { token },
    url,
    pattern: "/reset-password/:token",
  });
}

async function passwordWorks(email: string, password: string) {
  const account = await getUserForPasswordAuth(env.DB, email);
  return account?.passwordHash
    ? verifyPassword(password, account.passwordHash)
    : false;
}

async function sessionsOf(userId: string) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?",
  )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM password_resets"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM auth_events"),
    env.DB.prepare("DELETE FROM users WHERE user_id <> 'local'"),
  ]);
});

describe("owner-issued password reset", () => {
  it("issues a link on /people, stores only its hash, and the member sets a password with it", async () => {
    const userId = await member("member@example.com");
    await createSessionCookie(settings, new Request(ORIGIN), userId);
    await createSessionCookie(settings, new Request(ORIGIN), userId);
    expect(await sessionsOf(userId)).toBe(2);

    const issued = await peopleAction({
      intent: "reset-password",
      user: userId,
    });
    const link = issued && "reset" in issued ? issued.reset : undefined;
    if (!link) throw new Error("no link issued");
    const { token, expiresAt } = link;
    expect(token).toMatch(/^[\w-]{43}$/);
    const stored = await env.DB.prepare(
      "SELECT token_hash, created_by FROM password_resets WHERE user_id = ?",
    )
      .bind(userId)
      .first<{ token_hash: string; created_by: string }>();
    expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.token_hash).not.toContain(token);
    expect(stored?.created_by).toBe("local");
    expect(expiresAt - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(
      PASSWORD_RESET_TTL_SECONDS,
    );

    expect(await resetLoader(token)).toEqual({
      open: true,
      email: "member@example.com",
    });
    expect(await resetAction(token, "short")).toEqual({
      error: "Password must be at least 8 characters.",
    });
    expect(await resetAction(token, "new-password-1", "other")).toEqual({
      error: "Passwords do not match.",
    });
    expect(await resetAction(token, "new-password-1")).toEqual({
      saved: true,
    });
    expect(await passwordWorks("member@example.com", "new-password-1")).toBe(
      true,
    );
    expect(await sessionsOf(userId)).toBe(0);
    expect(await latestPasswordResets(env.DB)).toMatchObject([
      { userId, state: "used" },
    ]);
  });

  it("works once: a second use changes nothing", async () => {
    const userId = await member("once@example.com");
    const link = await issuePasswordReset(env.DB, {
      userId,
      createdBy: "local",
    });
    if (!link) throw new Error("no link");
    expect(await resetAction(link.token, "first-password")).toEqual({
      saved: true,
    });
    expect(await resetAction(link.token, "second-password")).toMatchObject({
      spent: true,
    });
    expect(await resetLoader(link.token)).toEqual({ open: false });
    expect(await passwordWorks("once@example.com", "first-password")).toBe(
      true,
    );
  });

  it("refuses an expired link", async () => {
    const userId = await member("late@example.com");
    const past = Math.floor(Date.now() / 1000) - PASSWORD_RESET_TTL_SECONDS - 1;
    const link = await issuePasswordReset(
      env.DB,
      { userId, createdBy: "local" },
      past,
    );
    if (!link) throw new Error("no link");
    expect(await resetLoader(link.token)).toEqual({ open: false });
    expect(await resetAction(link.token, "new-password-1")).toMatchObject({
      spent: true,
    });
    expect(await passwordWorks("late@example.com", "old-password")).toBe(true);
    expect(await latestPasswordResets(env.DB)).toMatchObject([
      { state: "expired" },
    ]);
  });

  it("a newer link replaces the older one", async () => {
    const userId = await member("twice@example.com");
    const first = await issuePasswordReset(env.DB, {
      userId,
      createdBy: "local",
    });
    const second = await issuePasswordReset(env.DB, {
      userId,
      createdBy: "local",
    });
    if (!first || !second) throw new Error("no link");
    expect(await resetAction(first.token, "from-first-link")).toMatchObject({
      spent: true,
    });
    expect(await resetAction(second.token, "from-second-link")).toEqual({
      saved: true,
    });
  });

  it("changes only the member the link was issued for", async () => {
    const alice = await member("alice@example.com");
    const bob = await member("bob@example.com");
    await createSessionCookie(settings, new Request(ORIGIN), bob);
    const link = await issuePasswordReset(env.DB, {
      userId: alice,
      createdBy: "local",
    });
    if (!link) throw new Error("no link");
    expect(await resetAction(link.token, "alice-new-password")).toEqual({
      saved: true,
    });
    expect(await passwordWorks("bob@example.com", "old-password")).toBe(true);
    expect(await passwordWorks("bob@example.com", "alice-new-password")).toBe(
      false,
    );
    expect(await sessionsOf(bob)).toBe(1);
  });

  it("is never issued for the owner, an unverified member or an unknown id", async () => {
    const pending = await member("pending@example.com", 0);
    expect(
      await issuePasswordReset(env.DB, { userId: "local", createdBy: "local" }),
    ).toBeNull();
    for (const user of [pending, "usr_nobody"]) {
      expect(
        await peopleAction({ intent: "reset-password", user }),
      ).toMatchObject({ resetError: { userId: user } });
    }
    expect(await latestPasswordResets(env.DB)).toEqual([]);
    await expect(
      peopleAction({ intent: "reset-password", user: "local" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("is not issued by a member, for themselves or anyone", async () => {
    const alice = await member("alice@example.com");
    const bob = await member("bob@example.com");
    await expect(
      peopleAction({ intent: "reset-password", user: bob }, alice),
    ).rejects.toMatchObject({ status: 404 });
    expect(await latestPasswordResets(env.DB)).toEqual([]);
  });

  it("refuses a cross-origin form post", async () => {
    const userId = await member("cross@example.com");
    const link = await issuePasswordReset(env.DB, {
      userId,
      createdBy: "local",
    });
    if (!link) throw new Error("no link");
    const url = new URL(`${ORIGIN}/reset-password/${link.token}`);
    await expect(
      reset({
        context: context(),
        request: new Request(url, {
          method: "POST",
          headers: { origin: "https://evil.test" },
          body: new URLSearchParams({
            password: "attacker-pass",
            confirm_password: "attacker-pass",
          }),
        }),
        params: { token: link.token },
        url,
        pattern: "/reset-password/:token",
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await redeemPasswordReset(env.DB, {
        token: link.token,
        passwordHash: await hashPassword("legit-password"),
      }),
    ).toBe(userId);
  });
});
