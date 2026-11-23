import { useEffect, useState } from "react";
import { Form, redirect, useActionData } from "react-router";
import { MCP_SCOPES } from "~/auth/scopes";
import {
  AddItemLink,
  ApplicationShell,
  Card,
  Empty,
  Field,
  Pill,
} from "~/components/ui";
import { Button } from "~/components/ui/button";
import type { ClientSession } from "~/concepts/activity";
import { iosShortcutLink } from "~/concepts/ios-shortcuts";
import {
  requireConsoleActor,
  requireConsoleCredentials,
  requireSameOriginAction,
} from "~/console/context.server";
import {
  parseOAuthClientId,
  parseTokenId,
  parseTokenMint,
} from "~/console/forms.server";
import type { Route } from "./+types/connections";

export async function loader({ context, request }: Route.LoaderArgs) {
  const actor = await requireConsoleActor(context, request);
  const credentials = await requireConsoleCredentials(context, request);
  const [oauthClients, tokens, sessions] = await Promise.all([
    credentials.oauthConnections(),
    credentials.bearerTokens(),
    actor.store.activity.clientSessions(),
  ]);
  return {
    oauthClients,
    tokens,
    sessions,
    mcpUrl: actor.env.MCP_RESOURCE_URL,
    shortcutLink: iosShortcutLink(actor.env),
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  requireSameOriginAction(request);
  const credentials = await requireConsoleCredentials(context, request);
  const form = await request.formData();
  if (form.get("intent") === "revoke-oauth") {
    await credentials.revokeOAuth(parseOAuthClientId(form));
    return redirect("/connections");
  }
  if (form.get("intent") === "revoke") {
    await credentials.revokeBearer(parseTokenId(form));
    return redirect("/connections");
  }
  const notConfigured = () =>
    new Response("The token pepper is not configured.", { status: 503 });
  if (form.get("intent") === "capture") {
    // A bearer token that can only add sources, carried in the fragment so it
    // is never part of a request URL. ADR-0015, amendment of 2026-11-02.
    const capture = await credentials.mintBearer({
      label: "iPhone Shortcut",
      scopes: ["sources:write"],
    });
    if (capture === null) throw notConfigured();
    return {
      capture: `${new URL(request.url).origin}/capture#${capture.token}`,
    };
  }
  const minted = await credentials.mintBearer(parseTokenMint(form));
  if (minted === null) throw notConfigured();
  return { minted };
}

export default function Connections({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const { mcpUrl, sessions } = loaderData;
  // An OAuth call logs its client id as the principal; a bearer call logs its
  // token id as the session. That is how a session finds its connection.
  const clientNames = new Map(
    loaderData.oauthClients.map((c) => [c.clientId, c.clientName]),
  );
  const tokenLabels = new Map(
    loaderData.tokens.map((t) => [t.tokenId, t.label]),
  );
  const connectionOf = (session: ClientSession): string => {
    if (session.transport === "loopback") return "local dev";
    if (session.transport === "bearer") {
      return tokenLabels.get(session.session ?? "") ?? "deleted token";
    }
    return clientNames.get(session.principal ?? "") ?? "revoked client";
  };
  return (
    <ApplicationShell
      lede="An OAuth client approved at the consent screen holds every scope. A bearer token holds only what you tick, which is how a script gets read-only access."
      title="Connections"
    >
      <Card className="editor connect">
        <h2>Connect a client</h2>
        <p className="eyebrow">MCP endpoint</p>
        <code>{mcpUrl}</code>
        <p className="eyebrow">Claude Code plugin</p>
        <p className="muted">
          The connector plus session headers and capture hooks. Remove a
          connector you added by hand first, or every tool shows twice.
        </p>
        <pre>{`/plugin marketplace add getvalise/valise
/plugin install valise@valise`}</pre>
        <p className="muted">
          The plugin connects to the hosted endpoint unless{" "}
          <code>VALISE_MCP_URL</code> names another. For this deployment:
        </p>
        <pre>{`export VALISE_MCP_URL=${mcpUrl}`}</pre>
        <p className="eyebrow">Any other MCP client</p>
        <pre>{`claude mcp add --transport http valise ${mcpUrl}
codex mcp add valise --url ${mcpUrl}`}</pre>
        <CaptureShortcut
          captureUrl={actionData?.capture ?? null}
          shortcutLink={loaderData.shortcutLink}
        />
      </Card>

      <section>
        <h2 className="eyebrow">Sessions, last 7 days</h2>
        {sessions.length === 0 ? (
          <Empty>No client has called this week.</Empty>
        ) : (
          <SessionTable connectionOf={connectionOf} sessions={sessions} />
        )}
      </section>

      <Card className="editor">
        <h2 id="new-token" tabIndex={-1}>
          New bearer token
        </h2>
        <Form className="stack" method="post">
          <Field label="Label" name="label" required />
          <fieldset>
            <legend>Scopes</legend>
            {MCP_SCOPES.map((scope) => (
              <label className="check" key={scope}>
                <input name="scope" type="checkbox" value={scope} />
                {scope}
              </label>
            ))}
          </fieldset>
          <div className="row">
            <button type="submit">Create token</button>
          </div>
        </Form>
        {actionData?.minted ? (
          <section className="token-reveal">
            <p className="eyebrow">Shown once</p>
            <p>Copy this token now. It cannot be shown again.</p>
            <code>{actionData.minted.token}</code>
          </section>
        ) : null}
      </Card>

      <section>
        <h2 className="eyebrow">OAuth clients</h2>
        {loaderData.oauthClients.length === 0 ? (
          <Empty>No OAuth client has an active connection.</Empty>
        ) : (
          <ul className="card-list">
            {loaderData.oauthClients.map((client) => (
              <Card as="li" className="todo-card" key={client.clientId}>
                <Pill tone="done">connected</Pill>
                <h3>{client.clientName}</h3>
                <ul className="tags">
                  {client.scopes.map((scope) => (
                    <li className="tag" key={scope}>
                      {scope}
                    </li>
                  ))}
                </ul>
                {client.redirectUris.length ? (
                  <p className="muted">{client.redirectUris.join(", ")}</p>
                ) : null}
                <Form method="post">
                  <input name="id" type="hidden" value={client.clientId} />
                  <input name="intent" type="hidden" value="revoke-oauth" />
                  <button className="danger small" type="submit">
                    Revoke OAuth connection
                  </button>
                </Form>
              </Card>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="eyebrow">Bearer tokens</h2>
        {loaderData.tokens.length === 0 ? (
          <Empty>No bearer tokens exist yet.</Empty>
        ) : null}
        <ul className="card-list">
          {loaderData.tokens.map((token) => (
            <Card as="li" className="todo-card" key={token.tokenId}>
              <Pill tone={token.revokedAt === null ? "done" : "blocked"}>
                {token.revokedAt === null ? "active" : "revoked"}
              </Pill>
              <h3>{token.label}</h3>
              <ul className="tags">
                {token.scopes.map((scope) => (
                  <li className="tag" key={scope}>
                    {scope}
                  </li>
                ))}
              </ul>
              {token.revokedAt === null ? (
                <Form method="post">
                  <input name="intent" type="hidden" value="revoke" />
                  <input name="id" type="hidden" value={token.tokenId} />
                  <button className="danger small" type="submit">
                    Revoke token
                  </button>
                </Form>
              ) : null}
            </Card>
          ))}
          <li className="add-item-card">
            <AddItemLink label="Create bearer token" to="#new-token" />
          </li>
        </ul>
      </section>
    </ApplicationShell>
  );
}

/**
 * Save from the iPhone share sheet: one capture URL per device, pasted once
 * into the Shortcut's install question. Create is a form button and the URL
 * is select-all text, so both work before hydration; Copy is the hydrated
 * shortcut over that select (P11).
 */
function CaptureShortcut({
  captureUrl,
  shortcutLink,
}: {
  captureUrl: string | null;
  shortcutLink: string | null;
}) {
  return (
    <>
      <p className="eyebrow">iPhone share sheet</p>
      <p className="muted">
        Share a page from Safari to Valise Capture and it is in Library, with
        the article when the site needs your login. Nothing opens and nothing
        asks again after the first save.
      </p>
      {captureUrl ? (
        <section className="token-reveal" aria-label="Capture URL">
          <p className="eyebrow">Shown once</p>
          <p>
            Your capture URL. Anyone holding it can add to your Library, so keep
            it to the Shortcut; revoke it below as iPhone Shortcut.
          </p>
          <code className="select-all">{captureUrl}</code>
          <CopyButton value={captureUrl} />
          <div className="row">
            {shortcutLink ? (
              <Button asChild>
                <a href={shortcutLink}>Add Shortcut</a>
              </Button>
            ) : (
              <p className="muted">
                This install offers no Capture Shortcut link, so there is
                nothing to add. This capture URL keeps working until you revoke
                it.
              </p>
            )}
          </div>
          <p>
            When the Shortcut asks for your capture URL, paste what you just
            copied.
          </p>
        </section>
      ) : (
        <Form method="post">
          <input name="intent" type="hidden" value="capture" />
          <Button size="sm" type="submit" variant="outline">
            Create capture URL
          </Button>
        </Form>
      )}
    </>
  );
}

/** Rendered once hydrated: without script the URL is select-all text. */
function CopyButton({ value }: { value: string }) {
  const [hydrated, setHydrated] = useState(false);
  const [copied, setCopied] = useState<boolean | null>(null);
  useEffect(() => setHydrated(true), []);
  if (!hydrated) return null;
  async function copy() {
    try {
      const { navigator } = globalThis as unknown as {
        navigator: { clipboard: { writeText(text: string): Promise<void> } };
      };
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="row">
      <Button onClick={copy} size="sm" type="button" variant="outline">
        {copied ? "Copied" : "Copy"}
      </Button>
      {copied === false ? (
        <p className="muted" role="status">
          Copy was refused. Tap the URL to select it, then copy.
        </p>
      ) : null}
    </div>
  );
}

/** Rows shown before the rest fold away; a busy week is hundreds. */
const SESSIONS_SHOWN = 25;

/**
 * One row per session that called this week. Everything but the connection
 * is what the client said about itself, so it labels and proves nothing.
 */
function SessionTable({
  sessions,
  connectionOf,
}: {
  sessions: ClientSession[];
  connectionOf: (session: ClientSession) => string;
}) {
  const rest = sessions.slice(SESSIONS_SHOWN);
  return (
    <>
      <SessionRows
        connectionOf={connectionOf}
        sessions={sessions.slice(0, SESSIONS_SHOWN)}
      />
      {rest.length > 0 ? (
        <details>
          <summary>{rest.length} more</summary>
          <SessionRows connectionOf={connectionOf} sessions={rest} />
        </details>
      ) : null}
    </>
  );
}

function SessionRows({
  sessions,
  connectionOf,
}: {
  sessions: ClientSession[];
  connectionOf: (session: ClientSession) => string;
}) {
  return (
    <div className="scroll-x">
      <table className="dense">
        <tbody>
          <tr>
            <th>Session</th>
            <th>Client</th>
            <th>Host</th>
            <th>Plugin</th>
            <th>Connection</th>
            <th>Last seen</th>
            <th>Tool calls</th>
          </tr>
          {sessions.map((session) => (
            <tr
              key={`${session.transport}:${session.principal}:${session.session}:${session.clientInfo}:${session.userAgent}`}
            >
              <td title={session.session ?? undefined}>
                {session.sessionName ?? shortId(session.session)}
              </td>
              <td title={session.userAgent ?? undefined}>
                {session.clientInfo ?? session.userAgent ?? "—"}
              </td>
              <td>{session.host ?? "—"}</td>
              <td>
                {session.plugin ? (
                  <Pill tone="label">{session.plugin}</Pill>
                ) : (
                  <span className="muted">none</span>
                )}
              </td>
              <td>{connectionOf(session)}</td>
              <td>{stamp(session.lastSeen)}</td>
              <td>{session.toolCalls}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A session id is a UUID; its first block is enough to tell rows apart. */
function shortId(id: string | null): string {
  return id === null ? "—" : id.split(/[-@]/)[0];
}

/** UTC, because a server-rendered local time mismatches on hydration. */
function stamp(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
}
