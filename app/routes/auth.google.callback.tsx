import { redirect } from "react-router";
import { googleSession } from "~/console/context.server";
import { clearStateCookie } from "~/lib/google.server";
import type { Route } from "./+types/auth.google.callback";

export async function loader({ context, request }: Route.LoaderArgs) {
  const headers = new Headers({ "set-cookie": clearStateCookie(request) });
  const result = await googleSession(context, request);
  if (!result.ok) {
    // A refusal goes back to the page the person started from: the invite
    // page explains an invite's state, the login page everything else.
    const back = result.invite
      ? `/join/${encodeURIComponent(result.invite)}`
      : "/login";
    return redirect(`${back}?error=${result.error}`, { headers });
  }
  headers.append("set-cookie", result.cookie);
  return redirect(result.next, { headers });
}
