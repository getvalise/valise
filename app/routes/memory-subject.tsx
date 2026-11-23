import type { ReactNode } from "react";
import { data, Form, Link, useFetcher } from "react-router";
import { Combobox } from "~/components/combobox";
import {
  Editable,
  useEditMode,
  useLanded,
  ViaFetcher,
} from "~/components/editable";
import { Icon } from "~/components/icon";
import { AddRow, ItemList, ItemRow } from "~/components/item-list";
import { Markdown } from "~/components/markdown";
import { Modal } from "~/components/modal";
import { ApplicationShell, Empty, Field } from "~/components/ui";
import { SUBJECT_KINDS } from "~/concepts/memory-subjects";
import {
  requireConsoleActor,
  requireSameOriginAction,
} from "~/console/context.server";
import { afterSave } from "~/console/forms.server";
import { waitingQuestions } from "~/console/memory-sections.server";
import {
  parseSubjectAction,
  validateSubjectField,
} from "~/console/subject-forms.server";
import { MemorySections } from "~/features/memories/sections";
import type { Route } from "./+types/memory-subject";

export async function loader({ context, request, params }: Route.LoaderArgs) {
  const actor = await requireConsoleActor(context, request);
  // A deleted subject keeps its page, so the Delete control can restore it (P12).
  const subject = await actor.store.subjects.get(params.subjectId, {
    includeDeleted: true,
  });
  if (!subject) throw new Response("Subject not found.", { status: 404 });
  const url = new URL(request.url);
  const page = Math.max(
    1,
    Math.min(10000, Number(url.searchParams.get("page")) || 1),
  );
  const query = (url.searchParams.get("find") ?? "").trim().slice(0, 200);
  const tag = (url.searchParams.get("tag") ?? "").trim().slice(0, 100);
  const members = await actor.store.subjects.members(subject.id, page);
  const suggestions = subject.deletedAt
    ? { rows: [], hasMore: false }
    : await actor.store.subjects.suggestions(subject.id);
  const candidates =
    query || tag
      ? await actor.store.memories.list(
          { query, tags: tag ? [tag] : [] },
          { limit: 30, offset: 0 },
        )
      : [];
  const vocabulary = await actor.store.vocabulary();
  const edit = url.searchParams.get("edit");
  return {
    subject,
    edit: SUBJECT_FIELDS.find((field) => field === edit) ?? null,
    editingSummary: edit === "summary",
    adding: url.searchParams.get("add") === "memory",
    members,
    suggestions,
    page,
    query,
    tag,
    candidates,
    tags: vocabulary.tags,
    waiting: await waitingQuestions(actor.store),
  };
}

export async function action({ context, request, params }: Route.ActionArgs) {
  requireSameOriginAction(request);
  const actor = await requireConsoleActor(context, request);
  const form = await request.formData();
  const input = parseSubjectAction(form);
  if (input.id !== params.subjectId)
    throw new Response("Subject mismatch.", { status: 400 });
  const subject = await actor.store.subjects.get(input.id, {
    includeDeleted: true,
  });
  if (!subject) throw new Response("Subject not found.", { status: 404 });
  if (subject.deletedAt && input.intent !== "delete")
    return data(
      { error: "This subject is deleted. Restore it before changing it." },
      { status: 409 },
    );
  let changed = false;
  switch (input.intent) {
    case "edit": {
      const value = validateSubjectField(input.field, input.value);
      const taken =
        input.field === "name"
          ? await actor.store.subjects.findByName(value)
          : null;
      if (taken && taken !== subject.id)
        return data(
          { error: `Another subject is already named "${value}".` },
          { status: 409 },
        );
      changed = await actor.store.subjects.edit(input.id, input.field, value);
      break;
    }
    case "delete": {
      const deleted = input.deleted === "true";
      changed = await actor.store.subjects.setDeleted(input.id, deleted);
      if (!changed && !deleted && subject.deletedAt)
        return data(
          {
            error: `Another subject is now named "${subject.name}". Rename or delete it, then restore this one.`,
          },
          { status: 409 },
        );
      break;
    }
    case "member":
      changed = await actor.store.subjects.changeMember(
        input.id,
        input.memory.slice("memory:".length),
        input.action,
      );
      break;
    case "summary":
      changed = await actor.store.subjects.setSummary(
        input.id,
        input.memory ? input.memory.slice("memory:".length) : null,
      );
      break;
    case "new-summary":
      changed =
        (await actor.store.subjects.createSummary(subject.id, input.body)) !==
        null;
      break;
  }
  if (!changed)
    return data(
      {
        error:
          "No live subject or memory matched this change. Reload and try again.",
      },
      { status: 409 },
    );
  return afterSave(form, `/memories/subjects/${subject.id}`);
}

/**
 * One write on this page, posted through a fetcher once hydrated and as a
 * document before (P11). `onSaved` runs once a write has landed without a
 * refusal, so a modal closes on success and stays open with the reason
 * otherwise.
 */
function SubjectForm({
  action,
  className,
  onSaved,
  children,
}: {
  action: string;
  className?: string;
  onSaved?: () => void;
  children: ReactNode;
}) {
  const fetcher = useFetcher<{ error?: string }>();
  const sent = useLanded(fetcher, () => {
    if (!fetcher.data?.error) onSaved?.();
  });
  return (
    <fetcher.Form
      action={action}
      className={className}
      method="post"
      onSubmit={sent}
      preventScrollReset
    >
      <ViaFetcher />
      {children}
      {fetcher.data?.error ? <p role="alert">{fetcher.data.error}</p> : null}
    </fetcher.Form>
  );
}

export default function SubjectDetail({ loaderData }: Route.ComponentProps) {
  const {
    subject,
    members,
    suggestions,
    page,
    query,
    tag,
    candidates,
    tags,
    edit,
    editingSummary,
    adding,
  } = loaderData;
  const url = `/memories/subjects/${subject.id}`;
  const summary = useEditMode(editingSummary, url);
  const add = useEditMode(adding, url);
  // Each detail reads as text and opens its own editor in place, posting the
  // same `edit` intent the document form did (P2, P6). The pen is a link to
  // `?edit=<field>`, so with scripting off the server renders it open (P11).
  const field = (name: (typeof SUBJECT_FIELDS)[number]) => ({
    action: url,
    cancelHref: url,
    editHref: `${url}?edit=${name}`,
    editing: edit === name,
    hidden: { id: subject.id, intent: "edit", field: name },
    label: name[0].toUpperCase() + name.slice(1),
    save: "fetch" as const,
  });
  const hidden = (intent: string) => (
    <>
      <input type="hidden" name="id" value={subject.id} />
      <input type="hidden" name="intent" value={intent} />
    </>
  );
  return (
    <ApplicationShell
      title={subject.name}
      lede={`${subject.kind} · ${subject.description || "No description yet"}`}
      sections={
        <MemorySections current="subjects" waiting={loaderData.waiting} />
      }
    >
      {/* Delete and Restore are one control in one place (P12). */}
      <div className="row items-center gap-3">
        <Link to="/memories/subjects">All subjects</Link>
        <SubjectForm action={url} className="ml-auto">
          {hidden("delete")}
          <input
            type="hidden"
            name="deleted"
            value={subject.deletedAt ? "false" : "true"}
          />
          <button className="ghost small" type="submit">
            {subject.deletedAt ? "Restore subject" : "Delete subject"}
          </button>
        </SubjectForm>
      </div>
      {subject.deletedAt ? (
        <p role="status">
          Deleted {stamp(subject.deletedAt)}. It is hidden from the subject
          list, the review picker and memory pages. Its memories are unchanged.
        </p>
      ) : (
        liveSubject()
      )}
    </ApplicationShell>
  );

  // Called, not rendered as a component, so its editors keep their DOM across renders.
  function liveSubject() {
    return (
      <>
        <section aria-label="Subject details">
          <h2>Subject details</h2>
          <dl className="facts subject-facts">
            <div>
              <dt>Name</dt>
              <dd>
                <Editable {...field("name")} defaultValue={subject.name}>
                  {subject.name}
                </Editable>
              </dd>
            </div>
            <div>
              <dt>Kind</dt>
              <dd>
                <Editable
                  {...field("kind")}
                  defaultValue={subject.kind}
                  editor={
                    <Combobox
                      autoFocus
                      openOnFocus={false}
                      defaultValue={subject.kind}
                      label="Kind"
                      name="value"
                      options={SUBJECT_KINDS.map((kind) => ({
                        value: kind,
                        label: kind,
                      }))}
                    />
                  }
                >
                  {subject.kind}
                </Editable>
              </dd>
            </div>
            <div>
              <dt>Description</dt>
              <dd>
                <Editable
                  {...field("description")}
                  defaultValue={subject.description}
                  empty={subject.description ? undefined : "Add a description"}
                  multiline
                  rows={3}
                >
                  {subject.description}
                </Editable>
              </dd>
            </div>
          </dl>
        </section>
        <section aria-label="Current understanding">
          <h2>Current understanding</h2>
          <p className="muted">
            {subject.freshness}
            {subject.newestEvidence
              ? ` · latest source or membership change ${stamp(subject.newestEvidence)}`
              : ""}
          </p>
          {subject.conflicts ? (
            <p role="status">
              {subject.conflicts} confirmed source conflict(s) need human
              review; no source or summary was silently changed.
            </p>
          ) : null}
          {subject.summary ? (
            <>
              <p>
                <Link to={`/memories?open=${subject.summary.id}`}>
                  {subject.summary.title || subject.summary.id}
                </Link>{" "}
                · updated {stamp(subject.summary.updatedAt)}
              </p>
              <Markdown>{subject.summary.body}</Markdown>
            </>
          ) : (
            <Empty>No current summary.</Empty>
          )}
          {/* Text, then one line of controls: writing or picking a summary is
            more than one field, so it opens a modal (P8, P15). */}
          <div className="row subject-summary-actions">
            <Link
              className="add-value"
              onClick={summary.start}
              preventScrollReset
              to={`${url}?edit=summary`}
            >
              <Icon name={subject.summary ? "edit" : "add"} size={13} />
              {subject.summary ? "Replace summary" : "Add a summary"}
            </Link>
            {subject.summaryId ? (
              <SubjectForm action={url}>
                {hidden("summary")}
                <input type="hidden" name="memory" value="" />
                <button className="ghost small" type="submit">
                  Clear summary
                </button>
              </SubjectForm>
            ) : null}
          </div>
          <p className="muted">
            The summary is an ordinary memory with history and provenance.
            Replacing it never supersedes its sources.
          </p>
          {summary.open ? (
            <Modal
              closeHref={url}
              onClose={summary.close}
              open
              title={subject.summary ? "Replace summary" : "Add a summary"}
            >
              <div className="stack gap-6">
                <SubjectForm
                  action={url}
                  className="stack gap-3 *:m-0"
                  onSaved={summary.close}
                >
                  {hidden("new-summary")}
                  <Field
                    label="Write a new summary"
                    name="body"
                    rows={6}
                    required
                  />
                  <button className="small justify-self-start" type="submit">
                    Create summary
                  </button>
                </SubjectForm>
                <SubjectForm
                  action={url}
                  className="stack gap-3 *:m-0"
                  onSaved={summary.close}
                >
                  {hidden("summary")}
                  <Field
                    label="Or use an existing memory (memory:mem_…)"
                    name="memory"
                    required
                  />
                  <button className="small justify-self-start" type="submit">
                    Use as summary
                  </button>
                </SubjectForm>
              </div>
            </Modal>
          ) : null}
        </section>
        <section aria-label="Supporting memories">
          <h2>Supporting memories ({subject.count} confirmed)</h2>
          <ItemList label="Supporting memories">
            <AddRow
              label="Add supporting memory"
              onClick={add.start}
              to={`${url}?add=memory`}
            />
            {members.rows.map((member) => (
              <ItemRow
                description={
                  member.body.slice(0, 240) +
                  (member.body.length > 240 ? "…" : "")
                }
                href={`/memories?open=${member.id}`}
                key={member.id}
                meta={
                  <>
                    <span>{member.type}</span>
                    <span>
                      {member.sourceAgent} · {member.sourceClient}
                    </span>
                    {member.assertedBy === "model" ? (
                      <span>added by an agent</span>
                    ) : null}
                    <span>{stamp(member.createdAt)}</span>
                    <SubjectForm action={url} className="ml-auto">
                      {hidden("member")}
                      <input type="hidden" name="action" value="remove" />
                      <input type="hidden" name="memory" value={member.id} />
                      <button
                        aria-label={`Remove ${member.title || member.id} from subject`}
                        className="ghost small"
                        type="submit"
                      >
                        Remove
                      </button>
                    </SubjectForm>
                  </>
                }
                stacked
                title={member.title || member.id}
              />
            ))}
          </ItemList>
          {members.rows.length === 0 ? (
            <Empty>No supporting memories yet.</Empty>
          ) : null}
          <nav aria-label="Supporting memory pages">
            {page > 1 ? (
              <Link to={`${url}?page=${page - 1}`}>Previous memories</Link>
            ) : null}{" "}
            {members.hasMore ? (
              <Link to={`${url}?page=${page + 1}`}>Next memories</Link>
            ) : null}
          </nav>
          {add.open ? (
            <Modal
              closeHref={url}
              onClose={add.close}
              open
              size="wide"
              title="Add supporting memory"
            >
              <div className="stack gap-6">
                <Form
                  action={url}
                  className="stack gap-3 *:m-0"
                  method="get"
                  preventScrollReset
                >
                  <input type="hidden" name="add" value="memory" />
                  <Field
                    label="Find memories by title or text"
                    name="find"
                    defaultValue={query}
                  />
                  <Combobox
                    label="Filter by tag"
                    name="tag"
                    defaultValue={tag}
                    options={tags.map((value) => ({ value, label: value }))}
                    creatable
                  />
                  <button className="small justify-self-start" type="submit">
                    Find memories
                  </button>
                </Form>
                {query || tag ? (
                  candidates.length === 0 ? (
                    <Empty>No active memories match this search.</Empty>
                  ) : (
                    <>
                      <ItemList label="Matching memories">
                        {candidates.map((candidate) => (
                          <ItemRow
                            href={`/memories?open=${candidate.id}`}
                            key={candidate.id}
                            meta={
                              <>
                                <span>{candidate.type}</span>
                                <SubjectForm action={url} className="ml-auto">
                                  {hidden("member")}
                                  <input
                                    type="hidden"
                                    name="action"
                                    value="add"
                                  />
                                  <input
                                    type="hidden"
                                    name="memory"
                                    value={candidate.id}
                                  />
                                  <button className="ghost small" type="submit">
                                    Add to {subject.name}
                                  </button>
                                </SubjectForm>
                              </>
                            }
                            stacked
                            title={candidate.title || candidate.id}
                          />
                        ))}
                      </ItemList>
                      <p className="muted">
                        Showing up to 30 matches. Narrow the search to find
                        another memory.
                      </p>
                    </>
                  )
                ) : null}
              </div>
            </Modal>
          ) : null}
        </section>
        {suggestions.rows.length > 0 ? (
          <section aria-label="Suggested memories">
            <h2>Suggested</h2>
            <p className="muted">
              Memories tagged with this subject's name, or that an agent
              suggested. Nothing is a member until you add it.
            </p>
            <ItemList label="Suggested memories">
              {suggestions.rows.map((suggestion) => (
                <ItemRow
                  description={
                    suggestion.body.slice(0, 240) +
                    (suggestion.body.length > 240 ? "…" : "")
                  }
                  href={`/memories?open=${suggestion.id}`}
                  key={suggestion.id}
                  meta={
                    <>
                      <span>{suggestion.type}</span>
                      <span>{suggestion.reason}</span>
                      <span>{stamp(suggestion.createdAt)}</span>
                      <span className="row gap-2 ml-auto">
                        <SubjectForm action={url}>
                          {hidden("member")}
                          <input type="hidden" name="action" value="add" />
                          <input
                            type="hidden"
                            name="memory"
                            value={suggestion.id}
                          />
                          <button
                            aria-label={`Add ${suggestion.title} to ${subject.name}`}
                            className="small"
                            type="submit"
                          >
                            Add
                          </button>
                        </SubjectForm>
                        <SubjectForm action={url}>
                          {hidden("member")}
                          <input type="hidden" name="action" value="remove" />
                          <input
                            type="hidden"
                            name="memory"
                            value={suggestion.id}
                          />
                          <button
                            aria-label={`Dismiss ${suggestion.title}`}
                            className="ghost small"
                            type="submit"
                          >
                            Dismiss
                          </button>
                        </SubjectForm>
                      </span>
                    </>
                  }
                  stacked
                  title={suggestion.title}
                />
              ))}
            </ItemList>
            {suggestions.hasMore ? (
              <p className="muted">
                Showing the 10 newest. Add or dismiss these to see more.
              </p>
            ) : null}
          </section>
        ) : null}
      </>
    );
  }
}

const SUBJECT_FIELDS = ["name", "kind", "description"] as const;

function stamp(seconds: number) {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}
