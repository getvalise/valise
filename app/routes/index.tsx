import { redirect } from "react-router";
import { requireConsoleUser } from "~/console/context.server";
import type { Route } from "./+types/index";

export async function loader({ context, request }: Route.LoaderArgs) {
  await requireConsoleUser(context, request);
  return redirect("/todos");
}
