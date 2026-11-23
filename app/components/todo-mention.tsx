import { createContext, type ReactNode, useContext, useEffect } from "react";
import { Link, useFetcher } from "react-router";
import { Icon } from "~/components/icon";
import { mentionedTodoIds, type TodoMention } from "~/concepts/todo-mentions";

/**
 * The titles and states of the to-dos a page's bodies mention. `/todos`
 * reads them in its loader, because its rows' previews need them; anywhere
 * else `MentionTitles` asks `/todos/mentions` once the Markdown is on screen.
 */
export const TodoMentions = createContext<Record<string, TodoMention>>({});

/**
 * Titles for the mentions in `text` that the page did not supply, fetched
 * after the first paint: a memory's or skill's pane, or a to-do opened
 * outside the loaded list. Until they land each card names its short id, at
 * the same height, so the paragraph does not move vertically (P4).
 */
export function MentionTitles({
  text,
  children,
}: {
  text: string;
  children: ReactNode;
}) {
  const known = useContext(TodoMentions);
  const missing = mentionedTodoIds([text]).filter((id) => !(id in known));
  const query = missing.map((id) => `id=${encodeURIComponent(id)}`).join("&");
  const fetcher = useFetcher<{ mentions: Record<string, TodoMention> }>();
  const { load } = fetcher;
  useEffect(() => {
    if (query) load(`/todos/mentions?${query}`);
  }, [query, load]);
  const fetched = fetcher.data?.mentions;
  // Always a provider, so the titles landing re-render the cards without
  // remounting the body around them.
  return (
    <TodoMentions.Provider value={fetched ? { ...known, ...fetched } : known}>
      {children}
    </TodoMentions.Provider>
  );
}

/**
 * A to-do named in prose, drawn as the thing it names: the to-do icon, its
 * title and its state, linking to it, as Jira and Confluence draw a ticket
 * key. One line, never wider than its paragraph; a long title truncates and
 * keeps the whole of it in the tooltip. P7.
 */
export function TodoMentionCard({ id }: { id: string }) {
  const mention = useContext(TodoMentions)[id];
  const short = id.slice("todo:tdo_".length, "todo:tdo_".length + 8);
  const title = mention?.title ?? `To-do ${short}`;
  return (
    <Link
      className="todo-mention"
      data-state={mention?.state}
      preventScrollReset
      title={mention ? `${mention.title} (${mention.state})` : id}
      to={`/todos?open=${encodeURIComponent(id)}`}
    >
      <Icon name="todos" size={13} />
      <span className="todo-mention-title">{title}</span>
      {mention ? (
        <span className="todo-mention-state">{mention.state}</span>
      ) : null}
    </Link>
  );
}
