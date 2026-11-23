import { redirect } from "react-router";
import {
  destroyConsoleSession,
  requireConsoleUser,
  requireSameOriginAction,
} from "~/console/context.server";
import type { Route } from "./+types/logout";

export async function loader({ context, request }: Route.LoaderArgs) {
  await requireConsoleUser(context, request);
  return redirect("/todos");
}

export async function action({ context, request }: Route.ActionArgs) {
  requireSameOriginAction(request);
  await requireConsoleUser(context, request);
  return redirect("/login", {
    headers: { "set-cookie": await destroyConsoleSession(context, request) },
  });
}

export default function Logout() {
  return null;
}
