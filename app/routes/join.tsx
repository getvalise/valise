import { Form, redirect, useActionData } from "react-router";
import { findInvite, type InviteStatus } from "~/concepts/users";
import {
  consoleContext,
  consoleUser,
  googleSignInEnabled,
  requireSameOriginAction,
} from "~/console/context.server";
import { sendVerificationEmail, verificationToken } from "~/lib/email.server";
import { googleSignInPath } from "~/lib/google.server";
import { hashPassword } from "~/lib/password.server";
import type { Route } from "./+types/join";

/**
 * Where an invite link lands. The invitee can sign up with Google or
 * create a password. Password users get a verification email. ADR-0016.
 */

const STATUS_LINES: Record<Exclude<InviteStatus, "open">, string> = {
  redeemed: "This invite has already been used.",
  revoked: "This invite was withdrawn.",
  expired: "This invite has expired.",
};

const ERRORS: Record<string, string> = {
  "invite-used": "This invite was used by someone else first.",
  "invite-revoked": "This invite was withdrawn.",
  "invite-expired": "This invite has expired.",
  "invite-other-email":
    "This invite is for a different account. Check the email address.",
  "invite-unknown": "That invite link is not one Valise issued.",
  "no-verified-email": "Google did not return a verified email address.",
  "bad-state":
    "The Google sign-in expired or was started elsewhere. Try again.",
};

export async function loader({ context, params, request }: Route.LoaderArgs) {
  const { env } = context.get(consoleContext);
  if (await consoleUser(context, request)) throw redirect("/todos");
  const invite = await findInvite(env.DB, params.code);
  const error = new URL(request.url).searchParams.get("error");
  return {
    invite:
      invite === null
        ? null
        : { label: invite.label, email: invite.email, status: invite.status },
    googleHref: googleSignInEnabled(context)
      ? googleSignInPath("/todos", params.code)
      : null,
    inviteCode: params.code,
    error:
      error === null ? null : (ERRORS[error] ?? "Sign-in failed. Try again."),
  };
}

export async function action({ context, params, request }: Route.ActionArgs) {
  requireSameOriginAction(request);
  const { env } = context.get(consoleContext);
  if (!env.EMAIL_API_KEY || env.EMAIL_API_KEY === "none") {
    return {
      error:
        "Password signup needs verification email configured. Continue with Google or ask the owner for help.",
    };
  }
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  const displayName = String(form.get("display_name") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("confirm_password") ?? "");

  if (!email.includes("@")) {
    return { error: "A valid email address is required." };
  }
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }
  if (password !== confirm) {
    return { error: "Passwords do not match." };
  }

  const { createUserWithPassword } = await import("~/concepts/users");
  const token = verificationToken();
  const result = await createUserWithPassword(env.DB, {
    email,
    inviteCode: params.code,
    displayName: displayName || undefined,
    passwordHash: await hashPassword(password),
    verificationToken: token,
  });

  if (!result.ok) {
    return { error: ERRORS[result.error] ?? "Could not create account." };
  }

  // No session until the recipient proves mailbox and password possession.
  try {
    await sendVerificationEmail(
      {
        EMAIL_API_KEY: env.EMAIL_API_KEY,
        EMAIL_FROM: env.EMAIL_FROM,
        APP_ORIGIN: env.APP_ORIGIN,
      },
      email,
      token,
    );
  } catch {
    return {
      error:
        "The account is pending, but the verification email could not be sent. Ask the owner for help; signing in is disabled until verification.",
    };
  }
  return { pending: true };
}

export default function Join({ loaderData }: Route.ComponentProps) {
  const { invite, googleHref, inviteCode, error } = loaderData;
  const actionData = useActionData<typeof action>();

  if (actionData && "pending" in actionData) {
    return (
      <section className="auth-card card">
        <p className="eyebrow">Valise</p>
        <h1>Check your email</h1>
        <p>
          Open the verification link within seven days and enter the password
          you just created. You cannot sign in until then.
        </p>
      </section>
    );
  }

  if (invite === null) {
    return (
      <section className="auth-card card">
        <p className="eyebrow">Valise</p>
        <h1>No such invite</h1>
        <p className="muted">
          That link is not one Valise issued. Ask whoever sent it for a new one.
        </p>
      </section>
    );
  }
  if (invite.status !== "open") {
    return (
      <section className="auth-card card">
        <p className="eyebrow">Valise</p>
        <h1>{STATUS_LINES[invite.status]}</h1>
        <p className="muted">
          Ask whoever sent it for a new one, or <a href="/login">sign in</a> if
          you already have an account.
        </p>
      </section>
    );
  }
  return (
    <section className="auth-card card">
      <p className="eyebrow">Valise</p>
      <h1>You're invited.</h1>
      <p className="muted">
        One case for your skills, memories and to-dos, open to every model you
        use.
      </p>
      {error ? <p role="alert">{error}</p> : null}

      {/* Password creation form */}
      <details className="stack">
        <summary>Create a password</summary>
        <Form className="stack" method="post">
          <input name="invite_code" type="hidden" value={inviteCode} />
          <label>
            Email
            <input autoComplete="email" name="email" required type="email" />
          </label>
          <label>
            Display name
            <input
              autoComplete="name"
              maxLength={120}
              name="display_name"
              type="text"
            />
          </label>
          <label>
            Password
            <input
              autoComplete="new-password"
              minLength={8}
              name="password"
              required
              type="password"
            />
          </label>
          <label>
            Confirm password
            <input
              autoComplete="new-password"
              minLength={8}
              name="confirm_password"
              required
              type="password"
            />
          </label>
          {actionData?.error ? <p role="alert">{actionData.error}</p> : null}
          <button className="wide" type="submit">
            Create account
          </button>
        </Form>
      </details>

      {googleHref ? (
        <>
          <p className="auth-or">or</p>
          <a className="button ghost google wide" href={googleHref}>
            <img alt="" height="16" src="/google-g.svg" width="16" />
            Continue with Google
          </a>
        </>
      ) : (
        <p role="alert">
          Google sign-in is not configured. You can create a password instead.
        </p>
      )}
      <p className="muted">
        Already have an account? <a href="/login">Sign in</a>.
      </p>
    </section>
  );
}
