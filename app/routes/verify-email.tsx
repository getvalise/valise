import { Form, redirect, useActionData } from "react-router";
import { provisionBuiltinSkills } from "~/concepts/builtin-skills";
import {
  consoleContext,
  logAuthEvent,
  requireSameOriginAction,
} from "~/console/context.server";
import { createSessionCookie } from "~/lib/auth.server";
import { verifyUserEmail } from "~/lib/member-verification.server";
import type { Route } from "./+types/verify-email";

/** GET is inert, including when a mail scanner opens the link. */
export async function action({ context, params, request }: Route.ActionArgs) {
  requireSameOriginAction(request);
  const { env, ctx } = context.get(consoleContext);
  if (!env.SESSION_SECRET)
    throw new Response("Session secret is not configured.", { status: 503 });
  const form = await request.formData();
  const user = await verifyUserEmail(
    env.DB,
    params.token,
    String(form.get("password") ?? ""),
  );
  logAuthEvent(context, request, {
    kind: user ? "console_login" : "console_login_failed",
    userId: user?.userId ?? null,
    detail: user
      ? "password: email verified"
      : "password: invalid verification or password",
  });
  if (!user)
    return {
      error:
        "The link is invalid, used or expired, or the password does not match. Use the password from signup; otherwise ask the owner for help.",
    };
  ctx.waitUntil(provisionBuiltinSkills(env, user.userId));
  return redirect("/todos", {
    headers: {
      "set-cookie": await createSessionCookie(
        { DB: env.DB, SESSION_SECRET: env.SESSION_SECRET },
        request,
        user.userId,
      ),
    },
  });
}

export default function VerifyEmail() {
  const result = useActionData<typeof action>();
  return (
    <section className="auth-card card">
      <p className="eyebrow">Valise</p>
      <h1>Verify your email</h1>
      <p>
        Enter the password you chose at signup. The link expires after seven
        days.
      </p>
      <Form method="post" className="stack">
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </label>
        {result?.error ? <p role="alert">{result.error}</p> : null}
        <button type="submit">Verify and sign in</button>
      </Form>
    </section>
  );
}
