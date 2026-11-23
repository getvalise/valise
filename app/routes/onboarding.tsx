import {
  requireConsoleActor,
  requireSameOriginAction,
} from "~/console/context.server";
import { afterSave } from "~/console/forms.server";
import type { Route } from "./+types/onboarding";

/**
 * Hides the first-run checklist for the account, or brings it back. A form
 * post from /todos, /skills or /account, so it works without scripting and
 * lands back on the page it came from.
 */
export async function action({ context, request }: Route.ActionArgs) {
  requireSameOriginAction(request);
  const actor = await requireConsoleActor(context, request);
  const form = await request.formData();
  const dismissed = form.get("dismissed");
  if (dismissed !== "1" && dismissed !== "0")
    throw new Response("dismissed must be 1 or 0.", { status: 400 });
  await actor.store.onboarding.dismiss(dismissed === "1");
  return afterSave(form, backTo(form.get("back")));
}

/** Only a path on this origin; anything else goes to the to-dos. */
function backTo(back: unknown): string {
  return typeof back === "string" &&
    back.startsWith("/") &&
    !back.startsWith("//")
    ? back
    : "/todos";
}
