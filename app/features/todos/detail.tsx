import { useState } from "react";
import { AttachmentFiles } from "~/components/attachment-files";
import { Combobox } from "~/components/combobox";
import {
  Editable,
  EditLink,
  EditOnClick,
  useEditable,
  ViaFetcher,
} from "~/components/editable";
import { Icon } from "~/components/icon";
import { LeaseCountdown } from "~/components/lease-countdown";
import { offer } from "~/components/list-filters";
import { Markdown } from "~/components/markdown";
import { Modal } from "~/components/modal";
import { QuickAddInput } from "~/components/quick-add";
import {
  asksToReconcile,
  TodoRelationSection,
} from "~/components/todo-relations";
import { ProjectChip } from "~/components/ui";
import { clientName } from "~/concepts/agent-names";
import { listHref } from "~/concepts/list-filters";
import { type QuickAddVocabulary } from "~/concepts/quick-add";

import { AddSubtask } from "./checklist";
import { TodoNavigation, type TodoNeighbors } from "./navigation";
import { RefSet } from "./pointers";
import { Byline, StatusLine, TodoProgressThread } from "./progress-thread";
import { Blocker, CompleteBox } from "./state-controls";
import type { TodoCardView } from "./types";

export function TodoDetail({
  view,
  detailOnly,
  onClose,
  onFiles,
  neighbors,
}: {
  view: TodoCardView;
  detailOnly: boolean;
  onClose: () => void;
  onFiles: (files: File[], target: unknown) => void;
  neighbors: TodoNeighbors;
}) {
  const {
    todo,
    filters,
    now,
    title,
    body,
    project,
    state,
    done,
    here,
    tags,
    field,
    open,
    stateForm,
    stateAnswer,
    relationOptions,
    tickForm: TickForm,
    sendState,
    blockNote,
    shown,
    vocabulary,
  } = view;
  const stateError =
    stateAnswer?.stateId === todo.id ? stateAnswer.stateError : undefined;
  return (
    <Modal
      heading={
        // The same circle as the row, before the title: completing is a
        // property of the to-do, not a separate action in the body (P1).
        <div className="todo-pane-heading">
          <CompleteBox
            done={done}
            filters={filters}
            form={stateForm}
            onSubmit={sendState}
            todo={todo}
          />
          <Editable
            {...field("title")}
            className="todo-title"
            defaultValue={title}
            editor={
              <TitleEditor defaultValue={title} vocabulary={vocabulary} />
            }
            label="Title"
            saveOnBlur
          >
            {/* The title is the pen's target too, so a click on the text
                  edits it (P1). Out of the tab order: the pen is the
                  keyboard's stop. */}
            <h2>
              <EditLink
                className="todo-title-edit"
                tabIndex={-1}
                to={field("title").editHref}
              >
                {title}
              </EditLink>
            </h2>
          </Editable>
        </div>
      }
      onClose={onClose}
      closeHref={view.closed}
      mobileSheet
      headerActions={<TodoNavigation {...neighbors} />}
      onFiles={onFiles}
      open
      size="pane"
      title={title}
    >
      {/* One rhythm down the pane: six units between groups, three between
          the controls inside one ("The visual language"). */}
      <div className="todo-detail grid gap-6 *:m-0">
        <div className="grid gap-3 *:m-0">
          <StatusLine now={now} updates={todo.updates} />
          {/* Block and Unblock sit under the status they change, so a
              blocked to-do's way out is at the top, not under its history. */}
          <Blocker
            back={here}
            filters={filters}
            form={stateForm}
            note={blockNote}
            onSubmit={sendState}
            open={open === "state"}
            state={state}
            todo={todo}
          />
          {detailOnly ? <div className="todo-tags">{tags}</div> : null}
          {stateError ? <p role="alert">{stateError}</p> : null}

          <Editable
            {...field("body")}
            className="todo-body"
            defaultValue={body}
            empty={body ? undefined : "Add a description"}
            label="Body"
            multiline
            placeholder={"What done looks like.\n\n- [ ] first step"}
            rows={8}
            saveOnBlur
          >
            <EditOnClick>
              {/* Its own form: the checkboxes inside post a line, and a
                    form nested in the editor's form is not markup. */}
              <TickForm action={here} method="post" preventScrollReset>
                <ViaFetcher />
                <input name="intent" type="hidden" value="toggle-task" />
                <input name="id" type="hidden" value={todo.id} />
                <Markdown tasks={{ name: "task" }}>{shown}</Markdown>
              </TickForm>
            </EditOnClick>
          </Editable>

          <AddSubtask
            back={here}
            filters={filters}
            open={open === "subtask"}
            todoId={todo.id}
          />
        </div>

        <RefSet
          action={here}
          adding={open === "refs"}
          editHref={field("refs").editHref}
          hidden={field("refs").hidden}
          refs={todo.refs}
        />

        <AttachmentFiles
          back={here}
          id={todo.id}
          title={todo.title}
          files={todo.files}
          addHref={field("files").editHref}
          adding={open === "files"}
        />

        <TodoRelationSection
          addHref={field("relation").editHref}
          adding={open === "relation"}
          back={here}
          id={todo.id}
          options={relationOptions}
          recover={asksToReconcile(stateError, todo.blockedOn)}
          relations={todo.relations}
        />

        <dl className="facts">
          <div>
            <dt>Project</dt>
            <dd>
              <Editable
                {...field("project")}
                defaultValue={project ?? ""}
                editor={
                  <Combobox
                    autoFocus
                    creatable
                    defaultValue={project ?? ""}
                    label="Project"
                    name="value"
                    openOnFocus={false}
                    options={offer(vocabulary.projects)}
                  />
                }
                empty={project ? undefined : "Add a project"}
                label="Project"
              >
                {/* A span, as the held copy under the editor is: the chip
                    then sits on the same line box open or closed (P6). */}
                {project ? (
                  <span>
                    <ProjectChip
                      href={listHref("/todos", {
                        ...filters,
                        page: undefined,
                        project,
                      })}
                      preventScrollReset
                      project={project}
                    />
                  </span>
                ) : null}
              </Editable>
            </dd>
          </div>
          <div>
            <dt>Opened by</dt>
            <dd>
              <Byline
                agent={todo.sourceAgent}
                sessionName={todo.sourceSessionName}
                via={todo.sourceClient}
              />
            </dd>
          </div>
          <div>
            <dt>Claim holder</dt>
            <dd className="with-icon" title={todo.leaseHolder ?? undefined}>
              {/* A buckled latch or one come apart: the shape says it
                      before the words do, and the words still say it. */}
              <Icon name={todo.leaseHolder ? "claimed" : "released"} />
              {todo.leaseHolder ? clientName(todo.leaseHolder) : "Unclaimed"}
            </dd>
          </div>
          <div>
            <dt>Lease</dt>
            <dd className="with-icon">
              <Icon name="lease" />
              <LeaseCountdown
                expiresAt={todo.leaseExpiresAt}
                initialSeconds={Math.max(0, (todo.leaseExpiresAt ?? now) - now)}
              />
            </dd>
          </div>
          <div>
            <dt>Fencing token</dt>
            <dd>
              <code>{todo.fencingToken}</code>
            </dd>
          </div>
        </dl>

        <div className="grid gap-3 *:m-0">
          <TodoProgressThread back={here} now={now} todo={todo} />
        </div>
      </div>
    </Modal>
  );
}

/**
 * The title takes the composer's line: words stay the title, `key:value` and
 * `#tag` join the tags, and `@name` or `project:` moves the to-do. The server
 * parses the same way, so with scripting off the posted line means the same
 * thing.
 */
function TitleEditor({
  defaultValue,
  vocabulary,
}: {
  defaultValue: string;
  vocabulary: QuickAddVocabulary;
}) {
  const editable = useEditable();
  const [text, setText] = useState(defaultValue);
  return (
    <QuickAddInput
      autoFocus
      label="Title"
      name="value"
      onEscape={() => editable?.close()}
      onValueChange={setText}
      value={text}
      vocabulary={vocabulary}
    />
  );
}
