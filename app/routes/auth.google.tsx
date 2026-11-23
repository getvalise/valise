import { redirect } from "react-router";
import { consoleContext, localRedirectPath } from "~/console/context.server";
import { googleAuthRedirect, googleEnabled } from "~/lib/google.server";
import type { Route } from "./+types/auth.google";

export async function loader({ context, request }: Route.LoaderArgs) {
  const { env } = context.get(consoleContext);
  if (!googleEnabled(env)) throw redirect("/login");
  const params = new URL(request.url).searchParams;
  const next = localRedirectPath(params.get("next"));
  // An invite code rides in the signed state, not the URL Google sees, so
  // the callback can tie the sign-in to the link it started from.
  const invite = params.get("invite")?.trim() || null;
  const { url, stateCookie } = await googleAuthRedirect(
    env,
    request,
    next,
    invite,
  );
  return redirect(url, { headers: { "set-cookie": stateCookie } });
}
