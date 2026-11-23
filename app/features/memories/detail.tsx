import { useState } from "react";
import { Link, useFetcher, useNavigate } from "react-router";
import { AsyncPicker } from "~/components/async-picker";
import { AttachmentFiles } from "~/components/attachment-files";
import { Combobox } from "~/components/combobox";
import {
  Editable,
  editKey,
  openField,
  useLanded,
  ViaFetcher,
} from "~/components/editable";
import { Icon } from "~/components/icon";
import { offer } from "~/components/list-filters";
import { Markdown } from "~/components/markdown";
import { Modal } from "~/components/modal";
import { TagInput, TagSet } from "~/components/tag-input";
import { Pill, ProjectChip } from "~/components/ui";
import { Button } from "~/components/ui/button";
import { type Version, VersionHistory } from "~/components/version-history";
import { byline } from "~/concepts/agent-names";
import { type Attachment } from "~/concepts/attachments";
import { type ListFilters, listHref, withTag } from "~/concepts/list-filters";
import {
  type ConsoleMemory,
  type MemoryRevision,
  type MemoryUsage,
} from "~/concepts/memories";
import { MEMORY_LINK_KINDS, type MemoryLink } from "~/concepts/memory-links";
import { memoryReviewHref } from "~/concepts/memory-review-path";
import { type Vocabulary } from "~/concepts/vocabulary";

export function MemoryDetail({
  files,
  memory,
  filters,
  editing,
  revisions,
  types,
  usage,
  vocabulary,
  links,
  subjects,
  reviewCount,
  linkTargets,
}: {
  files: Attachment[];
  memory: ConsoleMemory;
  filters: ListFilters;
  editing: string | undefined;
  revisions: MemoryRevision[];
  usage: MemoryUsage;
  types: string[];
  vocabulary: Vocabulary;
  links: MemoryLink[];
  subjects: { id: string; name: string }[];
  reviewCount: number;
  linkTargets: { id: string; title: string }[];
}) {
  const archive = useFetcher<{ archiveError?: string }>();
  const [archiving, setArchiving] = useState(false);
  const landed = useLanded(archive, () => setArchiving(false));
  const navigate = useNavigate();
  const open = openField(editing, memory.id);
  const back = listHref("/memories", filters, { open: memory.id });
  const editHref = (name: string) =>
    listHref("/memories", filters, { edit: editKey(memory.id, name) });
  // A modal over the pane closes back to the pane, not the list. P3.
  const closeToPane = () =>
    navigate(back, { replace: true, preventScrollReset: true });
  const versions = memoryVersions(memory, revisions);
  const field = (name: string) => ({
    action: back,
    cancelHref: back,
    editHref: editHref(name),
    editing: open === name,
    hidden: { id: memory.id, field: name },
    save: "fetch" as const,
  });

  return (
    // One rhythm down the pane: six units between sections (V-rules, "The
    // visual language"), so no section's own margin decides the gap.
    <div className="memory-detail grid gap-6 *:m-0">
      <div className="grid gap-3 *:m-0">
        <Editable
          {...field("type")}
          defaultValue={memory.type}
          editor={
            <Combobox
              autoFocus
              openOnFocus={false}
              creatable
              defaultValue={memory.type}
              label="Type"
              name="value"
              options={offer(types)}
            />
          }
          label="Type"
        >
          <Pill tone="label">{memory.type}</Pill>
        </Editable>

        <Editable
          {...field("body")}
          className="memory-body"
          defaultValue={memory.body}
          label="Body"
          multiline
          rows={10}
        >
          <Markdown>{memory.body}</Markdown>
        </Editable>
      </div>

      <dl className="facts">
        <div>
          <dt>Project</dt>
          <dd>
            <Editable
              {...field("project")}
              defaultValue={memory.project ?? ""}
              editor={
                <Combobox
                  autoFocus
                  openOnFocus={false}
                  creatable
                  defaultValue={memory.project ?? ""}
                  label="Project"
                  name="value"
                  options={offer(vocabulary.projects)}
                />
              }
              label="Project"
            >
              {memory.project ? (
                <ProjectChip
                  href={listHref("/memories", {
                    ...filters,
                    page: undefined,
                    project: memory.project,
                  })}
                  project={memory.project}
                />
              ) : (
                "—"
              )}
            </Editable>
          </dd>
        </div>
        <div>
          <dt>Tags</dt>
          <dd>
            <Editable
              {...field("tags")}
              defaultValue={memory.tags.join(", ")}
              editor={
                <TagInput
                  autoFocus
                  defaultValue={memory.tags}
                  name="value"
                  options={vocabulary.tags}
                />
              }
              label="Tags"
              noPen
            >
              <TagSet
                action={field("tags").action}
                chipHref={(tag) => listHref("/memories", withTag(filters, tag))}
                editHref={field("tags").editHref}
                hidden={field("tags").hidden}
                options={vocabulary.tags}
                tags={memory.tags}
              />
            </Editable>
          </dd>
        </div>
        <div>
          <dt>Saved by</dt>
          <dd title={`${memory.sourceAgent} · ${memory.sourceClient}`}>
            {byline(memory.sourceAgent, memory.sourceSessionName)}
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{stamp(memory.createdAt)}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{stamp(memory.updatedAt)}</dd>
        </div>
        <div>
          <dt>Fetched</dt>
          <dd>
            {usage.fetches === 0
              ? "never, in 30 days"
              : `${usage.fetches === 1 ? "once" : `${usage.fetches} times`} in 30 days`}
          </dd>
        </div>
        <div>
          <dt>In results</dt>
          <dd>{usage.appearances} in 30 days (first ten results per search)</dd>
        </div>
        <div>
          <dt>Last fetched</dt>
          <dd>{usage.lastFetched ? stampMs(usage.lastFetched) : "—"}</dd>
        </div>
        <div>
          <dt>Id</dt>
          <dd>
            <code>{memory.id}</code>
          </dd>
        </div>
      </dl>

      {versions.length > 1 ? (
        <div>
          <VersionHistory
            closeHref={back}
            count={versions.length}
            href={editHref("history")}
            lastSavedAt={memory.updatedAt}
            onClose={closeToPane}
            open={open === "history"}
            title={memory.title || "Untitled memory"}
            // Only while open, so a closed table adds no second body to the pane.
            versions={open === "history" ? versions : []}
          />
        </div>
      ) : null}
      <p className="m-0">
        <Link
          to={memoryReviewHref(undefined, {
            memory: memory.id.slice("memory:".length),
          })}
        >
          {reviewCount
            ? `Memory review: in ${reviewCount} suggestion${reviewCount === 1 ? "" : "s"}`
            : "Memory review: check for overlaps"}
        </Link>
      </p>
      {subjects.length > 0 ? (
        <section aria-label="Subjects" className="grid gap-3 *:m-0">
          <h3>Subjects</h3>
          <ul className="log">
            {subjects.map((subject) => (
              <li key={subject.id}>
                <Link to={`/memories/subjects/${subject.id}`}>
                  {subject.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <MemoryLinks
        memory={memory}
        links={links}
        targets={linkTargets}
        action={back}
        addHref={editHref("links")}
        adding={open === "links"}
        onClose={closeToPane}
        filters={filters}
      />

      <AttachmentFiles
        addHref={editHref("files")}
        adding={open === "files"}
        back={back}
        files={files}
        id={memory.id}
        title={memory.title || "Untitled memory"}
      />

      <archive.Form
        action={back}
        className="grid justify-items-start gap-3 *:m-0"
        method="post"
        onSubmit={() => {
          setArchiving(true);
          landed();
        }}
        preventScrollReset
      >
        <ViaFetcher />
        <input name="id" type="hidden" value={memory.id} />
        <input name="intent" type="hidden" value="archive" />
        <Button disabled={archiving} size="sm" type="submit" variant="outline">
          <Icon name="archive" />
          {archiving ? "Archiving…" : "Archive memory"}
        </Button>
        {archive.data?.archiveError ? (
          <p role="alert">{archive.data.archiveError}</p>
        ) : null}
      </archive.Form>
    </div>
  );
}

/**
 * The links this memory has, then one control that opens the form for a new
 * one in a modal over the pane. The form is a URL (`?edit=<id>.links`), so it
 * opens from a link with scripting off (P3, P11), and a link that lands closes
 * it back to the pane, where the list now holds it.
 */
function MemoryLinks({
  memory,
  links,
  targets,
  action,
  addHref,
  adding,
  onClose,
  filters,
}: {
  memory: ConsoleMemory;
  links: MemoryLink[];
  targets: { id: string; title: string }[];
  action: string;
  addHref: string;
  adding: boolean;
  onClose: () => void;
  filters: ListFilters;
}) {
  const fetcher = useFetcher();
  const landed = useLanded(fetcher, onClose);
  if (links.length === 0 && targets.length === 0) return null;
  return (
    <section
      aria-label="Memory links"
      // Not the dialog: a modal centres itself on its auto margins.
      className="grid gap-3 [&>:not(dialog)]:m-0"
    >
      {links.length > 0 ? (
        <>
          <h3>Links</h3>
          <ul className="log memory-links pl-0">
            {links.map((link) => (
              <li
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
                key={link.link_id}
              >
                <p className="m-0">
                  {link.kind} ·{" "}
                  <Link to={listHref("/memories", filters, { open: link.id })}>
                    {link.title || link.id}
                  </Link>
                  {linkNote(link)}
                </p>
                <LinkControls
                  memoryId={memory.id}
                  link={link}
                  action={action}
                />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {targets.length > 0 ? (
        <>
          <Button
            asChild
            className="justify-self-start"
            size="sm"
            variant="outline"
          >
            <Link preventScrollReset to={addHref}>
              <Icon name="link" />
              Add link
            </Link>
          </Button>
          {adding ? (
            <Modal closeHref={action} onClose={onClose} open title="Add a link">
              <fetcher.Form
                action={action}
                className="grid gap-3 *:m-0"
                method="post"
                onSubmit={landed}
                preventScrollReset
              >
                <ViaFetcher />
                <input type="hidden" name="id" value={memory.id} />
                <input type="hidden" name="intent" value="memory-link" />
                <input type="hidden" name="action" value="add" />
                <label>
                  Relationship
                  <select name="kind">
                    {MEMORY_LINK_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {kind}
                      </option>
                    ))}
                  </select>
                </label>
                <AsyncPicker
                  endpoint={`/memories/targets?${new URLSearchParams({ for: memory.id })}`}
                  fallback={targets.map((target) => ({
                    value: target.id,
                    label: target.title || target.id,
                  }))}
                  label="Memory"
                  name="target"
                  placeholder="Search memories by title"
                />
                <p className="muted">
                  Supersedes points to the older claim this memory fully
                  replaces. It is the only kind that asks for confirmation,
                  because a confirmed one takes the older memory out of search.
                  Links you add here are confirmed.
                </p>
                <Button
                  className="justify-self-start"
                  disabled={fetcher.state !== "idle"}
                  size="sm"
                  type="submit"
                >
                  <Icon name="link" />
                  {fetcher.state !== "idle" ? "Adding…" : "Add link"}
                </Button>
              </fetcher.Form>
            </Modal>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/**
 * Only a confirmed supersession changes anything: it takes the older memory
 * out of search. Confirming any other kind would change only this label, so
 * it is not asked for (ADR-0012, amendment of 2026-10-26).
 */
function supersession(link: MemoryLink): boolean {
  return link.kind === "supersedes" || link.kind === "superseded-by";
}

function linkNote(link: MemoryLink): string {
  if (link.removed_at !== null) return " · removed";
  if (supersession(link))
    return link.confirmed ? " · confirmed" : " · model suggestion";
  return link.asserted_by === "model" ? " · added by an agent" : "";
}

function LinkControls({
  memoryId,
  link,
  action,
}: {
  memoryId: string;
  link: MemoryLink;
  action: string;
}) {
  const fetcher = useFetcher();
  return (
    <fetcher.Form action={action} method="post" preventScrollReset>
      <ViaFetcher />
      <input type="hidden" name="id" value={memoryId} />
      <input type="hidden" name="intent" value="memory-link" />
      <input type="hidden" name="link" value={link.link_id} />
      <fieldset
        className="flex gap-2 border-0 p-0"
        disabled={fetcher.state !== "idle"}
      >
        {link.removed_at === null && !link.confirmed && supersession(link) ? (
          <Button name="action" size="xs" value="confirm" variant="outline">
            <Icon name="check" />
            Confirm link
          </Button>
        ) : null}
        <Button
          name="action"
          size="xs"
          value={link.removed_at === null ? "remove" : "restore"}
          variant="outline"
        >
          <Icon name={link.removed_at === null ? "delete" : "restore"} />
          {link.removed_at === null ? "Remove link" : "Restore link"}
        </Button>
      </fieldset>
      {fetcher.state !== "idle" ? <p role="status">Saving…</p> : null}
    </fetcher.Form>
  );
}

/**
 * Every saved version, newest first, for `VersionHistory` (P14). A
 * `memory_revisions` row is the text an edit replaced, stamped with that
 * edit's time and author; so revision n was saved by the edit before it (or
 * by the memory's creation), and the row above the oldest is the memory as
 * it reads now.
 */
function memoryVersions(
  memory: ConsoleMemory,
  revisions: MemoryRevision[],
): Version[] {
  const oldestFirst = [...revisions].sort((a, b) => a.revision - b.revision);
  const states = [
    ...oldestFirst.map((revision, index) => {
      const before = oldestFirst[index - 1];
      return {
        id: revision.revision,
        savedAt: before?.createdAt ?? memory.createdAt,
        by: before?.createdBy ?? memory.sourceAgent,
        fields: revision,
      };
    }),
    {
      id: oldestFirst.length + 1,
      savedAt: memory.updatedAt,
      by: oldestFirst.at(-1)?.createdBy ?? memory.sourceAgent,
      fields: memory,
    },
  ];
  return states
    .map((state, index): Version => {
      const older = states[index - 1]?.fields;
      return {
        id: state.id,
        label: `v${state.id}`,
        savedAt: state.savedAt,
        by: state.by,
        current: index === states.length - 1,
        changed: older ? changedFields(older, state.fields) : [],
        content: (
          <>
            <h3>{state.fields.title || "Untitled memory"}</h3>
            <Markdown>{state.fields.body}</Markdown>
          </>
        ),
      };
    })
    .reverse();
}

type MemoryFields = Pick<
  MemoryRevision,
  "type" | "title" | "body" | "tags" | "project"
>;

function changedFields(older: MemoryFields, newer: MemoryFields): string[] {
  return [
    ["Type", older.type !== newer.type],
    ["Title", older.title !== newer.title],
    ["Body", older.body !== newer.body],
    ["Tags", older.tags.join("\u0000") !== newer.tags.join("\u0000")],
    ["Project", (older.project ?? null) !== (newer.project ?? null)],
  ]
    .filter(([, changed]) => changed)
    .map(([name]) => name as string);
}

/** UTC, because a server-rendered local time mismatches on hydration. */
function stamp(seconds: number): string {
  return stampMs(seconds * 1000);
}

/** The call log keeps milliseconds; the memory rows keep seconds. */
function stampMs(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
}
