import { type ReactNode, useState } from "react";
import {
  Link,
  useActionData,
  useFetcher,
  useNavigate,
  useSearchParams,
} from "react-router";
import { BeltSwitch } from "~/components/belt-switch";
import {
  Editable,
  editKey,
  openField,
  useLanded,
  ViaFetcher,
} from "~/components/editable";
import { ItemList, ItemRow } from "~/components/item-list";
import { Markdown } from "~/components/markdown";
import { Modal } from "~/components/modal";
import { DetailSection, Empty, ListControls, Pill } from "~/components/ui";
import type { Principle } from "~/concepts/memory-reflection";
import type {
  ReviewGroup,
  ReviewSnapshot,
  UpkeepRun,
} from "~/concepts/memory-review";
import {
  MAX_MANUAL_MEMORIES,
  MAX_UPKEEP_MEMORIES,
  RANKING_REQUESTS_PER_MEMORY,
} from "~/concepts/memory-review-limits";
import {
  REVIEW_MODELS,
  type ReviewProposal,
  reviewFailureLabel,
  reviewMaxCallMicrousd,
  reviewModelChoices,
  reviewModelLabel,
} from "~/concepts/memory-review-model";
import { memoryReviewHref } from "~/concepts/memory-review-path";
import {
  currentRankingStop,
  REVIEW_RANK_DESTINATION,
  rankingFailureLabel,
} from "~/concepts/memory-review-ranking";
import type { action, loader } from "~/console/memory-review.server";

/** Fetcher enhancement keeps the same native form and stable row, with immediate pending feedback (P4/P11). */
function ReviewForm({
  children,
  label,
  className,
  pendingText = "Working…",
}: {
  children: ReactNode;
  label?: string;
  className?: string;
  pendingText?: string;
}) {
  const [params] = useSearchParams();
  const fetcher = useFetcher<typeof action>();
  const [pending, setPending] = useState(false);
  const sent = useLanded(fetcher, () => setPending(false));
  const result = fetcher.data;
  return (
    <div>
      <fetcher.Form
        action={memoryReviewHref(params)}
        aria-label={label}
        className={className ?? "row"}
        method="post"
        onSubmit={() => {
          sent();
          setPending(true);
        }}
        preventScrollReset
      >
        <ViaFetcher />
        <fieldset
          disabled={pending || fetcher.state !== "idle"}
          className="contents"
        >
          {children}
        </fieldset>
      </fetcher.Form>
      {pending || fetcher.state !== "idle" ? (
        <p role="status">{pendingText}</p>
      ) : null}
      {result && "error" in result ? <p role="alert">{result.error}</p> : null}
      {result && "report" in result ? (
        <div role="status">
          <p className="text-sm">{result.outcome}</p>
          <p className="muted small">
            Reviewed{" "}
            {count(result.report.scanned, "queued memory", "queued memories")};{" "}
            {count(result.report.calls, "model call")},{" "}
            {count(result.report.proposed, "proposal")}, {result.report.skipped}{" "}
            skipped, {result.report.failed} failed.
            {result.report.stopped &&
            !/^(ranking|embedding)-/.test(result.report.stopped)
              ? ` Stopped: ${result.report.stopped}.`
              : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}

const count = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;
const usd = (microusd: number) => `$${(microusd / 1_000_000).toFixed(4)}`;

const utc = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** The last automatic run in words (J-0). */
function runText(run: UpkeepRun): string {
  const what = [
    `compared ${plural(run.scanned, "memory", "memories")}`,
    `added ${plural(run.applied, "summary", "summaries")}`,
    `left ${plural(run.questions, "question")} for you`,
    ...(run.lessons ? [`wrote ${plural(run.lessons, "lesson line")}`] : []),
    ...(run.principles
      ? [`drafted ${plural(run.principles, "principle card")}`]
      : []),
    ...(run.failed ? [`${plural(run.failed, "check")} failed`] : []),
  ].join(", ");
  if (run.finishedAt === null)
    return `Running since ${utc(run.startedAt)} UTC: ${what} so far.`;
  const ended =
    run.ended === "done"
      ? "Nothing else is waiting."
      : run.ended === "limit"
        ? "Tonight's memory checks are used up; the rest waits for the next run."
        : run.ended === "cost"
          ? "Today's cost cap ended the run; the rest waits for the next one."
          : run.ended === "passes"
            ? "The run reached its pass limit; the rest waits for the next one."
            : "The run stopped early; nothing more was sent.";
  return `Last run, ${utc(run.startedAt)} UTC: ${what}. ${ended}`;
}

function nextRunText(at: number, now: number): string {
  return at <= now + 120
    ? "The next run starts within a few minutes."
    : `Next run: ${utc(at)} UTC.`;
}

/** J-0's one switch: model reviews, nightly runs and applying summaries, bound to the displayed model. */
function UpkeepSwitch({
  on,
  model,
  disabled,
}: {
  on: boolean;
  model: string;
  disabled?: boolean;
}) {
  return (
    <ReviewForm pendingText="Saving…">
      <input name="intent" type="hidden" value="upkeep" />
      <input name="expectedModel" type="hidden" value={model} />
      <input name="value" type="hidden" value={on ? "off" : "on"} />
      <BeltSwitch
        type="submit"
        checked={on}
        disabled={disabled}
        label="Tidy my memories every night"
      />
    </ReviewForm>
  );
}

/** One reversible consent switch; the model it names is the one it consents to. */
function SettingSwitch({
  field,
  checked,
  model,
  label,
  disabled,
}: {
  field: "enabled" | "overnight";
  checked: boolean;
  model: string;
  label: string;
  disabled?: boolean;
}) {
  return (
    <ReviewForm>
      <input name="intent" type="hidden" value="setting" />
      <input name="field" type="hidden" value={field} />
      <input name="expectedModel" type="hidden" value={model} />
      <input name="value" type="hidden" value={checked ? "off" : "on"} />
      <BeltSwitch
        type="submit"
        checked={checked}
        disabled={disabled}
        label={label}
      />
    </ReviewForm>
  );
}

/** The check itself: the waiting queue, or one memory when `memory` is set (J-A, J-B). */
function RunCheck({
  memory,
  disabled,
}: {
  memory?: string;
  disabled: boolean;
}) {
  return (
    <ReviewForm pendingText="Checking… a check can take up to a minute.">
      <input name="intent" type="hidden" value="run" />
      {memory ? <input name="memory" type="hidden" value={memory} /> : null}
      <button disabled={disabled} type="submit">
        {memory ? "Check this memory now" : "Check waiting memories"}
      </button>
    </ReviewForm>
  );
}

export function MemoryReview({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const [params] = useSearchParams();
  const {
    settings,
    groups,
    budget,
    open,
    editing,
    limit,
    providerAvailable,
    providerUnavailableReason,
    ran,
    history,
    events,
    counts,
    memoryId,
    anchor,
    hideDecided,
    view,
    upkeep,
    caps,
  } = loaderData;
  const refused = useActionData<typeof action>();
  const configured = providerAvailable[REVIEW_MODELS.indexOf(settings.model)];
  const model = reviewModelLabel(settings.model);
  // Nightly upkeep is both switches of J-0 at once; an older overnight-only row drafts without applying.
  const upkeepOn = settings.overnight && settings.autoApply;
  // The person's own decisions: automatic applications live in their own view.
  const decided = counts.accepted + counts.dismissed;
  // Waiting rows in the order shown, so a decided pane can offer the next one (J-A).
  const waiting = groups.filter((g) => g.state === "proposal");
  const nextWaiting = (id: string) => {
    const after = groups.findIndex((g) => g.group_id === id);
    return (
      groups.slice(after + 1).find((g) => g.state === "proposal") ??
      waiting.find((g) => g.group_id !== id) ??
      null
    );
  };
  const { ranking, rankingBudget, rankingConfigured } = loaderData;
  // A ranking stop today explains why checks stop, so the status line says it.
  const rankingStopCode = ranking.enabled
    ? currentRankingStop(rankingBudget, {
        ...settings,
        rankingMicrousd: caps.rankingMicrousd,
      })
    : null;
  const rankingStop = rankingStopCode
    ? rankingFailureLabel(rankingStopCode)
    : null;
  // Advanced opens itself when a save there was refused, or a no-script save
  // under it redirected with `?settings=open` (P11).
  const advancedOpen =
    params.get("settings") === "open" || (!!refused && "error" in refused);
  // The person's own consent and limits. Once allowed, one memory's view leads with its suggestions (J-B).
  const controls = (
    <>
      {settings.enabled ? (
        <section aria-label="Review status" className="grid gap-3 *:m-0">
          <p>
            <strong>
              {upkeepOn
                ? `Nightly upkeep is on with ${model}`
                : settings.overnight
                  ? `Nightly drafts are on with ${model}`
                  : `Checks by hand with ${model}`}
            </strong>{" "}
            · {counts.proposal} question{counts.proposal === 1 ? "" : "s"} for
            you
          </p>
          {upkeep.run ? <p>{runText(upkeep.run)}</p> : null}
          {settings.overnight && upkeep.lessons.memories ? (
            <p className="muted">
              Lesson lines: {upkeep.lessons.written} of{" "}
              {plural(upkeep.lessons.memories, "memory", "memories")} read,{" "}
              {upkeep.lessons.withLesson} with a lesson that carries beyond its
              project.
            </p>
          ) : null}
          {settings.overnight && upkeep.nextRunAt !== null ? (
            <p className="muted small">
              {nextRunText(upkeep.nextRunAt, upkeep.now)}
            </p>
          ) : null}
          {settings.overnight && !settings.autoApply ? (
            <p className="muted small">
              An earlier setting drafts suggestions at night without applying
              any. Turn on nightly upkeep to add new summaries automatically.
            </p>
          ) : null}
          {counts.failed ? (
            <p className="muted small">
              {counts.failed} check{counts.failed === 1 ? "" : "s"} could not
              finish. Each retries once, an hour later; All activity says why.
            </p>
          ) : null}
          <p className="muted small">
            Today: {budget.manual_calls} of {settings.manualMemories} memory
            checks by hand
            {settings.overnight
              ? `, ${budget.upkeep_calls} of ${settings.upkeepMemories} at night`
              : ""}
            .
          </p>
          {providerUnavailableReason ? (
            <p className="muted small">{providerUnavailableReason}</p>
          ) : null}
          {/* Ranking has its own counter, so a ranking stop sits beside the count it hit. */}
          {ranking.enabled ? (
            <p className="muted small">
              Candidate ranking today: {rankingBudget.manual_requests} of{" "}
              {RANKING_REQUESTS_PER_MEMORY * settings.manualMemories} requests
              by hand
              {settings.overnight
                ? `, ${rankingBudget.upkeep_requests} of ${RANKING_REQUESTS_PER_MEMORY * settings.upkeepMemories} at night`
                : ""}
              .
            </p>
          ) : null}
          {rankingStop ? (
            <p className="muted small">
              Candidate ranking stopped: {rankingStop}
            </p>
          ) : null}
          {/* The check's result grows under its button, so it sits apart from the switch row. */}
          {memoryId ? null : <RunCheck disabled={!configured} />}
          <div className="row flex-wrap items-center">
            <UpkeepSwitch
              on={upkeepOn}
              model={settings.model}
              disabled={!configured && !upkeepOn}
            />
            {/* With upkeep on, its own switch is the off control; this one returns with checks by hand. */}
            {upkeepOn ? null : (
              <SettingSwitch
                field="enabled"
                checked
                model={settings.model}
                label="Allow model reviews"
              />
            )}
          </div>
        </section>
      ) : (
        <section aria-label="Set up memory review" className="grid gap-3 *:m-0">
          <p>
            Each night Valise sends up to four related memories at a time to{" "}
            {model}, adds a summary where they fit together, and asks you where
            they conflict. It also sends up to sixteen memories at a time, cut
            to their opening, to write each one&apos;s lesson in a line.
          </p>
          <p className="muted">
            Up to {settings.upkeepMemories} memories a night, at most{" "}
            {usd(caps.reviewMicrousd)} a day, and you can undo anything it adds.
          </p>
          {providerUnavailableReason ? (
            <p className="muted">{providerUnavailableReason}</p>
          ) : null}
          <UpkeepSwitch
            on={false}
            model={settings.model}
            disabled={!configured}
          />
          <div className="row flex-wrap items-center">
            <span className="muted small">
              Or only check when you ask, and decide every suggestion yourself:
            </span>
            <SettingSwitch
              field="enabled"
              checked={false}
              model={settings.model}
              label="Allow model reviews"
            />
          </div>
        </section>
      )}
      <details open={advancedOpen || undefined}>
        <summary>Advanced: model, limits and ranking</summary>
        <ListControls>
          <DetailSection title="Model">
            <ReviewForm>
              <input name="intent" type="hidden" value="setting" />
              <input name="field" type="hidden" value="model" />
              <label className="field min-w-0 w-full max-w-full">
                Provider and model
                <select
                  className="min-w-0 max-w-full"
                  defaultValue={settings.model}
                  name="value"
                >
                  {reviewModelChoices(settings.model).map((choice) => (
                    <option key={choice} value={choice}>
                      {reviewModelLabel(choice)} — up to $
                      {(reviewMaxCallMicrousd(choice) / 1_000_000).toFixed(4)}{" "}
                      per call
                      {providerAvailable[REVIEW_MODELS.indexOf(choice)]
                        ? ""
                        : " — not configured"}
                    </option>
                  ))}
                </select>
              </label>
              <button className="ghost" type="submit">
                Save provider
              </button>
            </ReviewForm>
            <p className="muted small">
              Changing model turns reviews and nightly upkeep off until you turn
              them on again.
            </p>
          </DetailSection>
          <DetailSection title="Daily limits">
            <ReviewForm label="Daily limits" className="grid gap-4">
              <input name="intent" type="hidden" value="limits" />
              <input
                name="expectedModel"
                type="hidden"
                value={settings.model}
              />
              <input
                name="wasManualMemories"
                type="hidden"
                value={settings.manualMemories}
              />
              <input
                name="wasUpkeepMemories"
                type="hidden"
                value={settings.upkeepMemories}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="field min-w-0">
                  Memories checked by hand a day (1–{MAX_MANUAL_MEMORIES})
                  <input
                    defaultValue={settings.manualMemories}
                    min="1"
                    max={MAX_MANUAL_MEMORIES}
                    name="manualMemories"
                    type="number"
                    required
                  />
                </label>
                <label className="field min-w-0">
                  Memories checked each night (1–{MAX_UPKEEP_MEMORIES})
                  <input
                    defaultValue={settings.upkeepMemories}
                    min="1"
                    max={MAX_UPKEEP_MEMORIES}
                    name="upkeepMemories"
                    type="number"
                    required
                  />
                </label>
              </div>
              <div>
                <button className="ghost" type="submit">
                  Save limits
                </button>
              </div>
            </ReviewForm>
            <p className="muted small">
              One check is one model call about one memory; with candidate
              ranking on it also uses {RANKING_REQUESTS_PER_MEMORY} ranking
              requests. Counts reset at midnight UTC, and failed attempts count.
              An admin caps what a day may cost: {usd(caps.reviewMicrousd)} for
              review, {usd(caps.rankingMicrousd)} for ranking.
            </p>
          </DetailSection>
          <RankingSettings loaderData={loaderData} />
        </ListControls>
      </details>
      <details>
        <summary>How memory review works</summary>
        <ol className="grid gap-2">
          <li>
            A check takes a waiting memory and finds linked and matching
            memories to compare it with. With none, no model is called.
          </li>
          <li>
            The model drafts one clearer memory, a summary or a conflict flag
            from up to four of them, or suggests no change.
          </li>
          <li>
            With nightly upkeep on, a summary that only adds is saved with Undo;
            anything else waits under Questions, and accepting keeps the
            originals.
          </li>
        </ol>
      </details>
    </>
  );
  return (
    <>
      {refused && "error" in refused ? (
        <p role="alert">{refused.error}</p>
      ) : null}
      {ran ? <p role="status">{ran}</p> : null}
      {memoryId ? (
        <section aria-label="This memory" className="grid gap-3 *:m-0">
          {anchor ? (
            <>
              <h2 className="text-base">
                Suggestions that include{" "}
                <Link to={`/memories?open=memory%3A${anchor.id}`}>
                  {anchor.title || anchor.id}
                </Link>
              </h2>
              <p className="muted">
                A check compares this memory with its linked and matching
                memories. Pairs already compared are not sent again.
              </p>
              {settings.enabled ? (
                <RunCheck memory={anchor.id} disabled={!configured} />
              ) : null}
            </>
          ) : (
            <p role="alert">
              That memory cannot be found. It may have been archived.
            </p>
          )}
          <Link
            preventScrollReset
            to={memoryReviewHref(params, {
              memory: null,
              open: null,
              edit: null,
            })}
          >
            Show all suggestions
          </Link>
        </section>
      ) : null}
      {memoryId ||
      !(
        settings.overnight ||
        loaderData.principles.cards.length ||
        loaderData.principles.counts.adopted
      ) ? null : (
        <ThisWeek
          principles={loaderData.principles}
          canReflect={settings.enabled && settings.overnight}
        />
      )}
      {memoryId && settings.enabled ? null : controls}
      <nav aria-label="Review views" className="row flex-wrap">
        {(
          [
            ["questions", `Questions (${counts.proposal})`],
            ["applied", `Applied automatically (${counts.applied})`],
            ["all", "All activity"],
          ] as const
        ).map(([key, label]) => (
          <Link
            key={key}
            preventScrollReset
            aria-current={view === key ? "page" : undefined}
            to={memoryReviewHref(params, {
              view: key === "questions" ? null : key,
              activity: null,
              open: null,
              edit: null,
            })}
          >
            {label}
          </Link>
        ))}
        {view === "questions" && decided ? (
          <Link
            preventScrollReset
            className="ml-auto"
            to={memoryReviewHref(params, {
              decided: hideDecided ? null : "hide",
              open: null,
              edit: null,
            })}
          >
            {hideDecided ? "Show" : "Hide"} decided ({decided})
          </Link>
        ) : null}
      </nav>
      {!groups.length ? (
        <Empty>
          {memoryId
            ? "No suggestions include this memory yet."
            : view === "applied"
              ? "Nothing has been applied automatically yet. Summaries that nightly upkeep adds on its own appear here, each with Undo."
              : hideDecided && decided
                ? "Nothing is waiting. Every question here has a decision."
                : upkeepOn
                  ? `Nothing needs you. ${counts.applied ? `Nightly upkeep has added ${plural(counts.applied, "summary", "summaries")} on its own; see Applied automatically.` : "Nightly upkeep asks here when two memories conflict or would replace each other."}`
                  : "No suggestions to review."}{" "}
          {upkeepOn && !memoryId
            ? ""
            : settings.enabled
              ? memoryId
                ? "Check this memory now to look for overlaps."
                : "Check waiting memories to look for overlaps."
              : "Turn on nightly upkeep above, or allow model reviews and check by hand."}{" "}
          No-change results are kept in All activity. Originals always stay
          readable.
        </Empty>
      ) : null}
      <ItemList label="Memory reviews">
        {groups.map((group) => (
          <ReviewCard
            key={group.group_id}
            group={group}
            open={open === group.group_id}
            editing={editing}
            events={open === group.group_id ? events : []}
            sourceHistory={
              open === group.group_id ? loaderData.sourceHistory : {}
            }
            subjects={loaderData.subjects}
            next={open === group.group_id ? nextWaiting(group.group_id) : null}
          />
        ))}
      </ItemList>
      {groups.length >= limit && limit < 100 ? (
        <Link
          preventScrollReset
          to={memoryReviewHref(params, { limit: String(limit + 30) })}
        >
          Load more reviews
        </Link>
      ) : null}
      {memoryId && settings.enabled ? controls : null}
    </>
  );
}

const CHANGE_LABEL: Record<Principle["change_kind"], string> = {
  agents: "Add to the agent instructions",
  skill: "Update a skill",
  hook: "Add a hook",
  todo: "New to-do",
  none: "",
};

const distinct = (values: (string | null)[]) => new Set(values).size;

/** J-E's default view: at most three principle cards, or why there are none. */
function ThisWeek({
  principles,
  canReflect,
}: {
  principles: Awaited<ReturnType<typeof loader>>["principles"];
  canReflect: boolean;
}) {
  const { cards, adopted, counts, latest, lines } = principles;
  const running = !!latest && latest.finished_at === null;
  return (
    <section aria-label="This week's lessons" className="grid gap-3 *:m-0">
      <h2 className="text-base">This week&apos;s lessons</h2>
      {cards.length ? (
        <div className="grid gap-4">
          {cards.map((card) => (
            <PrincipleCard key={card.principle_id} card={card} />
          ))}
        </div>
      ) : running ? (
        <p className="muted">
          Reflecting on this week&apos;s lesson lines. Cards appear here as each
          one is drafted, one model call a minute.
        </p>
      ) : latest ? (
        <>
          <p className="muted">
            {latest.ended && !["done", "nothing"].includes(latest.ended)
              ? `The last reflection stopped: ${reviewFailureLabel(latest.ended)} `
              : ""}
            {plural(lines.length, "new lesson line")} since{" "}
            {utc(latest.since || latest.created_at)} UTC; nothing generalises
            yet.
          </p>
          {lines.length ? (
            <details>
              <summary>Lesson lines the reflection read</summary>
              <ul className="grid gap-1">
                {lines.map((line) => (
                  <li key={line.id}>
                    <Link to={`/memories?open=memory%3A${line.id}`}>
                      {line.lesson}
                    </Link>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : (
        <p className="muted">
          Once a week, after nightly upkeep has written lesson lines, the review
          model looks for one lesson in at least three memories from two
          sessions and two projects, and drafts it as a rule you can adopt.
        </p>
      )}
      {canReflect && !running ? (
        <ReviewForm pendingText="Asking for a reflection…">
          <input name="intent" type="hidden" value="reflect" />
          <button className="ghost" type="submit">
            Reflect now
          </button>
          <span className="muted small">
            Runs within a few minutes and counts against tonight&apos;s memory
            checks.
          </span>
        </ReviewForm>
      ) : null}
      <p className="muted small">
        Cards use memory evidence only; agent transcripts are not read.
        {counts.rejected
          ? ` Marked not a rule: ${counts.rejected}. The next reflection reads them and does not propose them again.`
          : ""}
      </p>
      {adopted.length ? (
        <details>
          <summary>Adopted principles ({counts.adopted})</summary>
          <ul className="grid gap-1">
            {adopted.map((p) => (
              <li key={p.principle_id}>
                <Link to={`/memories?open=memory%3A${p.result_memory_id}`}>
                  {p.rule}
                </Link>{" "}
                <span className="muted small">
                  {plural(p.evidence.length, "memory", "memories")}
                </span>
              </li>
            ))}
          </ul>
          {counts.adopted > adopted.length ? (
            <Link to="/memories?tag=principle">All adopted principles</Link>
          ) : null}
        </details>
      ) : null}
    </section>
  );
}

function PrincipleCard({ card }: { card: Principle }) {
  const chips = card.evidence.slice(0, 8);
  const change = CHANGE_LABEL[card.change_kind];
  return (
    <article
      aria-label={card.rule}
      className="card grid gap-3 p-4 *:m-0 min-w-0"
    >
      <h3>{card.rule}</h3>
      <p>
        <span className="muted">Applies when:</span> {card.applies_when}
      </p>
      <p className="muted small">
        {plural(card.evidence.length, "memory", "memories")} in{" "}
        {plural(distinct(card.evidence.map((e) => e.project)), "project")}, from{" "}
        {plural(distinct(card.evidence.map((e) => e.session)), "session")}
        {card.counter.length
          ? `; ${plural(card.counter.length, "counterexample")}`
          : ""}
      </p>
      <p aria-label="Evidence" className="flex flex-wrap gap-x-3 gap-y-1">
        {chips.map((e) => (
          <Link key={e.id} to={`/memories?open=memory%3A${e.id}`}>
            {e.title || e.id}
          </Link>
        ))}
        {card.evidence.length > chips.length ? (
          <span className="muted small">
            and {card.evidence.length - chips.length} more
          </span>
        ) : null}
      </p>
      {change && card.change_text ? (
        <p>
          <span className="muted">{change}:</span> {card.change_text}
        </p>
      ) : null}
      <details>
        <summary>Evidence, mechanism and exceptions</summary>
        <div className="grid gap-2 *:m-0">
          <p>
            <span className="muted">Mechanism:</span> {card.mechanism}
          </p>
          {card.exceptions ? (
            <p>
              <span className="muted">Exceptions:</span> {card.exceptions}
            </p>
          ) : null}
          <ul className="grid gap-1">
            {card.evidence.map((e) => (
              <li key={e.id}>
                <Link to={`/memories?open=memory%3A${e.id}`}>
                  {e.title || e.id}
                </Link>
                {e.project ? (
                  <span className="muted small"> · {e.project}</span>
                ) : null}
                <br />
                <span className="muted small">{e.lesson}</span>
              </li>
            ))}
          </ul>
          {card.counter.length ? (
            <>
              <p className="muted">Counterexamples</p>
              <ul className="grid gap-1">
                {card.counter.map((e) => (
                  <li key={e.id}>
                    <Link to={`/memories?open=memory%3A${e.id}`}>
                      {e.title || e.id}
                    </Link>
                    <br />
                    <span className="muted small">{e.lesson}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <p className="muted small">
            Drafted by{" "}
            {(REVIEW_MODELS as readonly string[]).includes(card.model)
              ? reviewModelLabel(card.model as (typeof REVIEW_MODELS)[number])
              : card.model}{" "}
            on {utc(card.created_at)} UTC.
          </p>
        </div>
      </details>
      <ReviewForm label="Adopt" className="grid gap-2" pendingText="Adopting…">
        <input name="intent" type="hidden" value="adopt" />
        <input name="principle" type="hidden" value={card.principle_id} />
        <label className="field">
          Rule, as it will be saved
          <textarea name="rule" defaultValue={card.rule} rows={2} required />
        </label>
        {change && card.change_text ? (
          <label className="row items-center gap-2">
            <input defaultChecked name="fileTodo" type="checkbox" />
            Also file a to-do for the change
          </label>
        ) : null}
        <div>
          <button type="submit">Adopt</button>
        </div>
      </ReviewForm>
      <details>
        <summary>Not a rule</summary>
        <ReviewForm label="Not a rule" className="grid gap-2">
          <input name="intent" type="hidden" value="reject" />
          <input name="principle" type="hidden" value={card.principle_id} />
          <label className="field">
            Why not (optional; the next reflection reads it)
            <input maxLength={500} name="reason" />
          </label>
          <div>
            <button className="ghost" type="submit">
              Not a rule
            </button>
          </div>
        </ReviewForm>
      </details>
    </article>
  );
}

/** Ranking keeps its own destination and permission (ADR-0012, 2026-10-30); its counts follow Daily limits. */
function RankingSettings({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { settings, ranking, rankingBudget, rankingConfigured, caps } =
    loaderData;
  const stop = ranking.enabled
    ? currentRankingStop(rankingBudget, {
        ...settings,
        rankingMicrousd: caps.rankingMicrousd,
      })
    : null;
  return (
    <DetailSection title="Candidate ranking">
      <p>
        Picks better memories to compare by sending the starting memory to
        Cloudflare Workers AI and the candidates to TypeSafe Jev.
      </p>
      <ReviewForm>
        <input type="hidden" name="intent" value="ranking-setting" />
        <input type="hidden" name="field" value="enabled" />
        <input
          type="hidden"
          name="value"
          value={ranking.enabled ? "off" : "on"}
        />
        <input type="hidden" name="revision" value={ranking.revision} />
        <input
          type="hidden"
          name="destination"
          value={REVIEW_RANK_DESTINATION}
        />
        <input type="hidden" name="expectedModel" value={settings.model} />
        <BeltSwitch
          type="submit"
          checked={ranking.enabled}
          disabled={
            !ranking.enabled && (!settings.enabled || !rankingConfigured)
          }
          label="Allow Workers AI + Jev candidate ranking"
        />
      </ReviewForm>
      {!rankingConfigured ? (
        <p className="muted small">
          Candidate ranking is not configured on this server.
        </p>
      ) : (
        <p className="muted small">
          Today: {rankingBudget.requests} ranking requests,{" "}
          {usd(rankingBudget.reserved_microusd)} of {usd(caps.rankingMicrousd)}.
          Each memory checked uses {RANKING_REQUESTS_PER_MEMORY}.
        </p>
      )}
      {stop ? (
        <p role="status">
          Ranking paused. {rankingFailureLabel(stop)} Waiting memories stay
          queued.
        </p>
      ) : null}
    </DetailSection>
  );
}

/** What accepting does, in one line, before any of the text it would add (J-A). */
function suggestionAction(
  kind: ReviewProposal["kind"],
  n: number,
  automatic: boolean,
): string {
  const memories = `${n} memor${n === 1 ? "y" : "ies"}`;
  if (automatic)
    return `Nightly upkeep wrote one new summary memory from ${memories}. The originals stay.`;
  return {
    consolidation: `Combine ${memories} that repeat each other into one new memory. The originals stay.`,
    summary: `Write one new summary memory from ${memories}. The originals stay.`,
    "stale-summary": `Write an updated summary from ${memories}. The originals stay.`,
    contradiction: `Mark ${memories} as conflicting. Neither is changed.`,
    noop: `No change suggested for ${memories}.`,
  }[kind];
}

/**
 * A long proposed body shows its first lines and a toggle. The toggle is a
 * checkbox and its label, so it works with scripting off (P11).
 */
function LongText({ id, children }: { id: string; children: string }) {
  if (children.length < 600 && children.split("\n").length < 10)
    return <Markdown>{children}</Markdown>;
  return (
    <div>
      <input
        aria-label="Show the full proposed text"
        className="peer sr-only"
        id={id}
        type="checkbox"
      />
      <div className="max-h-48 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)] peer-checked:max-h-none peer-checked:[mask-image:none]">
        <Markdown>{children}</Markdown>
      </div>
      <label
        className="cursor-pointer underline peer-checked:hidden peer-focus-visible:outline-2"
        htmlFor={id}
      >
        Show the full text
      </label>
      <label
        className="hidden cursor-pointer underline peer-checked:inline peer-focus-visible:outline-2"
        htmlFor={id}
      >
        Show less
      </label>
    </div>
  );
}

function ReviewCard({
  group,
  open,
  editing,
  events,
  sourceHistory,
  subjects,
  next,
}: {
  group: ReviewGroup;
  open: boolean;
  editing?: string;
  events: Awaited<ReturnType<typeof loader>>["events"];
  sourceHistory: Awaited<ReturnType<typeof loader>>["sourceHistory"];
  subjects: Awaited<ReturnType<typeof loader>>["subjects"];
  /** The next waiting suggestion in list order, offered once this one is decided (J-A). */
  next: ReviewGroup | null;
}) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const proposal = group.proposal_json
    ? (JSON.parse(group.proposal_json) as ReviewProposal)
    : null;
  const sources = JSON.parse(group.sources_json) as ReviewSnapshot[];
  // The memories the draft draws on: those it quotes, or all when it quotes none.
  const cited = sources.filter((s) =>
    proposal?.evidence?.some((e) => e.id === s.source.id),
  );
  const used = cited.length ? cited : sources;
  const href = memoryReviewHref(params, { open: group.group_id, edit: null });
  const field = openField(editing, group.group_id);
  let organizedSubject: string | null = null;
  try {
    const event = events.find((e) => e.kind === "accept" && e.value);
    const value = event?.value ? JSON.parse(event.value) : null;
    if (typeof value?.subject === "string") organizedSubject = value.subject;
  } catch {
    /* Older events may not be structured. */
  }
  const closeHref = memoryReviewHref(params, { open: null, edit: null });
  // Nightly upkeep applied it, and it may since have been undone (J-0).
  const automatic = group.applied_by === "auto";
  const title =
    group.state === "noop"
      ? "No change suggested"
      : group.state === "failed"
        ? "Review could not finish"
        : group.draft_title ||
          (proposal?.kind === "contradiction"
            ? `Conflict: ${sources.map(({ source }) => source.title || source.id).join(" vs ")}`
            : "Review in progress");
  const description = automatic
    ? group.state === "accepted"
      ? "Added a summary on its own"
      : "Added a summary, then undone"
    : group.state === "failed"
      ? reviewFailureLabel(group.error ?? "")
      : group.state === "noop"
        ? "No new memory was proposed."
        : proposal
          ? {
              consolidation: "Combine overlapping memories",
              summary: "Connect useful facts in a new summary",
              contradiction: "Check a possible conflict",
              "stale-summary": "Update an outdated summary",
              noop: "No change",
            }[proposal.kind]
          : "Waiting for the model response.";
  return (
    <ItemRow
      href={href}
      title={title}
      description={`${description} · ${sources.map(({ source }) => source.title || source.id).join(" · ")}`}
      open={open}
      meta={
        <Pill
          tone={
            group.state === "accepted"
              ? "done"
              : group.state === "failed"
                ? "blocked"
                : "label"
          }
        >
          {automatic
            ? group.state === "accepted"
              ? "Applied"
              : "Undone"
            : {
                proposal: "Waiting",
                noop: "No change",
                running: "Reviewing",
                failed: "Failed",
                accepted: "Accepted",
                dismissed: "Dismissed",
              }[group.state]}
        </Pill>
      }
    >
      {open ? (
        <Modal
          open
          size="pane"
          mobileSheet
          title={title}
          closeHref={closeHref}
          onClose={() =>
            navigate(closeHref, { replace: true, preventScrollReset: true })
          }
        >
          <div className="grid gap-6">
            {group.state === "failed" ? (
              <p role="alert">{reviewFailureLabel(group.error ?? "")}</p>
            ) : null}
            {proposal ? (
              <section
                aria-label="What this suggestion does"
                className="grid gap-2 *:m-0"
              >
                <p>
                  <strong>
                    {suggestionAction(proposal.kind, used.length, automatic)}
                  </strong>
                </p>
                <ul className="grid gap-1">
                  {sources.map(({ source }) => (
                    <li key={source.id}>
                      <Link to={`/memories?open=memory%3A${source.id}`}>
                        {source.title || source.id}
                      </Link>
                      {used.some((u) => u.source.id === source.id) ? null : (
                        <span className="muted small">
                          {" "}
                          · compared, not used
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {proposal ? (
              <DetailSection
                title={
                  proposal.kind === "noop"
                    ? "Why no change was suggested"
                    : proposal.kind === "contradiction"
                      ? "Possible conflict"
                      : "Why"
                }
              >
                <p>{proposal.why}</p>
              </DetailSection>
            ) : null}
            {proposal &&
            proposal.kind !== "noop" &&
            proposal.kind !== "contradiction" ? (
              <DetailSection
                title={automatic ? "Added memory" : "Proposed new memory"}
              >
                {(["title", "body"] as const).map((name) => (
                  <Editable
                    key={name}
                    action={href}
                    cancelHref={href}
                    editHref={`${href}&edit=${editKey(group.group_id, name)}`}
                    label={`Draft ${name}`}
                    defaultValue={
                      group[name === "title" ? "draft_title" : "draft_body"] ??
                      ""
                    }
                    editing={group.state === "proposal" && field === name}
                    multiline={name === "body"}
                    save="fetch"
                    hidden={{
                      intent: "edit",
                      id: group.group_id,
                      field: name,
                      was:
                        group[
                          name === "title" ? "draft_title" : "draft_body"
                        ] ?? "",
                    }}
                    noPen={group.state !== "proposal"}
                  >
                    {name === "title" ? (
                      <h3>{group.draft_title}</h3>
                    ) : (
                      <LongText id={`draft-${group.group_id}`}>
                        {group.draft_body ?? ""}
                      </LongText>
                    )}
                  </Editable>
                ))}
              </DetailSection>
            ) : null}
            <section aria-label="Decision" className="grid gap-3 *:m-0">
              {group.state === "proposal" ? (
                <>
                  <div className="row items-start">
                    <ReviewForm label="Accept proposal">
                      <input name="intent" type="hidden" value="accept" />
                      <input name="id" type="hidden" value={group.group_id} />
                      <input
                        name="draftTitle"
                        type="hidden"
                        value={group.draft_title ?? ""}
                      />
                      <input
                        name="draftBody"
                        type="hidden"
                        value={group.draft_body ?? ""}
                      />
                      {proposal?.kind === "consolidation" ? (
                        <details>
                          <summary>
                            Also replace the originals in search
                          </summary>
                          <div className="grid gap-4">
                            <label className="check">
                              <input name="supersede" type="checkbox" /> Also
                              supersede the contributing originals (removes them
                              from search, not history)
                            </label>
                            <label className="check">
                              <input name="retainedTruth" type="checkbox" /> I
                              checked that the draft retains everything still
                              true, including qualifications and attribution
                            </label>
                          </div>
                        </details>
                      ) : null}
                      <button type="submit">
                        {proposal?.kind === "contradiction"
                          ? "Confirm contradiction link"
                          : "Accept new memory"}
                      </button>
                    </ReviewForm>
                    <ReviewForm>
                      <input name="intent" type="hidden" value="dismiss" />
                      <input name="id" type="hidden" value={group.group_id} />
                      <button className="ghost" type="submit">
                        Dismiss proposal
                      </button>
                    </ReviewForm>
                  </div>
                  {proposal?.kind !== "contradiction" ? (
                    <>
                      <Link
                        preventScrollReset
                        to={`${href}&edit=${editKey(group.group_id, "subject")}`}
                      >
                        Accept and organize as subject
                      </Link>
                      {field === "subject" ? (
                        <Modal
                          open
                          title="Accept and organize as subject"
                          closeHref={href}
                          onClose={() =>
                            navigate(href, {
                              replace: true,
                              preventScrollReset: true,
                            })
                          }
                        >
                          <p>
                            A subject is a stable topic with supporting
                            memories. This accepts the draft without superseding
                            originals. Only the members you select are added.
                          </p>
                          <ReviewForm
                            label="Organize review subject"
                            className="grid gap-4"
                          >
                            <input type="hidden" name="intent" value="accept" />
                            <input
                              type="hidden"
                              name="id"
                              value={group.group_id}
                            />
                            <input
                              type="hidden"
                              name="draftTitle"
                              value={group.draft_title ?? ""}
                            />
                            <input
                              type="hidden"
                              name="draftBody"
                              value={group.draft_body ?? ""}
                            />
                            <label className="field">
                              Subject action
                              <select name="subjectMode" defaultValue="new">
                                <option value="new">Create a new topic</option>
                                <option value="existing">
                                  Add to an existing subject
                                </option>
                              </select>
                            </label>
                            <label className="field">
                              New subject name
                              <input
                                name="subjectName"
                                defaultValue={group.draft_title ?? ""}
                                maxLength={200}
                              />
                            </label>
                            <label className="field">
                              Existing subject
                              <select name="subjectTarget" defaultValue="">
                                <option value="">
                                  Choose an existing subject
                                </option>
                                {subjects.map((s) => (
                                  <option
                                    key={s.subject_id}
                                    value={JSON.stringify({
                                      id: s.subject_id,
                                      summary: s.summary_memory_id,
                                    })}
                                  >
                                    {s.name}
                                    {s.summary_memory_id
                                      ? " · has a current summary"
                                      : " · no current summary"}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="field">
                              Or paste a subject id
                              <input name="subjectId" placeholder="sub_…" />
                            </label>
                            <p className="muted small">
                              The picker shows up to thirty subjects. A pasted
                              id can add members without replacing an
                              undisplayed summary.
                            </p>
                            <fieldset>
                              <legend>Supporting memories</legend>
                              {sources.map((s) => (
                                <label className="check" key={s.source.id}>
                                  <input
                                    type="checkbox"
                                    name="member"
                                    value={s.source.id}
                                    defaultChecked={proposal?.evidence.some(
                                      (e) => e.id === s.source.id,
                                    )}
                                  />
                                  {s.source.title || s.source.id}
                                </label>
                              ))}
                            </fieldset>
                            <label className="check">
                              <input type="checkbox" name="setSummary" />
                              Make the accepted memory the current summary
                              (replaces the current summary pointer, never the
                              original memories)
                            </label>
                            <button type="submit">Accept and organize</button>
                          </ReviewForm>
                        </Modal>
                      ) : null}
                    </>
                  ) : null}
                </>
              ) : null}
              {automatic && group.state === "accepted" ? (
                <>
                  <p>
                    Nightly upkeep applied this because it only adds a summary.
                    Undo archives the added memory; the same sources are not
                    suggested again unless they change.
                  </p>
                  <ReviewForm label="Undo automatic change">
                    <input name="intent" type="hidden" value="undo" />
                    <input name="id" type="hidden" value={group.group_id} />
                    <button className="ghost" type="submit">
                      Undo: archive the added memory
                    </button>
                  </ReviewForm>
                </>
              ) : null}
              {automatic && group.state === "dismissed" ? (
                <p>
                  Undone. The added memory is archived, and the same sources are
                  not suggested again unless they change.
                </p>
              ) : null}
              {group.state === "dismissed" && !automatic ? (
                <ReviewForm>
                  <input name="intent" type="hidden" value="reopen" />
                  <input name="id" type="hidden" value={group.group_id} />
                  <button className="ghost" type="submit">
                    Reopen proposal
                  </button>
                </ReviewForm>
              ) : null}
              {group.result_memory_id &&
              !(automatic && group.state === "dismissed") ? (
                <Link to={`/memories?open=memory%3A${group.result_memory_id}`}>
                  {automatic ? "Open added memory" : "Open accepted memory"}
                </Link>
              ) : null}
              {organizedSubject ? (
                <Link to={`/memories/subjects/${organizedSubject}`}>
                  Open subject
                </Link>
              ) : null}
              {group.state === "accepted" && !automatic ? (
                <p>
                  Approval is recorded. Originals and immutable histories
                  remain. Accepted links can be removed in Memories; archiving
                  the new memory also restores any superseded originals to
                  search.
                </p>
              ) : null}
              {group.state === "failed" ? (
                <p>
                  {group.attempts < 2
                    ? "One delayed retry is eligible after an hour, within your daily budget."
                    : "Retry limit reached. Only changed sources or new evidence can reopen eligibility."}
                </p>
              ) : null}
              {next && group.state !== "proposal" ? (
                <p>
                  <Link
                    preventScrollReset
                    replace
                    to={memoryReviewHref(params, {
                      open: next.group_id,
                      edit: null,
                    })}
                  >
                    Next waiting suggestion:{" "}
                    {next.draft_title || "Untitled draft"}
                  </Link>
                </p>
              ) : null}
            </section>
            <DetailSection title="Source evidence">
              {sources.map(({ source, fingerprint, selection }) => (
                <section key={source.id}>
                  <h3>
                    <Link to={`/memories?open=memory%3A${source.id}`}>
                      {source.title || source.id}
                    </Link>
                  </h3>
                  {proposal?.evidence
                    .filter((e) => e.id === source.id)
                    .map((e) => (
                      <blockquote key={e.id}>{e.quote}</blockquote>
                    ))}
                  {proposal &&
                  !proposal.evidence.some((e) => e.id === source.id) ? (
                    <p className="muted small">
                      Compared, but not cited in a proposed change.
                    </p>
                  ) : null}
                  <details>
                    <summary>Source details</summary>
                    <p className="muted small">
                      Revision {source.revision} · {source.agent} ·{" "}
                      {source.client}
                      {source.session ? ` · ${source.session}` : ""}
                    </p>
                    <p className="muted small">
                      {selection
                        ? `Selected as: ${{ "starting-memory": "starting memory from the change queue", "existing-link": "existing linked memory", "keyword-match": "keyword search match", "same-project": "recent memory in the same project", "vector-match": "current vector candidate", "hybrid-ranking": "Jev joint-review candidate" }[selection.via]}.${selection.score === undefined ? "" : ` Relevance ${selection.score}; not source authority.`}`
                        : "Selection reason was not recorded for this older review."}{" "}
                      {selection && selection.anchorId !== source.id ? (
                        <>
                          Compared with{" "}
                          <Link
                            to={`/memories?open=memory%3A${selection.anchorId}`}
                          >
                            {sources.find(
                              (s) => s.source.id === selection.anchorId,
                            )?.source.title || selection.anchorId}
                          </Link>
                          .
                        </>
                      ) : null}
                    </p>
                    {selection?.ranking ? (
                      <details>
                        <summary>Candidate selection record</summary>
                        <p>
                          {selection.ranking.model} · provisional cutoff{" "}
                          {selection.ranking.threshold}. Scores express review
                          relevance, not authority or permission to consolidate.
                          Low-scoring or oversized sources may be omitted; this
                          is not whole-library coverage.
                        </p>
                        <pre className="whitespace-pre-wrap break-words">
                          {JSON.stringify(selection.ranking, null, 2)}
                        </pre>
                      </details>
                    ) : null}
                    <Markdown>{source.body}</Markdown>
                    <p className="muted small">
                      Content fingerprint{" "}
                      <code className="break-all">{fingerprint}</code>
                    </p>
                  </details>
                  {sourceHistory[source.id]?.length ? (
                    <>
                      <Link
                        preventScrollReset
                        to={`${href}&edit=${editKey(group.group_id, `history-${source.id}`)}`}
                      >
                        Previous reviews (
                        {Math.min(10, sourceHistory[source.id].length)}
                        {sourceHistory[source.id].length > 10 ? "+" : ""})
                      </Link>
                      {field === `history-${source.id}` ? (
                        <Modal
                          open
                          title={`Previous reviews: ${source.title || source.id}`}
                          closeHref={href}
                          onClose={() =>
                            navigate(href, {
                              replace: true,
                              preventScrollReset: true,
                            })
                          }
                        >
                          <p>
                            Compared is not consolidated. The same memory may
                            support a new relationship or changed evidence.
                          </p>
                          <div
                            className="overflow-x-auto"
                            role="region"
                            aria-label="Previous review decisions"
                            tabIndex={0}
                          >
                            <table>
                              <thead>
                                <tr>
                                  <th>Reviewed</th>
                                  <th>Evidence</th>
                                  <th>Use</th>
                                  <th>Decision</th>
                                </tr>
                              </thead>
                              <tbody>
                                {sourceHistory[source.id]
                                  .slice(0, 10)
                                  .map((prior) => (
                                    <tr key={prior.group_id}>
                                      <td>
                                        <Link
                                          to={memoryReviewHref(params, {
                                            open: prior.group_id,
                                            edit: null,
                                            activity: "all",
                                          })}
                                        >
                                          {new Date(prior.created_at * 1000)
                                            .toISOString()
                                            .slice(0, 10)}
                                        </Link>
                                      </td>
                                      <td>
                                        Revision {prior.revision} ·{" "}
                                        {prior.fingerprint === fingerprint
                                          ? "same evidence"
                                          : "different evidence"}
                                      </td>
                                      <td>
                                        {prior.state === "accepted" &&
                                        prior.cited
                                          ? prior.superseded
                                            ? "Superseded"
                                            : prior.result_memory_id
                                              ? "Incorporated"
                                              : "Conflict linked"
                                          : prior.cited
                                            ? "Cited"
                                            : "Compared only"}
                                      </td>
                                      <td>
                                        {prior.state}
                                        {prior.result_memory_id ? (
                                          <Link
                                            to={`/memories?open=memory%3A${prior.result_memory_id}`}
                                          >
                                            {" "}
                                            · accepted memory
                                          </Link>
                                        ) : null}
                                      </td>
                                    </tr>
                                  ))}
                              </tbody>
                            </table>
                          </div>
                          <p className="small muted md:hidden">
                            Scroll the table sideways to read every decision.
                          </p>
                          <p>
                            Latest ten reviews; these are recorded comparisons,
                            not a claim that every relevant memory has been
                            reviewed.
                          </p>
                        </Modal>
                      ) : null}
                    </>
                  ) : (
                    <p className="muted small">
                      No previous reviews recorded for this source.
                    </p>
                  )}
                </section>
              ))}
            </DetailSection>
            <details>
              <summary>Model response and review history</summary>
              <p className="muted small">
                {group.model} · {group.prompt_version} · attempt{" "}
                {group.attempts}. Reviewed{" "}
                {new Date(group.created_at * 1000).toISOString()}.{" "}
                {sources.every((s) => s.selection)
                  ? "Selection methods are recorded with the sources."
                  : "This run has no complete selection trace; do not infer a selection reason from similarity alone."}
              </p>
              {proposal ? (
                <>
                  <h3>Original model response</h3>
                  <p>
                    This is the unedited response, not necessarily the draft you
                    accepted.
                  </p>
                  <pre className="whitespace-pre-wrap break-words">
                    {JSON.stringify(proposal, null, 2)}
                  </pre>
                </>
              ) : null}
              <h3>Human review history</h3>
              {events.length ? (
                <ul>
                  {events.map((event, index) => (
                    <li key={`${event.created_at}-${index}`}>
                      <time>
                        {new Date(event.created_at * 1000).toISOString()}
                      </time>{" "}
                      · {event.kind}
                      {event.value ? (
                        <pre className="whitespace-pre-wrap break-words">
                          {event.value}
                        </pre>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No human edits or decisions recorded.</p>
              )}
              {events.length === 50 ? (
                <p>Showing the latest 50 events.</p>
              ) : null}
            </details>
          </div>
        </Modal>
      ) : null}
    </ItemRow>
  );
}
