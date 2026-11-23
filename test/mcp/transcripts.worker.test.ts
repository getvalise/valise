import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { mintBearerToken } from "~/concepts/tokens";

/**
 * `/transcripts` behind the OAuth provider: the CLI's grant with
 * `transcripts:write` appends, a grant without it is refused, a console
 * bearer token with the scope works the same, and what was written is
 * reachable through `fetch` and `search` with `type: transcript`. ADR-0022.
 */

const REDIRECT = "http://127.0.0.1:4567/callback";
const PEPPER = "local-test-token-pepper";

afterEach(async () => {
  for (const table of [
    "search_docs",
    "transcript_turns",
    "transcripts",
    "mcp_calls",
    "bearer_token_grants",
    "bearer_token_scopes",
    "bearer_tokens",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  const listed = await env.BUNDLES.list();
  if (listed.objects.length)
    await env.BUNDLES.delete(listed.objects.map((object) => object.key));
});

const body = {
  client: "claude-code",
  device: "laptop",
  session_id: "a4d6c2b0-0000-4000-8000-000000000002",
  cwd: "/Users/me/code/valise",
  project: "valise",
  from: 0,
  turns: [
    { kind: "human", text: "Please find the hedgerow flake.", at: 1700000000 },
    { kind: "tool_call", tool_name: "Bash", text: "npm run verify" },
    { kind: "api_error", text: "529 overloaded_error, request id req_123" },
    { kind: "assistant", text: "Done." },
  ],
};

describe("POST and GET /transcripts", () => {
  it("appends under a CLI grant, refuses without the scope, and reads back through MCP", async () => {
    const cli = await grant("search:read transcripts:write transcripts:read");
    const written = await post(cli, body);
    expect(written.status, await written.clone().text()).toBe(200);
    const first = await written.json<{
      id: string;
      turn_count: number;
      chain_hash: string;
      appended: number;
    }>();
    expect(first).toMatchObject({ turn_count: 4, appended: 4 });
    expect(first.id).toMatch(/^transcript:trn_/);

    // The server's state, for a writer that lost its answer.
    const state = await SELF.fetch(
      `http://localhost/mcp/transcripts?client=claude-code&device=laptop&session=${body.session_id}`,
      { headers: { authorization: `Bearer ${cli}`, host: "localhost" } },
    );
    expect(state.status).toBe(200);
    const held = await state.json<{ turn_count: number; hashes: string[] }>();
    expect(held.turn_count).toBe(4);
    expect(held.hashes).toHaveLength(4);

    // A diverged resend answers 409 with the held hashes.
    const diverged = await post(cli, {
      ...body,
      from: 2,
      turns: [{ kind: "assistant", text: "not what was held" }],
    });
    expect(diverged.status).toBe(409);
    expect(await diverged.json()).toMatchObject({
      error: "conflict",
      turn_count: 4,
      hashes: held.hashes,
    });

    // Nonsense is a 400 with the reason.
    const refused = await post(cli, { ...body, from: 0, turns: [] });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "invalid_transcript" });

    // fetch returns the distilled text; search finds it by type only.
    const fetched = await mcp("fetch", { id: first.id }, cli);
    expect(fetched.status, await fetched.clone().text()).toBe(200);
    const document = await structured<{
      title: string;
      text: string;
      metadata: Record<string, unknown>;
    }>(fetched);
    expect(document.title).toBe("Please find the hedgerow flake.");
    expect(document.text).toContain("Tool Bash: npm run verify");
    expect(document.text).toContain("API error: 529 overloaded_error");
    expect(document.metadata).toMatchObject({
      client: "claude-code",
      device: "laptop",
      turn_count: 4,
    });
    const found = await mcp(
      "search",
      { query: "hedgerow", type: "transcript" },
      cli,
    );
    expect(found.status).toBe(200);
    const results = await structured<{ results: { id: string }[] }>(found);
    expect(results.results.map((hit) => hit.id)).toEqual([first.id]);
    const broad = await mcp("search", { query: "hedgerow" }, cli);
    expect(
      (await structured<{ results: { id: string }[] }>(broad)).results,
    ).toEqual([]);

    // A writer whose history differs partway replaces the held tail.
    const phone = { ...body, device: "phone" };
    expect((await post(cli, phone)).status).toBe(200);
    const replaced = await post(cli, {
      ...phone,
      from: 2,
      replace: true,
      turns: [{ kind: "assistant", text: "what this machine has" }],
    });
    expect(replaced.status, await replaced.clone().text()).toBe(200);
    expect(await replaced.json()).toMatchObject({ turn_count: 3, appended: 1 });

    // A grant that named other scopes, and so holds only those, cannot
    // write or read; naming search:read alone would be the whole case.
    const reader = await grant("search:read todos:read");
    expect((await post(reader, body)).status).toBe(403);
    const peek = await SELF.fetch(
      "http://localhost/mcp/transcripts?client=claude-code&device=laptop&session=x",
      { headers: { authorization: `Bearer ${reader}`, host: "localhost" } },
    );
    expect(peek.status).toBe(403);
    expect(peek.headers.get("www-authenticate")).toContain("transcripts:read");
    expect((await post("not-a-token", body)).status).toBe(401);
  });

  it("fetches one message with its neighbours, and pages through the rest", async () => {
    const cli = await grant("search:read transcripts:write transcripts:read");
    const turns = Array.from({ length: 30 }, (_, i) => ({
      kind: i % 2 ? "assistant" : "human",
      text: `Turn ${i}`,
      at: 1700000000 + i * 60,
    }));
    turns[3] = {
      kind: "human",
      text: "<task-notification><status>completed</status><summary>verify passed</summary></task-notification>",
      at: 1700000180,
    };
    const written = await post(cli, {
      ...body,
      session_id: "a4d6c2b0-0000-4000-8000-000000000030",
      turns,
    });
    const { id } = await written.json<{ id: string }>();
    type Page = {
      id: string;
      text: string;
      url?: string;
      prev_cursor: string | null;
      next_cursor: string | null;
      metadata: Record<string, unknown>;
    };
    const fetchPage = async (args: Record<string, unknown>) =>
      structured<Page>(await mcp("fetch", args, cli));

    // A message link: that turn, marked, with five either side.
    const around = await fetchPage({ id: `${id}#t-15` });
    const lines = around.text.split("\n");
    expect(lines).toHaveLength(11);
    expect(lines[0]).toMatch(/^\[t-10 \d\d:\d\d\] Human: Turn 10$/);
    expect(lines[5]).toMatch(/^→ \[t-15 \d\d:\d\d\] Assistant: Turn 15$/);
    expect(around).toMatchObject({
      id: `${id}#t-15`,
      prev_cursor: "t-0",
      next_cursor: "t-21",
      metadata: {
        message: "t-15",
        turns_shown: "t-10 to t-20",
        turn_count: 30,
      },
    });

    // fetch links back to the message in the console pane.
    expect(around.url).toBe(
      `http://localhost/activity/transcripts?open=${encodeURIComponent(id)}#t-15`,
    );
    // The console link a person pastes reads the same.
    const pasted = await fetchPage({
      id: `https://app.valise.run/activity/transcripts?open=${encodeURIComponent(id)}#t-15`,
    });
    expect(pasted.text).toBe(around.text);

    // Paging on from the window, and from the top of a bare id.
    const next = await fetchPage({ id: `${id}#t-15`, cursor: "t-21" });
    expect(next.text.split("\n")[0]).toContain("[t-21");
    expect(next.next_cursor).toBeNull();
    const top = await fetchPage({ id, limit: 5 });
    expect(top.text.split("\n")).toHaveLength(5);
    expect(top).toMatchObject({ prev_cursor: null, next_cursor: "t-5" });
    // A turn the client wrote reads as an event, not as the person.
    expect(top.text).toMatch(
      /^\[t-3 \d\d:\d\d\] Event: Background task: verify passed$/m,
    );

    const bad = await mcp("fetch", { id, cursor: "page-2" }, cli);
    expect(await bad.text()).toContain("is not a next_cursor or prev_cursor");
  });

  it("takes a console-minted bearer token holding the scope", async () => {
    const minted = await mintBearerToken(
      { DB: env.DB, TOKEN_PEPPER: PEPPER },
      {
        userId: "local",
        label: "laptop import",
        scopes: ["transcripts:write"],
      },
    );
    const written = await post(minted.token, { ...body, device: "desktop" });
    expect(written.status, await written.clone().text()).toBe(200);
    const row = await env.DB.prepare(
      "SELECT source_agent AS agent, source_client AS client FROM transcripts",
    ).first<{ agent: string; client: string }>();
    expect(row).toEqual({ agent: "laptop import", client: "bearer" });
    const narrow = await mintBearerToken(
      { DB: env.DB, TOKEN_PEPPER: PEPPER },
      { userId: "local", label: "reader", scopes: ["search:read"] },
    );
    expect((await post(narrow.token, body)).status).toBe(403);
  });
});

function post(token: string, payload: unknown): Promise<Response> {
  return SELF.fetch("http://localhost/mcp/transcripts", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      host: "localhost",
    },
    body: JSON.stringify(payload),
  });
}

function mcp(
  name: string,
  args: Record<string, unknown>,
  accessToken: string,
): Promise<Response> {
  return SELF.fetch("http://localhost/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      host: "localhost",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
}

async function structured<T>(response: Response): Promise<T> {
  const raw = await response.text();
  const line = raw
    .split("\n")
    .find((l) => l.startsWith("data:"))
    ?.slice("data:".length)
    .trim();
  const parsed = JSON.parse(line || raw);
  expect(parsed.result?.isError, raw).not.toBe(true);
  return parsed.result.structuredContent as T;
}

/** One consent for a loopback client asking for `scope`; the access token. */
async function grant(scope: string): Promise<string> {
  const registered = await SELF.fetch("http://localhost/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Valise CLI test",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(registered.status).toBe(201);
  const client = await registered.json<{ client_id: string }>();
  const verifier = "t".repeat(64);
  const authorize = new URL("http://localhost/authorize");
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    scope,
    resource: "http://localhost/mcp",
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
    state: "cli-state",
  }).toString();
  const consent = await SELF.fetch(authorize);
  expect(consent.status).toBe(200);
  const page = await consent.text();
  const approved = await SELF.fetch("http://localhost/authorize", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: consent.headers.get("set-cookie")?.split(";")[0] ?? "",
    },
    body: new URLSearchParams({
      handle: /name="handle" value="([^"]+)"/.exec(page)?.[1] ?? "",
      decision: "approve",
      password: "local-test-password-for-oauth",
    }),
    redirect: "manual",
  });
  expect(approved.status).toBe(302);
  const redirected = new URL(approved.headers.get("location") ?? "");
  const token = await SELF.fetch("http://localhost/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: redirected.searchParams.get("code") ?? "",
      redirect_uri: REDIRECT,
      client_id: client.client_id,
      code_verifier: verifier,
      resource: "http://localhost/mcp",
    }),
  });
  expect(token.status).toBe(200);
  return (await token.json<{ access_token: string }>()).access_token;
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  let binary = "";
  for (const byte of new Uint8Array(digest))
    binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
