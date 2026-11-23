import type { ConsoleActor } from "~/console/context.server";

/**
 * The waiting-question count beside Review in the Memories sections. A
 * failed read draws no count rather than failing the page it decorates.
 */
export async function waitingQuestions(
  store: Pick<ConsoleActor["store"], "review">,
): Promise<number | null> {
  try {
    return await store.review.waiting();
  } catch (error) {
    console.error("memory review: waiting count unavailable", error);
    return null;
  }
}
