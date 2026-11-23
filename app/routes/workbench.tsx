import {
  Link,
  type ShouldRevalidateFunctionArgs,
  useActionData,
  useSearchParams,
} from "react-router";
import { type BackupStatus, backupStatus } from "~/backup/monitor";
import { ApplicationShell, Empty, Pill, SubNav } from "~/components/ui";
import {
  isRunSort,
  parseActivityFilters,
  type RunSort,
} from "~/concepts/activity";
import { parseCapUsd } from "~/concepts/memory-review-limits";
import {
  requireConsoleAdmin,
  requireSameOriginAction,
} from "~/console/context.server";
import {
  type EvalCaseRow,
  type EvalCell,
  type EvalCondition,
  type EvalHistoryEntry,
  type EvalRunNote,
  type Evals,
  readEvals,
} from "~/console/evals.server";
import { Components } from "~/features/workbench/components";
import { Logs } from "~/features/workbench/logs";
import { ReviewCosts } from "~/features/workbench/review-costs";
import { Spend } from "~/features/workbench/spend";
import type { Route } from "./+types/workbench";

/**
 * The development surface. Three tabs:
 *
 * - Components, the design principles followed by every primitive in every
 *   state, each specimen tagged with the principle it carries, so a token
 *   change is reviewed in one place rather than by clicking through four
 *   routes. The principles are `docs/design/principles.md` itself, read at
 *   build time; there is no second copy to drift.
 * - Logs, what clients actually send: one row per MCP request with its
 *   arguments, plus who signed in and who was refused. ADR-0006.
 * - Evals, whether a model picks the right tool from the descriptions alone,
 *   from `evals/runs/index.json` when the evals ran locally, otherwise the
 *   committed `evals/fixtures/runs-index.sample.json`. ADR-0003 made that
 *   text the product.
 * - Costs: estimated spend per account over 30 days, with System and
 *   Unattributed rows (`docs/design/spend.md`), above each account's daily
 *   money caps on memory review and candidate ranking, the one control here
 *   that writes. ADR-0012, 2026-11-04.
 *
 * Only the tab being looked at costs a query. Logs reads D1; evals is read on
 * the server so one condition and one case's history, not every run, cross
 * the wire.
 */

const TABS = ["components", "logs", "evals", "costs"] as const;
type Tab = (typeof TABS)[number];

function tabOf(url: URL): Tab {
  const value = url.searchParams.get("tab");
  return TABS.includes(value as Tab) ? (value as Tab) : "components";
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const actor = await requireConsoleAdmin(context, request);
  const url = new URL(request.url);
  const tab = tabOf(url);
  const backups = await backupStatus(actor.env);
  if (tab !== "logs") {
    return {
      backups,
      activity: null,
      runs: null,
      call: null,
      runSort: "recent" as RunSort,
      evals:
        tab === "evals"
          ? readEvals(url.searchParams.get("on"), url.searchParams.get("case"))
          : null,
      ...(tab === "costs"
        ? await (async () => {
            const [costs, spend] = await Promise.all([
              actor.admin.listReviewCosts(),
              actor.admin.readSpend(),
            ]);
            return { costs, spend };
          })()
        : { costs: null, spend: null }),
    };
  }
  const filters = parseActivityFilters(url);
  const requested = url.searchParams.get("sort");
  const runSort: RunSort = isRunSort(requested) ? requested : "recent";
  const callId = url.searchParams.get("call")?.trim();
  return {
    backups,
    activity: await actor.store.activity.calls(filters),
    runs: await actor.store.activity.runs(filters, runSort),
    // Read by id, outside the filters, so a shared link opens its call even
    // when the window or the filters no longer list it.
    call: callId ? await actor.store.activity.call(callId) : null,
    runSort,
    evals: null,
    costs: null,
    spend: null,
  };
}

/** The one write on the workbench: an account's review cost caps. Admins only. */
export async function action({ context, request }: Route.ActionArgs) {
  requireSameOriginAction(request);
  const actor = await requireConsoleAdmin(context, request);
  const form = await request.formData();
  if (form.get("intent") !== "review-caps")
    throw new Response("Unknown workbench action.", { status: 400 });
  const userId = String(form.get("user") ?? "");
  if (!/^[\w-]{1,80}$/.test(userId))
    throw new Response("Invalid user id.", { status: 400 });
  const reviewMicrousd = parseCapUsd(String(form.get("reviewUsd") ?? ""));
  const rankingMicrousd = parseCapUsd(String(form.get("rankingUsd") ?? ""));
  if (reviewMicrousd === null || rankingMicrousd === null)
    return {
      refused: {
        userId,
        message:
          "Enter each cap in dollars from $0.001 to $5.00, with at most six decimal places.",
      },
    };
  // A cap someone else changed since this page loaded is not overwritten (P2).
  const current = (await actor.admin.listReviewCosts()).find(
    (account) => account.userId === userId,
  );
  if (
    current &&
    (String(current.reviewMicrousd) !== form.get("wasReview") ||
      String(current.rankingMicrousd) !== form.get("wasRanking"))
  )
    return {
      refused: {
        userId,
        message: "These caps changed elsewhere. Reload the page and try again.",
      },
    };
  if (
    !(await actor.admin.setReviewCaps(userId, {
      reviewMicrousd,
      rankingMicrousd,
    }))
  )
    throw new Response("Not found", { status: 404 });
  return { saved: userId };
}

/**
 * Selecting a call changes only `call`, and the page already holds every call
 * it lists. Skipping the reload makes the pane open on the keypress and keeps
 * the list from re-reading under the reader (P4). A call the list does not
 * hold only arrives by a full load, which runs the loader anyway.
 */
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (formMethod || currentUrl.pathname !== nextUrl.pathname) {
    return defaultShouldRevalidate;
  }
  const before = new URLSearchParams(currentUrl.search);
  const after = new URLSearchParams(nextUrl.search);
  // The spend view holds every account it lists, so opening one reads nothing.
  for (const key of ["call", "spend"]) {
    before.delete(key);
    after.delete(key);
  }
  before.sort();
  after.sort();
  return before.toString() === after.toString()
    ? false
    : defaultShouldRevalidate;
}

const TAB_LABELS: Record<Tab, string> = {
  components: "Components",
  logs: "Logs",
  evals: "Evals",
  costs: "Costs",
};

export default function Workbench({ loaderData }: Route.ComponentProps) {
  const [params] = useSearchParams();
  const result = useActionData<typeof action>();
  const requested = params.get("tab");
  const tab: Tab = TABS.includes(requested as Tab)
    ? (requested as Tab)
    : "components";

  return (
    <ApplicationShell
      lede="Admins only. The visual vocabulary, what clients actually send, whether models pick the right tool, and what each account costs."
      title="Workbench"
      sections={
        <SubNav
          items={TABS.map((name) => ({
            href: `/workbench?tab=${name}`,
            label: TAB_LABELS[name],
            current: tab === name,
          }))}
          label="Workbench sections"
        />
      }
    >
      <BackupLine status={loaderData.backups} />
      {tab === "components" ? <Components /> : null}
      {tab === "logs" && loaderData.activity && loaderData.runs ? (
        <Logs
          activity={loaderData.activity}
          linked={loaderData.call}
          runs={loaderData.runs}
          sort={loaderData.runSort}
        />
      ) : null}
      {tab === "evals" && loaderData.evals ? (
        <EvalCases evals={loaderData.evals} />
      ) : null}
      {tab === "costs" && loaderData.spend ? (
        <Spend open={params.get("spend")} read={loaderData.spend} />
      ) : null}
      {tab === "costs" && loaderData.costs ? (
        <ReviewCosts
          accounts={loaderData.costs}
          refused={
            result && "refused" in result ? (result.refused ?? null) : null
          }
          saved={result && "saved" in result ? (result.saved ?? null) : null}
        />
      ) : null}
    </ApplicationShell>
  );
}

/* ----------------------------------------------------------- backups --- */

function utc(at: number) {
  return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * One line on every tab: when the last complete snapshot finished and how the
 * latest run went. The alert emails the same facts. ADR-0019.
 */
function BackupLine({ status }: { status: BackupStatus }) {
  if (!status.configured)
    return <p className="muted">Backups: not configured on this deployment.</p>;
  const { latest, lastComplete } = status;
  const last = lastComplete?.finishedAt ? (
    <>
      last complete snapshot {utc(lastComplete.finishedAt)},{" "}
      <code>{lastComplete.snapshot}</code>
    </>
  ) : (
    "no complete snapshot yet"
  );
  const run = !latest
    ? "no run has started"
    : latest.state === "failed"
      ? `latest run failed: ${latest.error ?? "no error recorded"}`
      : latest.state === "running"
        ? `latest run started ${utc(latest.startedAt)} and is still running`
        : "latest run complete";
  return (
    <p className="muted" data-testid="backup-status">
      Backups: {last}; {run}.
    </p>
  );
}

/* ------------------------------------------------------------- evals --- */

/**
 * Whether a model picks the right tool from the descriptions alone, read per
 * case rather than per run. A cell is that model's newest result on the case
 * under the condition shown, from whichever run produced it, so a focused
 * rerun moves the cells it ran and leaves the rest. A run marked dropped
 * tested a change that did not ship, and never counts as newest.
 *
 * Tool choice and argument validity are scored apart, because a model that
 * picks `create_todo` and omits `project` read the description correctly and
 * tripped over the schema. `via skill` counts the routes that read a SKILL.md
 * before acting, which is what a skills-first surface is built to move.
 */
function EvalCases({ evals }: { evals: Evals }) {
  const condition = evals.condition;
  if (condition === null) {
    return (
      <Empty>
        No eval runs indexed. Run <code>npm run evals</code>, then{" "}
        <code>npm run evals:index</code>.
      </Empty>
    );
  }

  const openId = evals.opened?.testCase.id ?? evals.missing;
  const href = (caseId: string | null) => evalsHref(condition.key, caseId);
  const before = new Map(condition.before.map((row) => [row.model, row]));
  const ran = evals.cases.filter((testCase) => condition.cells[testCase.id]);
  const labels = new Map(
    evals.conditions.map((each) => [each.key, each.label]),
  );

  return (
    <section>
      {evals.conditions.length > 1 ? (
        <SubNav
          items={evals.conditions.map((each) => ({
            href: evalsHref(each.key, openId),
            label: `${each.label} · ${plural(each.runs, "run")}`,
            current: each.key === condition.key,
          }))}
          label="Eval conditions"
        />
      ) : null}

      <p className="muted">
        Each case's newest result: {ran.length} of {evals.cases.length} cases
        have run here, across {plural(condition.runs, "run")}, the newest{" "}
        {condition.newest ?? "none"}. A run marked dropped never counts. Deltas
        compare each cell with the result it replaced.{" "}
        {divergenceText(condition.divergence)}
      </p>

      <div className="scroll-x">
        <table className="dense">
          <tbody>
            <tr>
              <th>Model</th>
              <th>Primary tool</th>
              <th>Primary or accepted</th>
              <th>Arguments valid</th>
              <th>Within budget</th>
              <th>Capped</th>
              <th>Via skill</th>
              <th>Turns</th>
              <th>Tokens</th>
              <th>Cost</th>
              <th>Said why</th>
              <th>Errors</th>
            </tr>
            {condition.summary.map((row) => (
              <tr key={row.model}>
                <td>
                  <code>{row.model}</code>
                </td>
                <td>
                  {row.exact}/{row.total}{" "}
                  <Delta now={row.exact} then={before.get(row.model)?.exact} />
                </td>
                <td>
                  {row.accepted}/{row.total}
                </td>
                <td>
                  {row.argsValid}/{row.total}{" "}
                  <Delta
                    now={row.argsValid}
                    then={before.get(row.model)?.argsValid}
                  />
                </td>
                <td>
                  {row.withinBudget === null
                    ? "—"
                    : `${row.withinBudget}/${row.total}`}{" "}
                  <Delta
                    now={row.withinBudget}
                    then={before.get(row.model)?.withinBudget}
                  />
                </td>
                <td>{row.capped || "—"}</td>
                <td>
                  {row.viaSkill}/{row.total}
                </td>
                <td>
                  {count(row.turns)}{" "}
                  <Delta now={row.turns} then={before.get(row.model)?.turns} />
                </td>
                <td title={reasoningNote(row.reasoningTokens)}>
                  {count(tokensOf(row))}{" "}
                  <Delta
                    now={tokensOf(row)}
                    then={tokensOf(before.get(row.model))}
                  />
                </td>
                <td>{dollars(row.costUsd)}</td>
                <td>
                  {row.whyOffered === 0
                    ? "—"
                    : `${row.whyFilled}/${row.whyOffered}`}
                </td>
                <td>{row.errors || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="eyebrow">Per case</h2>
      <div className="evals-split">
        <div className="scroll-x">
          <table className="dense matrix">
            <tbody>
              <tr>
                <th>Case</th>
                <th>Expected</th>
                <th>Budget</th>
                {condition.models.map((model) => (
                  <th key={model}>{model.split("/").pop()}</th>
                ))}
              </tr>
              {evals.cases.map((testCase) => (
                <tr
                  aria-current={testCase.id === openId ? "true" : undefined}
                  key={testCase.id}
                >
                  <td>
                    <Link
                      className="cell"
                      preventScrollReset
                      to={href(testCase.id)}
                    >
                      {testCase.id}
                    </Link>
                  </td>
                  <td>
                    <code>{testCase.expected ?? "(no tool)"}</code>
                  </td>
                  <td>{testCase.turnBudget ?? "—"}</td>
                  {condition.models.map((model) => (
                    <Cell
                      cell={condition.cells[testCase.id]?.[model]}
                      href={href(testCase.id)}
                      key={model}
                      testCase={testCase}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {openId ? (
          <CasePane
            closeHref={href(null)}
            // A new case starts at its top, not where the last one was left.
            key={openId}
            condition={condition}
            labels={labels}
            missing={evals.missing}
            opened={evals.opened}
          />
        ) : null}
      </div>

      <h2 className="eyebrow">Runs</h2>
      <p className="muted">
        Newest first. A note says what the run tested; a verdict says what
        became of it. <code>node evals/run.mjs --note "…"</code> writes the
        first, <code>npm run evals:verdict</code> the second.
      </p>
      <div className="scroll-x">
        <table className="dense run-log">
          <tbody>
            <tr>
              <th>Run</th>
              <th>Condition</th>
              <th>Cases</th>
              <th>Passed</th>
              <th>Verdict</th>
              <th>What it tested</th>
            </tr>
            {evals.runs.map((run) => (
              <tr
                className={run.verdict === "dropped" ? "dropped" : undefined}
                key={run.stamp}
              >
                <td>
                  <code>{run.stamp.replace("T", " ")}</code>
                </td>
                <td>{labels.get(run.condition) ?? run.condition}</td>
                <td>
                  {run.cases}
                  {run.repeat > 1 ? ` × ${run.repeat}` : ""}
                </td>
                <td>
                  {run.passes}/{run.rows}
                </td>
                <td>
                  <VerdictPill run={run} />
                </td>
                <td>{run.note ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** `?case=` is what is open, `?on=` the condition, so both survive a reload. P3. */
function evalsHref(on: string, caseId: string | null): string {
  const params = new URLSearchParams({ tab: "evals" });
  if (on !== "plain") params.set("on", on);
  if (caseId) params.set("case", caseId);
  return `/workbench?${params}`;
}

function divergenceText({
  divergent,
  cases,
}: {
  divergent: number;
  cases: number;
}): string {
  if (cases === 0) return "";
  return `The models end on different tools on ${divergent} of ${cases} cases.`;
}

const VERDICT_TONE = {
  kept: "done",
  dropped: "blocked",
  baseline: "label",
} as const;

function VerdictPill({ run }: { run: EvalRunNote }) {
  if (run.verdict === null) return <>—</>;
  return (
    <span title={run.why ?? undefined}>
      <Pill tone={VERDICT_TONE[run.verdict]}>{run.verdict}</Pill>
    </span>
  );
}

/**
 * One case, beside the matrix rather than over it, so the next row stays in
 * view. What the model was asked, each model's newest result, and every run
 * that sent the case, with what changed between them: the case's own text,
 * the description of a tool it expects, or something else on the surface.
 *
 * The arguments the model built are deliberately not here. They are in the
 * per-run file and, because the harness talks to a live endpoint, in the logs
 * tab under the agent `valise-eval`. ADR-0006.
 */
function CasePane({
  opened,
  missing,
  condition,
  labels,
  closeHref,
}: {
  opened: Evals["opened"];
  missing: string | null;
  condition: EvalCondition;
  labels: Map<string, string>;
  closeHref: string;
}) {
  const cells = opened ? (condition.cells[opened.testCase.id] ?? {}) : {};
  const ran = condition.models.filter((model) => cells[model]);
  const passing = ran.filter((model) => cells[model]?.pass).length;
  return (
    <aside aria-label="Case details" className="call-pane">
      <header className="call-pane-head">
        <code className="what">{opened?.testCase.id ?? missing}</code>
        {ran.length > 0 ? (
          <Pill tone={passing === ran.length ? "done" : "blocked"}>
            {passing}/{ran.length} pass
          </Pill>
        ) : null}
        <Link className="close" preventScrollReset to={closeHref}>
          Close
        </Link>
      </header>
      {opened === null ? (
        <Empty>
          No case named <code>{missing}</code> in <code>evals/cases.json</code>.
        </Empty>
      ) : (
        <CaseBody
          cells={cells}
          condition={condition}
          labels={labels}
          opened={opened}
        />
      )}
    </aside>
  );
}

function CaseBody({
  opened: { testCase, models, history },
  cells,
  condition,
  labels,
}: {
  opened: NonNullable<Evals["opened"]>;
  cells: Record<string, EvalCell>;
  condition: EvalCondition;
  labels: Map<string, string>;
}) {
  // The trend behind each newest cell: every counted run under this
  // condition, so one sample reads against how the cell has behaved.
  const counted = history.filter(
    (entry) =>
      entry.run.condition === condition.key && entry.run.verdict !== "dropped",
  );
  const across = (model: string) => {
    const column = models.indexOf(model);
    let passes = 0;
    let n = 0;
    for (const entry of counted) {
      const mark = entry.marks[column];
      if (!mark) continue;
      passes += mark[0];
      n += mark[1];
    }
    return n === 0 ? "—" : `${passes}/${n}`;
  };

  return (
    <>
      <h3 className="eyebrow">The turn, as sent</h3>
      <pre>{testCase.prompt ?? "No run has sent this case yet."}</pre>
      {testCase.scoredIn ? (
        <p className="muted">As run {testCase.scoredIn}.</p>
      ) : null}

      <dl className="facts">
        <div>
          <dt>Expected</dt>
          <dd>
            <code>{testCase.expected ?? "(no tool)"}</code>
          </dd>
        </div>
        <div>
          <dt>Required arguments</dt>
          <dd>{testCase.requiredArgs.join(", ") || "—"}</dd>
        </div>
        <div>
          <dt>Must pass through</dt>
          <dd>{testCase.via ? <code>{testCase.via}</code> : "—"}</dd>
        </div>
        <div>
          <dt>Also accepted</dt>
          <dd>{testCase.alsoAccept.join(", ") || "—"}</dd>
        </div>
        <div>
          <dt>Turn budget</dt>
          <dd>{testCase.turnBudget ?? "—"}</dd>
        </div>
      </dl>
      {testCase.why ? <p className="muted">{testCase.why}</p> : null}

      <h3 className="eyebrow">Newest, per model · {condition.label}</h3>
      <table className="dense matrix">
        <tbody>
          <tr>
            <th>Model</th>
            <th>Result</th>
            <th>Route</th>
            <th>Across runs</th>
            <th>Run</th>
          </tr>
          {condition.models.map((model) => {
            const cell = cells[model];
            return (
              <tr key={model}>
                <td>{model.split("/").pop()}</td>
                {cell ? (
                  <>
                    <td className={cell.pass ? "pass" : "fail"}>
                      {cell.n > 1
                        ? `${cell.passes}/${cell.n}`
                        : cellText(cell, testCase)}{" "}
                      <Moved cell={cell} />
                    </td>
                    <td>{cell.route.join(" → ") || "no tool call"}</td>
                    <td>{across(model)}</td>
                    <td>{shortStamp(cell.stamp)}</td>
                  </>
                ) : (
                  <td colSpan={4}>not run here</td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>

      <h3 className="eyebrow">History</h3>
      {history.length === 0 ? (
        <Empty>No run has sent this case.</Empty>
      ) : (
        <>
          <p className="muted">
            One mark per model:{" "}
            {models.map((m) => m.split("/").pop()).join(", ")}. ✓ every repeat
            passed, ✗ none did, ~ some did, · not run.
          </p>
          <ol className="case-history">
            {history.map((entry) => (
              <li
                className={
                  entry.run.verdict === "dropped" ? "dropped" : undefined
                }
                key={entry.run.stamp}
              >
                <span className="when">{shortStamp(entry.run.stamp)}</span>
                <Marks marks={entry.marks} models={models} />
                <span className="badges">
                  <VerdictPill run={entry.run} />
                  {entry.run.condition === "plain" ? null : (
                    <Pill tone="label">
                      {labels.get(entry.run.condition) ?? entry.run.condition}
                    </Pill>
                  )}
                </span>
                {entry.run.note ? (
                  <p className="note">{entry.run.note}</p>
                ) : null}
                <Changes entry={entry} />
              </li>
            ))}
          </ol>
        </>
      )}

      {testCase.system ? (
        <details>
          <summary>System prompt</summary>
          <pre>{testCase.system}</pre>
        </details>
      ) : null}
    </>
  );
}

function Marks({
  marks,
  models,
}: {
  marks: EvalHistoryEntry["marks"];
  models: string[];
}) {
  return (
    <span className="marks">
      {marks.map((mark, index) => {
        const model = models[index]?.split("/").pop() ?? "";
        if (mark === null) {
          return (
            <i
              className="none"
              key={models[index]}
              title={`${model} did not run`}
            >
              ·
            </i>
          );
        }
        const [passes, n] = mark;
        const state = passes === n ? "pass" : passes === 0 ? "fail" : "part";
        return (
          <i
            className={state}
            key={models[index]}
            title={`${model} ${passes}/${n}`}
          >
            {state === "pass" ? "✓" : state === "fail" ? "✗" : "~"}
          </i>
        );
      })}
    </span>
  );
}

/** What moved since the run before this one that sent the same case. */
function Changes({ entry }: { entry: EvalHistoryEntry }) {
  const parts = [
    entry.edited ? "case text changed" : null,
    ...entry.changedTools.map((tool) => `${tool} description changed`),
    entry.otherTools > 0
      ? `${plural(entry.otherTools, "other tool")} changed`
      : null,
    entry.surfaceChanged &&
    entry.changedTools.length === 0 &&
    entry.otherTools === 0
      ? "tool surface changed"
      : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return <p className="changes">{parts.join(" · ")}</p>;
}

/** Up or down against the result this cell replaced, as a share of repeats. */
function Moved({ cell }: { cell: EvalCell }) {
  if (!cell.was) return null;
  const now = cell.passes / cell.n;
  const then = cell.was.passes / cell.was.n;
  if (now === then) return null;
  return (
    <span
      className={now > then ? "delta up" : "delta down"}
      title={`was ${cell.was.passes}/${cell.was.n} in ${cell.was.stamp}`}
    >
      {now > then ? "↑" : "↓"}
    </span>
  );
}

/** `10-18 13:17`: the suite has run for days, not years. */
function shortStamp(stamp: string): string {
  return `${stamp.slice(5, 10)} ${stamp.slice(11, 16).replace("-", ":")}`;
}

function Cell({
  cell,
  testCase,
  href,
}: {
  cell: EvalCell | undefined;
  testCase: EvalCaseRow;
  href: string;
}) {
  if (!cell) return <td>—</td>;
  const text =
    cell.n > 1 ? `${cell.passes}/${cell.n}` : cellText(cell, testCase);
  return (
    <td className={cell.pass ? "pass" : "fail"}>
      <Link
        className="cell"
        preventScrollReset
        title={cell.route.join(" → ")}
        to={href}
      >
        <span className={cell.route.length > 1 ? "via" : undefined}>
          {text}
        </span>{" "}
        <Moved cell={cell} />
      </Link>
    </td>
  );
}

/** The same vocabulary the markdown report prints, so a diff reads the same. */
function cellText(cell: EvalCell, testCase: EvalCaseRow): string {
  if (cell.error) return "error";
  if (cell.pass) {
    const ending = cell.chose === testCase.expected ? "✓" : `≈ ${cell.chose}`;
    // No budget before the runner had one, and none on a harness run.
    if (cell.withinBudget === null || cell.turns === null) return ending;
    const over =
      testCase.turnBudget !== null && cell.turns > testCase.turnBudget;
    return `${ending} ${cell.turns}t${over ? " over" : ""}`;
  }
  if (cell.viaMissing) return `skipped ${cell.viaMissing}`;
  if (cell.toolMatch && cell.wrongArgs.length > 0)
    return `wrong ${cell.wrongArgs.join(", ")}`;
  if (cell.answerMissing) return "unnamed";
  if (cell.toolMatch) return `missing ${cell.missingArgs.join(", ")}`;
  if (cell.routeCapped) return "(cap)";
  return cell.chose ?? "(none)";
}

function Delta({
  now,
  then,
}: {
  now: number | null;
  then: number | null | undefined;
}) {
  if (now === null || then === null || then === undefined || then === now) {
    return null;
  }
  const move = now - then;
  return (
    <span className={move > 0 ? "delta up" : "delta down"}>
      {move > 0 ? `+${move}` : move}
    </span>
  );
}

/** A run from before the counters existed reads as absent, never as zero. */
function count(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

/** Four places everywhere. A whole suite costs cents, and a column that
 * switches precision between rows cannot be read down. */
function dollars(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(4)}`;
}

function tokensOf(
  row:
    | { promptTokens: number | null; completionTokens: number | null }
    | undefined,
): number | null {
  if (!row || row.promptTokens === null || row.completionTokens === null) {
    return null;
  }
  return row.promptTokens + row.completionTokens;
}

function reasoningNote(reasoning: number | null): string | undefined {
  if (reasoning === null) return undefined;
  return `${reasoning.toLocaleString("en-US")} of these are reasoning tokens`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
