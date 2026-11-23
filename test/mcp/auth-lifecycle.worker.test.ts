import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  listBearerTokens,
  mintBearerToken,
  resolveBearerToken,
  revokeBearerToken,
} from "~/concepts/tokens";
import {
  createSessionCookie,
  destroySessionCookie,
  getUser,
} from "~/lib/auth.server";

const tokenEnv = { DB: env.DB, TOKEN_PEPPER: "test-token-pepper" };
const sessionEnv = { DB: env.DB, SESSION_SECRET: "test-session-secret" };

afterEach(async () => {
  await env.DB.prepare("DELETE FROM bearer_token_scopes").run();
  await env.DB.prepare("DELETE FROM bearer_tokens").run();
  await env.DB.prepare("DELETE FROM sessions").run();
});

describe("bearer token lifecycle", () => {
  it("mints a one-time credential and resolves safe canonical metadata", async () => {
    const minted = await mintBearerToken(tokenEnv, {
      userId: "local",
      label: "Laptop deploy script",
      scopes: ["skills:write", "search:read", "skills:write"],
    });

    expect(minted.token).toMatch(/^vls_[A-Za-z0-9_-]{43}$/);
    expect(minted.record).toEqual({
      tokenId: expect.any(String),
      userId: "local",
      label: "Laptop deploy script",
      scopes: ["search:read", "skills:write"],
      createdAt: expect.any(Number),
      revokedAt: null,
    });
    expect(minted.record).not.toHaveProperty("tokenDigest");

    const stored = await env.DB.prepare(
      "SELECT token_digest FROM bearer_tokens WHERE token_id = ?",
    )
      .bind(minted.record.tokenId)
      .first<{ token_digest: string }>();
    expect(stored?.token_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.token_digest).not.toBe(minted.token);

    await expect(resolveBearerToken(tokenEnv, minted.token)).resolves.toEqual(
      minted.record,
    );
    await expect(listBearerTokens(tokenEnv, "local")).resolves.toEqual([
      minted.record,
    ]);
  });

  it("rejects invalid token requests and unusable credentials", async () => {
    await expect(
      mintBearerToken(tokenEnv, {
        userId: "local",
        label: "   ",
        scopes: ["search:read"],
      }),
    ).rejects.toThrow("label");
    await expect(
      mintBearerToken(tokenEnv, {
        userId: "local",
        label: "x".repeat(121),
        scopes: ["search:read"],
      }),
    ).rejects.toThrow("label");
    await expect(
      mintBearerToken(tokenEnv, {
        userId: "local",
        label: "CLI",
        scopes: [],
      }),
    ).rejects.toThrow("scope");
    await expect(
      mintBearerToken(tokenEnv, {
        userId: "local",
        label: "CLI",
        scopes: ["unknown:scope"],
      }),
    ).rejects.toThrow("scope");
    await expect(resolveBearerToken(tokenEnv, "vls_short")).resolves.toBeNull();
  });

  it("revokes only the owner and remains revoked when repeated", async () => {
    const minted = await mintBearerToken(tokenEnv, {
      userId: "local",
      label: "CLI",
      scopes: ["search:read"],
    });

    await expect(
      revokeBearerToken(tokenEnv, {
        userId: "another-user",
        tokenId: minted.record.tokenId,
      }),
    ).resolves.toEqual({ revoked: false });
    await expect(
      resolveBearerToken(tokenEnv, minted.token),
    ).resolves.not.toBeNull();

    const request = { userId: "local", tokenId: minted.record.tokenId };
    await expect(revokeBearerToken(tokenEnv, request)).resolves.toEqual({
      revoked: true,
    });
    await expect(revokeBearerToken(tokenEnv, request)).resolves.toEqual({
      revoked: true,
    });
    await expect(
      resolveBearerToken(tokenEnv, minted.token),
    ).resolves.toBeNull();

    const withoutScopes = await mintBearerToken(tokenEnv, {
      userId: "local",
      label: "Broken scope fixture",
      scopes: ["search:read"],
    });
    await env.DB.prepare("DELETE FROM bearer_token_scopes WHERE token_id = ?")
      .bind(withoutScopes.record.tokenId)
      .run();
    await expect(
      resolveBearerToken(tokenEnv, withoutScopes.token),
    ).resolves.toBeNull();
  });
});

describe("browser sessions", () => {
  it("accepts signed, unexpired cookies and cleans up expired sessions", async () => {
    const cookie = await createSessionCookie(
      sessionEnv,
      new Request("https://valise.run/login"),
      "local",
    );
    const requestCookie = cookie.split(";", 1)[0];
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=2592000");
    expect(cookie).toContain("Secure");
    await expect(
      getUser(
        sessionEnv,
        new Request("https://valise.run/connections", {
          headers: { cookie: requestCookie },
        }),
      ),
    ).resolves.toEqual({ userId: "local" });

    await expect(
      getUser(
        sessionEnv,
        new Request("https://valise.run/connections", {
          headers: { cookie: `${requestCookie}x` },
        }),
      ),
    ).resolves.toBeNull();

    const sessionId = requestCookie.split("=")[1].split(".")[0];
    await env.DB.prepare(
      "UPDATE sessions SET expires_at = 0 WHERE session_id = ?",
    )
      .bind(sessionId)
      .run();
    await expect(
      getUser(
        sessionEnv,
        new Request("https://valise.run/connections", {
          headers: { cookie: requestCookie },
        }),
      ),
    ).resolves.toBeNull();
    await expect(
      env.DB.prepare("SELECT session_id FROM sessions WHERE session_id = ?")
        .bind(sessionId)
        .first(),
    ).resolves.toBeNull();
  });

  it("deletes a valid session and expires its cookie", async () => {
    const cookie = await createSessionCookie(
      sessionEnv,
      new Request("http://localhost/login"),
      "local",
    );
    const requestCookie = cookie.split(";", 1)[0];
    const expired = await destroySessionCookie(
      sessionEnv,
      new Request("http://localhost/logout", {
        headers: { cookie: requestCookie },
      }),
    );

    expect(expired).toContain("Max-Age=0");
    expect(expired).not.toContain("Secure");
    await expect(
      getUser(
        sessionEnv,
        new Request("http://localhost/connections", {
          headers: { cookie: requestCookie },
        }),
      ),
    ).resolves.toBeNull();
    const sessionId = requestCookie.split("=")[1].split(".")[0];
    await expect(
      env.DB.prepare("SELECT session_id FROM sessions WHERE session_id = ?")
        .bind(sessionId)
        .first(),
    ).resolves.toBeNull();
  });
});
