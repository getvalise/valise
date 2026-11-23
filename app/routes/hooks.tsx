import { data, Form, redirect, useActionData } from "react-router";
import { BeltSwitch } from "~/components/belt-switch";
import { Editable, editKey, openField } from "~/components/editable";
import { ApplicationShell, Card, Empty, Pill } from "~/components/ui";
import {
  editHookConfig,
  HOOK_EVENTS,
  type HookEntry,
  type HookEvent,
  hookEntries,
  MAX_HOOK_TEXT_LENGTH,
} from "~/concepts/hook-config";
import {
  requireConsoleActor,
  requireSameOriginAction,
} from "~/console/context.server";
import { parseHookConfigEdit } from "~/console/forms.server";
import type { Route } from "./+types/hooks";

/**
 * The text a hook injects, stored here and cached by every machine whose hook
 * holds a `config:read` token. Each field saves on its own (P2), and the
 * document keeps only what differs from the shipped defaults.
 */

const EVENT_HEADINGS: Record<HookEvent, string> = {
  SessionStart: "At session start",
  Stop: "When the model stops",
  PostToolUseFailure: "When a shell command fails",
};

/** What each event buys, so its token cost below has something to weigh against. */
const EVENT_PURPOSES: Record<HookEvent, string> = {
  SessionStart:
    "Runs once per session, so the agent searches decisions and skills before it re-derives them. Every connected client also receives it as server instructions, ChatGPT after its connector is refreshed.",
  Stop: "Runs when the model stops: on the first turn, then once per set number of turns, so decisions and dead ends get saved before the session ends. A client without the hooks, such as ChatGPT, receives it as a standing rule in the server instructions.",
  PostToolUseFailure:
    "Runs after each failed shell command, so a recurring error gets fixed from a stored memory instead of being debugged again. A search it prompts adds its results on top. A client without the hooks receives it as a standing rule in the server instructions.",
};

export async function loader({ context, request }: Route.LoaderArgs) {
  const actor = await requireConsoleActor(context, request);
  const { document, updatedAt } = await actor.store.hooks.read();
  return {
    document,
    updatedAt,
    read: hookEntries(document),
    endpoint: new URL("/config/hooks", request.url).href,
    editing: new URL(request.url).searchParams.get("edit") ?? undefined,
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  requireSameOriginAction(request);
  const actor = await requireConsoleActor(context, request);
  const edit = parseHookConfigEdit(await request.formData());
  const { document } = await actor.store.hooks.read();
  const edited = editHookConfig(document, edit);
  if ("error" in edited) {
    return data({ error: edited.error }, { status: 400 });
  }
  await actor.store.hooks.write(edited.document);
  return redirect("/hooks");
}

export default function Hooks({ loaderData }: Route.ComponentProps) {
  const refused = useActionData<typeof action>();
  const { read, editing, endpoint, document } = loaderData;
  return (
    <ApplicationShell
      lede="What your hooks add to a session. A hook holding a config:read token picks up a change here within ten minutes."
      title="Hooks"
    >
      {refused ? <p role="alert">{refused.error}</p> : null}

      {"error" in read ? (
        <Empty>
          The stored document is one the hook would refuse: {read.error}.
        </Empty>
      ) : (
        HOOK_EVENTS.map((event) => (
          <EventSection
            editing={editing}
            entries={read.entries.filter((entry) => entry.event === event)}
            event={event}
            key={event}
          />
        ))
      )}

      <Card className="editor">
        <h2>Reach a session</h2>
        <p>
          SessionStart entries reach every client as MCP server instructions.
          The Claude Code plugin's failed-command hook asks Valise over its own
          sign-in, so Recall on error and PostToolUseFailure entries apply as
          saved here. Stop entries reach the plugin's hook only from{" "}
          <code>~/.valise/config.json</code> on each machine; the plugin no
          longer syncs that file from here.
        </p>
        <p className="eyebrow">Endpoint</p>
        <code>{endpoint}</code>
        <p className="eyebrow">Stored document</p>
        <pre>{document}</pre>
      </Card>
    </ApplicationShell>
  );
}

function EventSection({
  event,
  entries,
  editing,
}: {
  event: HookEvent;
  entries: HookEntry[];
  editing: string | undefined;
}) {
  const addId = `new-${event.toLowerCase()}`;
  return (
    <section>
      <h2 className="eyebrow">
        {EVENT_HEADINGS[event]} <code>{event}</code>
      </h2>
      <p className="muted">{EVENT_PURPOSES[event]}</p>
      <ul className="card-list">
        {entries.map((entry) => (
          <EntryCard editing={editing} entry={entry} key={entry.id} />
        ))}
        <li className="add-item-card">
          <Editable
            addItem
            action="/hooks"
            cancelHref="/hooks"
            defaultValue=""
            editHref={`/hooks?edit=${editKey(addId, "text")}`}
            editing={openField(editing, addId) === "text"}
            empty={`Add a ${event} entry`}
            hidden={{ intent: "add", event }}
            label={`New ${event} text`}
            multiline
            placeholder={`At most ${MAX_HOOK_TEXT_LENGTH} characters.`}
          />
        </li>
      </ul>
    </section>
  );
}

function EntryCard({
  entry,
  editing,
}: {
  entry: HookEntry;
  editing: string | undefined;
}) {
  const open = openField(editing, entry.id);
  const customNumber = entry.shipped
    ? null
    : Number(entry.id.slice("custom-".length)) + 1;
  const name = entry.shipped ? entry.label : `Custom entry ${customNumber}`;
  return (
    <Card as="li" className="todo-card">
      <h3>
        {name} {entry.enabled ? null : <Pill tone="label">off</Pill>}
      </h3>
      <Editable
        action="/hooks"
        cancelHref="/hooks"
        defaultValue={entry.text}
        editHref={`/hooks?edit=${editKey(entry.id, "text")}`}
        editing={open === "text"}
        hidden={{ intent: "text", id: entry.id }}
        label={`${name} text`}
        multiline
      >
        <p>{entry.text}</p>
      </Editable>
      {/* Four characters a token is close enough for English prose. */}
      <p className="muted">
        About {Math.ceil(entry.text.length / 4)} tokens each time it runs
      </p>
      {entry.everyTurns === null ? null : (
        <Editable
          action="/hooks"
          cancelHref="/hooks"
          defaultValue={String(entry.everyTurns)}
          editHref={`/hooks?edit=${editKey(entry.id, "every")}`}
          editing={open === "every"}
          hidden={{ intent: "every-turns", id: entry.id }}
          label={`${name} turns between`}
        >
          <p className="muted">
            Every{" "}
            {entry.everyTurns === 1 ? "turn" : `${entry.everyTurns} turns`}
          </p>
        </Editable>
      )}
      <div className="row">
        <Form action="/hooks" method="post" preventScrollReset>
          <input name="intent" type="hidden" value="enabled" />
          <input name="id" type="hidden" value={entry.id} />
          <input
            name="enable"
            type="hidden"
            value={entry.enabled ? "off" : "on"}
          />
          <BeltSwitch
            checked={entry.enabled}
            label={`${name} enabled`}
            type="submit"
          />
        </Form>
        {entry.defaultText !== null && entry.text !== entry.defaultText ? (
          <Form action="/hooks" method="post" preventScrollReset>
            <input name="intent" type="hidden" value="text" />
            <input name="id" type="hidden" value={entry.id} />
            <input name="value" type="hidden" value={entry.defaultText} />
            <button className="ghost small" type="submit">
              Use the shipped text
            </button>
          </Form>
        ) : null}
        {entry.shipped ? null : (
          <Form action="/hooks" method="post" preventScrollReset>
            <input name="intent" type="hidden" value="remove" />
            <input name="id" type="hidden" value={entry.id} />
            <button className="ghost small" type="submit">
              Remove {name}
            </button>
          </Form>
        )}
      </div>
    </Card>
  );
}
