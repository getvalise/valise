import { useState } from "react";
import { Link, useFetcher, useLocation } from "react-router";
import type { Onboarding } from "~/concepts/onboarding";
import { ViaFetcher } from "./editable";
import { Icon } from "./icon";
import { Pill } from "./ui";

/**
 * The first-run checklist, above the list on /todos and /skills. Each step
 * ticks from what the store sees; nothing here installs anything, and a
 * starter skill opens the same preview the Add skill dialog shows. Hidden for
 * the account once dismissed (Account brings it back) or once both steps are
 * done. Hide posts through a fetcher and goes on the click's own frame; with
 * scripting off it is a form that lands back here (P11).
 */
export function OnboardingChecklist({
  onboarding,
}: {
  onboarding: Onboarding;
}) {
  const fetcher = useFetcher();
  const location = useLocation();
  const [hidden, setHidden] = useState(false);
  if (hidden || onboarding.dismissedAt !== null || onboarding.complete)
    return null;
  return (
    <section
      aria-labelledby="onboarding-title"
      className="onboarding grid min-w-0 gap-3 rounded-lg border bg-card px-4 py-3"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="grid min-w-0 gap-0.5">
          <h2 className="m-0 text-base font-medium" id="onboarding-title">
            Get started
          </h2>
          <p className="m-0 max-w-none text-sm text-muted-foreground">
            Two steps to a working Valise. Each one ticks itself when it
            happens.
          </p>
        </div>
        <fetcher.Form
          action="/onboarding"
          method="post"
          onSubmit={() => setHidden(true)}
          preventScrollReset
        >
          <ViaFetcher />
          <input name="dismissed" type="hidden" value="1" />
          <input
            name="back"
            type="hidden"
            value={`${location.pathname}${location.search}`}
          />
          <button
            aria-label="Hide the getting-started checklist"
            className="ghost small"
            type="submit"
          >
            Hide
          </button>
        </fetcher.Form>
      </div>
      <ol className="m-0 grid list-none gap-3 p-0">
        <Step
          done={onboarding.connected}
          title="Connect an MCP client"
          todo={
            <>
              Add Valise as an MCP server in Claude Code, Cursor or another
              client. This ticks on the client's first call.{" "}
              <Link to="/connections">Open Connections</Link>
            </>
          }
          finished="A client has called Valise."
        />
        <Step
          done={onboarding.firstSkill}
          title="Add your first skill"
          todo={
            <>
              Built-in skills do not count. Start from one below, or{" "}
              <Link to="/skills?add=search">add your own</Link>.
            </>
          }
          finished="You have added a skill."
        />
      </ol>
      <div className="grid min-w-0 gap-1.5">
        <p className="m-0 text-sm font-medium">Starter skills</p>
        <ul className="m-0 grid list-none gap-1.5 p-0">
          {onboarding.starters.map((starter) => (
            <li
              className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm"
              key={starter.source}
            >
              {starter.added ? (
                <>
                  <code>{starter.name}</code>
                  <Pill tone="done">added</Pill>
                </>
              ) : (
                <Link
                  aria-label={`Preview ${starter.name}`}
                  className="inline-flex min-h-6 items-center gap-1"
                  to={starterHref(starter.source)}
                >
                  <Icon name="expand" />
                  <code>{starter.name}</code>
                </Link>
              )}
              <span className="min-w-0 text-muted-foreground">
                {starter.reason}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Step({
  done,
  title,
  todo,
  finished,
}: {
  done: boolean;
  title: string;
  todo: React.ReactNode;
  finished: string;
}) {
  return (
    <li className="flex min-w-0 items-start gap-2.5">
      <span
        aria-hidden="true"
        className={`mt-0.5 inline-flex size-[18px] shrink-0 items-center justify-center rounded-full border ${
          done ? "border-primary bg-primary text-primary-foreground" : ""
        }`}
      >
        {done ? <Icon name="check" size={12} /> : null}
      </span>
      <div className="grid min-w-0 gap-0.5">
        <p className="m-0 max-w-none text-sm font-medium">
          {title}
          <span className="sr-only">{done ? ", done" : ", not done yet"}</span>
        </p>
        <p className="m-0 max-w-none text-sm text-muted-foreground">
          {done ? finished : todo}
        </p>
      </div>
    </li>
  );
}

/** The Add skill preview a starter opens, the same one its suggestion opens. */
export function starterHref(source: string): string {
  return source.startsWith("https://")
    ? `/skills?${new URLSearchParams({ add: "url", url: source })}`
    : `/skills?${new URLSearchParams({
        add: "search",
        find: source.split("/")[2] ?? source,
        preview: source,
      })}`;
}
