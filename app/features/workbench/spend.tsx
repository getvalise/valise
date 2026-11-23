import { Link } from "react-router";
import { Empty } from "~/components/ui";
import type {
  AccountSpend,
  CategorySpend,
  SpendRead,
  SpendReport,
} from "~/concepts/spend";

/**
 * Who is costing money over 30 days, on what, and where to act on it.
 * `docs/design/spend.md` is the contract: a row per account plus System and
 * Unattributed, ranked by estimated USD; opening a row (`?spend=`, P3) shows
 * its categories, a daily series and the way to its cap. Every figure is an
 * estimate at list price and says so; a failed read says unavailable, never $0.
 */

/** Money reads down a column: right-aligned, tabular figures, unbroken. */
const NUM = "text-right tabular-nums whitespace-nowrap";

export function usd(microusd: number): string {
  if (microusd === 0) return "$0.00";
  const dollars = microusd / 1_000_000;
  return dollars >= 1 ? `$${dollars.toFixed(2)}` : `$${dollars.toFixed(4)}`;
}

const count = (n: number) => n.toLocaleString("en-US");

function percent(share: number): string {
  if (share === 0) return "0%";
  if (share < 0.001) return "<0.1%";
  return `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`;
}

function plural(n: number, word: string) {
  return `${count(n)} ${word}${n === 1 ? "" : "s"}`;
}

/** Money plus what money cannot say: calls with no list price. */
function Money({ microusd, unpriced }: { microusd: number; unpriced: number }) {
  if (unpriced > 0 && microusd === 0)
    return (
      <span data-unpriced="true">
        unpriced <span className="muted">({plural(unpriced, "call")})</span>
      </span>
    );
  return (
    <span>
      {usd(microusd)}
      {unpriced > 0 ? (
        <span className="muted" data-unpriced="true">
          {" "}
          + {plural(unpriced, "unpriced call")}
        </span>
      ) : null}
    </span>
  );
}

function Trend({ last7, prior7 }: { last7: number; prior7: number }) {
  if (last7 === 0 && prior7 === 0) return <span className="muted">—</span>;
  const change =
    prior7 === 0
      ? "new"
      : `${last7 >= prior7 ? "+" : "−"}${Math.round(
          (Math.abs(last7 - prior7) / prior7) * 100,
        )}%`;
  return (
    <span>
      {usd(last7)} <span className="muted">vs {usd(prior7)}</span>{" "}
      <span className={last7 > prior7 ? "text-(--danger)" : "muted"}>
        {change}
      </span>
    </span>
  );
}

export function spendHref(accountId: string | null) {
  const params = new URLSearchParams({ tab: "costs" });
  if (accountId) params.set("spend", accountId);
  return `/workbench?${params}#spend`;
}

export function Spend({
  read,
  open,
}: {
  read: SpendRead;
  open: string | null;
}) {
  return (
    <section
      aria-labelledby="spend-heading"
      className="grid grid-cols-[minmax(0,1fr)] gap-3"
      id="spend"
    >
      <h2 className="eyebrow" id="spend-heading">
        Spend per account
      </h2>
      {read.ok ? (
        <SpendTable open={open} report={read.report} />
      ) : (
        <div role="alert">
          <p>
            Spend is <strong>unavailable</strong>: the read failed, so no figure
            is shown rather than a $0 that is not true.
          </p>
          <p className="muted">
            <code>{read.reason}</code>
          </p>
        </div>
      )}
    </section>
  );
}

function SpendTable({
  report,
  open,
}: {
  report: SpendReport;
  open: string | null;
}) {
  const opened = report.accounts.find((a) => a.accountId === open) ?? null;
  const metered = report.accounts.filter(
    (a) => a.microusd > 0 || a.unpricedCalls > 0,
  ).length;
  const unpriced = report.accounts.reduce((n, a) => n + a.unpricedCalls, 0);
  return (
    <>
      <p className="muted">
        Estimated USD over the {report.days} days {report.from} to {report.to}{" "}
        (UTC), at list price, from Valise's own records. Not the Cloudflare
        invoice: free allocations are not subtracted, and Worker requests, CPU,
        Durable Objects, R2 and request-path D1 are not metered per account.
        System is Valise's own cron jobs, D1 rows included.
      </p>
      {report.stale.length ? (
        <p className="text-(--warn)" role="status">
          Stale:{" "}
          {report.stale.map((entry, i) => (
            <span key={entry.category}>
              {i ? "; " : ""}
              {entry.label} has no rows since {entry.lastDay}
            </span>
          ))}
          . A meter that stopped writing reads as $0 here.
        </p>
      ) : null}
      {metered === 0 ? (
        <Empty>No metered spend in these {report.days} days.</Empty>
      ) : null}
      <div className="scroll-x">
        <table className="dense">
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th className={NUM} scope="col">
                Est. USD, 30 days
              </th>
              <th className={NUM} scope="col">
                Share
              </th>
              <th scope="col">Largest category</th>
              <th scope="col">Last 7 days vs the 7 before</th>
            </tr>
          </thead>
          <tbody>
            {report.accounts.map((account) => (
              <tr
                aria-current={account.accountId === open ? "true" : undefined}
                className={
                  account.accountId === open
                    ? "[&>*]:bg-(--paper-2)"
                    : undefined
                }
                data-account={account.accountId}
                key={account.accountId}
              >
                <td className="min-w-32">
                  <Link
                    className="cell"
                    preventScrollReset
                    to={
                      account.accountId === open
                        ? spendHref(null)
                        : spendHref(account.accountId)
                    }
                  >
                    {account.name}
                  </Link>
                  {account.kind === "account" ? null : (
                    <span className="muted block text-[0.75rem]">
                      {account.kind === "system" ? "cron jobs" : "no account"}
                    </span>
                  )}
                </td>
                <td className={NUM}>
                  <Money
                    microusd={account.microusd}
                    unpriced={account.unpricedCalls}
                  />
                </td>
                <td className={NUM}>{percent(account.share)}</td>
                <td className="whitespace-nowrap">
                  {account.largest ? (
                    account.largest.label
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="whitespace-nowrap">
                  <Trend last7={account.last7} prior7={account.prior7} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="[&>tr>*]:border-t [&>tr>*]:border-(--strong-rule)">
            <tr>
              <td className="min-w-32">Total</td>
              <td className={NUM}>
                <Money microusd={report.totalMicrousd} unpriced={unpriced} />
              </td>
              <td className={NUM}>100%</td>
              <td colSpan={2} className="muted">
                {plural(report.accounts.length, "row")}, ranked by estimated USD
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {opened ? <SpendDetail account={opened} report={report} /> : null}
    </>
  );
}

function SpendDetail({
  account,
  report,
}: {
  account: AccountSpend;
  report: SpendReport;
}) {
  return (
    <section
      aria-label={`Spend for ${account.name}`}
      className="card grid min-w-0 gap-3"
      id="spend-detail"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <h3>
          {account.name}:{" "}
          <Money microusd={account.microusd} unpriced={account.unpricedCalls} />{" "}
          <span className="muted">estimated over {report.days} days</span>
        </h3>
        <Link
          aria-label="Close spend details"
          className="ghost"
          preventScrollReset
          to={spendHref(null)}
        >
          Close
        </Link>
      </header>
      <Action account={account} />
      {account.kind === "system" ? null : (
        <p className="muted">
          {plural(account.mcpCalls, "MCP request")} in the window, the
          request-load proxy: Worker and D1 cost per request is not metered.
        </p>
      )}
      <DailySeries account={account} />
      {account.categories.length ? (
        <div className="scroll-x">
          <table className="dense">
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th className={NUM} scope="col">
                  Calls
                </th>
                <th className={NUM} scope="col">
                  Units
                </th>
                <th className={NUM} scope="col">
                  Est. USD
                </th>
              </tr>
            </thead>
            <tbody>
              {account.categories.map((entry) => (
                <CategoryRow entry={entry} key={entry.category} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No metered rows in these {report.days} days: $0.00.</Empty>
      )}
    </section>
  );
}

function Action({ account }: { account: AccountSpend }) {
  if (account.kind === "system")
    return (
      <p>
        No cap applies: these are Valise's own cron jobs, metered in{" "}
        <code>workers/app.ts</code>. A job that reads far more rows than its
        work needs is a query to fix, as in PR #366.
      </p>
    );
  if (account.kind === "unattributed")
    return (
      <p>
        No cap applies: MCP requests refused before sign-in, and the rows of
        accounts that no longer exist.
      </p>
    );
  return (
    <p>
      <a href={`#caps-${account.accountId}`}>Review caps for {account.name}</a>{" "}
      <span className="muted">
        below. Other categories have no per-account cap yet.
        {account.email ? ` Contact: ${account.email}.` : ""}
      </span>
    </p>
  );
}

function CategoryRow({ entry }: { entry: CategorySpend }) {
  return (
    <tr data-category={entry.category}>
      <td className="min-w-32">
        {entry.label}
        <span className="muted block max-w-[32rem] text-[0.75rem]">
          {entry.price}
        </span>
      </td>
      <td className={NUM}>{count(entry.calls)}</td>
      <td className={NUM}>
        {count(entry.units)} <span className="muted">{entry.unit}</span>
      </td>
      <td className={NUM}>
        {entry.proxy ? (
          <span className="muted">not priced</span>
        ) : (
          <Money microusd={entry.microusd} unpriced={entry.unpricedCalls} />
        )}
      </td>
    </tr>
  );
}

/** One bar a day, oldest on the left; the label carries the numbers. */
function DailySeries({ account }: { account: AccountSpend }) {
  const peak = account.daily.reduce(
    (best, day) => (day.microusd > best.microusd ? day : best),
    account.daily[0],
  );
  const max = peak?.microusd ?? 0;
  const width = 300;
  const height = 48;
  const step = width / account.daily.length;
  const label =
    max === 0
      ? `Daily estimated USD, ${account.daily[0]?.day} to ${account.daily.at(-1)?.day}: $0.00 every day.`
      : `Daily estimated USD, ${account.daily[0]?.day} to ${account.daily.at(-1)?.day}; the highest was ${usd(max)} on ${peak.day}.`;
  return (
    <figure className="m-0">
      <svg
        aria-label={label}
        className="block h-12 w-full fill-(--primary)"
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        <line
          className="stroke-(--strong-rule)"
          x1="0"
          x2={width}
          y1={height - 0.5}
          y2={height - 0.5}
        />
        {account.daily.map((day, i) => {
          const h = max ? Math.max(1, (day.microusd / max) * (height - 2)) : 0;
          return (
            <rect
              height={h}
              key={day.day}
              width={Math.max(1, step - 2)}
              x={i * step + 1}
              y={height - 1 - h}
            >
              <title>
                {day.day}: {usd(day.microusd)}
              </title>
            </rect>
          );
        })}
      </svg>
      <figcaption className="muted">{label}</figcaption>
    </figure>
  );
}
