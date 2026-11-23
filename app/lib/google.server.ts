import { adminEmailSet } from "~/concepts/users";
import { readCookie, signValue, verifyValue } from "~/lib/auth.server";

/**
 * Console sign-in with Google. The standard OAuth code flow. This module
 * verifies an email and hands it back; who that email signs in as is
 * `resolveSignIn` in `app/concepts/users.ts`: `VALISE_ADMIN_EMAILS` names the
 * owner and the other admins, everyone else needs an account or an invite. ADR-0004, ADR-0016.
 */
export type GoogleEnv = {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  VALISE_ADMIN_EMAILS?: string;
  SESSION_SECRET?: string;
};

export type GoogleCallbackError =
  | "missing-params"
  | "bad-state"
  | "token-exchange-failed"
  | "userinfo-failed"
  | "no-verified-email";

export type GoogleCallbackResult =
  | {
      ok: true;
      email: string;
      next: string;
      /** The `/join/<code>` the sign-in started from, if it did. */
      invite: string | null;
    }
  | { ok: false; error: GoogleCallbackError; email?: string };

const STATE_COOKIE = "valise_google_state";
const STATE_TTL_SECONDS = 600;

/**
 * Google is offered when the client is configured. Admission is no longer
 * the allowlist's job alone: with no allowlist and no invites a deployment
 * admits nobody, which is the same safety by a different route. ADR-0016.
 */
export function googleEnabled(env: GoogleEnv): env is ConfiguredGoogleEnv {
  return Boolean(
    configured(env.GOOGLE_CLIENT_ID) &&
      configured(env.GOOGLE_CLIENT_SECRET) &&
      env.SESSION_SECRET,
  );
}

/** `scripts/first-deploy.sh` stores `none` for a secret it was not given. */
function configured(value: string | undefined): boolean {
  return Boolean(value) && value !== "none";
}

type ConfiguredGoogleEnv = Omit<Required<GoogleEnv>, "VALISE_ADMIN_EMAILS"> &
  Pick<GoogleEnv, "VALISE_ADMIN_EMAILS">;

export function googleSignInPath(next: string, invite?: string): string {
  const params = new URLSearchParams({ next });
  if (invite) params.set("invite", invite);
  return `/auth/google?${params}`;
}

export async function googleAuthRedirect(
  env: ConfiguredGoogleEnv,
  request: Request,
  next: string,
  invite: string | null = null,
): Promise<{ url: string; stateCookie: string }> {
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl(request),
    response_type: "code",
    scope: "openid email",
    state,
    prompt: "select_account",
  });
  const signed = await signValue(
    JSON.stringify({ state, next, invite }),
    env.SESSION_SECRET,
  );
  return {
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    stateCookie: stateCookie(request, signed, STATE_TTL_SECONDS),
  };
}

export function clearStateCookie(request: Request): string {
  return stateCookie(request, "", 0);
}

/**
 * Checks the state and trades the code for the verified email. `next` is
 * returned unchecked; the caller owns keeping redirects on this origin, and
 * owns deciding whether the email may sign in.
 */
export async function handleGoogleCallback(
  env: ConfiguredGoogleEnv,
  request: Request,
  fetcher: typeof fetch = fetch,
): Promise<GoogleCallbackResult> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return { ok: false, error: "missing-params" };

  const cookie = readCookie(request, STATE_COOKIE);
  const stored =
    cookie === null
      ? null
      : await verifyValue(decodeURIComponent(cookie), env.SESSION_SECRET);
  const expected = parseState(stored);
  if (expected === null || expected.state !== state) {
    return { ok: false, error: "bad-state" };
  }

  const tokenResponse = await fetcher("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: callbackUrl(request),
    }),
  });
  if (!tokenResponse.ok) return { ok: false, error: "token-exchange-failed" };
  const { access_token: accessToken } = (await tokenResponse.json()) as {
    access_token?: string;
  };
  if (!accessToken) return { ok: false, error: "token-exchange-failed" };

  const infoResponse = await fetcher(
    "https://openidconnect.googleapis.com/v1/userinfo",
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!infoResponse.ok) return { ok: false, error: "userinfo-failed" };
  const info = (await infoResponse.json()) as {
    email?: string;
    email_verified?: boolean;
  };
  if (!info.email || info.email_verified !== true) {
    return { ok: false, error: "no-verified-email" };
  }
  return {
    ok: true,
    email: normalizeEmail(info.email),
    next: expected.next,
    invite: expected.invite,
  };
}

/** The admin addresses, as `VALISE_ADMIN_EMAILS` lists them. */
export function allowedEmails(env: GoogleEnv): Set<string> {
  return adminEmailSet(env.VALISE_ADMIN_EMAILS);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function parseState(
  value: string | null,
): { state: string; next: string; invite: string | null } | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as {
      state?: unknown;
      next?: unknown;
      invite?: unknown;
    };
    return typeof parsed.state === "string" && typeof parsed.next === "string"
      ? {
          state: parsed.state,
          next: parsed.next,
          invite: typeof parsed.invite === "string" ? parsed.invite : null,
        }
      : null;
  } catch {
    return null;
  }
}

function callbackUrl(request: Request): string {
  return `${new URL(request.url).origin}/auth/google/callback`;
}

function stateCookie(request: Request, value: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${STATE_COOKIE}=${encodeURIComponent(value)}; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
