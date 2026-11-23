import { Form, Link } from "react-router";
import { Icon, type IconName } from "~/components/icon";
import { ItemList, ItemRow } from "~/components/item-list";
import { ApplicationShell, Empty, ProjectChip } from "~/components/ui";
import { authorLabel } from "~/concepts/agent-names";
import {
  groupTrail,
  TRAIL_DAYS,
  TRAIL_LIMIT,
  type TrailConcept,
  timeRange,
  trailHref,
  trailOutcomes,
  trailVerb,
  trailWindow,
} from "~/concepts/trail";
import { requireConsoleActor } from "~/console/context.server";
import { ActivityNav } from "~/features/activity/nav";
import type { Route } from "./+types/activity";

/**
 * What happened while you were away: every write to your own case, newest
 * first, in blocks by the session that made it. Any signed-in person sees
 * their own; the call log, latency and errors stay on the owner's Workbench.
 * ADR-0006, amendment of 2026-10-29.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const actor = await requireConsoleActor(context, request);
  const window = trailWindow(new URL(request.url));
  const trail = await actor.store.activity.trail(window);
  return { window, ...trail, now: Math.floor(Date.now() / 1000) };
}

export default function Activity({ loaderData }: Route.ComponentProps) {
  const { window, events, counts, truncated } = loaderData;
  const runs = groupTrail(events);
  const outcomes = trailOutcomes(counts);
  const scope = window.day
    ? `On ${dayLabel(window.day)} (UTC)`
    : `In the last ${TRAIL_DAYS} days`;
  const withProject = (project: string | null) => {
    const params = new URLSearchParams();
    if (window.day) params.set("day", window.day);
    if (project) params.set("project", project);
    const search = params.toString();
    return search ? `/activity?${search}` : "/activity";
  };
  let lastDay = "";
  return (
    <ApplicationShell
      lede="What changed in your case, newest first, grouped by the session that changed it. Each line links to the item."
      sections={<ActivityNav current="changes" />}
      title="Activity"
    >
      <Form className="row activity-filters" method="get">
        <label>
          Day
          <input defaultValue={window.day ?? ""} name="day" type="date" />
        </label>
        <label>
          Project
          <input
            defaultValue={window.project ?? ""}
            name="project"
            type="text"
          />
        </label>
        <button type="submit">Show</button>
        {window.day || window.project ? (
          <Link className="ghost-link" to="/activity">
            Last {TRAIL_DAYS} days, every project
          </Link>
        ) : null}
      </Form>

      <p className="activity-outcomes" data-testid="activity-outcomes">
        {scope}
        {window.project ? `, in ${window.project}` : ""}:{" "}
        {outcomes.length ? outcomes.join(", ") : "nothing changed"}.
      </p>

      {runs.length === 0 ? (
        <Empty>
          Nothing was saved, published or changed in this window. Pick another
          day, or clear the project.
        </Empty>
      ) : (
        <ol className="activity-trail">
          {runs.map((run) => {
            const heading = run.day !== lastDay ? run.day : null;
            lastDay = run.day;
            const { name, client } = authorLabel(run.agent, run.session);
            const first = run.events.at(-1)?.at ?? 0;
            const last = run.events[0]?.at ?? 0;
            return (
              <li key={run.events[0].id}>
                {heading ? (
                  <h2 className="eyebrow activity-day">
                    <Link to={`/activity?day=${heading}`}>
                      {dayLabel(heading)}
                    </Link>
                  </h2>
                ) : null}
                <section
                  aria-label={`${name}, ${time(first)} to ${time(last)}`}
                  className="activity-run"
                >
                  <p className="activity-who">
                    <strong title={run.agent ?? undefined}>{name}</strong>
                    {client ? <span className="muted"> · {client}</span> : null}
                    <span className="muted">
                      {" "}
                      · {timeRange(first, last)} UTC · {run.events.length}{" "}
                      {run.events.length === 1 ? "change" : "changes"}
                    </span>
                  </p>
                  <ItemList label={`Changes by ${name}`}>
                    {run.events.map((event) => (
                      <ItemRow
                        className="activity-event"
                        dense
                        description={
                          event.detail ? `· ${event.detail}` : undefined
                        }
                        href={trailHref(event)}
                        key={event.id}
                        lead={trailVerb(event)}
                        media={
                          <Icon
                            label={KIND[event.concept].label}
                            name={KIND[event.concept].icon}
                          />
                        }
                        meta={
                          event.project ? (
                            <ProjectChip
                              href={withProject(event.project)}
                              project={event.project}
                            />
                          ) : undefined
                        }
                        title={event.title}
                      />
                    ))}
                  </ItemList>
                </section>
              </li>
            );
          })}
        </ol>
      )}
      {truncated ? (
        <p className="muted">
          Showing the newest {TRAIL_LIMIT}. Pick a day to see the rest of it.
        </p>
      ) : null}
    </ApplicationShell>
  );
}

/** Each kind leads its line with the icon the sidebar gives its page. */
const KIND: Record<TrailConcept, { icon: IconName; label: string }> = {
  todo: { icon: "todos", label: "To-do" },
  memory: { icon: "memory", label: "Memory" },
  skill: { icon: "skills", label: "Skill" },
  source: { icon: "link", label: "Source" },
  file: { icon: "file", label: "File" },
};

function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function time(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(11, 16);
}
