/**
 * A to-do named by id in prose: `todo:tdo_<uuid>`, the form every MCP tool
 * returns and agents paste into bodies and comments. The console draws each
 * one as a card with the to-do's title and state (docs/design/principles.md,
 * P7), so this module finds them in text and reads what the card shows.
 */

export const TODO_MENTION =
  /\btodo:tdo_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;

/** At most this many mentions are resolved per page; the rest still link. */
export const TODO_MENTION_LIMIT = 100;

export type TodoMention = { title: string; state: string };

/** Every distinct id mentioned across the texts, in first-seen order. */
export function mentionedTodoIds(texts: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(TODO_MENTION)) seen.add(match[0]);
  }
  return [...seen];
}

/** Title and state for each owned id, keyed `todo:tdo_…`; unknown ids are absent. */
export async function readTodoMentions(
  db: D1Database,
  userId: string,
  ids: string[],
): Promise<Record<string, TodoMention>> {
  const bare = ids
    .slice(0, TODO_MENTION_LIMIT)
    .map((id) => id.slice("todo:".length));
  if (!bare.length) return {};
  const { results } = await db
    .prepare(
      `SELECT todo_id, title, state FROM todos
       WHERE user_id = ?1 AND todo_id IN (SELECT value FROM json_each(?2))`,
    )
    .bind(userId, JSON.stringify(bare))
    .all<{ todo_id: string; title: string; state: string }>();
  return Object.fromEntries(
    results.map((row) => [
      `todo:${row.todo_id}`,
      { title: row.title, state: row.state },
    ]),
  );
}

/** Ids replaced by their titles, for plain-text places such as a row preview. */
export function withMentionTitles(
  text: string,
  mentions: Record<string, TodoMention>,
): string {
  return text.replace(TODO_MENTION, (id) => mentions[id]?.title ?? id);
}
