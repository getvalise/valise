import { describe, expect, it } from "vitest";
import { signValue, verifyValue } from "~/lib/auth.server";
import {
  allowedEmails,
  googleAuthRedirect,
  googleEnabled,
  handleGoogleCallback,
} from "~/lib/google.server";

const googleEnv = {
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  VALISE_ADMIN_EMAILS: " Owner@Example.com , second@example.com",
  SESSION_SECRET: "test-session-secret",
};

/** Google's token and userinfo endpoints, answering with `userinfo`. */
function google(userinfo: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "access" });
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      return Response.json(userinfo);
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

async function callback(
  userinfo: Record<string, unknown>,
  tamper?: { state?: string },
) {
  const start = new Request("https://valise.test/auth/google?next=/skills");
  const { url, stateCookie } = await googleAuthRedirect(
    googleEnv,
    start,
    "/skills",
  );
  const state = new URL(url).searchParams.get("state") ?? "";
  const cookie = stateCookie.split(";")[0];
  const request = new Request(
    `https://valise.test/auth/google/callback?code=c&state=${tamper?.state ?? state}`,
    { headers: { cookie } },
  );
  return handleGoogleCallback(googleEnv, request, google(userinfo));
}

describe("signed values", () => {
  it("round-trips any length and refuses a changed payload", async () => {
    for (const value of ["", "a", "ab", "abc", '{"next":"/todos?open=x"}']) {
      const signed = await signValue(value, "secret");
      await expect(verifyValue(signed, "secret")).resolves.toBe(value);
    }
    const signed = await signValue("/todos", "secret");
    const [, signature] = signed.split(".");
    const forged = `${btoa("//evil.example").replaceAll("=", "")}.${signature}`;
    await expect(verifyValue(forged, "secret")).resolves.toBeNull();
    await expect(verifyValue(signed, "other-secret")).resolves.toBeNull();
  });
});

describe("Google sign-in", () => {
  it("is offered with a client, allowlist or not (ADR-0016)", () => {
    expect(googleEnabled(googleEnv)).toBe(true);
    expect(googleEnabled({ ...googleEnv, VALISE_ADMIN_EMAILS: " , " })).toBe(
      true,
    );
    expect(googleEnabled({ ...googleEnv, GOOGLE_CLIENT_SECRET: "" })).toBe(
      false,
    );
    expect(googleEnabled({ ...googleEnv, SESSION_SECRET: "" })).toBe(false);
    // first-deploy.sh writes `none` for a secret it was not given.
    expect(googleEnabled({ ...googleEnv, GOOGLE_CLIENT_ID: "none" })).toBe(
      false,
    );
  });

  it("asks Google for an email at this origin's callback", async () => {
    const { url, stateCookie } = await googleAuthRedirect(
      googleEnv,
      new Request("https://valise.test/auth/google"),
      "/todos",
    );
    const params = new URL(url).searchParams;
    expect(params.get("redirect_uri")).toBe(
      "https://valise.test/auth/google/callback",
    );
    expect(params.get("scope")).toBe("openid email");
    expect(stateCookie).toMatch(/HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
  });

  it("returns a verified email lowercased, with no invite when none started it", async () => {
    await expect(
      callback({ email: "OWNER@example.com", email_verified: true }),
    ).resolves.toEqual({
      ok: true,
      email: "owner@example.com",
      next: "/skills",
      invite: null,
    });
  });

  it("hands back any verified email; whether it may sign in is resolveSignIn's call", async () => {
    await expect(
      callback({ email: "someone@example.com", email_verified: true }),
    ).resolves.toEqual({
      ok: true,
      email: "someone@example.com",
      next: "/skills",
      invite: null,
    });
    expect([...allowedEmails(googleEnv)]).toEqual([
      "owner@example.com",
      "second@example.com",
    ]);
  });

  it("carries the invite code from the link through the signed state", async () => {
    const start = new Request("https://valise.test/auth/google");
    const { url, stateCookie } = await googleAuthRedirect(
      googleEnv,
      start,
      "/todos",
      "abc_123-XYZ",
    );
    expect(url).not.toContain("abc_123");
    const state = new URL(url).searchParams.get("state") ?? "";
    const request = new Request(
      `https://valise.test/auth/google/callback?code=c&state=${state}`,
      { headers: { cookie: stateCookie.split(";")[0] } },
    );
    await expect(
      handleGoogleCallback(
        googleEnv,
        request,
        google({ email: "friend@example.com", email_verified: true }),
      ),
    ).resolves.toEqual({
      ok: true,
      email: "friend@example.com",
      next: "/todos",
      invite: "abc_123-XYZ",
    });
  });

  it("refuses an unverified email even when it is allowlisted", async () => {
    await expect(callback({ email: "owner@example.com" })).resolves.toEqual({
      ok: false,
      error: "no-verified-email",
    });
  });

  it("refuses a callback whose state does not match the cookie", async () => {
    await expect(
      callback(
        { email: "owner@example.com", email_verified: true },
        { state: "another" },
      ),
    ).resolves.toEqual({ ok: false, error: "bad-state" });
  });
});
