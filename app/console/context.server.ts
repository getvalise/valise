import { createContext, type RouterContextProvider } from "react-router";
import { type AuthEventRecord, recordAuthEvent } from "~/concepts/activity";
import { provisionBuiltinSkills } from "~/concepts/builtin-skills";
import type { Provenance } from "~/concepts/memories";
import {
  getUserForPasswordAuth,
  getUser as getUserRecord,
  isAdmin,
  OWNER_USER_ID,
  resolveSignIn,
  type SignInRefusal,
  setMemberPassword,
  touchUser,
  type UserRecord,
} from "~/concepts/users";
import {
  type BrowserUser,
  createMemberPasswordSession,
  createPasswordSession,
  createSessionCookie,
  currentSessionId,
  destroySessionCookie,
  getUser,
  type PasswordSessionEnv,
  requireUser,
} from "~/lib/auth.server";
import {
  allowedEmails,
  type GoogleCallbackError,
  type GoogleEnv,
  googleEnabled,
  handleGoogleCallback,
} from "~/lib/google.server";
import { type AdminStore, requireAdminStore } from "~/store/admin.server";
import { requireCredentialStore } from "~/store/credentials.server";
import {
  type BrowserTenantStore,
  requireBrowserStore,
} from "~/store/tenant.server";
import type { OAuthEnv } from "../../workers/oauth";

export type ConsoleEnv = OAuthEnv &
  GoogleEnv &
  Partial<
    Pick<
      Env,
      "AI" | "VALISE_VECTOR_NAMESPACE" | "VECTOR_INDEX" | "TYPESAFE_API_KEY"
    >
  > & {
    SESSION_SECRET?: string;
    VALISE_ADMIN_PASSWORD?: string;
    TOKEN_PEPPER?: string;
    EMAIL_API_KEY?: string;
    EMAIL_FROM?: string;
    /** The Capture Shortcut's iCloud link; `none` hides it. */
    IOS_SHORTCUT_LINK?: string;
    /** Optional inbox provider; users explicitly select OpenRouter before any evidence is sent. */
    OPENROUTER_API_KEY?: string;
    /** skills.sh, overridable so an upstream change is config. V1-16. */
    SKILLS_REGISTRY_URL?: string;
  };

type ConsoleRequestContext = {
  env: ConsoleEnv;
  ctx: ExecutionContext;
};

export const consoleContext = createContext<ConsoleRequestContext>();

export type ConsoleActor = {
  user: BrowserUser;
  env: ConsoleEnv;
  provenance: Provenance;
  store: BrowserTenantStore;
};

function environment(context: Readonly<RouterContextProvider>): ConsoleEnv {
  return context.get(consoleContext).env;
}

function sessionEnvironment(env: ConsoleEnv): PasswordSessionEnv | null {
  if (!env.SESSION_SECRET) return null;
  return {
    DB: env.DB,
    SESSION_SECRET: env.SESSION_SECRET,
    VALISE_ADMIN_PASSWORD: env.VALISE_ADMIN_PASSWORD,
  };
}

export async function consoleUser(
  context: Readonly<RouterContextProvider>,
  request: Request,
): Promise<BrowserUser | null> {
  const env = sessionEnvironment(environment(context));
  return env === null ? null : getUser(env, request);
}

export async function requireConsoleUser(
  context: Readonly<RouterContextProvider>,
  request: Request,
): Promise<BrowserUser> {
  const env = sessionEnvironment(environment(context));
  if (env === null) {
    throw new Response("The console session secret is not configured.", {
      status: 503,
    });
  }
  return requireUser(env, request);
}

export async function requireConsoleActor(
  context: Readonly<RouterContextProvider>,
  request: Request,
): Promise<ConsoleActor> {
  const env = environment(context);
  const session = sessionEnvironment(env);
  if (session === null) {
    throw new Response("The console session secret is not configured.", {
      status: 503,
    });
  }
  const { user, provenance, store } = await requireBrowserStore(
    { ...env, ...session },
    request,
  );
  return {
    user,
    env,
    provenance,
    store,
  };
}

export type ConsoleIdentity = Pick<
  UserRecord,
  "userId" | "displayName" | "email" | "role"
> & {
  /** The owner, or an account `VALISE_ADMIN_EMAILS` names. ADR-0016. */
  admin: boolean;
};

/**
 * Who is signed in, for the shell: the name beside "Sign out" and whether
 * the admin pages are offered. Null when nobody is, so the login page and
 * the error boundary can render without a session. ADR-0016.
 */
export async function consoleIdentity(
  context: Readonly<RouterContextProvider>,
  request: Request,
): Promise<ConsoleIdentity | null> {
  const user = await consoleUser(context, request);
  if (user === null) return null;
  const record = await getUserRecord(environment(context).DB, user.userId);
  if (record === null) {
    // A session for a user row that does not exist: the owner before the
    // migration ran, or a deleted member. The session is not a user.
    return null;
  }
  return {
    userId: record.userId,
    displayName: record.displayName,
    email: record.email,
    role: record.role,
    admin: isAdmin(environment(context), record),
  };
}

/** The admin pages: invites, people and the workbench. Anyone else gets a 404, not a hint. */
/**
 * The signed-in person's credentials and account record, a browser-only
 * factory apart from the tenant store. Used by /connections and /account.
 */
export async function requireConsoleCredentials(
  context: Readonly<RouterContextProvider>,
  request: Request,
) {
  const env = environment(context);
  const session = sessionEnvironment(env);
  if (session === null) {
    throw new Response("The console session secret is not configured.", {
      status: 503,
    });
  }
  return requireCredentialStore({ ...env, ...session }, request);
}

export async function requireConsoleAdmin(
  context: Readonly<RouterContextProvider>,
  request: Request,
): Promise<ConsoleActor & { identity: ConsoleIdentity; admin: AdminStore }> {
  const actor = await requireConsoleActor(context, request);
  const session = sessionEnvironment(actor.env);
  if (session === null) throw new Response("Not configured", { status: 503 });
  const { identity, admin } = await requireAdminStore(
    { ...session, VALISE_ADMIN_EMAILS: actor.env.VALISE_ADMIN_EMAILS },
    request,
  );
  return { ...actor, identity: { ...identity, admin: true }, admin };
}

export async function passwordSession(
  context: Readonly<RouterContextProvider>,
  request: Request,
  password: string,
  email?: string,
): Promise<string | null> {
  const env = sessionEnvironment(environment(context));
  if (env === null) return null;
  const user = email ? await getUserForPasswordAuth(env.DB, email) : null;
  const owner = !email || user?.userId === OWNER_USER_ID;
  const cookie = owner
    ? await createPasswordSession(env, request, password)
    : await createMemberPasswordSession(env, request, email ?? "", password);
  const userId = owner ? OWNER_USER_ID : user?.userId;
  if (cookie !== null && userId) {
    context.get(consoleContext).ctx.waitUntil(touchUser(env.DB, userId));
  }
  logAuthEvent(context, request, {
    kind: cookie === null ? "console_login_failed" : "console_login",
    userId: cookie === null ? null : owner ? OWNER_USER_ID : user?.userId,
    subject: email || null,
    detail: "password",
  });
  return cookie;
}

export type PasswordChange =
  | { ok: true; endedOtherSessions: true }
  | { ok: false; error: string };

/**
 * Sets the signed-in member's password, or replaces it when the current one
 * is right. The browser that did it stays signed in; every other browser
 * session of that member ends. The owner signs in with the administrator
 * password, so this refuses the owner. ADR-0016, amendment of 2026-10-29.
 */
/** The session's own password; the person is read from the session, never an argument. */
export async function changeConsolePassword(
  context: Readonly<RouterContextProvider>,
  request: Request,
  input: { current: string; next: string; confirm: string },
): Promise<PasswordChange> {
  const env = sessionEnvironment(environment(context));
  if (env === null) return { ok: false, error: "Sign-in is not configured." };
  const { userId } = await requireUser(env, request);
  const record = await getUserRecord(env.DB, userId);
  if (record === null || record.role !== "member" || record.email === null) {
    return {
      ok: false,
      error: "This account signs in with the administrator password.",
    };
  }
  const account = await getUserForPasswordAuth(env.DB, record.email);
  if (account === null || account.userId !== userId) {
    return { ok: false, error: "This account cannot set a password." };
  }
  const { hashPassword, verifyPassword } = await import(
    "~/lib/password.server"
  );
  if (
    account.passwordHash !== null &&
    !(await verifyPassword(input.current, account.passwordHash))
  ) {
    return { ok: false, error: "The current password is wrong." };
  }
  if (input.next.length < 8) {
    return { ok: false, error: "Password must be at least 8 characters." };
  }
  if (input.next !== input.confirm) {
    return { ok: false, error: "Passwords do not match." };
  }
  const sessionId = await currentSessionId(env, request);
  if (sessionId === null) return { ok: false, error: "Sign in again." };
  const saved = await setMemberPassword(env.DB, {
    userId,
    previousHash: account.passwordHash,
    passwordHash: await hashPassword(input.next),
    keepSessionId: sessionId,
  });
  if (!saved) {
    return {
      ok: false,
      error: "The password changed in another session. Reload and try again.",
    };
  }
  return { ok: true, endedOtherSessions: true };
}

export function googleSignInEnabled(
  context: Readonly<RouterContextProvider>,
): boolean {
  return googleEnabled(environment(context));
}

export type GoogleSignInError =
  | GoogleCallbackError
  | SignInRefusal
  | "email-unverified";

/**
 * Finishes a Google sign-in. An allowlisted email is the owner, the user the
 * password signs in as; any other verified email needs an account or an
 * invite, which `resolveSignIn` decides. A new member gets the built-in
 * skills published into their case behind the response. ADR-0016.
 */
export async function googleSession(
  context: Readonly<RouterContextProvider>,
  request: Request,
): Promise<
  | { ok: true; cookie: string; next: string }
  | { ok: false; error: GoogleSignInError; invite: string | null }
> {
  const { env, ctx } = context.get(consoleContext);
  if (!googleEnabled(env))
    return { ok: false, error: "bad-state", invite: null };
  const result = await handleGoogleCallback(env, request);
  if (!result.ok) {
    logAuthEvent(context, request, {
      kind: "console_login_failed",
      subject: result.email ?? null,
      detail: `google: ${result.error}`,
    });
    return { ok: false, error: result.error, invite: null };
  }
  const resolved = await resolveSignIn(env.DB, {
    email: result.email,
    inviteCode: result.invite,
    adminEmails: allowedEmails(env),
  });
  if (!resolved.ok) {
    logAuthEvent(context, request, {
      kind: "console_login_failed",
      subject: result.email,
      detail: `google: ${resolved.error}${result.invite ? " (with invite link)" : ""}`,
    });
    return { ok: false, error: resolved.error, invite: result.invite };
  }
  const { user } = resolved;
  logAuthEvent(context, request, {
    kind: "console_login",
    userId: user.userId,
    subject: result.email,
    detail: resolved.created
      ? `google: joined with invite ${user.inviteId}`
      : "google",
  });
  if (resolved.created) ctx.waitUntil(provisionBuiltinSkills(env, user.userId));
  return {
    ok: true,
    cookie: await createSessionCookie(env, request, user.userId),
    next: localRedirectPath(result.next),
  };
}

export async function destroyConsoleSession(
  context: Readonly<RouterContextProvider>,
  request: Request,
): Promise<string> {
  const env = sessionEnvironment(environment(context));
  if (env === null) {
    throw new Response("The console session secret is not configured.", {
      status: 503,
    });
  }
  const user = await getUser(env, request);
  logAuthEvent(context, request, {
    kind: "console_logout",
    userId: user?.userId ?? null,
  });
  return destroySessionCookie(env, request);
}

/**
 * Who got in and who was refused, written behind `waitUntil` so a sign-in
 * never waits on its own audit row. ADR-0006.
 */
export function logAuthEvent(
  context: Readonly<RouterContextProvider>,
  request: Request,
  record: AuthEventRecord,
): void {
  const { env, ctx } = context.get(consoleContext);
  ctx.waitUntil(recordAuthEvent(env, request, record));
}

export function requireSameOriginAction(request: Request): void {
  if (request.headers.get("origin") === new URL(request.url).origin) return;
  throw new Response("Invalid form origin.", { status: 403 });
}

export function localRedirectPath(value: string | null): string {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/todos";
}
