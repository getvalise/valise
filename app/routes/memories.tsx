import { ApplicationShell } from "~/components/ui";
import {
  action as memoryAction,
  loader as memoryLoader,
} from "~/console/memories.server";
import {
  action as reviewAction,
  loader as reviewLoader,
} from "~/console/memory-review.server";
import { MemoryList } from "~/features/memories/list";
import { MemoryReview } from "~/features/memories/review";
import { MemorySections } from "~/features/memories/sections";
import type { Route } from "./+types/memories";

export async function loader(args: Route.LoaderArgs) {
  return new URL(args.request.url).searchParams.get("tab") === "review"
    ? { tab: "review" as const, review: await reviewLoader(args) }
    : { tab: "all" as const, list: await memoryLoader(args) };
}

export async function action(args: Route.ActionArgs) {
  return new URL(args.request.url).searchParams.get("tab") === "review"
    ? reviewAction(args)
    : memoryAction(args);
}

export default function Memories({ loaderData }: Route.ComponentProps) {
  const review = loaderData.tab === "review";
  return (
    <ApplicationShell
      title="Memories"
      lede={
        review
          ? "Nightly upkeep adds summaries that only add to your memories and asks you about the rest. Your originals always stay."
          : "Archiving removes a memory from the next agent search without deleting it. Every edit keeps the text it replaced, under History."
      }
      sections={
        <MemorySections
          current={review ? "review" : "all"}
          waiting={
            loaderData.tab === "review"
              ? loaderData.review.waiting
              : loaderData.list.waiting
          }
        />
      }
    >
      {loaderData.tab === "review" ? (
        <MemoryReview loaderData={loaderData.review} />
      ) : (
        <MemoryList loaderData={loaderData.list} />
      )}
    </ApplicationShell>
  );
}
