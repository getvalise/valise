import { type ReactNode, useEffect, useState } from "react";
import { Form, Link, useNavigation } from "react-router";
import { Combobox } from "~/components/combobox";
import { FileTree } from "~/components/file-tree";
import { Icon } from "~/components/icon";
import { ItemList } from "~/components/item-list";
import { offer } from "~/components/list-filters";
import { Markdown } from "~/components/markdown";
import { SearchBar } from "~/components/search-bar";
import { TagInput } from "~/components/tag-input";
import { DetailSection, Empty, Pill, SubNav, TagRow } from "~/components/ui";
import { type CuratedSkill, curatedFor } from "~/concepts/curated-skills";
import { type SkillAddPreview } from "~/concepts/skills";
import {
  type GithubImportReport,
  type GithubImportState,
} from "~/concepts/skills-github";
import {
  type PopularSkill,
  type RegistryHit,
} from "~/concepts/skills-registry";
import { type Vocabulary } from "~/concepts/vocabulary";
import { DiffView } from "./editor";
import type { AddRoute, GithubPreview, Listing, Preview } from "./types";
/**
 * One way in for a skill, whatever its source. Every route ends in the same
 * preview, and publishing is the last step of that preview, so a stranger's
 * bundle and a hand-written SKILL.md are both read before they are written.
 */
export function AddSkill({
  route,
  find,
  hits,
  preview,
  draft,
  errors,
  hrefFor,
  vocabulary,
  pasted,
  github,
  githubList,
  githubImport,
  suggestions,
  suggestionHref,
}: {
  pasted: string;
  github: GithubPreview | null;
  githubList: Listing | null;
  githubImport: GithubImportReport | null;
  route: AddRoute;
  find: string;
  hits: RegistryHit[];
  preview: Preview | null;
  draft: SkillAddPreview | null;
  errors: string[];
  hrefFor: (route: AddRoute | null) => string;
  vocabulary: Vocabulary;
  suggestions: (CuratedSkill & { name: string; added: boolean })[];
  suggestionHref: (source: string) => string;
}) {
  return (
    <div className="grid min-w-0 gap-4 [&>.subnav]:m-0 [&>.subnav]:border-b [&>.subnav]:pb-3">
      <SubNav
        items={[
          {
            href: hrefFor("search"),
            label: "Search skills.sh",
            current: route === "search",
          },
          {
            href: hrefFor("url"),
            label: "Paste a URL",
            current: route === "url",
          },
          {
            href: hrefFor("write"),
            label: "Write SKILL.md",
            current: route === "write",
          },
        ]}
        label="Where the skill comes from"
      />
      {errors.length > 0 ? <p role="alert">{errors.join(" ")}</p> : null}
      {route === "search" ? (
        <RegistrySearch
          find={find}
          hits={hits}
          hrefFor={hrefFor}
          preview={preview}
          suggestions={suggestions}
          suggestionHref={suggestionHref}
          vocabulary={vocabulary}
        />
      ) : route === "url" ? (
        <PasteUrl
          github={github}
          hrefFor={hrefFor}
          imported={githubImport}
          listing={githubList}
          pasted={pasted}
          vocabulary={vocabulary}
        />
      ) : (
        <WriteSkill draft={draft} vocabulary={vocabulary} />
      )}
    </div>
  );
}

/**
 * A GitHub file, folder or repository, or a skills.sh link. A repository
 * lists its skills as a checklist pinned to the commit the list was read at,
 * so a batch import and each skill's own preview read the same files.
 */
function PasteUrl({
  pasted,
  github,
  listing,
  imported,
  hrefFor,
  vocabulary,
}: {
  pasted: string;
  github: GithubPreview | null;
  listing: Listing | null;
  imported: GithubImportReport | null;
  hrefFor: (route: AddRoute | null) => string;
  vocabulary: Vocabulary;
}) {
  const here = hrefFor("url");
  const kept = [...new URLSearchParams(here.split("?")[1] ?? "")];
  const open = (url: string) => `${here}&${new URLSearchParams({ url })}`;
  return (
    <>
      <SearchBar
        action="/skills"
        hidden={kept}
        submit="Open"
        field={{
          label: "GitHub or skills.sh URL",
          name: "url",
          defaultValue: pasted,
          placeholder:
            "github.com/owner/repo, a folder, a SKILL.md, or a skills.sh link",
          type: "url",
        }}
      />
      {imported === null ? null : <ImportReport report={imported} />}
      {listing !== null ? (
        listing.groups.length === 0 ? (
          <Empty>
            No SKILL.md in {listing.owner}/{listing.repo}.
          </Empty>
        ) : (
          // Keyed on the commit, so a new listing starts from its own ticks.
          <GithubChecklist
            key={`${listing.owner}/${listing.repo}@${listing.sha}`}
            listing={listing}
            open={open}
            vocabulary={vocabulary}
          />
        )
      ) : null}
      {github !== null ? (
        <SkillPreview
          reason={<CuratedReason source={pasted} />}
          check={github.check}
          digest={github.hash}
          files={github.files}
          hidden={{ intent: "import-github", source: github.source }}
          vocabulary={vocabulary}
        >
          <a href={github.url} rel="noreferrer" target="_blank">
            View on GitHub
            <Icon name="external" />
          </a>
        </SkillPreview>
      ) : null}
    </>
  );
}

const IMPORT_STATE: Record<GithubImportState, string | null> = {
  new: null,
  added: "added",
  taken: "name taken",
};

/**
 * A repository's skills as one form: tick what to import, label them once,
 * publish them all from the commit the list was read at. New skills start
 * ticked; one already added from this folder starts unticked, and ticking it
 * imports this commit over it. A name another skill owns cannot be ticked.
 * Each name still opens its own preview, for a diff before importing.
 */
function GithubChecklist({
  listing,
  open,
  vocabulary,
}: {
  listing: Listing;
  open: (url: string) => string;
  vocabulary: Vocabulary;
}) {
  const navigation = useNavigation();
  const busy =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "import-github-batch";
  const skills = listing.groups.flatMap((group) => group.skills);
  const [picked, setPicked] = useState<Set<string>>(
    () =>
      new Set(
        skills
          .filter((skill) => skill.state === "new")
          .map((skill) => skill.path),
      ),
  );
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const tickable = (among: typeof skills) =>
    among.filter((skill) => skill.state !== "taken").map((skill) => skill.path);
  const pick = (paths: string[], on: boolean) =>
    setPicked((before) => {
      const after = new Set(before);
      for (const path of paths) {
        if (on) after.add(path);
        else after.delete(path);
      }
      return after;
    });
  // An import that landed unticks what it added and leaves every other tick
  // as the person set it, so the next press cannot re-import the rest.
  const added = skills
    .filter((skill) => skill.state === "added")
    .map((skill) => skill.path)
    .join("\n");
  useEffect(() => {
    if (added !== "") pick(added.split("\n"), false);
  }, [added]);
  return (
    <Form className="stack" method="post" preventScrollReset>
      <input name="intent" type="hidden" value="import-github-batch" />
      <input name="owner" type="hidden" value={listing.owner} />
      <input name="repo" type="hidden" value={listing.repo} />
      <input name="sha" type="hidden" value={listing.sha} />
      {/* Ticking many at once needs scripting; each box does not. */}
      {hydrated ? (
        <p className="row">
          <TickAll paths={tickable(skills)} pick={pick} picked={picked} />
        </p>
      ) : null}
      {listing.groups.map((group) => {
        const paths = tickable(group.skills);
        return (
          <section key={group.plugin ?? ""}>
            <div className="row">
              <p className="eyebrow m-0">
                {group.plugin === null
                  ? "Not in a plugin"
                  : `Plugin ${group.plugin}`}
              </p>
              {hydrated && paths.length > 1 ? (
                <TickAll paths={paths} pick={pick} picked={picked} />
              ) : null}
            </div>
            <ItemList
              label={
                group.plugin === null
                  ? "Skills not in a plugin"
                  : `Skills in plugin ${group.plugin}`
              }
            >
              {group.skills.map((found) => (
                <RegistryRow key={found.path}>
                  <p className={HEAD}>
                    <label className="check">
                      <input
                        aria-label={`Import ${found.name}`}
                        checked={picked.has(found.path)}
                        disabled={found.state === "taken"}
                        name="path"
                        onChange={(event) =>
                          pick(
                            [found.path],
                            (event.target as { checked?: boolean }).checked ===
                              true,
                          )
                        }
                        type="checkbox"
                        value={found.path}
                      />
                      <code>{found.name}</code>
                    </label>
                    <span className={SOURCE}>
                      {IMPORT_STATE[found.state] === null ? null : (
                        <Pill tone="label">{IMPORT_STATE[found.state]}</Pill>
                      )}{" "}
                      {found.path || "."}
                    </span>
                    <Link
                      aria-label={`Preview ${found.name}`}
                      preventScrollReset
                      to={open(found.url)}
                    >
                      <Icon name="expand" />
                    </Link>
                  </p>
                  {found.description ? (
                    <small className="block truncate pl-7 text-xs text-muted-foreground">
                      {found.description}
                    </small>
                  ) : null}
                </RegistryRow>
              ))}
            </ItemList>
          </section>
        );
      })}
      <Combobox
        creatable
        label="Project"
        name="project"
        options={offer(vocabulary.projects)}
      />
      <fieldset>
        <legend>Tags</legend>
        <TagInput defaultValue={[]} name="tags" options={vocabulary.tags} />
      </fieldset>
      <div className="row">
        <button
          disabled={busy || (hydrated && picked.size === 0)}
          type="submit"
        >
          {busy
            ? "Importing…"
            : hydrated
              ? `Import ${picked.size} ${picked.size === 1 ? "skill" : "skills"}`
              : "Import ticked skills"}
        </button>
        <span className="muted">
          From {listing.owner}/{listing.repo} at {listing.sha.slice(0, 7)}
        </span>
      </div>
    </Form>
  );
}

function TickAll({
  paths,
  picked,
  pick,
}: {
  paths: string[];
  picked: Set<string>;
  pick: (paths: string[], on: boolean) => void;
}) {
  const all = paths.every((path) => picked.has(path));
  return (
    <button
      className="ghost small"
      onClick={() => pick(paths, !all)}
      type="button"
    >
      {all ? "Untick all" : "Tick all"}
    </button>
  );
}

function ImportReport({ report }: { report: GithubImportReport }) {
  return (
    <div className="skill-change-report" role="status">
      {report.imported.length > 0 ? (
        <p>
          Imported{" "}
          {report.imported
            .map((skill) => `${skill.name} (v${skill.version})`)
            .join(", ")}
          .
        </p>
      ) : null}
      {report.taken.length > 0 ? (
        <p>
          Skipped {report.taken.map((skill) => skill.name).join(", ")}: another
          skill already has{" "}
          {report.taken.length === 1 ? "that name" : "those names"}.
        </p>
      ) : null}
      {report.failed.map((failure) => (
        <p key={failure.path}>
          Could not import {failure.path || "."}: {failure.errors.join(" ")}
        </p>
      ))}
    </div>
  );
}

/**
 * What the Valise maintainers recommend, and why, under the list. Popular is what many
 * people install; this is one person's reasons, so the reason leads.
 */
export function Suggestions({
  suggestions,
  hrefFor,
}: {
  suggestions: (CuratedSkill & { name: string; added: boolean })[];
  hrefFor: (source: string) => string;
}) {
  if (suggestions.length === 0) return null;
  return (
    <section aria-label="Suggested skills" className="grid min-w-0">
      <p className="eyebrow">Suggested</p>
      <ItemList label="Suggested skills">
        {suggestions.map((entry) => (
          <RegistryRow key={entry.source}>
            <div className={HEAD}>
              {entry.added ? (
                <code>{entry.name}</code>
              ) : (
                <Link
                  className={OPEN}
                  preventScrollReset
                  to={hrefFor(entry.source)}
                >
                  <Icon name="expand" />
                  <code>{entry.name}</code>
                </Link>
              )}
              {entry.added ? <Pill tone="done">added</Pill> : null}
              <TagRow tags={entry.tags} />
            </div>
            <div className={REASON}>
              <Markdown>{entry.reason}</Markdown>
            </div>
          </RegistryRow>
        ))}
      </ItemList>
    </section>
  );
}

/**
 * What many people install, from skills.sh, beside the maintainers' picks. A
 * row opens the search route's preview, which downloads the SKILL.md; the
 * list itself carries no description.
 */
export function Popular({
  hits,
  sort,
  sortHref,
  hrefFor,
}: {
  hits: (PopularSkill & { added: boolean })[];
  sort: "all-time" | "trending";
  sortHref: (sort: "all-time" | "trending") => string;
  hrefFor: (source: string) => string;
}) {
  return (
    <section aria-label="Popular on skills.sh" className="mt-10 grid min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-3 [&>.subnav]:m-0">
        <p className="eyebrow">Popular on skills.sh</p>
        <SubNav
          items={[
            {
              href: sortHref("all-time"),
              label: "All time",
              current: sort === "all-time",
            },
            {
              href: sortHref("trending"),
              label: "Trending",
              current: sort === "trending",
            },
          ]}
          label="Sort popular skills"
        />
      </div>
      <ItemList label="Popular skills">
        {hits.map((hit) => (
          <RegistryRow key={hit.id}>
            <div className={HEAD}>
              {hit.added ? (
                <code>{hit.skillId}</code>
              ) : (
                <Link className={OPEN} preventScrollReset to={hrefFor(hit.id)}>
                  <Icon name="expand" />
                  <code>{hit.skillId}</code>
                </Link>
              )}
              <span className={SOURCE}>
                {hit.source}
                {hit.added ? " · added" : ""}
              </span>
              <span className={INSTALLS}>
                {sort === "trending" && hit.trend !== null
                  ? `${trendLabel(hit.trend)} last week`
                  : `${hit.installs.toLocaleString("en-US")} installs`}
              </span>
            </div>
          </RegistryRow>
        ))}
      </ItemList>
    </section>
  );
}

/** 1.32 reads "+32%"; 0.9 reads "-10%". */
function trendLabel(trend: number): string {
  const percent = Math.round((trend - 1) * 100);
  return `${percent >= 0 ? "+" : ""}${percent}%`;
}

/** The maintainers' reason, above the preview of a suggested skill. */
function CuratedReason({ source }: { source: string }) {
  const entry = curatedFor(source);
  if (entry === null) return null;
  return (
    <div className="bg-muted p-3">
      <p className="eyebrow">Why it is suggested</p>
      <div className={REASON}>
        <Markdown>{entry.reason}</Markdown>
      </div>
    </div>
  );
}

/** A GET form, so a search is a URL like any other on this page. P3. */
function RegistrySearch({
  find,
  hits,
  preview,
  hrefFor,
  vocabulary,
  suggestions,
  suggestionHref,
}: {
  find: string;
  hits: RegistryHit[];
  preview: Preview | null;
  hrefFor: (route: AddRoute | null) => string;
  vocabulary: Vocabulary;
  suggestions: (CuratedSkill & { name: string; added: boolean })[];
  suggestionHref: (source: string) => string;
}) {
  const here = hrefFor("search");
  // The list's filters ride along, so closing the dialog lands on the same list.
  const kept = [...new URLSearchParams(here.split("?")[1] ?? "")];
  const withFind = (extra: Record<string, string>) =>
    `${here}&${new URLSearchParams({ find, ...extra })}`;
  return (
    <div className="grid min-w-0 gap-4">
      <SearchBar
        action="/skills"
        hidden={kept}
        field={{
          label: "Find a skill on skills.sh",
          name: "find",
          defaultValue: find,
          placeholder: "Find a skill on skills.sh",
        }}
      />
      {find === "" ? null : hits.length === 0 ? (
        <Empty>Nothing on skills.sh matches “{find}”.</Empty>
      ) : (
        <ItemList label="Skills on skills.sh">
          {hits.map((hit) => {
            const open = preview?.id === hit.id;
            return (
              <RegistryRow current={open} key={hit.id}>
                <p className={HEAD}>
                  {/* The preview is a download, so it is a link rather than a
                      disclosure: what you are looking at stays in the URL. */}
                  <Link
                    className={OPEN}
                    preventScrollReset
                    to={open ? withFind({}) : withFind({ preview: hit.id })}
                  >
                    <Icon name={open ? "expanded" : "expand"} />
                    <code>{hit.skillId}</code>
                  </Link>
                  <span className={SOURCE}>{hit.source}</span>
                  <span className={INSTALLS}>
                    {hit.installs.toLocaleString("en-US")} installs
                  </span>
                </p>
                {open && preview ? (
                  <SkillPreview
                    reason={<CuratedReason source={preview.id} />}
                    check={preview.check}
                    digest={preview.hash}
                    files={preview.files}
                    hidden={{ import: hit.id }}
                    vocabulary={vocabulary}
                  >
                    <a href={hit.listingUrl} rel="noreferrer" target="_blank">
                      View on skills.sh
                      <Icon name="external" />
                    </a>
                  </SkillPreview>
                ) : null}
              </RegistryRow>
            );
          })}
        </ItemList>
      )}
      <Suggestions hrefFor={suggestionHref} suggestions={suggestions} />
    </div>
  );
}

const SKILL_TEMPLATE = `---
name: my-skill
description: When an agent should use this skill, in one sentence.
---

# My skill

What to do, step by step.
`;

/**
 * The textarea and the preview are both on screen once previewed. Publish
 * posts the previewed body from a hidden field, so what lands is what the
 * preview showed, and typing again takes the publish away until the next
 * preview.
 */
function WriteSkill({
  draft,
  vocabulary,
}: {
  draft: SkillAddPreview | null;
  vocabulary: Vocabulary;
}) {
  const [stale, setStale] = useState(false);
  const navigation = useNavigation();
  const busy = navigation.formData?.get("intent") === "preview-write";
  return (
    <>
      {draft !== null && !stale ? (
        <SkillPreview
          check={draft}
          digest={null}
          files={[]}
          hidden={{ intent: "add", body: draft.body }}
          vocabulary={vocabulary}
        />
      ) : null}
      <Form className="stack" method="post" preventScrollReset>
        <label>
          SKILL.md
          <textarea
            defaultValue={draft?.body ?? SKILL_TEMPLATE}
            key={draft?.body ?? ""}
            name="body"
            onChange={() => setStale(true)}
            required
            rows={14}
          />
        </label>
        <div className="row">
          <button
            className={draft !== null && !stale ? "ghost" : undefined}
            disabled={busy}
            name="intent"
            onClick={() => setStale(false)}
            type="submit"
            value="preview-write"
          >
            Preview
          </button>
        </div>
      </Form>
    </>
  );
}

/**
 * The step every source ends on: what the skill claims to be, what it
 * carries, and what it would replace. Its one action names the outcome, "Add
 * skill" for a new name and "Publish version N" for a taken one.
 */
function SkillPreview({
  check,
  files,
  digest,
  hidden,
  vocabulary,
  children,
  reason,
}: {
  check: SkillAddPreview;
  files: { path: string; size: number; sha256: string }[];
  /** The upstream's digest, for an import. */
  digest: string | null;
  /** What the publish posts besides project and tags. */
  hidden: Record<string, string>;
  vocabulary: Vocabulary;
  children?: ReactNode;
  reason?: ReactNode;
}) {
  const navigation = useNavigation();
  const busy =
    navigation.formData !== undefined &&
    Object.entries(hidden).every(
      ([key, value]) => navigation.formData?.get(key) === value,
    );
  const existing = check.existing;
  const name = check.frontmatter.name ?? "";
  return (
    <section
      aria-label="Skill preview"
      className="grid gap-4 py-3 [&_.facts]:m-0 [&_.facts]:grid-cols-2 sm:[&_.facts]:grid-cols-3"
    >
      {check.errors.length > 0 ? (
        <p role="alert">{check.errors.join(" ")}</p>
      ) : null}
      <DetailSection title="Skill details">
        <dl className="facts">
          <div>
            <dt>Name</dt>
            <dd>
              <code>{name || "not stated"}</code>
            </dd>
          </div>
          <div>
            <dt>Licence</dt>
            <dd>{check.frontmatter.license ?? "not stated"}</dd>
          </div>
          {digest !== null ? (
            <div>
              <dt>Upstream digest</dt>
              <dd>
                <code>{digest.slice(0, 16) || "none"}</code>
              </dd>
            </div>
          ) : null}
          <div className="col-span-full">
            <dt>Description</dt>
            <dd>{check.frontmatter.description ?? "not stated"}</dd>
          </div>
        </dl>
        {reason}
      </DetailSection>

      <DetailSection title="Bundle">
        <FileTree
          files={files}
          root={{ path: "SKILL.md", size: check.body.length, sha256: "" }}
        />
      </DetailSection>

      {existing === null ? null : existing.unchanged ? (
        <p className="warn">
          {existing.deleted
            ? `${name} was deleted, and this is its v${existing.version} word for word. Adding it restores that version.`
            : `${name} already exists, and this is its v${existing.version} word for word. Nothing to publish.`}
        </p>
      ) : (
        <>
          <p className="warn">
            {name} {existing.deleted ? "was deleted" : "already exists"}
            {existing.source ? `, from ${existing.source}` : ""}. Publishing
            this makes v{existing.version}
            {existing.deleted ? " and restores it" : ""}; the earlier versions
            stay.
          </p>
          <p className="eyebrow">Changes against the head</p>
          <DiffView lines={existing.diff} />
        </>
      )}

      {check.errors.length > 0 ||
      (existing?.unchanged && !existing.deleted) ? null : (
        <DetailSection title="Organize and add">
          <Form className="stack" method="post" preventScrollReset>
            {Object.entries(hidden).map(([key, value]) => (
              <input key={key} name={key} type="hidden" value={value} />
            ))}
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              <Combobox
                creatable
                label="Project"
                name="project"
                options={offer(vocabulary.projects)}
              />
              <fieldset>
                <legend>Tags</legend>
                <TagInput
                  defaultValue={[]}
                  name="tags"
                  options={vocabulary.tags}
                />
              </fieldset>
            </div>
            <div className="row">
              <button disabled={busy} type="submit">
                {busy
                  ? "Publishing…"
                  : existing?.deleted && existing.unchanged
                    ? "Restore skill"
                    : existing
                      ? `Publish version ${existing.version}`
                      : "Add skill"}
              </button>
              <span className="inline-flex items-center gap-1 text-[0.8125rem] text-muted-foreground [&_a]:inline-flex [&_a]:items-center [&_a]:gap-1">
                {children}
              </span>
            </div>
          </Form>
        </DetailSection>
      )}
    </section>
  );
}

/** One registry row: its head line, then what that skill carries. */
function RegistryRow({
  current = false,
  children,
}: {
  current?: boolean;
  children: ReactNode;
}) {
  return (
    <li
      aria-current={current ? "true" : undefined}
      className="grid min-w-0 gap-1 px-4 py-2"
    >
      {children}
    </li>
  );
}

/** Name, source, count: three columns on a wide screen, stacked on a phone. */
const HEAD =
  "m-0 grid min-w-0 max-w-none items-center gap-x-4 gap-y-0.5 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto]";
const OPEN =
  "inline-flex min-h-6 items-center gap-1.5 no-underline hover:[&_code]:underline hover:[&_code]:decoration-primary hover:[&_code]:underline-offset-[3px]";
const SOURCE = "text-sm text-muted-foreground";
const INSTALLS = "font-mono text-xs text-muted-foreground";
const REASON = "text-sm text-muted-foreground [&_p]:mt-0 [&_p]:mb-2";
