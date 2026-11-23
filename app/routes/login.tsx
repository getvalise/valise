import { Form, redirect, useActionData } from "react-router";
import { Field } from "~/components/ui";
import {
  consoleUser,
  googleSignInEnabled,
  localRedirectPath,
  passwordSession,
  requireSameOriginAction,
} from "~/console/context.server";
import { googleSignInPath } from "~/lib/google.server";
import type { Route } from "./+types/login";

/** What a failed Google sign-in says, keyed by the callback's error code. */
const GOOGLE_ERRORS: Record<string, string> = {
  "email-unverified":
    "This email has an unverified password signup. Use the verification email and your original password, or ask the owner for help.",
  "not-invited":
    "That Google account has no Valise yet. Sign-up is by invitation: ask for an invite link.",
  "invite-used": "That invite has already been used.",
  "invite-revoked": "That invite was withdrawn.",
  "invite-expired": "That invite has expired.",
  "invite-other-email": "That invite is for a different Google account.",
  "invite-unknown": "That invite link is not one Valise issued.",
  "no-verified-email": "Google did not return a verified email address.",
  "bad-state":
    "The Google sign-in expired or was started elsewhere. Try again.",
};

export async function loader({ context, request }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const next = localRedirectPath(params.get("next"));
  if (await consoleUser(context, request)) {
    return redirect(next);
  }
  const error = params.get("error");
  return {
    next,
    googleHref: googleSignInEnabled(context) ? googleSignInPath(next) : null,
    googleError:
      error === null
        ? null
        : (GOOGLE_ERRORS[error] ?? "Google sign-in failed. Try again."),
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  requireSameOriginAction(request);
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const next = form.get("next");

  if (!password) return { error: "A password is required." };

  const cookie = await passwordSession(context, request, password, email);

  if (cookie === null) return { error: "Invalid credentials." };
  return redirect(localRedirectPath(typeof next === "string" ? next : null), {
    headers: { "set-cookie": cookie },
  });
}

export default function Login({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();

  return (
    <section className="auth-card card">
      <p className="eyebrow">Valise</p>
      <h1>One case, every model.</h1>
      <p className="muted">
        Skills, memories, and to-dos that travel between your clients.
      </p>
      {loaderData.googleError ? (
        <p role="alert">{loaderData.googleError}</p>
      ) : null}

      {/* Administrator sign-in */}
      <Form action="/login" className="stack" method="post">
        <input name="next" type="hidden" value={loaderData.next} />
        <Field
          autoComplete="current-password"
          label="Administrator password"
          name="password"
          required
          type="password"
        />
        <button className="wide" type="submit">
          Sign in
        </button>
      </Form>

      <p className="auth-or">or</p>

      {/* Member sign-in */}
      <Form action="/login" className="stack" method="post">
        <input name="next" type="hidden" value={loaderData.next} />
        <Field
          autoComplete="email"
          label="Email"
          name="email"
          required
          type="email"
        />
        <Field
          autoComplete="current-password"
          label="Password"
          name="password"
          required
          type="password"
        />
        <button className="wide" type="submit">
          Log in
        </button>
      </Form>

      {actionData?.error ? <p role="alert">{actionData.error}</p> : null}

      {loaderData.googleHref ? (
        <>
          <p className="auth-or">or</p>
          <a className="button ghost google wide" href={loaderData.googleHref}>
            <img alt="" height="16" src="/google-g.svg" width="16" />
            Continue with Google
          </a>
        </>
      ) : null}
    </section>
  );
}
