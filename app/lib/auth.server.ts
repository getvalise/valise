import {
  AuthorizationError,
  type ConsentDescription,
  getOAuthApi,
} from "@cloudflare/workers-oauth-provider";
import {
  chromeExtensionGrant,
  chromeExtensionId,
} from "~/auth/chrome-extension";
import { consentGrant, type McpScope, WHOLE_CASE_SCOPES } from "~/auth/scopes";
import { recordAuthEvent } from "~/concepts/activity";
import {
  type GoogleEnv,
  googleEnabled,
  googleSignInPath,
} from "~/lib/google.server";
import { type OAuthEnv, oauthOptions } from "../../workers/oauth";

type AuthEnv = OAuthEnv &
  GoogleEnv & {
    SESSION_SECRET?: string;
    VALISE_ADMIN_PASSWORD?: string;
  };

const SESSION_COOKIE_NAME = "valise_session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_VALUE_PATTERN = /^(ses_[0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;

export type SessionEnv = {
  DB: D1Database;
  SESSION_SECRET: string;
};

export type PasswordSessionEnv = SessionEnv & {
  VALISE_ADMIN_PASSWORD?: string;
};

export type BrowserUser = { userId: string };

/**
 * The initial single-user authorization screen. A deployment supplies the
 * password as a Worker secret; no credentials are accepted from MCP clients.
 */
export async function handleAuthorization(
  request: Request,
  env: AuthEnv,
  defaultHandler: ExportedHandler<OAuthEnv>,
): Promise<Response> {
  const oauth = getOAuthApi(oauthOptions(env, defaultHandler), env);
  try {
    if (request.method === "GET") {
      const authorization = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authorization);
      const consent = await oauth.beginConsent(authorization);
      consent.headers.set("content-type", "text/html; charset=utf-8");
      const url = new URL(request.url);
      const googleHref = googleEnabled(env)
        ? googleSignInPath(`${url.pathname}${url.search}`)
        : null;
      const { extensionId, scope } = grantFor(
        authorization.redirectUri,
        authorization.scope,
      );
      return new Response(
        consentPage(
          details,
          extensionId,
          scope,
          consent.handle,
          await sessionUser(env, request),
          googleHref,
        ),
        {
          headers: consent.headers,
        },
      );
    }
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });

    const form = await request.formData();
    const existingUser = await sessionUser(env, request);
    if (
      form.get("decision") !== "approve" ||
      (existingUser === null &&
        !(await hasAdminPassword(String(form.get("password") ?? ""), env)))
    ) {
      await recordAuthEvent(env, request, {
        kind: "oauth_denied",
        userId: existingUser?.userId ?? null,
        detail:
          form.get("decision") === "approve"
            ? "wrong administrator password"
            : "declined at the consent screen",
      });
      return new Response("Authorization denied", { status: 403 });
    }
    // No scope override here: an extension's grant depends on what it asked
    // for, which an override would replace.
    const approved = await oauth.approveConsent(
      request,
      String(form.get("handle") ?? ""),
    );
    // The handle resolves to the request it was issued for, so this is the
    // redirect the provider delivers the code to, checked against the client.
    const { extensionId, scope } = grantFor(
      approved.request.redirectUri,
      approved.request.scope,
    );
    const userId = existingUser?.userId ?? "local";
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId,
      metadata: {},
      scope,
      // The MCP handler admits this extension's Origin for this grant only.
      props:
        extensionId === null
          ? { userId }
          : { userId, chromeExtensionId: extensionId },
    });
    await recordAuthEvent(env, request, {
      kind: "oauth_grant",
      userId,
      subject: approved.request.clientId,
      detail: scope.join(" "),
    });
    if (existingUser === null && env.SESSION_SECRET) {
      approved.headers.append(
        "set-cookie",
        await createSessionCookie(
          { DB: env.DB, SESSION_SECRET: env.SESSION_SECRET },
          request,
          "local",
        ),
      );
    }
    approved.headers.set("location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError) {
      return new Response(error.description, {
        status: 400,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    throw error;
  }
}

/**
 * The grant a consent produces: a Chrome extension gets the capture scopes
 * plus what it asked for, for its own id; any other client gets what
 * `consentGrant` makes of its request.
 */
function grantFor(
  redirectUri: string,
  requested: string[],
): { extensionId: string | null; scope: McpScope[] } {
  const extensionId = chromeExtensionId(redirectUri);
  return extensionId === null
    ? { extensionId, scope: consentGrant(requested) }
    : { extensionId, scope: chromeExtensionGrant(requested) };
}

/**
 * What each granted scope lets a connected client do, in the words of the
 * person approving it rather than the words of the protocol.
 */
const SCOPE_SENTENCES: Record<McpScope, string> = {
  "search:read": "Search everything in the case and read what it finds.",
  "todos:read": "See which to-dos are ready to pick up.",
  "todos:write": "Create, claim, update, and close to-dos.",
  "memories:read": "Read saved memories.",
  "memories:write": "Save new memories.",
  "skills:read": "Read your skills and load their instructions.",
  "skills:write": "Publish a new version of a skill.",
  "config:read": "Read the text your hooks inject at session start and stop.",
  "config:write":
    "Add, change, or remove the text your hooks inject at session start and stop.",
  "assets:read": "Download the files you uploaded.",
  "assets:write":
    "Upload files and change their titles, descriptions and expiry, never their bytes.",
  "sources:read": "Export your library of sources and their history.",
  "sources:write": "Save bookmarks, notes and file references as sources.",
  "transcripts:read": "Read the session transcripts your machines sent.",
  "transcripts:write": "Send session transcripts from this machine.",
  "hooks:exec":
    "Run the hooks you approved on this machine, and report how each run went.",
};

function consentPage(
  details: ConsentDescription,
  extensionId: string | null,
  granted: readonly McpScope[],
  handle: string,
  user: BrowserUser | null,
  googleHref: string | null,
): string {
  const scopes = granted
    .map(
      (scope) =>
        `<li><code>${escapeHtml(scope)}</code><span>${escapeHtml(
          SCOPE_SENTENCES[scope],
        )}</span></li>`,
    )
    .join("");
  const localWarning = details.redirectIsLoopback
    ? '<p class="warn">This sends access to an application running on your own computer. Any local process can claim this name.</p>'
    : "";
  const authentication =
    user === null
      ? '<label>Administrator password<input type="password" name="password" autocomplete="current-password" required></label>'
      : '<p class="muted">You are signed in to Valise.</p>';
  const google =
    user === null && googleHref !== null
      ? `<p class="auth-or">or</p><a class="button ghost google" href="${escapeHtml(googleHref)}"><img alt="" height="16" src="/google-g.svg" width="16">Continue with Google</a>`
      : "";
  const coverage = WHOLE_CASE_SCOPES.every((scope) => granted.includes(scope))
    ? "<p>One approval covers the whole case. This client will not ask again:</p>"
    : "<p>This client asked for part of the case. It can do these things and nothing else:</p>";
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${escapeHtml(details.clientName)}</title>
<link rel="stylesheet" href="/valise.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<main class="shell">
<section class="card auth-card">
  <p class="eyebrow">Valise</p>
  ${
    extensionId === null
      ? `<h1>Allow ${escapeHtml(details.clientName)} to open the case?</h1>
  <p>Tokens go to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
  ${localWarning}
  ${coverage}`
      : `<h1>Allow the Chrome extension ${escapeHtml(details.clientName)} to save captures?</h1>
  <p>Tokens go only to the Chrome extension <code>${extensionId}</code> in this browser. Check that id on <code>chrome://extensions</code>.</p>
  <p>This connection can do these things and nothing else:</p>`
  }
  <ul class="scope-list">${scopes}</ul>
  <form class="stack" method="post">
    <input type="hidden" name="handle" value="${escapeHtml(handle)}">
    ${authentication}
    <div class="row">
      <button name="decision" value="approve">Allow</button>
      <button class="ghost" name="decision" value="deny">Deny</button>
    </div>
  </form>
  ${google}
  <p class="muted">Revoke this connection any time on the Connections page.</p>
</section>
</main>
</html>`;
}

async function sessionUser(
  env: AuthEnv,
  request: Request,
): Promise<BrowserUser | null> {
  if (!env.SESSION_SECRET) return null;
  return getUser({ DB: env.DB, SESSION_SECRET: env.SESSION_SECRET }, request);
}

async function hasAdminPassword(
  value: string,
  env: { VALISE_ADMIN_PASSWORD?: string },
): Promise<boolean> {
  const configured = env.VALISE_ADMIN_PASSWORD;
  if (!configured || configured.length < 16) return false;
  const encoder = new TextEncoder();
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(value)),
    crypto.subtle.digest("SHA-256", encoder.encode(configured)),
  ]);
  const left = new Uint8Array(actual);
  const right = new Uint8Array(expected);
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export async function createPasswordSession(
  env: PasswordSessionEnv,
  request: Request,
  password: string,
): Promise<string | null> {
  if (!(await hasAdminPassword(password, env))) return null;
  return createSessionCookie(env, request, "local");
}

/**
 * Sign in a member with their email and password.
 * Returns a session cookie, or null if the credentials are wrong.
 */
export async function createMemberPasswordSession(
  env: PasswordSessionEnv & { DB: D1Database },
  request: Request,
  email: string,
  password: string,
): Promise<string | null> {
  const { getUserForPasswordAuth } = await import("~/concepts/users");
  const { verifyPassword } = await import("~/lib/password.server");
  const user = await getUserForPasswordAuth(env.DB, email);
  if (user === null || user.passwordHash === null || !user.emailVerified)
    return null;
  if (!(await verifyPassword(password, user.passwordHash))) return null;
  return createSessionCookie(env, request, user.userId);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) => `&#${character.charCodeAt(0)};`,
  );
}

export async function createSessionCookie(
  env: SessionEnv,
  request: Request,
  userId: string,
): Promise<string> {
  if (!userId.trim()) throw new Error("A session requires a user id.");
  const sessionId = `ses_${crypto.randomUUID()}`;
  const createdAt = nowSeconds();
  const expiresAt = createdAt + SESSION_TTL_SECONDS;
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
  )
    .bind(sessionId, userId, createdAt, expiresAt)
    .run();
  return sessionCookie(
    request,
    `${sessionId}.${await sessionSignature(sessionId, env.SESSION_SECRET)}`,
    SESSION_TTL_SECONDS,
  );
}

export async function getUser(
  env: SessionEnv,
  request: Request,
): Promise<BrowserUser | null> {
  const sessionId = await verifiedSessionId(env.SESSION_SECRET, request);
  if (sessionId === null) return null;
  const session = await env.DB.prepare(
    `SELECT s.user_id AS userId, s.expires_at AS expiresAt
         FROM sessions s JOIN users u ON u.user_id = s.user_id
        WHERE session_id = ? AND (u.role = 'owner' OR u.email_verified = 1)`,
  )
    .bind(sessionId)
    .first<{ userId: string; expiresAt: number }>();
  if (session === null) return null;
  if (session.expiresAt <= nowSeconds()) {
    await env.DB.prepare(
      "DELETE FROM sessions WHERE session_id = ? AND expires_at <= ?",
    )
      .bind(sessionId, nowSeconds())
      .run();
    return null;
  }
  return { userId: session.userId };
}

export async function destroySessionCookie(
  env: SessionEnv,
  request: Request,
): Promise<string> {
  const sessionId = await verifiedSessionId(env.SESSION_SECRET, request);
  if (sessionId !== null) {
    await env.DB.prepare("DELETE FROM sessions WHERE session_id = ?")
      .bind(sessionId)
      .run();
  }
  return sessionCookie(request, "", 0);
}

export async function requireUser(
  env: SessionEnv,
  request: Request,
): Promise<BrowserUser> {
  const user = await getUser(env, request);
  if (user !== null) return user;
  const requestUrl = new URL(request.url);
  const login = new URL("/login", requestUrl.origin);
  login.searchParams.set("next", `${requestUrl.pathname}${requestUrl.search}`);
  throw Response.redirect(login.toString(), 302);
}

/** A value a cookie can carry without the browser being able to change it. */
export async function signValue(
  value: string,
  secret: string,
): Promise<string> {
  const payload = base64Url(new TextEncoder().encode(value));
  return `${payload}.${await sessionSignature(payload, secret)}`;
}

export async function verifyValue(
  signed: string,
  secret: string,
): Promise<string | null> {
  const [payload, encodedSignature, ...rest] = signed.split(".");
  if (encodedSignature === undefined || rest.length > 0) return null;
  const signature = base64UrlBytes(encodedSignature);
  const bytes = base64UrlBytes(payload);
  if (signature === null || bytes === null) return null;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await sessionKey(secret, "verify"),
    signature,
    new TextEncoder().encode(payload),
  );
  return valid ? new TextDecoder().decode(bytes) : null;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  let found: string | null = null;
  for (const part of header.split(";")) {
    const [cookieName, ...value] = part.trim().split("=");
    if (cookieName !== name) continue;
    if (found !== null) return null;
    found = value.join("=");
  }
  return found;
}

/** The signed-in browser's session id, so a credential change can keep it. */
export async function currentSessionId(
  env: SessionEnv,
  request: Request,
): Promise<string | null> {
  return verifiedSessionId(env.SESSION_SECRET, request);
}

async function verifiedSessionId(
  secret: string,
  request: Request,
): Promise<string | null> {
  const value = readCookie(request, SESSION_COOKIE_NAME);
  const match = value === null ? null : SESSION_VALUE_PATTERN.exec(value);
  if (match === null) return null;
  const signature = base64UrlBytes(match[2]);
  if (signature === null) return null;
  const key = await sessionKey(secret, "verify");
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(match[1]),
  );
  return valid ? match[1] : null;
}

async function sessionSignature(
  sessionId: string,
  secret: string,
): Promise<string> {
  const key = await sessionKey(secret, "sign");
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(sessionId),
  );
  return base64Url(new Uint8Array(signature));
}

async function sessionKey(
  secret: string,
  usage: "sign" | "verify",
): Promise<CryptoKey> {
  if (!secret) throw new Error("SESSION_SECRET is required.");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

function sessionCookie(
  request: Request,
  value: string,
  maxAge: number,
): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function base64UrlBytes(value: string): Uint8Array | null {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
