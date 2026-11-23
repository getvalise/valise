import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_SKILLS, syncBuiltinSkills } from "~/concepts/builtin-skills";
import { getSkill } from "~/concepts/skills";
import { mintBearerToken } from "~/concepts/tokens";
import {
  getUser as account,
  createInvite,
  createUserWithPassword,
  findInvite,
  resolveSignIn,
  VERIFICATION_TTL_SECONDS,
} from "~/concepts/users";
import { consoleContext, consoleIdentity } from "~/console/context.server";
import {
  createMemberPasswordSession,
  createSessionCookie,
  getUser,
} from "~/lib/auth.server";
import { emailSender, sendVerificationEmail } from "~/lib/email.server";
import { verifyUserEmail } from "~/lib/member-verification.server";
import { hashPassword, verifyPassword } from "~/lib/password.server";
import { action as join } from "~/routes/join";
import { action as login } from "~/routes/login";
import { action as verify } from "~/routes/verify-email";
import { authorizeBearer } from "../../workers/config";
import { mcpHandler } from "../../workers/mcp";

vi.mock("~/lib/email.server", async (original) => ({
  ...(await original<typeof import("~/lib/email.server")>()),
  sendVerificationEmail: vi.fn(async () => {}),
}));

const PASSWORD = "an original password for this signup";
const SESSION_SECRET = "account-repair-test-session-secret";
const settings = {
  ...env,
  SESSION_SECRET,
  EMAIL_API_KEY: "test-only-no-email",
  VALISE_ADMIN_PASSWORD: "local-test-password-for-oauth",
};
const sessionEnv = { DB: env.DB, SESSION_SECRET };

function request(
  path: string,
  fields: Record<string, string>,
  origin = "https://valise.test",
) {
  return new Request(`https://valise.test${path}`, {
    method: "POST",
    headers: { origin },
    body: new URLSearchParams(fields),
  });
}

function args(request: Request, code = "", override = {}) {
  const context = new RouterContextProvider();
  const ctx = createExecutionContext();
  context.set(consoleContext, { env: { ...settings, ...override }, ctx });
  return {
    context,
    ctx,
    request,
    url: new URL(request.url),
    params: { code, token: code },
    pattern: "/",
  };
}

async function pending(
  email = "friend@example.com",
  now = Math.floor(Date.now() / 1000),
) {
  const invite = await createInvite(
    env.DB,
    { createdBy: "local", label: "Friend", email },
    now,
  );
  const result = await createUserWithPassword(
    env.DB,
    {
      email,
      inviteCode: invite.code,
      passwordHash: await hashPassword(PASSWORD),
      verificationToken: crypto.randomUUID(),
    },
    now,
  );
  if (!result.ok) throw new Error(result.error);
  const row = await env.DB.prepare(
    "SELECT verification_token AS token FROM users WHERE user_id = ?",
  )
    .bind(result.user.userId)
    .first<{ token: string }>();
  return { user: result.user, invite, token: row?.token ?? "" };
}

beforeEach(async () => {
  vi.mocked(sendVerificationEmail).mockClear();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM search_docs WHERE concept = 'skill'"),
    env.DB.prepare("DELETE FROM skill_versions"),
    env.DB.prepare("DELETE FROM skills"),
    env.DB.prepare("DELETE FROM invites"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM auth_events"),
    env.DB.prepare("DELETE FROM mcp_calls"),
    env.DB.prepare("DELETE FROM users WHERE user_id <> 'local'"),
  ]);
});

describe("password signup admission", () => {
  it("hashes with independent salts and refuses the wrong password", async () => {
    const one = await hashPassword(PASSWORD);
    expect(await hashPassword(PASSWORD)).not.toBe(one);
    expect(await verifyPassword(PASSWORD, one)).toBe(true);
    expect(await verifyPassword("wrong", one)).toBe(false);
  });

  it("creates only a pending account and sends verification, never a session", async () => {
    const invite = await createInvite(env.DB, {
      createdBy: "local",
      label: "Alice",
    });
    const input = args(
      request(`/join/${invite.code}`, {
        email: "alice@example.com",
        password: PASSWORD,
        confirm_password: PASSWORD,
      }),
      invite.code,
    );
    expect(await join(input)).toEqual({ pending: true });
    expect(sendVerificationEmail).toHaveBeenCalledOnce();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first("n"),
    ).toBe(0);
    expect(await findInvite(env.DB, invite.code)).toMatchObject({
      status: "redeemed",
    });
  });

  it("lets multiple friends register through the same group URL with separate verification", async () => {
    const invite = await createInvite(env.DB, {
      createdBy: "local",
      reusable: true,
    });
    const tokens = new Set<string>();
    for (const name of ["alice", "bob"]) {
      const input = args(
        request(`/join/${invite.code}`, {
          email: `${name}@example.com`,
          password: PASSWORD,
          confirm_password: PASSWORD,
        }),
        invite.code,
      );
      expect(await join(input)).toEqual({ pending: true });
      const user = await account(
        env.DB,
        (await env.DB.prepare("SELECT user_id FROM users WHERE email = ?")
          .bind(`${name}@example.com`)
          .first<string>("user_id")) ?? "",
      );
      expect(user).toMatchObject({
        emailVerified: false,
        inviteId: invite.inviteId,
      });
      const call = vi.mocked(sendVerificationEmail).mock.calls.at(-1);
      expect(call?.[1]).toBe(`${name}@example.com`);
      tokens.add(call?.[2] ?? "");
    }
    expect(tokens.size).toBe(2);
    expect(tokens.has("")).toBe(false);
    expect(await findInvite(env.DB, invite.code)).toMatchObject({
      status: "open",
      useCount: 2,
    });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first("n"),
    ).toBe(0);
  });

  it("refuses signup cross-origin before redeeming the invite", async () => {
    const invite = await createInvite(env.DB, {
      createdBy: "local",
      label: "Alice",
    });
    await expect(
      join(
        args(
          request(
            `/join/${invite.code}`,
            {
              email: "alice@example.com",
              password: PASSWORD,
              confirm_password: PASSWORD,
            },
            "https://evil.example",
          ),
          invite.code,
        ),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(await findInvite(env.DB, invite.code)).toMatchObject({
      status: "open",
    });
  });

  it("does not consume the invite when email is not configured", async () => {
    const invite = await createInvite(env.DB, {
      createdBy: "local",
      label: "Alice",
    });
    expect(
      await join(
        args(
          request(`/join/${invite.code}`, {
            email: "alice@example.com",
            password: PASSWORD,
            confirm_password: PASSWORD,
          }),
          invite.code,
          { EMAIL_API_KEY: "" },
        ),
      ),
    ).toHaveProperty("error");
    expect(await findInvite(env.DB, invite.code)).toMatchObject({
      status: "open",
    });
  });

  it("reports delivery failure without admitting the pending account", async () => {
    vi.mocked(sendVerificationEmail).mockRejectedValueOnce(
      new Error("provider unavailable"),
    );
    const invite = await createInvite(env.DB, {
      createdBy: "local",
      label: "Alice",
    });
    expect(
      await join(
        args(
          request(`/join/${invite.code}`, {
            email: "alice@example.com",
            password: PASSWORD,
            confirm_password: PASSWORD,
          }),
          invite.code,
        ),
      ),
    ).toHaveProperty("error");
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first("n"),
    ).toBe(0);
  });

  it("refuses password sign-in and legacy sessions while unverified", async () => {
    const { user } = await pending();
    const req = new Request("https://valise.test/login");
    expect(
      await createMemberPasswordSession(
        sessionEnv,
        req,
        user.email ?? "",
        PASSWORD,
      ),
    ).toBeNull();
    const cookie = await createSessionCookie(sessionEnv, req, user.userId);
    expect(
      await getUser(sessionEnv, new Request(req.url, { headers: { cookie } })),
    ).toBeNull();
  });

  it("cannot pre-register a victim email and auto-link their Google identity", async () => {
    const { user, token } = await pending("victim@example.com");
    expect(
      await resolveSignIn(env.DB, {
        email: "victim@example.com",
        adminEmails: [],
      }),
    ).toEqual({ ok: false, error: "email-unverified" });
    // A victim clicking an unsolicited link without the attacker's password cannot activate it.
    expect(
      await verifyUserEmail(env.DB, token, "victim's different password"),
    ).toBeNull();
    expect(await account(env.DB, user.userId)).toMatchObject({
      emailVerified: false,
    });
  });

  it("rejects existing OAuth and bearer access while pending and records the MCP refusal", async () => {
    const { user } = await pending();
    const ctx = createExecutionContext();
    Object.assign(ctx, {
      auth: { clientId: "legacy-client", scope: ["search:read"] },
      props: { userId: user.userId },
    });
    const response = await mcpHandler.fetch(
      new Request("https://valise.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(401);
    await response.text();
    await waitOnExecutionContext(ctx);
    expect(
      await env.DB.prepare("SELECT user_id, outcome FROM mcp_calls").first(),
    ).toMatchObject({ user_id: user.userId, outcome: "unauthorized" });
    const bearerEnv = { DB: env.DB, TOKEN_PEPPER: "test-only-pepper" };
    const minted = await mintBearerToken(bearerEnv, {
      userId: user.userId,
      label: "legacy",
      scopes: ["config:read"],
    });
    const refusal = await authorizeBearer(
      new Request("https://valise.test/config/hooks", {
        headers: { authorization: `Bearer ${minted.token}` },
      }),
      { ...env, ...bearerEnv },
      ["config:read"],
    );
    expect(refusal).toBeInstanceOf(Response);
    expect((refusal as Response).status).toBe(401);
  });

  it("requires token and original password and consumes the token exactly once", async () => {
    const { user, token } = await pending();
    expect(await verifyUserEmail(env.DB, "wrong-token", PASSWORD)).toBeNull();
    expect(await verifyUserEmail(env.DB, token, PASSWORD)).toMatchObject({
      userId: user.userId,
      emailVerified: true,
    });
    expect(await verifyUserEmail(env.DB, token, PASSWORD)).toBeNull();
    const cookie = await createMemberPasswordSession(
      sessionEnv,
      new Request("https://valise.test/login"),
      user.email ?? "",
      PASSWORD,
    );
    expect(cookie).toContain("valise_session=");
    expect(
      await resolveSignIn(env.DB, { email: user.email ?? "", adminEmails: [] }),
    ).toMatchObject({
      ok: true,
      created: false,
      user: { userId: user.userId },
    });
  });

  it("lets only one concurrent activation consume the token", async () => {
    const { token } = await pending();
    const results = await Promise.all([
      verifyUserEmail(env.DB, token, PASSWORD),
      verifyUserEmail(env.DB, token, PASSWORD),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("expires at seven days, including legacy tokens without expiry", async () => {
    const now = 1_800_000_000;
    const { token } = await pending("expired@example.com", now);
    expect(
      await verifyUserEmail(
        env.DB,
        token,
        PASSWORD,
        now + VERIFICATION_TTL_SECONDS,
      ),
    ).toBeNull();
    expect(
      await verifyUserEmail(
        env.DB,
        token,
        PASSWORD,
        now + VERIFICATION_TTL_SECONDS - 1,
      ),
    ).not.toBeNull();
    const legacy = await pending("legacy@example.com", now);
    await env.DB.prepare(
      "UPDATE users SET verification_expires_at = NULL WHERE user_id = ?",
    )
      .bind(legacy.user.userId)
      .run();
    expect(
      await verifyUserEmail(env.DB, legacy.token, PASSWORD, now),
    ).toBeNull();
  });

  it("verifies by same-origin POST, provisions the member's own builtins and audits the login", async () => {
    const { user, token } = await pending();
    await expect(
      verify(
        args(
          request(
            `/verify-email/${token}`,
            { password: PASSWORD },
            "https://evil.example",
          ),
          token,
        ),
      ),
    ).rejects.toMatchObject({ status: 403 });
    const input = args(
      request(`/verify-email/${token}`, { password: PASSWORD }),
      token,
    );
    const result = await verify(input);
    expect(result).toBeInstanceOf(Response);
    await waitOnExecutionContext(input.ctx);
    const cookie = (result as Response).headers.get("set-cookie") ?? "";
    expect(
      await getUser(
        sessionEnv,
        new Request("https://valise.test/todos", { headers: { cookie } }),
      ),
    ).toEqual({ userId: user.userId });
    const skills = await env.DB.prepare(
      "SELECT name FROM skills WHERE user_id = ? ORDER BY name",
    )
      .bind(user.userId)
      .all<{ name: string }>();
    expect(skills.results.map((row) => row.name)).toEqual(
      BUILTIN_SKILLS.map((skill) => skill.name).sort(),
    );
    expect(
      await env.DB.prepare(
        "SELECT user_id, kind, detail FROM auth_events",
      ).first(),
    ).toMatchObject({
      user_id: user.userId,
      kind: "console_login",
      detail: "password: email verified",
    });
  });

  it("records password login success and failure, with identity from the session only", async () => {
    const { user, token } = await pending();
    await verifyUserEmail(env.DB, token, PASSWORD);
    const bad = args(
      request("/login", { email: user.email ?? "", password: "wrong" }),
    );
    expect(await login(bad)).toEqual({ error: "Invalid credentials." });
    await waitOnExecutionContext(bad.ctx);
    const good = args(
      request("/login", { email: user.email ?? "", password: PASSWORD }),
    );
    const response = (await login(good)) as Response;
    await waitOnExecutionContext(good.ctx);
    const req = new Request("https://valise.test/todos?user=local", {
      headers: {
        cookie: response.headers.get("set-cookie") ?? "",
        "x-valise-user": "local",
      },
    });
    expect(await consoleIdentity(good.context, req)).toMatchObject({
      userId: user.userId,
      displayName: "Friend",
      role: "member",
    });
    const events = await env.DB.prepare(
      "SELECT kind, user_id FROM auth_events ORDER BY rowid",
    ).all();
    expect(events.results).toEqual([
      { kind: "console_login_failed", user_id: null },
      { kind: "console_login", user_id: user.userId },
    ]);
  });

  it("provisions a verified member's own built-ins without touching or sharing owner skills", async () => {
    const indexes = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'skills'",
    ).all<{ name: string }>();
    expect(indexes.results.map((row) => row.name)).not.toContain(
      "skills_name_unique",
    );
    expect(indexes.results.map((row) => row.name)).toContain(
      "skills_user_name_unique",
    );
    expect(
      (await syncBuiltinSkills(env, "local")).every(
        (row) => row.outcome === "published",
      ),
    ).toBe(true);
    const before = await env.DB.prepare(
      "SELECT * FROM skills WHERE user_id = 'local' ORDER BY name",
    ).all();
    const versions = await env.DB.prepare(
      "SELECT * FROM skill_versions ORDER BY skill_id, version",
    ).all();
    const { user, token } = await pending();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const input = args(
        request(`/verify-email/${token}`, { password: PASSWORD }),
        token,
      );
      const activated = (await verify(input)) as Response;
      expect(activated.status).toBe(302);
      await waitOnExecutionContext(input.ctx);
      expect(log).not.toHaveBeenCalled();
      const cookie = activated.headers.get("set-cookie") ?? "";
      expect(
        await getUser(
          sessionEnv,
          new Request("https://valise.test/todos", { headers: { cookie } }),
        ),
      ).toEqual({ userId: user.userId });
      expect(
        (await syncBuiltinSkills(env, user.userId)).map((row) => row.outcome),
      ).toEqual(BUILTIN_SKILLS.map(() => "current"));
      for (const skill of BUILTIN_SKILLS) {
        const memberSkill = await getSkill(env.DB, user.userId, skill.name);
        const ownerSkill = await getSkill(env.DB, "local", skill.name);
        expect(memberSkill).not.toBeNull();
        expect(memberSkill?.skillId).not.toBe(ownerSkill?.skillId);
      }
      expect(
        (
          await env.DB.prepare(
            "SELECT * FROM skills WHERE user_id = 'local' ORDER BY name",
          ).all()
        ).results,
      ).toEqual(before.results);
      expect(
        (
          await env.DB.prepare(
            "SELECT v.* FROM skill_versions v JOIN skills s USING (skill_id) WHERE s.user_id = 'local' ORDER BY skill_id, version",
          ).all()
        ).results,
      ).toEqual(versions.results);
      const signedIn = args(
        request("/login", { email: user.email ?? "", password: PASSWORD }),
      );
      expect(((await login(signedIn)) as Response).status).toBe(302);
      await waitOnExecutionContext(signedIn.ctx);
      expect(
        await resolveSignIn(env.DB, {
          email: user.email ?? "",
          adminEmails: [],
        }),
      ).toMatchObject({
        ok: true,
        created: false,
        user: { userId: user.userId },
      });
    } finally {
      log.mockRestore();
    }
  });
});

describe("email sender", () => {
  it("sends from EMAIL_FROM when an install sets it, and from the hosted default otherwise", () => {
    expect(emailSender({ EMAIL_FROM: "Valise <noreply@self.example>" })).toBe(
      "Valise <noreply@self.example>",
    );
    expect(emailSender({ EMAIL_FROM: "  " })).toBe(
      "Valise <noreply@valise.run>",
    );
    expect(emailSender({})).toBe("Valise <noreply@valise.run>");
  });
});
