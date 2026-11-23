import { useContext, useRef, useState } from "react";
import { Link, useActionData, useFetcher, useSearchParams } from "react-router";
import { useLanded, ViaFetcher } from "~/components/editable";
import { Markdown } from "~/components/markdown";
import { TodoMentions } from "~/components/todo-mention";
import { authorLabel } from "~/concepts/agent-names";
import { statusEntry } from "~/concepts/todo-activity";
import { withMentionTitles } from "~/concepts/todo-mentions";
import { type ConsoleTodo, type TodoUpdate } from "~/concepts/todos";

export function TodoProgressThread({
  todo,
  now,
  back,
}: {
  todo: ConsoleTodo & { updates: TodoUpdate[] };
  now: number;
  back: string;
}) {
  return (
    <>
      <History now={now} updates={todo.updates} />
      <CommentBox back={back} todo={todo} />
    </>
  );
}

/**
 * The to-do's status: the summary of its newest progress, comment, blocker or
 * completion, and when it was written. First on the row and at the top of the
 * pane, so a pending to-do whose thread holds the work does not read as idle.
 * A claim or a release never replaces it; the count beside the preview still
 * counts them.
 */
export function StatusLine({
  updates,
  now,
  omitBlocked = false,
}: {
  updates: TodoUpdate[];
  now: number;
  /** Leave the line out when it is the blocker a BlockedLine already shows. */
  omitBlocked?: boolean;
}) {
  const mentions = useContext(TodoMentions);
  const entry = statusEntry(updates);
  if (!entry?.summary) return null;
  if (omitBlocked && entry.kind === "blocked") return null;
  const { kind, createdAt: statusAt, summary } = entry;
  // A status is one plain line, so a named to-do reads as its title.
  const status = withMentionTitles(summary, mentions);
  return (
    <p className="todo-last-update" data-testid="todo-status">
      <span className="todo-last-update-when">
        {LAST[kind]} ·{" "}
        <time
          dateTime={new Date(statusAt * 1000).toISOString()}
          title={utc(statusAt)}
        >
          {ago(statusAt, now)}
        </time>
      </span>{" "}
      {status}
    </p>
  );
}

const LAST: Record<TodoUpdate["kind"], string> = {
  claim: "Claimed",
  progress: "Progress",
  comment: "Comment",
  blocked: "Blocked",
  release: "Released",
  complete: "Completed",
};

/**
 * The author as a person reads it: the session's name, such as a worktree,
 * with the client after it, or the client's short name alone. The raw agent
 * string, an OAuth registration URL for most agents, is on hover. ADR-0004.
 */
export function Byline({
  agent,
  sessionName,
  via = null,
  strong = false,
}: {
  agent: string;
  sessionName: string | null;
  /** The transport it came through, such as `oauth`, kept on hover. */
  via?: string | null;
  strong?: boolean;
}) {
  const { name, client } = authorLabel(agent, sessionName);
  return (
    <span title={via ? `${agent} · ${via}` : agent}>
      {strong ? <strong>{name}</strong> : name}
      {client ? ` · ${client}` : ""}
    </span>
  );
}

/** What each kind of entry says its author did, before the entry's text. */
const DID: Record<TodoUpdate["kind"], string> = {
  claim: "claimed it",
  progress: "posted progress",
  comment: "commented",
  blocked: "blocked it",
  release: "released it",
  complete: "completed it",
};

/**
 * Claims, progress, blocks, releases, completions and comments as one
 * history. The person picks the order: newest first by default, so the
 * latest word is on top, or oldest first to read it as it happened. The
 * choice is `?history=oldest` in the URL (P3), so it survives a reload and
 * a shared link. The log arrives newest first. Each entry says when
 * relative to the loader's `now`, so the server and the hydrated page print
 * the same words, and the UTC time is on hover.
 */
function History({ updates, now }: { updates: TodoUpdate[]; now: number }) {
  const [params] = useSearchParams();
  const oldestFirst = params.get("history") === "oldest";
  const flipped = new URLSearchParams(params);
  if (oldestFirst) flipped.delete("history");
  else flipped.set("history", "oldest");
  const ordered = oldestFirst ? [...updates].reverse() : updates;
  return (
    <section aria-label="History" className="todo-history">
      <h3 className="eyebrow">History</h3>
      {updates.length > 1 ? (
        <p className="muted">
          {oldestFirst ? "Oldest first" : "Newest first"} ·{" "}
          <Link preventScrollReset replace to={`?${flipped}`}>
            {oldestFirst ? "Show newest first" : "Show oldest first"}
          </Link>
        </p>
      ) : null}
      {updates.length ? (
        <ol>
          {ordered.map((update) => (
            <li className={`entry-${update.kind}`} key={update.id}>
              <p className="entry-head">
                <Byline
                  agent={update.author}
                  sessionName={update.sessionName}
                  strong
                />{" "}
                {DID[update.kind]}
                {" · "}
                <time
                  dateTime={new Date(update.createdAt * 1000).toISOString()}
                  title={utc(update.createdAt)}
                >
                  {ago(update.createdAt, now)}
                </time>
              </p>
              {update.body ? <Markdown>{update.body}</Markdown> : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">
          Nothing yet. Claims, progress and comments land here.
        </p>
      )}
    </section>
  );
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", then the date. */
function ago(seconds: number, now: number): string {
  const past = Math.max(0, now - seconds);
  if (past < 60) return "just now";
  if (past < 3600) return `${Math.floor(past / 60)} min ago`;
  if (past < 86_400) return `${Math.floor(past / 3600)} h ago`;
  const days = Math.floor(past / 86_400);
  if (days < 7) return days === 1 ? "yesterday" : `${days} days ago`;
  return utc(seconds).slice(0, 10);
}

/** UTC, because a server-rendered local time mismatches on hydration. */
function utc(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

/**
 * A comment needs no claim, so the box is always there rather than behind a
 * link (P8). It posts through a fetcher and empties itself once the write
 * lands; the log above picks the comment up on revalidation (P11).
 *
 * The Comment button shows below the box once the box has focus or holds a
 * draft, as a field's Save does once its pen opens it. Enter sends and
 * Shift+Enter starts a new line. The reveal is CSS, so with scripting off
 * the button is still the next tab stop and the way to send.
 */
function CommentBox({
  todo,
  back,
}: {
  todo: ConsoleTodo;
  /** Where the comment posts, with the to-do's dialog open. */
  back: string;
}) {
  const fetcher = useFetcher<CommentAnswer>();
  const form = useRef<HTMLFormElement>(null);
  const returned = useActionData<CommentAnswer>();
  const answer =
    fetcher.data ?? (returned?.id === todo.id ? returned : undefined);
  const [busy, setBusy] = useState(false);
  const landed = useLanded(fetcher, () => {
    setBusy(false);
    if (fetcher.data?.saved)
      (form.current as { reset?: () => void } | null)?.reset?.();
  });
  return (
    <fetcher.Form
      action={back}
      className="todo-comment"
      method="post"
      onSubmit={() => {
        setBusy(true);
        landed();
      }}
      preventScrollReset
      ref={form}
    >
      <ViaFetcher />
      <input name="intent" type="hidden" value="comment" />
      <input name="id" type="hidden" value={todo.id} />
      <textarea
        aria-label={`Comment on ${todo.title}`}
        name="body"
        defaultValue={answer?.body ?? ""}
        onKeyDown={(event) => {
          // Not mid-composition: Enter there picks the IME's candidate.
          if (
            event.key !== "Enter" ||
            event.shiftKey ||
            event.nativeEvent.isComposing
          )
            return;
          event.preventDefault();
          if (!busy)
            (
              form.current as { requestSubmit?: () => void } | null
            )?.requestSubmit?.();
        }}
        readOnly={busy}
        placeholder="A question, an answer, or context"
        required
        rows={2}
      />
      <button className="small" disabled={busy} type="submit">
        {busy ? "Commenting…" : "Comment"}
      </button>
      {answer?.commentError ? <p role="alert">{answer.commentError}</p> : null}
    </fetcher.Form>
  );
}

type CommentAnswer = {
  saved?: boolean;
  commentError?: string;
  id?: string;
  body?: string;
};
