#!/usr/bin/env node
/**
 * Drive the whole OAuth flow the way a real MCP client does, then call one
 * tool from every scope family with the single token it produced.
 *
 * This is V1-7's lever: it fails loudly if any call comes back with an
 * `insufficient_scope` challenge, which is what a client being sent round the
 * consent screen a second time looks like from the wire. A second consent
 * then asks for `search:read transcripts:write` the way the Valise CLI does
 * and must get exactly that (ADR-0022): a `list_skills` call on it has to be
 * refused.
 *
 *   npm run dev
 *   node scripts/oauth-roundtrip.mjs
 *
 * VALISE_DEV_ORIGIN and VALISE_ADMIN_PASSWORD override the defaults.
 */
import { chromium } from "@playwright/test";
import { DEV_ORIGIN } from "./dev-lever.mjs";

const password =
  process.env.VALISE_ADMIN_PASSWORD ?? "local-development-password-01";
const redirectUri = "http://127.0.0.1:4567/callback";
const verifier = "v".repeat(64);

const browser = await chromium.launch();
const token = await consent("Valise OAuth round trip", "search:read");

/** One call per scope family, all on the token the one consent produced. */
const CALLS = [
  ["search:read", "search", { query: "duckdb" }],
  ["todos:read", "list_ready", {}],
  [
    "todos:write",
    "create_todo",
    { title: "OAuth round trip", project: "valise" },
  ],
  [
    "memories:write",
    "save_memory",
    {
      type: "fact",
      title: "OAuth round trip wrote a memory",
      body: "OAuth round trip",
      tags: ["oauth"],
    },
  ],
  ["skills:read", "list_skills", {}],
];

const results = [];
let createdTodo = null;
for (const [scope, name, args] of CALLS) {
  const { response, body } = await call(name, args, token);
  results.push({
    scope,
    tool: name,
    status: response.status,
    challenge: response.headers.get("www-authenticate"),
  });
  if (name === "create_todo") {
    createdTodo = body?.result?.structuredContent?.id ?? null;
  }
  process.stdout.write(
    `${response.status === 200 ? "ok  " : "FAIL"} ${scope.padEnd(16)} ${name}\n`,
  );
}

// Close the to-do this run opened. The lever should not grow the ready queue
// every time somebody reruns it, and claim-then-complete is free coverage.
if (createdTodo) {
  const claimed = await call("claim_todo", { id: createdTodo }, token);
  const fencing = claimed.body?.result?.structuredContent?.token;
  if (fencing) {
    await call(
      "complete_todo",
      {
        id: createdTodo,
        token: fencing,
        summary: "Closed by the OAuth round-trip lever.",
      },
      token,
    );
  }
  process.stdout.write(`ok   cleanup          ${createdTodo}\n`);
}

// A client that names a scope beyond search:read gets exactly what it named.
const narrow = await consent(
  "Valise CLI round trip",
  "search:read transcripts:write",
);
await browser.close();
const narrowScopes = (narrow.scope ?? "").split(" ").sort().join(" ");
const refused = await call("list_skills", {}, narrow);
process.stdout.write(
  `${narrowScopes === "search:read transcripts:write" && refused.response.status === 403 ? "ok  " : "FAIL"} narrow grant      ${narrowScopes} (list_skills ${refused.response.status})\n`,
);
if (
  narrowScopes !== "search:read transcripts:write" ||
  refused.response.status !== 403
) {
  process.stderr.write("\na client naming scopes did not get exactly those\n");
  process.exit(1);
}

const reauthorized = results.filter((row) => row.status !== 200);
process.stdout.write(
  `\ngranted scopes: ${(token.scope ?? "").split(" ").join(", ")}\n`,
);
if (reauthorized.length) {
  process.stderr.write(
    `\n${reauthorized.length} call(s) needed another authorization:\n${JSON.stringify(reauthorized, null, 2)}\n`,
  );
  process.exit(1);
}
process.stdout.write("one consent, every scope family, no step-up\n");

/** Register a client, approve its consent in a browser, and exchange the code. */
async function consent(clientName, scope) {
  const registered = await post("/register", {
    client_name: clientName,
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
  });
  const authorize = new URL(`${DEV_ORIGIN}/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: registered.client_id,
    redirect_uri: redirectUri,
    scope,
    resource: `${DEV_ORIGIN}/mcp`,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
    state: "round-trip",
  }).toString();
  const page = await browser.newPage();
  await page.goto(authorize.href);
  const passwordField = page.getByLabel("Administrator password");
  if (await passwordField.count()) await passwordField.fill(password);
  // Nothing listens on the callback port, so the redirect is read off the
  // request the browser makes rather than off a page that loads.
  const callback = page.waitForRequest((request) =>
    request.url().startsWith(redirectUri),
  );
  await page.getByRole("button", { name: "Allow" }).click();
  const code = new URL((await callback).url()).searchParams.get("code");
  await page.close();
  if (!code)
    throw new Error("the consent screen returned no authorization code");
  return form("/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: registered.client_id,
    code_verifier: verifier,
    resource: `${DEV_ORIGIN}/mcp`,
  });
}

async function call(name, args, bearer) {
  const response = await fetch(`${DEV_ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearer.access_token}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const raw = await response.text();
  const line = raw
    .split("\n")
    .find((l) => l.startsWith("data:"))
    ?.slice("data:".length)
    .trim();
  let body = null;
  try {
    body = JSON.parse(line || raw);
  } catch {}
  return { response, body };
}

async function post(path, body) {
  const response = await fetch(`${DEV_ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: ${await response.text()}`);
  return response.json();
}

async function form(path, body) {
  const response = await fetch(`${DEV_ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  if (!response.ok) throw new Error(`${path}: ${await response.text()}`);
  return response.json();
}

async function pkceChallenge(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Buffer.from(digest)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
