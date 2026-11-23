import { data, Form, Link, redirect, useNavigate } from "react-router";
import { Combobox } from "~/components/combobox";
import { AddRow, ItemList, ItemRow } from "~/components/item-list";
import { Modal } from "~/components/modal";
import { ApplicationShell, Empty, Field } from "~/components/ui";
import { SUBJECT_KINDS } from "~/concepts/memory-subjects";
import {
  requireConsoleActor,
  requireSameOriginAction,
} from "~/console/context.server";
import { waitingQuestions } from "~/console/memory-sections.server";
import { parseSubjectCreate } from "~/console/subject-forms.server";
import { MemorySections } from "~/features/memories/sections";
import type { Route } from "./+types/memory-subjects";

export async function loader({ context, request }: Route.LoaderArgs) {
  const actor = await requireConsoleActor(context, request);
  const url = new URL(request.url);
  const page = Math.max(
    1,
    Math.min(10000, Number(url.searchParams.get("page")) || 1),
  );
  return {
    ...(await actor.store.subjects.list(page)),
    waiting: await waitingQuestions(actor.store),
    page,
    creating: url.searchParams.get("create") === "subject",
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  requireSameOriginAction(request);
  const actor = await requireConsoleActor(context, request);
  const form = await request.formData();
  const input = parseSubjectCreate(form);
  const { id, created } = await actor.store.subjects.create(input);
  if (created) return redirect(`/memories/subjects/${id}`);
  // A retried or mistyped create must not make a second subject of the same name.
  return data(
    {
      error: `A subject named "${input.name}" already exists.`,
      existing: id,
      input,
    },
    { status: 409 },
  );
}

export default function Subjects({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const navigate = useNavigate();
  const refused = actionData?.error ? actionData : null;
  const list =
    loaderData.page > 1
      ? `/memories/subjects?page=${loaderData.page}`
      : "/memories/subjects";
  const here = list.includes("?") ? `${list}&` : `${list}?`;
  return (
    <ApplicationShell
      title="Memories"
      lede="Subjects group supporting memories around a current understanding. Tags remain independent."
      sections={
        <MemorySections current="subjects" waiting={loaderData.waiting} />
      }
    >
      <ItemList className="subjects" label="Subjects">
        <AddRow label="Create subject" to={`${here}create=subject`} />
        {loaderData.rows.map((subject) => (
          <ItemRow
            description={subject.description || undefined}
            href={`/memories/subjects/${subject.id}`}
            key={subject.id}
            meta={
              <>
                <span className="font-mono">{subject.kind}</span>
                <span>
                  {subject.count} {subject.count === 1 ? "memory" : "memories"}
                </span>
                <span>
                  {FRESHNESS[subject.freshness]}
                  {subject.conflicts
                    ? ` · ${subject.conflicts} conflict(s)`
                    : ""}
                </span>
              </>
            }
            title={subject.name}
          />
        ))}
      </ItemList>
      {loaderData.rows.length === 0 ? (
        <Empty>
          No subjects yet. Tags do not become subjects automatically.
        </Empty>
      ) : null}
      {loaderData.creating || refused ? (
        <Modal
          closeHref={list}
          onClose={() =>
            navigate(list, { replace: true, preventScrollReset: true })
          }
          open
          title="Create subject"
        >
          <Form
            action="/memories/subjects"
            className="stack gap-3 *:m-0"
            method="post"
          >
            {refused ? (
              <p role="alert">
                {refused.error}{" "}
                <Link to={`/memories/subjects/${refused.existing}`}>
                  Open the existing subject
                </Link>
              </p>
            ) : null}
            <Field
              defaultValue={refused?.input.name}
              label="Name"
              name="name"
              required
            />
            <Combobox
              defaultValue={refused?.input.kind ?? SUBJECT_KINDS[0]}
              label="Kind"
              name="kind"
              options={SUBJECT_KINDS.map((kind) => ({
                value: kind,
                label: kind,
              }))}
            />
            <Field
              defaultValue={refused?.input.description}
              label="Description"
              name="description"
              rows={3}
            />
            <button className="small justify-self-start" type="submit">
              Create subject
            </button>
          </Form>
        </Modal>
      ) : null}
      <nav aria-label="Subject pages">
        {loaderData.page > 1 ? (
          <Link to={`?page=${loaderData.page - 1}`}>Previous subjects</Link>
        ) : null}{" "}
        {loaderData.hasMore ? (
          <Link to={`?page=${loaderData.page + 1}`}>Next subjects</Link>
        ) : null}
      </nav>
    </ApplicationShell>
  );
}

/** The summary's state, short enough for a row's facts. */
const FRESHNESS = {
  missing: "no summary",
  "needs review": "summary needs review",
  "current against linked evidence": "summary current",
} as const;
