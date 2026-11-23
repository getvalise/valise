import { Fragment, type ReactNode, useEffect, useState } from "react";
import {
  Link,
  type ShouldRevalidateFunctionArgs,
  useNavigate,
  useSearchParams,
} from "react-router";
import { highlightCode } from "~/components/code-highlight";
import { Icon } from "~/components/icon";
import { InfiniteList } from "~/components/infinite-list";
import { ItemList, ItemRow } from "~/components/item-list";
import {
  type DateRange,
  DateRangeFilter,
  FacetFilter,
  ListToolbar,
  SortMenu,
} from "~/components/list-toolbar";
import { Markdown } from "~/components/markdown";
import { Modal } from "~/components/modal";
import {
  ApplicationShell,
  Empty,
  Pill,
  ProjectChip,
  SectionTabs,
  Tag,
  TagLinks,
} from "~/components/ui";
import {
  filtersFromRequest,
  type ListFilters,
  listHref,
  withTag,
} from "~/concepts/list-filters";
import { infiniteWindow } from "~/concepts/pagination";
import type { TranscriptContext } from "~/concepts/transcript-context";
import {
  answerIndexes,
  dayHeading,
  dayKey,
  type Exchange,
  groupExchanges,
  spanLabel,
  type TranscriptBlock,
  toolLabel,
  toolSummary,
} from "~/concepts/transcript-view";
import {
  TRANSCRIPT_PAGE_TURNS,
  type Transcript,
  type TranscriptSort,
  type TranscriptTurn,
  transcriptIdOf,
} from "~/concepts/transcripts";
import { requireConsoleActor } from "~/console/context.server";
import { ActivityNav } from "~/features/activity/nav";
import type { Route } from "./+types/activity.transcripts";

const PATH = "/activity/transcripts";
/**
 * Turns per page. Folded, 400 turns render as a few dozen blocks; 90% of
 * this repo's sessions fit on one page (P90 214 turns, max 535, 2026-11-06).
 */
const TURNS = TRANSCRIPT_PAGE_TURNS;
/** Each tag is one scan of the account's turns; five is plenty to narrow. */
const MAX_TAGS = 5;
const DAY = 86_400;

const SECTIONS = [
  "todos",
  "memories",
  "files",
  "tools",
  "prompts",
  "details",
] as const;
type Section = (typeof SECTIONS)[number];

function pageNumber(value: string | null): number {
  const number = Number(value ?? "0");
  return Number.isSafeInteger(number) && number >= 0 && number <= 10000
    ? number
    : 0;
}

function param(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim();
  return value ? value.slice(0, 200) : undefined;
}

/** A UTC day as `YYYY-MM-DD`, or undefined for anything else. */
function dayParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim();
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  return Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? undefined : value;
}

function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) / 1000;
}

/** The page's own filters beyond the shared ones; all GET parameters (P3). */
type Extra = {
  client?: string;
  device?: string;
  errors?: string;
  subject?: string;
  from?: string;
  to?: string;
};

export async function loader({ context, request }: Route.LoaderArgs) {
  const actor = await requireConsoleActor(context, request);
  const url = new URL(request.url);
  const shared = filtersFromRequest(request);
  const filters: ListFilters = {
    query: shared.query,
    project: shared.project,
    tags: shared.tags?.slice(0, MAX_TAGS),
    sort: shared.sort === "last" ? "last" : undefined,
    page: shared.page,
  };
  const turnPage = pageNumber(url.searchParams.get("turns"));
  const open = url.searchParams.get("open");
  const transcriptId = open ? transcriptIdOf(open) : null;
  if (open && !transcriptId) throw new Response("Not found", { status: 404 });
  let from = dayParam(url, "from");
  let to = dayParam(url, "to");
  if (from && to && from > to) [from, to] = [to, from];
  const extra: Extra = {
    client: param(url, "client"),
    device: param(url, "device"),
    subject: param(url, "subject"),
    errors: url.searchParams.get("errors") === "only" ? "only" : undefined,
    from,
    to,
  };
  const sort: TranscriptSort = filters.sort === "last" ? "last" : "first";
  const store = actor.store.transcripts;
  const linked =
    filters.tags?.length || extra.subject
      ? await store.linkedTo({
          tags: filters.tags,
          subjectId: extra.subject?.replace(/^subject:/, ""),
        })
      : undefined;
  const filter = {
    query: filters.query,
    client: extra.client,
    device: extra.device,
    project: filters.project,
    errors: Boolean(extra.errors),
    ids: linked,
    from: from ? dayStart(from) : undefined,
    to: to ? dayStart(to) + DAY : undefined,
  };
  const [total, facets, tagOptions, transcript, sessionContext] =
    await Promise.all([
      store.count(filter),
      store.facets(),
      store.tagOptions(),
      transcriptId ? store.get(transcriptId) : null,
      transcriptId ? store.context(transcriptId) : null,
    ]);
  if (transcriptId && !transcript)
    throw new Response("Not found", { status: 404 });
  // A growing prefix, as on /todos: page N shows the first N pages.
  const window = infiniteWindow(total, filters.page ?? 1);
  filters.page = window.page > 1 ? window.page : undefined;
  const shown = await store.list(0, window.limit, filter, sort);
  const [summaries, turns] = await Promise.all([
    store.summaries(shown.map((session) => session.transcriptId)),
    transcriptId ? store.turnPage(transcriptId, turnPage * TURNS, TURNS) : null,
  ]);
  return {
    sessions: shown,
    summaries,
    facets,
    tagOptions,
    window,
    turnPage,
    filters,
    extra,
    sort,
    hideTools: url.searchParams.get("tools") === "hide",
    transcript,
    context: sessionContext,
    turns,
    now: Math.floor(Date.now() / 1000),
  };
}

/**
 * Flipping the pane's section changes only which part of data already on
 * the page is drawn, so it skips the loader (P3, P4).
 */
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (formMethod || currentUrl.pathname !== nextUrl.pathname)
    return defaultShouldRevalidate;
  const before = new URLSearchParams(currentUrl.search);
  const after = new URLSearchParams(nextUrl.search);
  before.delete("section");
  after.delete("section");
  before.sort();
  after.sort();
  return before.toString() === after.toString()
    ? false
    : defaultShouldRevalidate;
}

function timeOf(seconds: number) {
  return new Date(seconds * 1000).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

function fullTime(seconds: number) {
  return `${new Date(seconds * 1000).toLocaleString("en-GB", { timeZone: "UTC" })} UTC`;
}

function When({ at, children }: { at: number; children?: string }) {
  return (
    <time dateTime={new Date(at * 1000).toISOString()} title={fullTime(at)}>
      {children ?? timeOf(at)}
    </time>
  );
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/** The end of a session the list is ordered by. */
function sortTime(session: Transcript, sort: TranscriptSort) {
  return sort === "last"
    ? (session.lastAt ?? session.updatedAt)
    : (session.firstAt ?? session.updatedAt);
}

function datePresets(now: number): (DateRange & { label: string })[] {
  const today = dayKey(now);
  return [
    { label: "Today", from: today, to: today },
    {
      label: "Yesterday",
      from: dayKey(now - DAY),
      to: dayKey(now - DAY),
    },
    { label: "Last 7 days", from: dayKey(now - 6 * DAY), to: today },
    { label: "Last 30 days", from: dayKey(now - 29 * DAY), to: today },
  ];
}

type OpenOptions = {
  turns?: number;
  hideTools?: boolean;
  section?: Section;
  hash?: string;
};

export default function Transcripts({ loaderData }: Route.ComponentProps) {
  const {
    sessions,
    summaries,
    facets,
    tagOptions,
    window,
    turnPage,
    filters,
    extra,
    sort,
    hideTools,
    transcript,
    context,
    turns,
    now,
  } = loaderData;
  const navigate = useNavigate();
  // From the URL, not the loader: shouldRevalidate skips `?section=`.
  const [search] = useSearchParams();
  const wanted = search.get("section");
  const section = SECTIONS.includes(wanted as Section)
    ? (wanted as Section)
    : null;
  const href = (next: ListFilters, nextExtra: Extra = extra) =>
    listHref(PATH, next, nextExtra);
  const base = href(filters);
  const openUrl = (id: string, options: OpenOptions = {}) =>
    `${listHref(PATH, filters, {
      ...extra,
      open: `transcript:${id}`,
      turns: options.turns ? String(options.turns) : undefined,
      tools: options.hideTools ? "hide" : undefined,
      section: options.section,
    })}${options.hash ? `#${options.hash}` : ""}`;
  const unpaged = { ...filters, page: undefined };
  const filtered =
    Boolean(filters.query || filters.project || filters.tags?.length) ||
    Object.values(extra).some(Boolean);
  const days = new Map<string, typeof sessions>();
  for (const session of sessions) {
    const day = dayKey(sortTime(session, sort));
    days.set(day, [...(days.get(day) ?? []), session]);
  }
  const presets = datePresets(now);
  const keep = [
    ...new URLSearchParams(
      href(unpaged, { ...extra, from: undefined, to: undefined }).split(
        "?",
      )[1] ?? "",
    ),
  ];
  return (
    <ApplicationShell
      lede={
        sort === "last"
          ? "Conversations received from your devices, the most recently active first. A missing session may still be on its device."
          : "Conversations received from your devices, the most recently started first. A missing session may still be on its device."
      }
      sections={<ActivityNav current="transcripts" />}
      title="Transcripts"
    >
      <ListToolbar
        extra={extra}
        facets={
          <>
            {facets.client.length > 1 || extra.client ? (
              <FacetFilter
                hrefFor={([client]) => href(unpaged, { ...extra, client })}
                name="client"
                options={facets.client.map((row) => ({
                  value: row.value,
                  label: row.value,
                  count: row.count,
                }))}
                path={PATH}
                selected={extra.client ? [extra.client] : []}
                title="Client"
              />
            ) : null}
            {facets.device.length > 1 || extra.device ? (
              <FacetFilter
                hrefFor={([device]) => href(unpaged, { ...extra, device })}
                name="device"
                options={facets.device.map((row) => ({
                  value: row.value,
                  label: row.value,
                  count: row.count,
                }))}
                path={PATH}
                selected={extra.device ? [extra.device] : []}
                title="Device"
              />
            ) : null}
            <DateRangeFilter
              hrefFor={(range) => href(unpaged, { ...extra, ...range })}
              keep={keep}
              path={PATH}
              presets={presets}
              range={{ from: extra.from, to: extra.to }}
            />
            <Link
              aria-current={extra.errors ? "true" : undefined}
              className="transcript-toggle"
              preventScrollReset
              to={href(unpaged, {
                ...extra,
                errors: extra.errors ? undefined : "only",
              })}
            >
              {extra.errors ? "✓ With errors" : "With errors"}
            </Link>
          </>
        }
        facetsActive={Object.values(extra).some(Boolean)}
        filters={filters}
        path={PATH}
        projectCounts={facets.project.map((row) => ({
          project: row.value,
          count: row.count,
        }))}
        vocabulary={{ projects: [], tags: tagOptions }}
      >
        <SortMenu
          label="Sort sessions"
          options={[
            {
              label: "Started",
              href: href({ ...unpaged, sort: undefined }),
              current: sort === "first",
            },
            {
              label: "Last active",
              href: href({ ...unpaged, sort: "last" }),
              current: sort === "last",
            },
          ]}
        />
      </ListToolbar>
      {extra.subject ? (
        <p className="transcript-filter-note">
          Sessions that named a memory in{" "}
          <Link
            to={`/memories/subjects/${extra.subject.replace(/^subject:/, "")}`}
          >
            this subject
          </Link>
          .{" "}
          <Link to={href(unpaged, { ...extra, subject: undefined })}>
            Clear
          </Link>
        </p>
      ) : null}
      {sessions.length === 0 ? (
        filtered ? (
          <Empty>
            No session matches these filters.{" "}
            <Link to={PATH}>Show every session</Link>.
          </Empty>
        ) : (
          <Empty>
            No transcripts captured yet. On each machine, sign in with{" "}
            <code>valise login</code>, then run <code>valise install</code> to
            send its existing sessions and watch for new ones.
          </Empty>
        )
      ) : (
        [...days].map(([day, rows]) => (
          <section
            aria-label={dayHeading(day, now)}
            className="transcript-day"
            key={day}
          >
            <h2 className="transcript-day-heading">{dayHeading(day, now)}</h2>
            <ItemList label={`Captured sessions, ${dayHeading(day, now)}`}>
              {rows.map((session) => (
                <SessionRow
                  href={openUrl(session.transcriptId)}
                  key={session.transcriptId}
                  open={transcript?.transcriptId === session.transcriptId}
                  session={session}
                  sort={sort}
                  summary={summaries[session.transcriptId]}
                  tagHref={(tag) => href(withTag(unpaged, tag))}
                />
              ))}
            </ItemList>
          </section>
        ))
      )}
      {sessions.length ? (
        <InfiniteList
          besidePane
          extra={{
            ...extra,
            // The open pane and where it is stay open while more rows load.
            open: transcript
              ? `transcript:${transcript.transcriptId}`
              : undefined,
            turns: turnPage ? String(turnPage) : undefined,
            tools: hideTools ? "hide" : undefined,
            section: section ?? undefined,
          }}
          filters={filters}
          noun="sessions"
          path={PATH}
          window={window}
        />
      ) : null}
      {transcript && context && turns ? (
        <Modal
          closeHref={base}
          key={transcript.transcriptId}
          mobileSheet
          onClose={() => navigate(base, { preventScrollReset: true })}
          open
          size="pane"
          title={transcript.title || "Untitled session"}
        >
          <TranscriptPane
            context={context}
            hideTools={hideTools}
            openUrl={openUrl}
            section={section}
            tagHref={(tag) => href({ tags: [tag] }, {})}
            transcript={transcript}
            turnPage={turnPage}
            turns={turns}
          />
        </Modal>
      ) : null}
    </ApplicationShell>
  );
}

function SessionRow({
  session,
  sort,
  summary,
  href,
  open,
  tagHref,
}: {
  session: Transcript;
  sort: TranscriptSort;
  summary?: {
    prompts: number;
    toolCalls: number;
    errors: number;
    tags: string[];
  };
  href: string;
  open: boolean;
  tagHref: (tag: string) => string;
}) {
  const span =
    session.firstAt !== null && session.lastAt !== null
      ? session.lastAt - session.firstAt
      : null;
  const facts = [
    session.client,
    session.device,
    summary ? plural(summary.prompts, "prompt") : null,
    summary ? plural(summary.toolCalls, "tool call") : null,
    span !== null && span > 0 ? spanLabel(span) : null,
  ].filter(Boolean);
  return (
    <ItemRow
      className={
        summary?.errors ? "transcript-row has-errors" : "transcript-row"
      }
      description={facts.join(" · ")}
      href={href}
      meta={
        <>
          {session.project ? <ProjectChip project={session.project} /> : null}
          {summary?.errors ? (
            <span className="transcript-error-count">
              {plural(summary.errors, "error")}
            </span>
          ) : null}
          {summary?.tags.length ? (
            <TagLinks href={tagHref} tags={summary.tags.slice(0, 4)} />
          ) : null}
          <When at={sortTime(session, sort)}>
            {`${sort === "last" ? "Last active" : "Started"} ${timeOf(sortTime(session, sort))}`}
          </When>
        </>
      }
      open={open}
      stacked
      title={session.title || "Untitled session"}
    />
  );
}

function TranscriptPane({
  transcript,
  context,
  turns,
  turnPage,
  hideTools,
  section,
  openUrl,
  tagHref,
}: {
  transcript: Transcript;
  context: TranscriptContext;
  turns: TranscriptTurn[];
  turnPage: number;
  hideTools: boolean;
  section: Section | null;
  openUrl: (id: string, options?: OpenOptions) => string;
  tagHref: (tag: string) => string;
}) {
  const { stats } = context;
  const id = transcript.transcriptId;
  const exchanges = groupExchanges(turns);
  const firstOnPage = turnPage * TURNS;
  const pageOf = (position: number) => Math.floor(position / TURNS);
  const here = { turns: turnPage, hideTools };
  const turnHref = (position: number) =>
    pageOf(position) === turnPage
      ? `#t-${position}`
      : openUrl(id, {
          ...here,
          turns: pageOf(position),
          section: section ?? undefined,
          hash: `t-${position}`,
        });
  const promptNumber = new Map(
    context.outline.map((entry, index) => [entry.position, index + 1]),
  );
  /*
   * A message's own address: the session, the page of turns it is on, and
   * its anchor, without the list's filters, so it reads the same to anyone.
   */
  const linkFor = (position: number) => {
    const params = new URLSearchParams({ open: `transcript:${id}` });
    if (pageOf(position)) params.set("turns", String(pageOf(position)));
    return `${PATH}?${params}#t-${position}`;
  };
  const nextPrompt = new Map(
    context.outline
      .slice(0, -1)
      .map((entry, index) => [
        entry.position,
        context.outline[index + 1].position,
      ]),
  );
  const maxTool = stats.tools[0]?.count ?? 1;
  const changed = context.files.filter((file) => file.writes).length;
  const available: { key: Section; label: string; count?: number }[] = [];
  if (context.todos.length)
    available.push({
      key: "todos",
      label: "To-dos",
      count: context.todos.length,
    });
  if (context.memories.length)
    available.push({
      key: "memories",
      label: "Memories",
      count: context.memories.length,
    });
  if (context.files.length)
    available.push({
      key: "files",
      label: "Files",
      count: context.files.length,
    });
  if (stats.tools.length || context.skills.length)
    available.push({ key: "tools", label: "Tools", count: stats.tools.length });
  if (context.outline.length)
    available.push({
      key: "prompts",
      label: "Prompts",
      count: context.outline.length,
    });
  available.push({ key: "details", label: "Details" });
  const current =
    available.find((one) => one.key === section)?.key ?? available[0].key;
  return (
    <div className="transcript-pane">
      {context.tags.length || context.subjects.length ? (
        <section aria-label="Tags and subjects" className="transcript-chips">
          {context.tags.length ? (
            <TagLinks
              href={tagHref}
              tags={context.tags.map((one) => one.tag)}
            />
          ) : null}
          {context.subjects.length ? (
            <ul className="transcript-subjects">
              {context.subjects.map((subject) => (
                <li key={subject.id}>
                  <Link
                    className="subject-chip"
                    title={
                      subject.via === "name"
                        ? "Its name appears in the prompts"
                        : subject.via === "memory"
                          ? "Holds a memory this session named"
                          : "This session named it"
                    }
                    to={`/memories/subjects/${subject.id}`}
                  >
                    {subject.name}
                    {subject.via === "name" ? (
                      <span className="subject-via">?</span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <p className="transcript-facts">
        {[
          transcript.client,
          transcript.device,
          transcript.model,
          transcript.gitBranch,
        ]
          .filter(Boolean)
          .join(" · ")}
        {transcript.project ? (
          <>
            {" "}
            <ProjectChip project={transcript.project} />
          </>
        ) : null}
      </p>

      <dl aria-label="Session numbers" className="transcript-stats">
        <div>
          <dt>Prompts</dt>
          <dd>{stats.prompts}</dd>
        </div>
        <div>
          <dt>Tool calls</dt>
          <dd>{stats.toolCalls}</dd>
        </div>
        <div className={stats.errors ? "has-errors" : undefined}>
          <dt>Errors</dt>
          <dd>{stats.errors}</dd>
        </div>
        <div>
          <dt>Active</dt>
          <dd>
            {stats.active !== null ? spanLabel(stats.active) : "—"}
            {stats.span !== null && stats.span > (stats.active ?? 0) + 60 ? (
              <span className="transcript-sub">
                {" "}
                of {spanLabel(stats.span)}
              </span>
            ) : null}
          </dd>
        </div>
      </dl>

      <SectionTabs
        items={available.map((one) => ({
          href: openUrl(id, { ...here, section: one.key }),
          label: one.label,
          count: one.count,
          current: one.key === current,
        }))}
        label="Session sections"
      >
        {current === "todos" ? (
          <ul className="transcript-linked">
            {context.todos.map((todo) => (
              <li key={todo.id}>
                <Pill
                  tone={
                    todo.state === "done"
                      ? "done"
                      : todo.state === "claimed"
                        ? "claimed"
                        : todo.state === "blocked"
                          ? "blocked"
                          : "pending"
                  }
                >
                  {todo.state}
                </Pill>{" "}
                <Link
                  to={`/todos?open=${encodeURIComponent(`todo:${todo.id}`)}`}
                >
                  {todo.title}
                </Link>{" "}
                <a className="transcript-jump" href={turnHref(todo.position)}>
                  first named ↓
                </a>
              </li>
            ))}
          </ul>
        ) : current === "memories" ? (
          <ul className="transcript-linked">
            {context.memories.map((memory) => (
              <li key={memory.id}>
                <Tag>{memory.type}</Tag>{" "}
                <Link
                  to={`/memories?open=${encodeURIComponent(`memory:${memory.id}`)}`}
                >
                  {memory.title}
                </Link>
              </li>
            ))}
          </ul>
        ) : current === "files" ? (
          <>
            <p className="transcript-sub">
              {plural(changed, "file")} changed,{" "}
              {context.files.length - changed} only read.
              {context.files.length > 40 ? " The first 40:" : ""}
            </p>
            <ul className="transcript-linked transcript-files">
              {context.files.slice(0, 40).map((file) => (
                <li key={file.path}>
                  <code>{file.path}</code>{" "}
                  <span className="transcript-sub">
                    {file.writes ? plural(file.writes, "edit") : "read"}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : current === "tools" ? (
          <>
            {stats.tools.length ? (
              <ul className="transcript-linked transcript-histogram">
                {stats.tools.slice(0, 12).map((tool) => (
                  <li key={tool.tool}>
                    <span className="transcript-histogram-name">
                      {tool.tool}
                    </span>
                    <span
                      aria-hidden="true"
                      className="transcript-histogram-bar"
                      style={{
                        inlineSize: `${(tool.count / maxTool) * 100}%`,
                      }}
                    />
                    <span>{tool.count}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {context.skills.length ? (
              <p className="transcript-sub">
                Skills: {context.skills.join(", ")}
              </p>
            ) : null}
          </>
        ) : current === "prompts" ? (
          <nav aria-label="Prompts" className="transcript-outline">
            <ol>
              {context.outline.map((entry) => (
                <li key={entry.position}>
                  <a href={turnHref(entry.position)}>
                    {entry.text.split("\n")[0] || "(empty)"}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        ) : (
          <dl className="facts">
            <div>
              <dt>Session</dt>
              <dd className="transcript-text">{transcript.sessionId}</dd>
            </div>
            {transcript.cwd ? (
              <div>
                <dt>Directory</dt>
                <dd className="transcript-text">{transcript.cwd}</dd>
              </div>
            ) : null}
            {transcript.firstAt ? (
              <div>
                <dt>Started</dt>
                <dd>{fullTime(transcript.firstAt)}</dd>
              </div>
            ) : null}
            {transcript.lastAt ? (
              <div>
                <dt>Last turn</dt>
                <dd>{fullTime(transcript.lastAt)}</dd>
              </div>
            ) : null}
            <div>
              <dt>Turns</dt>
              <dd>{transcript.turnCount}</dd>
            </div>
          </dl>
        )}
      </SectionTabs>

      <div className="transcript-conversation-head">
        <h3>Conversation</h3>
        <Link
          aria-pressed={hideTools}
          className="transcript-toggle"
          preventScrollReset
          replace
          to={openUrl(id, {
            turns: turnPage,
            hideTools: !hideTools,
            section: section ?? undefined,
          })}
        >
          {hideTools ? "Show tool calls" : "Hide tool calls"}
        </Link>
      </div>
      {hideTools ? (
        <p className="transcript-sub">
          Prompts and replies only. A run with a failed call stays.
        </p>
      ) : null}

      {turnPage > 0 ? (
        <p className="transcript-sub">
          Turns {firstOnPage + 1}–{firstOnPage + turns.length} of{" "}
          {transcript.turnCount}.
        </p>
      ) : null}

      <section aria-label="Conversation" className="transcript-conversation">
        {exchanges.map((exchange, index) => (
          <ExchangeView
            exchange={exchange}
            hideTools={hideTools}
            key={exchange.prompt?.position ?? `lead-${index}`}
            laterPage={turnPage > 0}
            linkFor={linkFor}
            nextHref={(() => {
              const next = exchange.prompt
                ? nextPrompt.get(exchange.prompt.position)
                : undefined;
              return next === undefined ? undefined : turnHref(next);
            })()}
            number={
              exchange.prompt
                ? promptNumber.get(exchange.prompt.position)
                : undefined
            }
          />
        ))}
      </section>

      <nav aria-label="Turn pages" className="row">
        {turnPage > 0 ? (
          <Link to={openUrl(id, { turns: turnPage - 1, hideTools })}>
            Earlier turns
          </Link>
        ) : null}
        {(turnPage + 1) * TURNS < transcript.turnCount ? (
          <Link to={openUrl(id, { turns: turnPage + 1, hideTools })}>
            Later turns
          </Link>
        ) : null}
      </nav>
    </div>
  );
}

/**
 * One line of the conversation: its time in a narrow column on the left, the
 * turn beside it, so the times read down one edge and the speakers down the
 * other, as a call transcript does.
 */
function Line({
  at,
  id,
  href,
  className,
  role,
  children,
}: {
  at: number | null;
  id?: string;
  /** The line's own address, so a message can be linked and quoted alone. */
  href?: string;
  className: string;
  role?: string;
  children: ReactNode;
}) {
  return (
    <div className={`transcript-line ${className}`} id={id} role={role}>
      <span className="transcript-time">
        {at !== null && href ? (
          <a href={href} title="Link to this message">
            <When at={at} />
          </a>
        ) : at !== null ? (
          <When at={at} />
        ) : null}
        {href ? <CopyLink href={href} /> : null}
      </span>
      <div className="transcript-body">{children}</div>
    </div>
  );
}

/**
 * Copies a message's full URL. The time beside it is the same link, so with
 * scripting off it is still there to copy by hand (P11); this button only
 * appears once the page has hydrated.
 */
function CopyLink({ href }: { href: string }) {
  const [hydrated, setHydrated] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => setHydrated(true), []);
  if (!hydrated) return null;
  async function copy() {
    const { navigator, location } = globalThis as unknown as {
      navigator: { clipboard: { writeText(text: string): Promise<void> } };
      location: { origin: string };
    };
    try {
      await navigator.clipboard.writeText(`${location.origin}${href}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <button
      aria-label={copied ? "Link copied" : "Copy link to this message"}
      className="transcript-copy"
      onClick={copy}
      title={copied ? "Copied" : "Copy link"}
      type="button"
    >
      <Icon name={copied ? "check" : "link"} size={13} />
    </button>
  );
}

function ExchangeView({
  exchange,
  number,
  hideTools,
  laterPage,
  linkFor,
  nextHref,
}: {
  exchange: Exchange;
  number?: number;
  hideTools: boolean;
  /** Whether turns before this page exist, so a lead exchange continues them. */
  laterPage: boolean;
  /** The next prompt's anchor, on this page or another; none for the last. */
  nextHref?: string;
  linkFor: (position: number) => string;
}) {
  const prompt = exchange.prompt;
  const answers = answerIndexes(exchange);
  return (
    <article
      aria-label={
        prompt
          ? `Prompt ${number ?? ""}`.trim()
          : "Before the first prompt on this page"
      }
      className="transcript-exchange"
    >
      {prompt ? (
        <Line
          at={prompt.at}
          className="transcript-turn turn-human"
          href={linkFor(prompt.position)}
          id={`t-${prompt.position}`}
        >
          {nextHref ? (
            <a className="transcript-next" href={nextHref}>
              Next prompt ↓
            </a>
          ) : null}
          <h3 className="transcript-speaker">
            <a href={`#t-${prompt.position}`}>
              {number ? `Prompt ${number}` : "Prompt"}
            </a>
          </h3>
          <Markdown plugins={highlightCode}>{prompt.text}</Markdown>
        </Line>
      ) : laterPage ? (
        <p className="transcript-sub">Continued from the previous page.</p>
      ) : null}
      {exchange.blocks.map((block, index) => (
        <Fragment key={blockKey(block, index)}>
          <BlockView
            answer={answers.has(index)}
            linkFor={linkFor}
            block={block}
            hideTools={hideTools}
          />
        </Fragment>
      ))}
    </article>
  );
}

function blockKey(block: TranscriptBlock, index: number) {
  switch (block.type) {
    case "tools":
      return `tools-${block.turns[0].position}`;
    case "system":
      return `system-${block.turns[0].position}`;
    case "gap":
      return `gap-${block.position}`;
    default:
      return `turn-${block.turn.position}-${index}`;
  }
}

function BlockView({
  block,
  hideTools,
  answer,
  linkFor,
}: {
  block: TranscriptBlock;
  hideTools: boolean;
  linkFor: (position: number) => string;
  /** The exchange's last reply, its answer, rather than a note on the way. */
  answer: boolean;
}) {
  switch (block.type) {
    case "event": {
      // Hidden with the tool calls, as background work, unless it failed.
      if (hideTools && !block.event.failed) return null;
      const { event } = block;
      const line = (
        <>
          {event.label}
          {event.code ? (
            <>
              {" "}
              <code>{event.code}</code>
            </>
          ) : null}
        </>
      );
      const className = event.failed
        ? "transcript-event has-errors"
        : "transcript-event";
      return (
        <Line
          at={block.turn.at}
          className="line-event"
          href={linkFor(block.turn.position)}
          id={`t-${block.turn.position}`}
        >
          {event.detail ? (
            <details className={className}>
              <summary>{line}</summary>
              {event.markdown ? (
                <div className="transcript-event-detail">
                  <Markdown plugins={highlightCode}>{event.detail}</Markdown>
                </div>
              ) : (
                <pre className="transcript-event-detail">{event.detail}</pre>
              )}
            </details>
          ) : (
            <p className={className}>{line}</p>
          )}
        </Line>
      );
    }
    case "gap":
      return (
        <p className="transcript-gap" role="separator">
          {spanLabel(block.seconds)} later
        </p>
      );
    case "thinking":
      // The agent's working: folded, set apart from a reply, and hidden with
      // the tool calls when only prompts and replies are wanted.
      if (hideTools) return null;
      return (
        <Line
          at={block.turn.at}
          className="line-thinking"
          href={linkFor(block.turn.position)}
          id={`t-${block.turn.position}`}
        >
          <details className="transcript-thinking">
            <summary>
              Thinking
              <span className="transcript-thinking-gist">
                {" · "}
                {block.turn.text.split("\n")[0].slice(0, 120)}
              </span>
            </summary>
            <div className="transcript-thinking-body">
              <Markdown plugins={highlightCode}>{block.turn.text}</Markdown>
            </div>
          </details>
        </Line>
      );
    case "system": {
      // What the client put in front of the model: the system prompt,
      // instruction files, hook context. Folded to the names of its sources,
      // each opening to its text; background, so hidden with the tool calls.
      if (hideTools) return null;
      const names = block.turns.map((turn) => systemSource(turn.toolName));
      const shown = [...new Set(names)];
      const label =
        shown.length > 3
          ? `${shown.slice(0, 3).join(", ")}, ${shown.length - 3} more`
          : shown.join(", ");
      return (
        <Line
          at={block.turns[0].at}
          className="line-system"
          href={linkFor(block.turns[0].position)}
        >
          <details className="transcript-system">
            <summary>
              System
              <span className="transcript-system-gist">
                {" · "}
                {label}
              </span>
            </summary>
            <ol className="transcript-system-list">
              {block.turns.map((turn, index) => (
                <li id={`t-${turn.position}`} key={turn.position}>
                  <details>
                    <summary title={turn.toolName ?? undefined}>
                      {names[index]}
                      <span className="transcript-system-size">
                        {" · "}
                        {sizeLabel(turn.text.length)}
                      </span>
                    </summary>
                    <pre className="transcript-system-text">{turn.text}</pre>
                  </details>
                </li>
              ))}
            </ol>
          </details>
        </Line>
      );
    }
    case "text":
      return (
        <Line
          at={block.turn.at}
          className={`transcript-turn turn-assistant ${answer ? "turn-answer" : "turn-progress"}`}
          href={linkFor(block.turn.position)}
          id={`t-${block.turn.position}`}
        >
          <p className="transcript-speaker">Assistant</p>
          <Markdown plugins={highlightCode}>{block.turn.text}</Markdown>
        </Line>
      );
    case "error":
      return (
        <Line
          at={block.turn.at}
          className="transcript-turn turn-error"
          href={linkFor(block.turn.position)}
          id={`t-${block.turn.position}`}
          role="note"
        >
          <p className="transcript-speaker">API error</p>
          <p className="transcript-text">{block.turn.text}</p>
        </Line>
      );
    case "tools": {
      if (hideTools && !block.errors) return null;
      const calls = block.turns.filter((turn) => turn.kind === "tool_call");
      const span =
        block.firstAt !== null && block.lastAt !== null
          ? block.lastAt - block.firstAt
          : 0;
      const label = `${plural(calls.length, "tool call")} · ${toolSummary(block.counts)}${span > 0 ? ` · ${spanLabel(span)}` : ""}`;
      return (
        <Line
          at={block.firstAt}
          className="line-tools"
          href={linkFor(block.turns[0].position)}
        >
          <details
            className={
              block.errors ? "transcript-tools has-errors" : "transcript-tools"
            }
            open={block.errors > 0}
          >
            <summary>
              {label}
              {block.errors ? (
                <span className="transcript-error-count">
                  {" "}
                  · {plural(block.errors, "failed", "failed")}
                </span>
              ) : null}
            </summary>
            <ol className="transcript-tool-list">
              {block.turns.map((turn) => (
                <li
                  className={
                    turn.kind === "tool_error" ? "tool-error" : undefined
                  }
                  id={`t-${turn.position}`}
                  key={turn.position}
                >
                  <span className="transcript-tool-name">
                    {turn.kind === "tool_error" ? "✕ " : ""}
                    {toolLabel(turn.toolName)}
                  </span>{" "}
                  <span className="transcript-text">{turn.text}</span>
                </li>
              ))}
            </ol>
          </details>
        </Line>
      );
    }
  }
}

/** A system turn's source as a reader names it: a file by its name. */
function systemSource(label: string | null): string {
  if (!label) return "Context";
  return /^[/~…]|^[A-Za-z]:\\/.test(label)
    ? (label.split(/[\\/]/).pop() ?? label)
    : label;
}

function sizeLabel(characters: number): string {
  return characters < 1000
    ? plural(characters, "character")
    : `${Math.round(characters / 1000)}k characters`;
}
