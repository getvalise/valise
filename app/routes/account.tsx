import { Form, useActionData } from "react-router";
import { ApplicationShell, Card, Field } from "~/components/ui";
import {
  changeConsolePassword,
  requireConsoleActor,
  requireConsoleCredentials,
  requireSameOriginAction,
} from "~/console/context.server";
import type { Route } from "./+types/account";

/**
 * The signed-in person's own account. A member who joined with Google sets a
 * password here, so /login works for them too; one who has a password
 * changes it with the current one. ADR-0016, amendment of 2026-10-29.
 */

export async function loader({ context, request }: Route.LoaderArgs) {
  const credentials = await requireConsoleCredentials(context, request);
  const actor = await requireConsoleActor(context, request);
  const [{ record, hasPassword }, onboarding] = await Promise.all([
    credentials.account(),
    actor.store.onboarding.read(),
  ]);
  return {
    email: record?.email ?? null,
    owner: record?.role !== "member",
    hasPassword,
    onboarding,
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  requireSameOriginAction(request);
  const form = await request.formData();
  const result = await changeConsolePassword(context, request, {
    current: String(form.get("current_password") ?? ""),
    next: String(form.get("password") ?? ""),
    confirm: String(form.get("confirm_password") ?? ""),
  });
  return result.ok ? { saved: true as const } : { error: result.error };
}

export default function Account({ loaderData }: Route.ComponentProps) {
  const { email, owner, hasPassword, onboarding } = loaderData;
  const actionData = useActionData<typeof action>();
  return (
    <ApplicationShell
      lede={email ? `Signed in as ${email}.` : undefined}
      title="Account"
    >
      <Card className="editor">
        <h2>Password</h2>
        {owner ? (
          <p className="muted">
            The owner signs in with the administrator password or Google. It is
            set in the deployment, not here.
          </p>
        ) : (
          <Form className="stack" method="post">
            <p className="muted">
              {hasPassword
                ? "Change the password you use with your email on the sign-in page."
                : "You sign in with Google. Set a password to also sign in with your email on the sign-in page."}{" "}
              Saving signs out every other browser; this one stays signed in.
            </p>
            {hasPassword ? (
              <Field
                autoComplete="current-password"
                label="Current password"
                name="current_password"
                required
                type="password"
              />
            ) : null}
            <Field
              autoComplete="new-password"
              label={hasPassword ? "New password" : "Password"}
              name="password"
              required
              type="password"
            />
            <Field
              autoComplete="new-password"
              label="Confirm password"
              name="confirm_password"
              required
              type="password"
            />
            <p className="muted">At least 8 characters.</p>
            {actionData && "error" in actionData ? (
              <p role="alert">{actionData.error}</p>
            ) : null}
            {actionData && "saved" in actionData ? (
              <p role="status">
                Password saved. Other browsers are signed out.
              </p>
            ) : null}
            <div className="row">
              <button type="submit">
                {hasPassword ? "Change password" : "Set password"}
              </button>
            </div>
          </Form>
        )}
      </Card>
      <Card className="editor">
        <h2>Getting started</h2>
        {onboarding.dismissedAt !== null ? (
          <Form action="/onboarding" className="stack" method="post">
            <p className="muted">
              The getting-started checklist is hidden on To-dos and Skills.
            </p>
            <input name="dismissed" type="hidden" value="0" />
            <input name="back" type="hidden" value="/todos" />
            <div className="row">
              <button className="ghost" type="submit">
                Show it again
              </button>
            </div>
          </Form>
        ) : (
          <p className="muted">
            {onboarding.complete
              ? "Every getting-started step is done."
              : "The getting-started checklist shows on To-dos and Skills until you hide it or finish it."}
          </p>
        )}
      </Card>
    </ApplicationShell>
  );
}
