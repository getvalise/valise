import { Form, Link, useActionData } from "react-router";
import {
  consoleContext,
  logAuthEvent,
  requireSameOriginAction,
} from "~/console/context.server";
import { hashPassword } from "~/lib/password.server";
import {
  openPasswordReset,
  redeemPasswordReset,
} from "~/lib/password-reset.server";
import type { Route } from "./+types/reset-password";

/**
 * A member sets a new password from a link the owner issued on /people. GET
 * only reads, so a link previewer cannot spend it. Saving ends every browser
 * session of the member and signs nobody in: they sign in on /login with the
 * new password. ADR-0016, amendment of 2026-10-29 (reset).
 */

/** The token is in the path; keep it out of any Referer header. */
export const meta: Route.MetaFunction = () => [
  { name: "referrer", content: "no-referrer" },
];

const SPENT =
  "This link is used, replaced or expired. Ask the owner for a new one.";

export async function loader({ context, params }: Route.LoaderArgs) {
  const { env } = context.get(consoleContext);
  const reset = await openPasswordReset(env.DB, params.token);
  return reset === null
    ? { open: false as const }
    : { open: true as const, email: reset.email };
}

export async function action({ context, params, request }: Route.ActionArgs) {
  requireSameOriginAction(request);
  const { env } = context.get(consoleContext);
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("confirm_password") ?? "");
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }
  if (password !== confirm) return { error: "Passwords do not match." };
  const userId = await redeemPasswordReset(env.DB, {
    token: params.token,
    passwordHash: await hashPassword(password),
  });
  logAuthEvent(context, request, {
    kind: userId === null ? "console_login_failed" : "console_logout",
    userId,
    detail:
      userId === null
        ? "password reset: link used, replaced or expired"
        : "password reset: password set, every session ended",
  });
  return userId === null ? { error: SPENT, spent: true } : { saved: true };
}

export default function ResetPassword({ loaderData }: Route.ComponentProps) {
  const result = useActionData<typeof action>();
  const saved = result !== undefined && "saved" in result;
  const spent = !loaderData.open || (result !== undefined && "spent" in result);
  return (
    <section className="auth-card card">
      <p className="eyebrow">Valise</p>
      <h1>Set a new password</h1>
      {saved ? (
        <>
          <p role="status">
            Password saved. Every browser that was signed in to this account is
            signed out.
          </p>
          <p>
            <Link to="/login">Sign in</Link> with your email and the new
            password.
          </p>
        </>
      ) : spent ? (
        <p role="alert">{SPENT}</p>
      ) : (
        <Form className="stack" method="post">
          <p>
            For {loaderData.open ? loaderData.email : "your account"}. The link
            works once. Saving signs this account out of every browser.
          </p>
          <label>
            New password
            <input
              autoComplete="new-password"
              name="password"
              required
              type="password"
            />
          </label>
          <label>
            Confirm password
            <input
              autoComplete="new-password"
              name="confirm_password"
              required
              type="password"
            />
          </label>
          <p className="muted">At least 8 characters.</p>
          {result && "error" in result ? (
            <p role="alert">{result.error}</p>
          ) : null}
          <button type="submit">Set password</button>
        </Form>
      )}
    </section>
  );
}
