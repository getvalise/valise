import { useState } from "react";
import { Link, useFetcher } from "react-router";
import { BeltSwitch } from "~/components/belt-switch";
import { Combobox } from "~/components/combobox";
import {
  Editable,
  useHydrated,
  useLanded,
  ViaFetcher,
} from "~/components/editable";
import { FileTree } from "~/components/file-tree";
import { Icon } from "~/components/icon";
import { offer } from "~/components/list-filters";
import { Markdown } from "~/components/markdown";
import { TagInput, TagSet } from "~/components/tag-input";
import { Pill, ProjectChip } from "~/components/ui";
import { type ListFilters, listHref, withTag } from "~/concepts/list-filters";
import type { SkillChange, SkillChangeReport } from "~/concepts/skills";
import { readFrontmatter, type SkillVersionHistory } from "~/concepts/skills";
import { parseGithubSource } from "~/concepts/skills-github";
import { type Vocabulary } from "~/concepts/vocabulary";
import { ChangeReport } from "./changes";
import type { Skill } from "./types";

/** The same reversible setting in the list and detail, with a form as its floor. */
export function SkillEnabled({
  skill,
  detail = false,
}: {
  skill: { name: string; disabled: boolean; deleted: boolean };
  detail?: boolean;
}) {
  const fetcher = useFetcher();
  const hydrated = useHydrated();
  const pending = fetcher.state !== "idle";
  const checked = pending
    ? fetcher.formData?.get("change") === "enable"
    : !skill.disabled && !skill.deleted;
  return (
    <fetcher.Form className="skill-enabled" method="post" preventScrollReset>
      <input name="intent" type="hidden" value="change" />
      <input name="skill" type="hidden" value={skill.name} />
      {hydrated ? <input name="via" type="hidden" value="fetcher" /> : null}
      <BeltSwitch
        aria-label={detail ? "Skill enabled" : `${skill.name} enabled`}
        checked={checked}
        disabled={skill.deleted || pending}
        hideLabel={!detail}
        label={detail ? "Skill enabled" : "Enabled"}
        name="change"
        title={
          skill.deleted
            ? "Restore this skill before enabling it"
            : `${skill.disabled ? "Enable" : "Disable"} ${skill.name}`
        }
        type="submit"
        value={skill.disabled ? "enable" : "disable"}
      />
    </fetcher.Form>
  );
}

export function SkillDetail({
  skill,
  updateHref,
  upstreamErrors,
  editHref,
  editing,
  hrefFor,
  filters,
  vocabulary,
}: {
  skill: Skill;
  /** The preview of the upstream copy, when an import has an upstream. */
  updateHref: string | null;
  upstreamErrors: string[];
  editHref: string;
  /** The field whose pen is open, from `?edit=<name>.<field>`. */
  editing: string | null;
  /** This dialog's URL, with a pen open when given a field. */
  hrefFor: (field?: string) => string;
  filters: ListFilters;
  vocabulary: Vocabulary;
}) {
  const mutation = useFetcher<{
    upstreamErrors?: string[];
    change?: SkillChange;
    report?: SkillChangeReport;
  }>();
  const [saving, setSaving] = useState(false);
  const landed = useLanded(mutation, () => setSaving(false));
  const submit = () => {
    setSaving(true);
    landed();
  };
  // The pen pattern the memory dialog uses: each label is its own form. P2.
  const field = (name: string) => ({
    action: hrefFor(),
    cancelHref: hrefFor(),
    editHref: hrefFor(name),
    editing: editing === name,
    hidden: { intent: "skill-field", skill: skill.name, field: name },
    save: "fetch" as const,
  });
  const head = skill.versions.find((version) => version.isHead);
  const [showing, setShowing] = useState(head?.version ?? skill.version);
  const version =
    skill.versions.find((row) => row.version === showing) ?? head ?? null;
  const frontmatter = version ? readFrontmatter(version.body) : {};
  const builtin = skill.source?.startsWith("builtin:") ?? false;
  // The sync writes source_hash beside every head it publishes, so a head
  // that no longer matches it was edited here, and updates are held.
  const held =
    builtin && head !== undefined && head.sha256 !== skill.sourceHash;

  return (
    <div className="skill-detail">
      <p className="skill-summary">
        {frontmatter.description ?? skill.description}
      </p>
      {version && !version.isHead ? (
        <p className="warn">
          Viewing v{version.version}. Settings and actions below apply to the
          current skill; Edit SKILL.md edits the head, v{skill.version}.
        </p>
      ) : null}
      {skill.disabled ? (
        <p className="warn">
          Off. No agent sees this skill — not as a tool, in search, through
          get_skill, or as a resource — until it is enabled again.
        </p>
      ) : null}
      {held ? (
        <p className="warn">
          Edited here, so built-in updates are held. Deploys stop moving this
          head until the local edits are republished as the built-in.
        </p>
      ) : null}

      <dl className="facts skill-organization">
        <div>
          <dt>Project</dt>
          <dd>
            <Editable
              {...field("project")}
              defaultValue={skill.project ?? ""}
              editor={
                <Combobox
                  autoFocus
                  creatable
                  defaultValue={skill.project ?? ""}
                  label="Project"
                  name="value"
                  openOnFocus={false}
                  options={offer(vocabulary.projects)}
                />
              }
              empty={skill.project ? undefined : "Add a project"}
              label="Project"
            >
              {skill.project ? (
                <ProjectChip
                  href={listHref("/skills", {
                    ...filters,
                    page: undefined,
                    project: skill.project,
                  })}
                  project={skill.project}
                />
              ) : null}
            </Editable>
          </dd>
        </div>
        <div>
          <dt>Tags</dt>
          <dd>
            <Editable
              {...field("tags")}
              defaultValue={skill.tags.join(", ")}
              editor={
                <TagInput
                  autoFocus
                  defaultValue={skill.tags}
                  name="value"
                  options={vocabulary.tags}
                />
              }
              label="Tags"
              noPen
            >
              <TagSet
                action={field("tags").action}
                chipHref={(tag) => listHref("/skills", withTag(filters, tag))}
                editHref={field("tags").editHref}
                hidden={field("tags").hidden}
                options={vocabulary.tags}
                tags={skill.tags}
              />
            </Editable>
          </dd>
        </div>
      </dl>
      <details className="skill-metadata">
        <summary>Skill settings and activity</summary>
        <dl className="facts">
          <div>
            <dt>Tool</dt>
            <dd>
              <code>{skill.toolName}</code>
            </dd>
          </div>
          <div>
            <dt>Resource</dt>
            <dd>
              <code>{skill.uri}</code>
            </dd>
          </div>
          <div>
            <dt>Reached</dt>
            <dd>
              {skill.usage.asTool} as tool, {skill.usage.viaGetSkill} via
              get_skill, {skill.usage.asResource} as resource,{" "}
              {skill.usage.asPrompt} as prompt
            </dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>
              {builtin ? (
                "built-in — ships with Valise, updates on deploy"
              ) : skill.source ? (
                <a
                  href={sourceUrl(skill.source)}
                  rel="noreferrer"
                  target="_blank"
                >
                  {skill.source}
                </a>
              ) : (
                "published here"
              )}
            </dd>
          </div>
          {skill.upstream ? (
            <div>
              <dt>Upstream</dt>
              <dd>
                {skill.upstream.checkedAt === null
                  ? "not checked yet"
                  : `${skill.upstream.available ? "update available" : "up to date"}, checked ${stampSeconds(skill.upstream.checkedAt)}`}
              </dd>
            </div>
          ) : null}
          {skill.upstream ? (
            <div>
              <dt>Auto-update</dt>
              <dd>
                {skill.autoUpdate
                  ? "on: the nightly check publishes upstream's changes"
                  : "off: updates wait for review"}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Last reached</dt>
            <dd>
              {skill.usage.lastSeen ? stampMs(skill.usage.lastSeen) : "never"}
            </dd>
          </div>
        </dl>
      </details>

      {skill.upstream?.available ? (
        <p className="warn">
          Upstream has changed since the import.
          {skill.autoUpdate && skill.upstream.editedHere
            ? " Auto-update is on, but holds this one until you review it."
            : ""}
          {skill.upstream.editedHere
            ? " This skill was also edited here, so publishing the update replaces that edit as the head; the edit stays in the version history."
            : ""}
        </p>
      ) : null}
      {(mutation.data?.upstreamErrors ?? upstreamErrors).length > 0 ? (
        <p role="alert">
          {(mutation.data?.upstreamErrors ?? upstreamErrors).join(" ")}
        </p>
      ) : null}
      {mutation.data?.report && mutation.data.change ? (
        <ChangeReport
          change={mutation.data.change}
          report={mutation.data.report}
        />
      ) : null}

      <div className="row skill-actions">
        {/* A link, so the editor is in the URL and opens before hydration. P3.
            A deleted skill is restored before it is edited. */}
        {skill.deleted ? null : (
          <Link className="button ghost small" preventScrollReset to={editHref}>
            <Icon name="edit" />
            Edit SKILL.md
          </Link>
        )}
        {skill.upstream ? (
          <mutation.Form method="post" onSubmit={submit} preventScrollReset>
            <ViaFetcher />
            <input name="skill" type="hidden" value={skill.name} />
            <button
              className="ghost small"
              disabled={saving}
              name="intent"
              type="submit"
              value="check-upstream"
            >
              <Icon name="refresh" />
              Check for updates
            </button>
          </mutation.Form>
        ) : null}
        {skill.upstream?.available && updateHref ? (
          <Link className="button small" preventScrollReset to={updateHref}>
            Review update
          </Link>
        ) : null}
        {skill.upstream ? (
          <mutation.Form method="post" onSubmit={submit} preventScrollReset>
            <ViaFetcher />
            <input name="intent" type="hidden" value="change" />
            <input name="skill" type="hidden" value={skill.name} />
            <BeltSwitch
              checked={skill.autoUpdate}
              disabled={saving}
              label="Auto-update"
              name="change"
              type="submit"
              value={skill.autoUpdate ? "auto-off" : "auto-on"}
            />
          </mutation.Form>
        ) : null}
        {skill.deleted ? null : <SkillEnabled detail skill={skill} />}
        <mutation.Form method="post" onSubmit={submit} preventScrollReset>
          <ViaFetcher />
          <input name="intent" type="hidden" value="change" />
          <input name="skill" type="hidden" value={skill.name} />
          {skill.deleted ? (
            <button
              className="ghost small"
              disabled={saving}
              name="change"
              type="submit"
              value="restore"
            >
              Restore skill
            </button>
          ) : (
            <>
              {/* A built-in would come back on the next deploy. */}
              {skill.source?.startsWith("builtin:") ? null : (
                <button
                  className="ghost small"
                  disabled={saving}
                  name="change"
                  type="submit"
                  value="delete"
                >
                  Delete skill
                </button>
              )}
            </>
          )}
        </mutation.Form>
        {saving ? <span role="status">Saving…</span> : null}
      </div>

      <p className="eyebrow">Bundle</p>
      {version ? (
        <FileTree
          files={version.files}
          root={{
            path: "SKILL.md",
            size: version.body.length,
            sha256: version.sha256,
          }}
        />
      ) : null}

      <p className="eyebrow">Versions</p>
      <ul className="versions">
        {skill.versions.map((row) => (
          <li key={row.version}>
            <button
              aria-pressed={row.version === showing}
              className="ghost small"
              title={`${stampSeconds(row.createdAt)} · ${row.createdBy}`}
              onClick={() => setShowing(row.version)}
              type="button"
            >
              v{row.version}
            </button>
            {row.isHead ? <Pill tone="done">head</Pill> : null}
          </li>
        ))}
      </ul>

      {version ? <VersionBody version={version} /> : null}
    </div>
  );
}

function VersionBody({ version }: { version: SkillVersionHistory }) {
  // Name is the dialog title, description is the selected version's summary.
  // Everything else is shown once and belongs to this immutable version.
  const frontmatter = Object.entries(readFrontmatter(version.body)).filter(
    ([key]) => key !== "name" && key !== "description",
  );
  const body = version.body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  return (
    <>
      {/* Not an eyebrow: that tracks out and uppercases, and a hex digest
          shouted in caps is harder to compare against one that is not. */}
      <p className="version-line">
        v{version.version} · sha256 {version.sha256.slice(0, 16)}
        {` · ${stampSeconds(version.createdAt)} · ${version.createdBy}`}
      </p>
      <div className="skill-version-body">
        <Markdown>{body}</Markdown>
        {frontmatter.length > 0 ? (
          <details className="skill-version-metadata" open>
            <summary>Version metadata</summary>
            <table
              aria-label="SKILL.md frontmatter"
              className="skill-frontmatter"
            >
              <tbody>
                {frontmatter.map(([key, value]) => (
                  <tr key={key}>
                    <th scope="row">{key}</th>
                    <td>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ) : null}
      </div>
    </>
  );
}

/** Where an imported skill's upstream can be read. */
function sourceUrl(source: string): string {
  const pinned = parseGithubSource(source);
  return pinned === null
    ? `https://www.skills.sh/${source}`
    : `https://github.com/${pinned.owner}/${pinned.repo}/tree/${pinned.sha}/${pinned.path}`;
}

/*
 * Two stamps because the schema keeps two units: `mcp_calls` is milliseconds,
 * every other table is seconds, and that is written where the columns are
 * declared. Sniffing the magnitude would work until a test inserted a date in
 * 1970.
 */

/** UTC, because a server-rendered local time mismatches on hydration. */
function stampSeconds(seconds: number): string {
  return format(seconds * 1000);
}

function stampMs(ms: number): string {
  return format(ms);
}

function format(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
}
