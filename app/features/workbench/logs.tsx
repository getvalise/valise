import { type ReactNode, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Icon } from "~/components/icon";
import { Empty, Pill } from "~/components/ui";
import {
  type Activity,
  CALL_FIELD_NAMES,
  type CallField,
  type CallRow,
  isStreamProbe,
  MCP_OUTCOMES,
  type McpOutcome,
  RUN_SORTS,
  type Run,
  type RunSort,
} from "~/concepts/activity";
import { itemPath } from "~/concepts/item-path";

/* -------------------------------------------------------------- logs --- */

export const WINDOWS = [
  { hours: 24, label: "24 hours" },
  { hours: 168, label: "7 days" },
  { hours: 720, label: "30 days" },
];

/**
 * What clients actually send. The tables above the call list are the point:
 * a per-tool error rate and a per-client count say where the surface is being
 * misread, and the arguments under each row say how.
 */
export function Logs({
  activity,
  linked,
  runs,
  sort,
}: {
  activity: Activity;
  /** The call named in the URL, read by id whether or not a run lists it. */
  linked: CallRow | null;
  runs: Run[];
  sort: RunSort;
}) {
  const { filters, totals } = activity;
  const [params] = useSearchParams();
  const selectedId = params.get("call")?.trim() || null;
  const listed = runs.flatMap((run) => run.calls);
  const selected =
    listed.find((call) => call.callId === selectedId) ??
    (linked?.callId === selectedId ? linked : null);
  const keysLive = useCallKeys(listed, selectedId, filters, sort);

  return (
    <section>
      {/* Keyed on the filters, so a value clicked in the pane shows in the
        selects as well as in the URL. */}
      <form
        action="/workbench"
        className="filters"
        key={logsHref(filters, sort)}
        method="get"
      >
        <input name="tab" type="hidden" value="logs" />
        {CALL_FIELD_NAMES.map((field) =>
          filters.fields[field] ? (
            <input
              key={field}
              name={field}
              type="hidden"
              value={filters.fields[field]}
            />
          ) : null,
        )}
        <label>
          Window
          <select defaultValue={String(filters.windowHours)} name="window">
            {WINDOWS.map((window) => (
              <option key={window.hours} value={window.hours}>
                {window.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tool
          <select defaultValue={filters.tool ?? ""} name="tool">
            <option value="">Any</option>
            {activity.knownTools.map((tool) => (
              <option key={tool} value={tool}>
                {tool}
              </option>
            ))}
          </select>
        </label>
        <label>
          Client
          <select defaultValue={filters.client ?? ""} name="client">
            <option value="">Any</option>
            {activity.knownClients.map((client) => (
              <option key={client} value={client}>
                {client}
              </option>
            ))}
          </select>
        </label>
        <label>
          Outcome
          <select defaultValue={filters.outcome ?? ""} name="outcome">
            <option value="">Any</option>
            {MCP_OUTCOMES.map((outcome) => (
              <option key={outcome} value={outcome}>
                {outcome}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input
            defaultChecked={filters.intentOnly}
            name="intent"
            type="checkbox"
            value="1"
          />
          Said why
        </label>
        <label className="check">
          <input
            defaultChecked={filters.handshakes}
            name="handshakes"
            type="checkbox"
            value="1"
          />
          Handshakes
        </label>
        <div className="filter-actions">
          <button type="submit">Apply</button>
          <a href="/workbench?tab=logs">Reset</a>
        </div>
      </form>

      <ActiveFilters
        filters={filters}
        remove={(param) =>
          logsHref(withoutFilter(filters, param), sort, selectedId)
        }
      />

      <nav aria-label="Sort runs" className="sorts">
        {RUN_SORTS.map((name) => (
          <a
            aria-current={sort === name ? "true" : undefined}
            href={logsHref(filters, name, selectedId)}
            key={name}
          >
            {SORT_LABELS[name]}
          </a>
        ))}
      </nav>

      <div className="logs-split" data-keys={keysLive ? "on" : undefined}>
        {runs.length === 0 ? (
          <Empty>No calls match those filters.</Empty>
        ) : (
          <ul className="runs">
            {runs.map((run, index) => (
              <li key={run.runId}>
                {/* The newest run open, so the latest calls show on arrival,
                  and the run holding the selected call, so it shows marked. */}
                <details
                  open={
                    (index === 0 && sort === "recent") ||
                    run.calls.some((call) => call.callId === selectedId)
                  }
                >
                  <summary>
                    {/* A named session leads: it is what tells two Claude Codes apart. */}
                    <span className="caller">
                      {run.sessionName ?? run.caller}
                    </span>
                    <span className="counts">
                      {plural(run.calls.length, "call")}
                      {run.tools > 0 ? ` · ${plural(run.tools, "tool")}` : ""}
                    </span>
                    <span className="took">{duration(run.spanMs)}</span>
                    <span className="badges">
                      {run.errors > 0 ? (
                        <Pill tone="blocked">{run.errors} not ok</Pill>
                      ) : (
                        <Pill tone="done">ok</Pill>
                      )}
                      {run.recovered ? (
                        <Pill tone="accent">recovered</Pill>
                      ) : null}
                      {run.repeated ? (
                        <Pill tone="claimed">repeated call</Pill>
                      ) : null}
                      {run.plugin ? (
                        <Pill tone="label">{run.plugin}</Pill>
                      ) : null}
                    </span>
                    <span className="via">
                      {[
                        run.sessionName ? run.caller : null,
                        run.host,
                        run.client ?? "—",
                        run.transport,
                        `last ${stamp(run.lastAt)}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    {run.intent ? <p className="why">{run.intent}</p> : null}
                  </summary>
                  <div className="run-detail">
                    <ul className="calls">
                      {run.calls.map((call) => (
                        <CallEntry
                          call={call}
                          href={logsHref(filters, sort, call.callId)}
                          key={call.callId}
                          selected={call.callId === selectedId}
                          startedAt={run.startedAt}
                        />
                      ))}
                    </ul>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
        {selectedId ? (
          <CallPane
            call={selected}
            closeHref={logsHref(filters, sort)}
            filterHref={(param, value) =>
              logsHref(withFilter(filters, param, value), sort, selectedId)
            }
            selfHref={logsHref(filters, sort, selectedId)}
          />
        ) : null}
      </div>

      <ul className="kpis">
        <Kpi label="Calls" value={totals.calls} />
        <Kpi
          label="Not ok"
          note={percent(totals.errors, totals.calls)}
          value={totals.errors}
        />
        <Kpi label="Callers" value={totals.clients} />
        <Kpi label="Tools used" value={totals.tools} />
      </ul>

      {activity.outcomes.length > 0 ? (
        <div className="row outcomes">
          {activity.outcomes.map((row) => (
            <Pill key={row.outcome} tone={outcomeTone(row.outcome)}>
              {row.outcome} {row.calls}
            </Pill>
          ))}
        </div>
      ) : null}

      {activity.logins.length === 0 ? (
        <Empty>No auth events recorded yet.</Empty>
      ) : (
        <details className="auth-trail">
          <summary>
            Sign-ins and consent
            <span className="count">{activity.logins.length}</span>
          </summary>
          <div className="scroll-x">
            <table className="dense">
              <tbody>
                <tr>
                  <th>When</th>
                  <th>Event</th>
                  <th>Who</th>
                  <th>Detail</th>
                  <th>From</th>
                </tr>
                {activity.logins.map((event) => (
                  <tr key={event.eventId}>
                    <td>{stamp(event.at)}</td>
                    <td>
                      <Pill tone={authTone(event.kind)}>{event.kind}</Pill>
                    </td>
                    <td>{event.subject ?? event.userId ?? "—"}</td>
                    <td>{event.detail ?? "—"}</td>
                    <td title={event.userAgent ?? undefined}>
                      {event.ip ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}

const SORT_LABELS: Record<RunSort, string> = {
  recent: "Newest",
  longest: "Longest",
  errors: "Most errors",
};

/**
 * The logs tab's own URL. Filters and sort travel with every link, because
 * they describe the same window; `call` is the open pane, P3.
 */
function logsHref(
  filters: Activity["filters"],
  sort: RunSort,
  call: string | null = null,
): string {
  const params = new URLSearchParams({ tab: "logs", sort });
  params.set("window", String(filters.windowHours));
  if (filters.tool) params.set("tool", filters.tool);
  if (filters.client) params.set("client", filters.client);
  if (filters.outcome) params.set("outcome", filters.outcome);
  for (const field of CALL_FIELD_NAMES) {
    const value = filters.fields[field];
    if (value) params.set(field, value);
  }
  if (filters.errorsOnly) params.set("errors", "1");
  if (filters.intentOnly) params.set("intent", "1");
  if (filters.handshakes) params.set("handshakes", "1");
  if (call) params.set("call", call);
  return `/workbench?${params}`;
}

/** A query parameter a value filter travels in: a select's, or a column's. */
type FilterParam = "tool" | "client" | "outcome" | CallField;

/** What each filter reads as on its chip. */
const FILTER_LABELS: Record<FilterParam, string> = {
  tool: "tool",
  client: "client",
  outcome: "outcome",
  agent: "agent",
  principal: "principal",
  transport: "transport",
  session: "session",
  name: "session name",
  host: "host",
  plugin: "plugin",
  target: "target",
  info: "client info",
  ua: "user agent",
};

function withFilter(
  filters: Activity["filters"],
  param: FilterParam,
  value: string,
): Activity["filters"] {
  if (param === "tool" || param === "client") {
    return { ...filters, [param]: value };
  }
  if (param === "outcome") {
    const outcome = MCP_OUTCOMES.find((known) => known === value);
    return outcome ? { ...filters, outcome } : filters;
  }
  return { ...filters, fields: { ...filters.fields, [param]: value } };
}

function withoutFilter(
  filters: Activity["filters"],
  param: FilterParam,
): Activity["filters"] {
  if (param === "tool" || param === "client" || param === "outcome") {
    return { ...filters, [param]: null };
  }
  const fields = { ...filters.fields };
  delete fields[param];
  return { ...filters, fields };
}

/**
 * Every value the list is narrowed to, one chip each, each with its own
 * remove. A value clicked in the pane lands here. P7, P3.
 */
function ActiveFilters({
  filters,
  remove,
}: {
  filters: Activity["filters"];
  remove: (param: FilterParam) => string;
}) {
  const active = (
    [
      ["tool", filters.tool],
      ["client", filters.client],
      ["outcome", filters.outcome],
      ...CALL_FIELD_NAMES.map((field) => [field, filters.fields[field]]),
    ] as [FilterParam, string | null | undefined][]
  ).filter((entry): entry is [FilterParam, string] => !!entry[1]);
  if (active.length === 0) return null;
  return (
    <ul aria-label="Active filters" className="tags active-filters">
      {active.map(([param, value]) => (
        <li className="chip" key={param}>
          <span title={value}>
            {FILTER_LABELS[param]}:{param === "target" ? shortId(value) : value}
          </span>
          <Link
            aria-label={`Remove ${FILTER_LABELS[param]} filter`}
            className="chip-remove"
            preventScrollReset
            to={remove(param)}
          >
            <Icon name="close" size={12} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** What the keyboard handler reads. Shaped like the DOM, which is not typed here. */
type KeyPress = {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  target: { tagName?: string; isContentEditable?: boolean } | null;
  preventDefault(): void;
};
type KeyDocument = {
  addEventListener(type: "keydown", listener: (event: KeyPress) => void): void;
  removeEventListener(
    type: "keydown",
    listener: (event: KeyPress) => void,
  ): void;
  querySelector(selector: string): {
    scrollIntoView(options: { block: "nearest" }): void;
    focus(options: { preventScroll: boolean }): void;
  } | null;
};

const TYPING = new Set(["INPUT", "SELECT", "TEXTAREA"]);

/**
 * j and k, or the arrows once a call is open, move the selection through the
 * calls in the order the page lists them; Escape closes the pane. Each move is
 * a navigation, so back and forward walk the selections. Returns whether the
 * keys are live, which the page marks so a test can wait for it.
 */
function useCallKeys(
  calls: CallRow[],
  selectedId: string | null,
  filters: Activity["filters"],
  sort: RunSort,
): boolean {
  const navigate = useNavigate();
  const [live, setLive] = useState(false);

  useEffect(() => {
    const doc = (globalThis as unknown as { document: KeyDocument }).document;
    function onKey(event: KeyPress) {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (target?.isContentEditable || TYPING.has(target?.tagName ?? "")) {
        return;
      }
      const at = calls.findIndex((call) => call.callId === selectedId);
      let next: string | null | undefined;
      if (event.key === "Escape" && selectedId) next = null;
      else if (event.key === "j" || (event.key === "ArrowDown" && selectedId)) {
        next = calls[Math.min(at + 1, calls.length - 1)]?.callId;
      } else if (event.key === "k" || (event.key === "ArrowUp" && selectedId)) {
        next = calls[Math.max(at - 1, 0)]?.callId;
      }
      if (next === undefined || next === selectedId) return;
      event.preventDefault();
      navigate(logsHref(filters, sort, next), { preventScrollReset: true });
    }
    doc.addEventListener("keydown", onKey);
    setLive(true);
    return () => doc.removeEventListener("keydown", onKey);
  }, [calls, selectedId, filters, sort, navigate]);

  // Keep the selected row on screen and focused as the keys walk past the
  // fold, so the focus ring and the selection mark stay on the same row.
  useEffect(() => {
    if (!selectedId) return;
    const doc = (globalThis as unknown as { document: KeyDocument }).document;
    const row = doc.querySelector(`[data-call="${selectorSafe(selectedId)}"]`);
    row?.scrollIntoView({ block: "nearest" });
    row?.focus({ preventScroll: true });
  }, [selectedId]);

  return live;
}

/** Call ids are `cal_<uuid>`; anything else is dropped from the selector. */
function selectorSafe(value: string): string {
  return value.replace(/[^\w-]/g, "");
}

function CallEntry({
  call,
  href,
  selected,
  startedAt,
}: {
  call: CallRow;
  /** This page with this call open in the pane. */
  href: string;
  selected: boolean;
  /** The run's first call, so each row shows how far into it this one is. */
  startedAt: number;
}) {
  return (
    <li>
      <Link
        aria-current={selected ? "true" : undefined}
        className="call-row"
        data-call={call.callId}
        preventScrollReset
        to={href}
      >
        <span className="when">{offset(call.at - startedAt)}</span>
        <code className="what">
          {call.tool ?? call.method}
          {call.targetId ? (
            <span className="target" title={call.targetId}>
              {shortId(call.targetId)}
            </span>
          ) : null}
          {call.rerankJson ? (
            <span className="rerank">{rerankLabel(call.rerankJson)}</span>
          ) : null}
        </code>
        <span className="who">
          {call.client ?? "—"} / {call.agent ?? "—"}
        </span>
        <CallOutcome call={call} />
        <span className="took">{call.durationMs} ms</span>
        {call.intent ? <span className="why">{call.intent}</span> : null}
        {call.errorMessage ? (
          <span className="error">{call.errorMessage}</span>
        ) : null}
      </Link>
    </li>
  );
}

/**
 * One call, every column, beside the list rather than inside it, so reading a
 * payload never pushes the next row off the screen. Grouped as a log explorer
 * groups it: what was asked, how it ended, who asked.
 */
export function CallPane({
  call,
  closeHref,
  filterHref,
  selfHref,
}: {
  call: CallRow | null;
  closeHref: string;
  /** The list narrowed to this value. Absent, the values are plain text. */
  filterHref?: (param: FilterParam, value: string) => string;
  selfHref: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <aside aria-label="Call details" className="call-pane">
      <header className="call-pane-head">
        <code className="what">
          {call ? (call.tool ?? call.method) : "No such call"}
        </code>
        {call ? <CallOutcome call={call} /> : null}
        {/* A link first: without scripts it is the share URL to copy. */}
        <a
          className="copy-link"
          href={selfHref}
          onClick={(event) => {
            const clipboard = (
              globalThis as unknown as {
                navigator?: {
                  clipboard?: { writeText(text: string): Promise<void> };
                };
              }
            ).navigator?.clipboard;
            if (!clipboard) return;
            event.preventDefault();
            const here = (
              globalThis as unknown as { location: { href: string } }
            ).location.href;
            void clipboard
              .writeText(new URL(selfHref, here).href)
              .then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy link"}
        </a>
        <Link className="close" preventScrollReset to={closeHref}>
          Close
        </Link>
      </header>
      {call === null ? (
        <Empty>
          No call has that id. The log keeps thirty days, so it may have aged
          out.
        </Empty>
      ) : (
        <CallFacts call={call} filterHref={filterHref} />
      )}
    </aside>
  );
}

function CallFacts({
  call,
  filterHref,
}: {
  call: CallRow;
  filterHref?: (param: FilterParam, value: string) => string;
}) {
  // A value that is a column is the filter for it: one click narrows the
  // list to calls that share it, and the pane stays on this call.
  const by = (param: FilterParam, value: string | null) =>
    value && filterHref ? (
      <Link
        className="filter-value"
        preventScrollReset
        title={`Show only calls with this ${FILTER_LABELS[param]}`}
        to={filterHref(param, value)}
      >
        {value}
      </Link>
    ) : (
      value
    );
  const opens = call.targetId ? itemPath(call.targetId) : null;
  return (
    <>
      <h3 className="eyebrow">Request</h3>
      <dl className="facts call-facts">
        <Fact label="When">{stamp(call.at)}</Fact>
        <Fact label="HTTP method">{call.httpMethod}</Fact>
        <Fact label="Limiter method">{call.limiterMethod}</Fact>
        <Fact label="Limiter name">{call.limiterName}</Fact>
        <Fact label="Method">{call.method}</Fact>
        <Fact label="Tool">{by("tool", call.tool)}</Fact>
        <Fact label="Scope">{call.requiredScope}</Fact>
        <Fact label="Target">
          {call.targetId ? (
            <>
              {by("target", call.targetId)}
              {opens ? (
                <a className="open-item" href={opens}>
                  Open
                </a>
              ) : null}
            </>
          ) : null}
        </Fact>
        <Fact label="Said why">{call.intent}</Fact>
        {/* Label above, not beside: a payload needs the pane's whole width. */}
        <div className="stacked">
          <dt>Arguments</dt>
          <dd>
            {call.argsJson ? (
              <>
                <JsonCode text={prettyArgs(call.argsJson)} />
                {truncated(call) ? (
                  <p className="muted">
                    Stored first 8KB of {bytes(call.argsBytes ?? 0)}.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="muted">No arguments on this request.</p>
            )}
          </dd>
        </div>
      </dl>

      <h3 className="eyebrow">Outcome</h3>
      <dl className="facts call-facts">
        <Fact label="Outcome">{by("outcome", call.outcome)}</Fact>
        <Fact label="Error">
          {[call.errorCode, call.errorMessage].filter(Boolean).join(" · ")}
        </Fact>
        <Fact label="Status">{String(call.status)}</Fact>
        {isStreamProbe(call) ? (
          <Fact label="Transport">
            Optional event stream not offered; tool calls use POST.
          </Fact>
        ) : null}
        <Fact label="Took">{`${call.durationMs} ms`}</Fact>
        <Fact label="Rerank">{rerankLabel(call.rerankJson)}</Fact>
        <Fact label="Response">{bytes(call.resultBytes ?? 0)}</Fact>
      </dl>

      <h3 className="eyebrow">Who</h3>
      <dl className="facts call-facts">
        <Fact label="Transport">{by("transport", call.transport)}</Fact>
        <Fact label="Principal">{by("principal", call.principal)}</Fact>
        <Fact label="Agent">{by("agent", call.agent)}</Fact>
        <Fact label="Client">{by("client", call.client)}</Fact>
        <Fact label="Client info">{by("info", call.clientInfo)}</Fact>
        <Fact label="User agent">{by("ua", call.userAgent)}</Fact>
        <Fact label="Session">{by("session", call.session)}</Fact>
        <Fact label="Session name">{by("name", call.sessionName)}</Fact>
        <Fact label="Host">{by("host", call.host)}</Fact>
        <Fact label="Plugin">{by("plugin", call.plugin)}</Fact>
        <Fact label="Call id">{call.callId}</Fact>
      </dl>
    </>
  );
}

/** One label and its value, label left. A missing value reads as a dash. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="wide">
      <dt>{label}</dt>
      <dd>{children || "—"}</dd>
    </div>
  );
}

function Kpi({
  label,
  value,
  note,
}: {
  label: string;
  value: number;
  note?: string;
}) {
  return (
    <li className="kpi">
      <span className="n">{value}</span>
      <span className="eyebrow">{label}</span>
      {note ? <span className="muted">{note}</span> : null}
    </li>
  );
}

function CallOutcome({ call }: { call: CallRow }) {
  return isStreamProbe(call) ? (
    <Pill tone="label">stream not offered</Pill>
  ) : (
    <Pill tone={outcomeTone(call.outcome)}>{call.outcome}</Pill>
  );
}

function outcomeTone(outcome: McpOutcome) {
  if (outcome === "ok") return "done";
  if (outcome === "tool_error" || outcome === "unauthorized") return "blocked";
  return "claimed";
}

function authTone(kind: string) {
  if (kind === "console_login" || kind === "oauth_grant") return "done";
  if (kind === "console_login_failed" || kind === "oauth_denied")
    return "blocked";
  return "label";
}

/** How far into the run a call happened. Absolute times all read the same. */
function offset(ms: number): string {
  return ms < 1000 ? `+${ms}ms` : `+${(ms / 1000).toFixed(1)}s`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Wall clock across a run. Seconds up to a minute, then minutes, because the
 * difference between 94 and 96 seconds is not what anyone reads this for.
 */
function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/** UTC, because a server-rendered local time mismatches on hydration. */
function stamp(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function percent(part: number, whole: number): string {
  return whole === 0 ? "—" : `${Math.round((part / whole) * 100)}% of calls`;
}

function bytes(count: number): string {
  if (count === 0) return "—";
  return count < 1024 ? `${count} B` : `${(count / 1024).toFixed(1)} KB`;
}

/**
 * A search's rerank stage in a few words: `jev 412 ms` when the order is the
 * reranker's, `fts order: timeout 1500 ms` when it fell back. Null when no
 * reranker ran, which is every other tool and a server without the key.
 */
function rerankLabel(json: string | null): string | null {
  if (!json) return null;
  try {
    const rerank = JSON.parse(json) as {
      backend: string;
      reranked: boolean;
      ms: number;
      fallback?: string;
    };
    return rerank.reranked
      ? `${rerank.backend} ${rerank.ms} ms`
      : `fts order: ${rerank.backend} ${rerank.fallback ?? "failed"}`;
  } catch {
    return null;
  }
}

function truncated(call: {
  argsJson: string | null;
  argsBytes: number | null;
}) {
  return (call.argsBytes ?? 0) > (call.argsJson?.length ?? 0);
}

/** Re-indent what was stored compact. A truncated payload prints as it is. */
/**
 * JSON as a log viewer shows it, with four ink weights rather than a theme:
 * keys, strings, and numbers and literals each one token colour, punctuation
 * receding. A tokenizer, not a parser, because a stored payload is cut at 8KB
 * and a cut payload still has to read.
 */
function JsonCode({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(JSON_TOKEN)) {
    const index = match.index ?? 0;
    if (index > at) parts.push(text.slice(at, index));
    const [token, string, colon, number, literal] = match;
    if (string !== undefined) {
      const item = colon ? null : itemHref(string);
      parts.push(
        item ? (
          <a className="j-str" href={item} key={index}>
            {string}
          </a>
        ) : (
          <span className={colon ? "j-key" : "j-str"} key={index}>
            {string}
          </span>
        ),
      );
      if (colon) parts.push(colon);
    } else if (number !== undefined) {
      parts.push(
        <span className="j-num" key={index}>
          {number}
        </span>,
      );
    } else if (literal !== undefined) {
      parts.push(
        <span className="j-lit" key={index}>
          {literal}
        </span>,
      );
    }
    at = index + token.length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <pre className="json">{parts}</pre>;
}

/** A string, and the colon that makes it a key; a number; a literal. */
const JSON_TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;

/** Where a quoted Valise id opens in the console. */
function itemHref(quoted: string): string | null {
  return /^"[^"]*"$/.test(quoted) ? itemPath(quoted.slice(1, -1)) : null;
}

/**
 * `todo:tdo_78f4…`: the kind, the id's own prefix, and four characters of a
 * uuid, which is enough to tell a run's rows apart. A skill's id is its name,
 * so it stays whole up to twenty characters.
 */
function shortId(id: string): string {
  const uuid = /^(todo:tdo_|memory:mem_)/.exec(id)?.[0];
  if (uuid) return `${uuid}${id.slice(uuid.length, uuid.length + 4)}…`;
  return id.length > 20 ? `${id.slice(0, 19)}…` : id;
}

function prettyArgs(argsJson: string): string {
  try {
    return JSON.stringify(JSON.parse(argsJson), null, 2);
  } catch {
    return argsJson;
  }
}
