/** Headless OpenCode V2, without the user's service, config, or auth database. */
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { buildTurn, resetStore, sessionCalls } from "./harness.mjs";

export const LANES = ["opencode+mcp"];
export const DEFAULT_MODELS = ["openrouter/openai/gpt-5.4-mini"];
const MAX_STEPS = 12;
// Only documented environment credentials cross the boundary. Saved accounts
// stay in the personal DB; importing it would also import sessions/integrations.
const PROVIDER_KEYS = [
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
];

export function harnessVersion() {
  const version = execFileSync("opencode", ["--version"], {
    encoding: "utf8",
  }).trim();
  if (!/^opencode v2\./.test(version)) {
    throw new Error("the OpenCode eval lane requires OpenCode V2");
  }
  return version.replace(/^opencode v/, "");
}

export function prepareLanes(mcpUrl, devRoute) {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(mcpUrl).hostname)) {
    throw new Error("the OpenCode eval lane requires a loopback eval store");
  }
  return { mcpUrl, devRoute };
}

/** Fresh HOME, XDG paths, runtime, DB, and cwd for every case, never a symlink. */
/**
 * `codemode` puts Valise behind OpenCode's `execute` tool, whose programs
 * call it; `execute` is allowed too, because OpenCode exposes the tools
 * directly when it is denied, and the arm would silently measure nothing.
 */
export function isolatedRuntime(
  mcpUrl,
  sessionId,
  sent,
  source = process.env,
  { codemode = false } = {},
) {
  const root = join(tmpdir(), "opencode");
  mkdirSync(root, { recursive: true });
  const dir = realpathSync(mkdtempSync(join(root, "valise-eval-")));
  const env = { PATH: source.PATH, OPENCODE_DISABLE_PROJECT_CONFIG: "1" };
  for (const key of PROVIDER_KEYS) if (source[key]) env[key] = source[key];
  for (const [key, name] of Object.entries({
    HOME: "home",
    XDG_CONFIG_HOME: "config",
    XDG_DATA_HOME: "data",
    XDG_CACHE_HOME: "cache",
    XDG_STATE_HOME: "state",
    XDG_RUNTIME_DIR: "runtime",
    TMPDIR: "tmp",
  })) {
    env[key] = join(dir, name);
    mkdirSync(env[key], { mode: 0o700 });
  }
  const configDir = join(env.XDG_CONFIG_HOME, "opencode");
  mkdirSync(configDir, { mode: 0o700 });
  const instructions = [];
  if (sent.appendSystemPrompt) {
    const file = join(configDir, "case.md");
    writeFileSync(file, sent.appendSystemPrompt, { mode: 0o600 });
    instructions.push(file);
  }
  const config = {
    $schema: "https://opencode.ai/config.json",
    update: "disable",
    snapshots: false,
    plugins: [],
    skills: [],
    instructions,
    agents: { build: { steps: MAX_STEPS } },
    permissions: [
      { action: "*", resource: "*", effect: "deny" },
      { action: "valise_*", resource: "*", effect: "allow" },
      ...(codemode
        ? [{ action: "execute", resource: "*", effect: "allow" }]
        : []),
    ],
    mcp: {
      servers: {
        valise: {
          type: "remote",
          url: mcpUrl,
          oauth: false,
          codemode,
          headers: {
            "x-valise-agent": "valise-eval-harness",
            "x-valise-client": "opencode",
            "x-valise-session": sessionId,
          },
        },
      },
    },
  };
  writeFileSync(join(configDir, "opencode.json"), JSON.stringify(config), {
    mode: 0o600,
  });
  return { dir, env, config, configDir };
}

/** Fail closed if managed/system configuration adds anything to the case. */
export function assertIsolatedConfig(entries, runtime) {
  const expected = [
    {
      type: "document",
      path: join(runtime.configDir, "opencode.json"),
      info: runtime.config,
    },
    { type: "directory", path: runtime.configDir },
  ];
  if (!isDeepStrictEqual(entries, expected)) {
    throw new Error(
      "OpenCode loaded unexpected configuration; refusing a contaminated eval",
    );
  }
}

export async function runHarnessEpisode(
  setup,
  column,
  testCase,
  fill,
  { codemode = false } = {},
) {
  const model = column.slice("opencode+mcp/".length);
  if (!model.includes("/"))
    throw new Error("OpenCode --models requires provider/model IDs");
  const sessionId = `ses_${randomUUID().replaceAll("-", "")}`;
  const sent = buildTurn(testCase, fill, false);
  const runtime = isolatedRuntime(setup.mcpUrl, sessionId, sent, process.env, {
    codemode,
  });
  let server;
  try {
    await resetStore(setup.devRoute);
    server = await startServer(runtime);
    const api = (path, method = "GET", body, timeout) =>
      apiRequest(server, path, method, body, timeout);
    assertIsolatedConfig(await api("/api/config"), runtime);
    const slash = model.indexOf("/");
    const [id, variant] = model.slice(slash + 1).split("#");
    await api("/api/session", "POST", {
      id: sessionId,
      agent: "build",
      model: {
        providerID: model.slice(0, slash),
        id,
        ...(variant ? { variant } : {}),
      },
      location: { directory: runtime.dir },
    });
    // Connect after session creation establishes the canonical Location.
    await api("/api/experimental/mcp/valise", "PUT", {
      config: runtime.config.mcp.servers.valise,
    });
    await api("/api/experimental/mcp/valise/connect", "POST");
    const { data: servers } = await api("/api/mcp");
    if (
      servers?.length !== 1 ||
      servers[0].name !== "valise" ||
      servers[0].status?.status !== "connected"
    ) {
      throw new Error("OpenCode did not connect only the Valise MCP server");
    }
    // Connection readiness precedes OpenCode's debounced tool-registry refresh.
    // Await the observed, settled catalog handshake before admitting any input.
    // The call-log reader waits in 400ms steps; v2.1.0 refreshes after 100ms.
    const handshake = await sessionCalls(setup.mcpUrl, sessionId);
    if (!handshake.some((call) => call.method === "tools/list")) {
      throw new Error(
        `no tools/list in mcp_calls for OpenCode session ${sessionId}`,
      );
    }
    await api(`/api/session/${sessionId}/prompt`, "POST", {
      text: sent.prompt,
    });
    await api(
      `/api/experimental/session/${sessionId}/wait`,
      "POST",
      undefined,
      300_000,
    );
    const { data: session } = await api(`/api/session/${sessionId}`);
    const { data: messages } = await api(
      `/api/session/${sessionId}/message?limit=100&type=assistant&order=asc`,
    );
    const result = readResult(session, messages, sessionId);
    // The header also attributes tools/list, which has no invoking session in
    // OpenCode. _meta[ai.opencode/sessionID] on tool calls uses this same ID.
    const calls = await sessionCalls(setup.mcpUrl, sessionId);
    if (!calls.some((call) => call.method === "tools/list")) {
      throw new Error(
        `no tools/list in mcp_calls for OpenCode session ${sessionId}`,
      );
    }
    return {
      ...result,
      route: calls
        .filter((call) => call.method === "tools/call")
        .map((call) => ({
          name: call.tool,
          args: JSON.parse(call.args_json ?? "null"),
        })),
      session: { sessionId, servedBy: session.model, hooks: [], sent },
    };
  } finally {
    if (server) await server.stop();
    rmSync(runtime.dir, { recursive: true, force: true });
  }
}

export function readResult(session, messages, sessionId) {
  if (
    session?.id !== sessionId ||
    session.outcome !== "succeeded" ||
    !Array.isArray(messages)
  ) {
    throw new Error("OpenCode session did not finish successfully");
  }
  const assistants = messages
    .filter((message) => message.type === "assistant")
    .sort((a, b) => a.time.created - b.time.created);
  if (
    !assistants.length ||
    assistants.some((message) => !message.time.completed || !message.tokens) ||
    assistants.at(-1).finish !== "stop"
  ) {
    throw new Error("OpenCode usage/messages are incomplete");
  }
  const inputOf = (tokens) =>
    (tokens?.input ?? 0) +
    (tokens?.cache?.read ?? 0) +
    (tokens?.cache?.write ?? 0);
  return {
    capped: assistants.length >= MAX_STEPS,
    // What OpenCode itself ran, `execute` included; the call log only sees
    // the MCP calls those make.
    clientTools: assistants.flatMap((message) =>
      message.content
        .filter((part) => part.type === "tool")
        .map((part) => part.tool ?? part.name ?? "unknown"),
    ),
    answer: assistants
      .at(-1)
      .content.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
    spend: {
      turns: assistants.length,
      firstPromptTokens: inputOf(assistants[0].tokens),
      promptTokens: inputOf(session.tokens),
      completionTokens: session.tokens?.output ?? 0,
      reasoningTokens: session.tokens?.reasoning ?? 0,
      costUsd: session.cost ?? 0,
    },
  };
}

/** Private foreground process on an ephemeral loopback port, never --service. */
export function startServer(runtime, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "opencode",
      ["serve", "--hostname", "127.0.0.1", "--port", "0"],
      {
        cwd: runtime.dir,
        env: runtime.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = new Promise((done) => child.once("close", done));
    const stop = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 2000);
      try {
        await exited;
      } finally {
        clearTimeout(force);
      }
    };
    let ready = false;
    let out = "";
    const fail = async () => {
      clearTimeout(timer);
      await stop();
      reject(new Error("isolated OpenCode server failed to start"));
    };
    const timer = setTimeout(fail, timeout);
    child.stdout.on("data", (chunk) => {
      if (ready) return;
      out += chunk;
      const url = out.match(
        /server listening on (http:\/\/127\.0\.0\.1:\d+)/,
      )?.[1];
      const password = out.match(/server password (\S+)/)?.[1];
      if (!ready && url && password) {
        ready = true;
        clearTimeout(timer);
        resolve({
          url,
          authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
          stop,
        });
        out = "";
      } else if (!ready && out.length > 65536) void fail();
    });
    // Neither startup's one-process password nor raw provider errors enter runs.
    child.stderr.resume();
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("could not start isolated OpenCode"));
    });
    child.once("close", () => {
      if (!ready) {
        clearTimeout(timer);
        reject(new Error("isolated OpenCode server exited before startup"));
      }
    });
  });
}

export async function apiRequest(
  server,
  path,
  method = "GET",
  body,
  timeout = 30_000,
) {
  let response;
  try {
    response = await fetch(`${server.url}${path}`, {
      method,
      headers: {
        authorization: server.authorization,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new Error("isolated OpenCode API timed out or disconnected");
  }
  if (!response.ok)
    throw new Error(`isolated OpenCode API answered ${response.status}`);
  if (response.status === 204) return null;
  try {
    return await response.json();
  } catch {
    throw new Error("isolated OpenCode API returned invalid JSON");
  }
}
