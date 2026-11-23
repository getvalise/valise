import { action, loader } from "~/console/skills.server";

export { action, loader };

import { Suspense, useEffect, useState } from "react";
import {
  Await,
  Link,
  useActionData,
  useFetcher,
  useLocation,
  useNavigate,
} from "react-router";
import { editKey, openField } from "~/components/editable";
import { InfiniteList, useLiveList } from "~/components/infinite-list";
import { AddRow, ItemList, ItemRow } from "~/components/item-list";
import { ListToolbar } from "~/components/list-toolbar";
import { Modal } from "~/components/modal";
import { OnboardingChecklist } from "~/components/onboarding-checklist";
import {
  ApplicationShell,
  Empty,
  ListControls,
  Pill,
  ProjectChip,
  TagLinks,
} from "~/components/ui";
import { Button } from "~/components/ui/button";
import { listHref, withTag } from "~/concepts/list-filters";
import {
  type SkillAddPreview,
  type SkillChange,
  type SkillChangeReport,
} from "~/concepts/skills";
import {
  type GithubImportReport,
  parseGithubSource,
} from "~/concepts/skills-github";
import { type UpstreamReport } from "~/concepts/skills-upstream";
import {
  ChangeReport,
  SkillChanges,
  UpdateReport,
} from "~/features/skills/changes";
import { SkillDetail, SkillEnabled } from "~/features/skills/detail";
import { type EditResult, SkillEditor } from "~/features/skills/editor";
import { AddSkill, Popular } from "~/features/skills/import";
import type { AddRoute } from "~/features/skills/types";
import type { Route } from "./+types/skills";

/**
 * One row per skill, and everything a skill is behind one click.
 *
 * A skill is three doors and a bundle: its own `skill_{name}` tool, a
 * `get_skill` naming it, a `skill://` resource, and the files in R2. The page
 * used to show the first of those and the whole SKILL.md of every version
 * stacked under disclosures, which at ten skills is forty `<pre>` blocks and
 * no answer to the only question worth asking — which door anything uses.
 */

export default function Skills({ loaderData }: Route.ComponentProps) {
  const live = useLiveList(
    loaderData.skills,
    (skill) => `${skill.name}\n${skill.body}`,
    loaderData.filters,
  );
  const navigationResult = useActionData<typeof action>();
  const bulk = useFetcher<typeof action>({ key: "skill-changes" });
  const actionData = navigationResult;
  const location = useLocation();
  const navigate = useNavigate();
  const result: Partial<Record<string, unknown>> | undefined = actionData;
  const editResult =
    result !== undefined && ("review" in result || "editErrors" in result)
      ? (actionData as EditResult)
      : null;
  const draft =
    result !== undefined && "draft" in result
      ? (actionData as { draft: SkillAddPreview }).draft
      : null;
  const githubImport =
    result !== undefined && "githubImport" in result
      ? (actionData as { githubImport: GithubImportReport }).githubImport
      : null;
  const importErrors =
    result !== undefined && "importErrors" in result
      ? (actionData as { importErrors: string[] }).importErrors
      : [];
  const skill = loaderData.detail;
  // Opening and closing keep whatever else is in the URL: the filters, and
  // a registry search that is still on screen.
  // The Add skill dialog keeps the list's filters and drops its own keys
  // when it closes or switches route.
  const withAdd = (route: AddRoute | null) => {
    const params = new URLSearchParams(location.search);
    for (const key of ["add", "find", "preview", "url"]) params.delete(key);
    if (route !== null) params.set("add", route);
    const search = params.toString();
    return search ? `/skills?${search}` : "/skills";
  };
  const filtered = Object.entries(loaderData.filters).some(
    ([key, value]) => key !== "page" && Boolean(value),
  );
  const bulkResult = bulk.data ?? actionData;
  const updated =
    bulkResult !== undefined && "updated" in bulkResult
      ? (bulkResult as { updated: UpstreamReport }).updated
      : null;
  const changed =
    bulkResult !== undefined && "report" in bulkResult
      ? (bulkResult as { change: SkillChange; report: SkillChangeReport })
      : null;
  // Ticked rows, by name. The checkboxes post themselves through `form=`,
  // so this only counts them and drives select-all once hydrated.
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  // A change that landed clears the ticks it acted on.
  useEffect(() => {
    if (changed !== null || updated !== null) setTicked(new Set());
  }, [changed, updated]);
  const shown = live.rows.map((row) => row.name);
  const tickedShown = shown.filter((name) => ticked.has(name));
  const tick = (name: string, on: boolean) =>
    setTicked((before) => {
      const after = new Set(before);
      if (on) after.add(name);
      else after.delete(name);
      return after;
    });
  const upstreamErrors =
    result !== undefined && "upstreamErrors" in result
      ? (actionData as { upstreamErrors: string[] }).upstreamErrors
      : [];
  // An update opens the Add skill preview on the upstream copy, so it gets
  // the same diff against the head as any other publish over a taken name.
  // A suggestion opens the route its source belongs to, on its preview.
  const suggestionHref = (source: string) =>
    source.startsWith("https://")
      ? `${withAdd("url")}&${new URLSearchParams({ url: source })}`
      : `${withAdd("search")}&${new URLSearchParams({
          find: source.split("/")[2] ?? source,
          preview: source,
        })}`;
  const updateHref = (source: string | null) => {
    if (source === null) return null;
    const pinned = parseGithubSource(source);
    if (pinned === null) {
      return `${withAdd("search")}&${new URLSearchParams({
        find: source.split("/")[2] ?? source,
        preview: source,
      })}`;
    }
    return `${withAdd("url")}&${new URLSearchParams({
      url: `https://github.com/${pinned.owner}/${pinned.repo}/tree/${pinned.sha}/${pinned.path}`,
    })}`;
  };
  const withOpen = (name: string | undefined, edit?: string) => {
    const params = new URLSearchParams(location.search);
    if (name === undefined) params.delete("open");
    else params.set("open", name);
    if (edit === undefined) params.delete("edit");
    else params.set("edit", edit);
    const search = params.toString();
    return search ? `/skills?${search}` : "/skills";
  };

  const editingBody =
    skill !== null &&
    openField(loaderData.editing || undefined, skill.name) === "body";
  const pane =
    skill === null || editingBody ? null : (
      <Modal
        closeHref={withOpen(undefined)}
        mobileSheet
        onClose={() =>
          navigate(withOpen(undefined), {
            replace: true,
            preventScrollReset: true,
          })
        }
        open
        size="pane"
        title={skill.name}
      >
        <SkillDetail
          key={skill.name}
          upstreamErrors={upstreamErrors}
          updateHref={updateHref(skill.upstream?.source ?? null)}
          editHref={withOpen(skill.name, editKey(skill.name, "body"))}
          editing={openField(loaderData.editing || undefined, skill.name)}
          filters={loaderData.filters}
          hrefFor={(field) =>
            withOpen(
              skill.name,
              field === undefined ? undefined : editKey(skill.name, field),
            )
          }
          skill={skill}
          vocabulary={loaderData.vocabulary}
        />
      </Modal>
    );
  const paneInList = live.rows.some((row) => row.name === skill?.name);
  const allTicked =
    tickedShown.length > 0 && tickedShown.length === shown.length;

  return (
    <ApplicationShell
      lede="Publishing creates an immutable version and moves the agent-visible head. Every skill is served three ways at once: its own MCP tool, the SEP-2640 skill:// resource, and get_skill."
      title="Skills"
    >
      <OnboardingChecklist onboarding={loaderData.onboarding} />
      <ListControls>
        <ListToolbar
          filters={loaderData.filters}
          live={live}
          path="/skills"
          tagCounts={loaderData.facets}
          vocabulary={loaderData.vocabulary}
        >
          {/* Deleted rows leave for a named place, one click back. P5. */}
          {loaderData.deletedCount > 0 ? (
            <Button asChild className="h-8" size="sm" variant="outline">
              <Link
                preventScrollReset
                to={listHref("/skills", loaderData.filters, {
                  page: undefined,
                  deleted: loaderData.filters.showDeleted ? undefined : "show",
                })}
              >
                {`${loaderData.filters.showDeleted ? "Hide" : "Show"} deleted (${loaderData.deletedCount})`}
              </Link>
            </Button>
          ) : null}
        </ListToolbar>
        {/* The bulk bar appears once a row is ticked. With scripting off it
            is always there: the boxes post through it. P11. */}
        {loaderData.skills.length > 0 &&
        (!hydrated || tickedShown.length > 0) ? (
          <SkillChanges
            hydrated={hydrated}
            onClear={() => setTicked(new Set())}
            showDeleted={loaderData.filters.showDeleted === true}
            ticked={tickedShown.length}
          />
        ) : null}
      </ListControls>

      <ItemList className="skill-list" label="Skills">
        <AddRow label="Add skill" to={withAdd("search")} />
        {loaderData.skills.length === 0 ? null : (
          <>
            {/* Select-all is the one control that needs scripting; each
              row's own box posts without it. P11. */}
            {hydrated ? (
              <li className="flex items-center gap-3 bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
                <label className="grid size-[24px] place-items-center">
                  <input
                    aria-label="Select every skill shown"
                    checked={allTicked}
                    className="size-4 accent-[var(--primary)]"
                    onChange={(event) =>
                      setTicked(
                        new Set(
                          (event.target as { checked?: boolean }).checked ===
                            true
                            ? shown
                            : [],
                        ),
                      )
                    }
                    type="checkbox"
                  />
                </label>
                <span>
                  {tickedShown.length > 0
                    ? `${tickedShown.length} of ${shown.length} selected`
                    : `${shown.length} ${shown.length === 1 ? "skill" : "skills"}`}
                </span>
              </li>
            ) : null}
            {live.rows.map((row) => (
              <ItemRow
                description={row.description}
                href={withOpen(row.name)}
                key={row.name}
                media={
                  <label className="grid size-[24px] place-items-center">
                    <input
                      aria-label={`Select ${row.name}`}
                      checked={ticked.has(row.name)}
                      className="size-4 accent-[var(--primary)]"
                      form="skill-changes"
                      name="skill"
                      onChange={(event) =>
                        tick(
                          row.name,
                          (event.target as { checked?: boolean }).checked ===
                            true,
                        )
                      }
                      type="checkbox"
                      value={row.name}
                    />
                  </label>
                }
                meta={
                  <>
                    {row.deleted ? <Pill tone="label">deleted</Pill> : null}
                    {row.upstream?.available ? (
                      <Pill tone="accent">update</Pill>
                    ) : null}
                    {row.autoUpdate ? <Pill tone="label">auto</Pill> : null}
                    {row.project ? (
                      <ProjectChip
                        href={listHref("/skills", {
                          ...loaderData.filters,
                          page: undefined,
                          project: row.project,
                        })}
                        project={row.project}
                      />
                    ) : null}
                    {row.tags.length > 0 ? (
                      <TagLinks
                        href={(tag) =>
                          listHref("/skills", withTag(loaderData.filters, tag))
                        }
                        tags={row.tags}
                      />
                    ) : null}
                    <span
                      className="font-mono"
                      title={`v${row.version}; ${row.files === 0 ? "SKILL.md only" : `SKILL.md and ${row.files} more files`}; calls in thirty days: ${row.usage.asTool} as its tool, ${row.usage.viaGetSkill} via get_skill, ${row.usage.asResource} as a resource, ${row.usage.asPrompt} as a prompt`}
                    >
                      v{row.version}
                    </span>
                    <SkillEnabled skill={row} />
                  </>
                }
                muted={row.deleted}
                open={row.name === skill?.name}
                title={<span className="font-mono">{row.name}</span>}
              >
                {row.name === skill?.name ? pane : null}
              </ItemRow>
            ))}
          </>
        )}
      </ItemList>
      {loaderData.skills.length === 0 ? (
        filtered ? (
          <Empty>No skills match those filters.</Empty>
        ) : (
          <Empty>
            No skills yet. A skill is a SKILL.md: a name, a one-line description
            of when to use it, and the instructions. Every agent connected here
            sees it as its own tool, as a skill:// resource, and through
            get_skill.
          </Empty>
        )
      ) : null}
      {paneInList ? null : pane}

      <InfiniteList
        paused={live.pending}
        filters={loaderData.filters}
        path="/skills"
        window={loaderData.window}
      />
      {/* Reports follow the working rows: inserting one must not push the
          acted-on row down under the pointer. P4. */}
      {changed === null ? null : <ChangeReport {...changed} />}
      {updated === null ? null : <UpdateReport report={updated} />}

      {/* Editing the body is a modal: a large form over the page, not a
          reading pane. */}
      <Modal
        size="wide"
        onClose={() =>
          navigate(withOpen(skill?.name), { preventScrollReset: true })
        }
        open={editingBody}
        title={skill?.name ?? "Skill"}
      >
        {skill !== null && editingBody ? (
          <SkillEditor
            key={skill.name}
            cancelHref={withOpen(skill.name)}
            edit={editResult}
            skill={skill}
          />
        ) : null}
      </Modal>

      <Modal
        onClose={() => navigate(withAdd(null), { preventScrollReset: true })}
        open={loaderData.add !== null}
        title="Add skill"
      >
        {loaderData.add === null ? null : (
          <AddSkill
            draft={draft}
            errors={[...loaderData.registryErrors, ...importErrors]}
            find={loaderData.find}
            hits={loaderData.registry}
            github={loaderData.github}
            githubImport={githubImport}
            githubList={loaderData.githubList}
            hrefFor={withAdd}
            pasted={loaderData.pasted}
            preview={loaderData.preview}
            route={loaderData.add}
            suggestions={loaderData.suggestions}
            suggestionHref={suggestionHref}
            vocabulary={loaderData.vocabulary}
          />
        )}
        {loaderData.add === "search" ? (
          <Suspense fallback={null}>
            <Await errorElement={null} resolve={loaderData.popular}>
              {(hits) =>
                hits.length === 0 ? null : (
                  <Popular
                    hits={hits}
                    hrefFor={suggestionHref}
                    sortHref={(sort) => {
                      const params = new URLSearchParams(location.search);
                      if (sort === "trending")
                        params.set("popular", "trending");
                      else params.delete("popular");
                      const search = params.toString();
                      return search ? `/skills?${search}` : "/skills";
                    }}
                    sort={loaderData.popularSort}
                  />
                )
              }
            </Await>
          </Suspense>
        ) : null}
      </Modal>
    </ApplicationShell>
  );
}
