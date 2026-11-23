/**
 * The harness lane: a case goes through headless Claude Code instead of a bare
 * chat completion, so Claude Code's own system prompt, the plugin's hooks, and
 * the `mcp__plugin_valise_valise__` prefix are all in the turn. `run.mjs
 * --harness claude` drives it; scoring and the report stay in `run.mjs`.
 *
 * Two lanes, one per column:
 *
 *   claude-code+plugin/<model>  `--plugin-dir` on a temp copy of clients/valise
 *   claude-code+mcp/<model>     `--mcp-config` naming only Valise, no hooks
 *
 * The route is read back from `mcp_calls` for the `-p` session, not from the
 * transcript, because the call log is what production has too.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "../clients/valise");
export const LANES = ["claude-code+plugin", "claude-code+mcp"];
const AGENT = "valise-eval-harness";

/**
 * Isolation, each flag earned by a probe. `--setting-sources ""` keeps the
 * user's settings, plugins and MCP servers out; `--tools ""` keeps native
 * tools from competing for the turn. Without ENABLE_CLAUDEAI_MCP_SERVERS the
 * claude.ai connectors attach mid-session and one memory turn cached 236k
 * tokens for $0.76; with it, $0.008. `--strict-mcp-config` would also drop
 * the plugin's own server, so only the MCP lane uses it.
 * `--include-hook-events` is what puts a PostToolUseFailure hook's response
 * in the stream; SessionStart reports itself without it.
 */
const BASE_ARGS = [
  "-p",
  "--setting-sources",
  "",
  "--no-session-persistence",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-hook-events",
];
const BASE_ENV = {
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
};

export function harnessVersion() {
  return execFileSync("claude", ["--version"], { encoding: "utf8" })
    .trim()
    .split(" ")[0];
}

/**
 * Why a case cannot be one `-p` turn, or null when it can. Text history folds
 * into the prompt as a transcript; a tool call in the history cannot, and a
 * case that rewrites the tool surface plays a client Claude Code is not.
 */
export function skipReason(testCase, harness = "claude") {
  const client = harness === "opencode" ? "OpenCode" : "Claude Code";
  if (harness === "opencode" && testCase.shell) {
    return "requires Claude Code Bash stubs and plugin hooks";
  }
  if (testCase.harnessTools || testCase.hideTools) {
    return `rewrites the tool surface, which ${client} serves itself`;
  }
  const replayed = (testCase.history ?? []).find(
    (message) =>
      message.role === "tool" ||
      message.tool_calls ||
      typeof message.content !== "string",
  );
  return replayed ? "history replays a tool call, which -p cannot" : null;
}

/**
 * The lane's fixed setup: a plugin copy that reaches the loopback endpoint,
 * or an mcp-config naming only Valise. Local MCP takes the agent and client
 * headers instead of OAuth, so the plugin copy adds those two and changes
 * nothing else; `VALISE_MCP_URL` is the override the shipped `.mcp.json`
 * already honours, and its headersHelper reports the `-p` session id.
 * `devRoute` is the runner's own call to the loopback `/__dev/*` levers, the
 * one it seeds and hashes the store with.
 */
export function prepareLanes(mcpUrl, devRoute) {
  const dir = mkdtempSync(join(tmpdir(), "valise-harness-"));
  const pluginDir = join(dir, "plugin");
  cpSync(PLUGIN, pluginDir, { recursive: true });
  const shipped = JSON.parse(readFileSync(join(PLUGIN, ".mcp.json"), "utf8"));
  shipped.mcpServers.valise.headers = {
    "x-valise-agent": AGENT,
    "x-valise-client": "claude-code",
  };
  writeFileSync(join(pluginDir, ".mcp.json"), JSON.stringify(shipped));
  return { dir, pluginDir, mcpUrl, devRoute };
}

/**
 * One case in one lane. Returns the route and spend `run.mjs` scores, plus
 * what was actually sent, since the plugin lane leaves the hook texts to the
 * hooks and the run file should say so.
 */
export async function runHarnessEpisode(setup, column, testCase, fill) {
  const [lane, model] = column.split("/");
  const plugin = lane === "claude-code+plugin";
  const sessionId = randomUUID();
  const sent = buildTurn(testCase, fill, plugin);

  // A to-do claimed in one case would answer "already claimed" in the next.
  await resetStore(setup.devRoute);

  const env = { ...process.env, ...BASE_ENV, VALISE_MCP_URL: setup.mcpUrl };
  // No config file means the shipped hook defaults. A case that scores the
  // Stop text fires it on the first turn rather than the tenth, and a case's
  // `hookConfig` turns a shipped hook off for its control.
  const config = join(setup.dir, `${sessionId}.json`);
  const hookConfig = {
    ...(testCase.hookConfig ?? {}),
    ...(sent.stopEvery
      ? { "capture-nudge": { every_turns: sent.stopEvery } }
      : {}),
  };
  if (Object.keys(hookConfig).length > 0) {
    writeFileSync(config, JSON.stringify(hookConfig));
  }
  env.VALISE_CONFIG = config;

  const args = [...BASE_ARGS, "--session-id", sessionId, "--model", model];
  // A `shell` case gets Bash and a stub per command on the PATH, so the
  // command fails for real and Claude Code fires PostToolUseFailure on it.
  // Every other case keeps native tools off the turn.
  const shell = testCase.shell
    ? stubCommands(setup.dir, sessionId, testCase.shell)
    : null;
  if (shell) {
    env.PATH = `${shell.bin}:${env.PATH}`;
    args.push("--tools", "Bash", `--allowedTools=${shell.allowed}`);
  } else {
    args.push("--tools", "");
  }
  if (plugin) {
    args.push("--plugin-dir", setup.pluginDir);
    args.push("--allowedTools=mcp__plugin_valise_valise");
  } else {
    const mcpConfig = join(setup.dir, `${sessionId}.mcp.json`);
    writeFileSync(
      mcpConfig,
      JSON.stringify({
        mcpServers: {
          valise: {
            type: "http",
            url: setup.mcpUrl,
            headers: {
              "x-valise-agent": AGENT,
              "x-valise-client": "claude-code",
              "x-valise-session": sessionId,
            },
          },
        },
      }),
    );
    args.push("--strict-mcp-config", "--mcp-config", mcpConfig);
    args.push("--allowedTools=mcp__valise");
  }
  if (sent.appendSystemPrompt) {
    args.push("--append-system-prompt", sent.appendSystemPrompt);
  }
  args.push("--", sent.prompt);

  // An empty temp cwd, so no CLAUDE.md or AGENTS.md from this repo joins the
  // turn.
  const events = await claude(args, env, setup.dir);
  const result = events.find((event) => event.type === "result");
  if (!result) throw new Error("claude -p ended without a result event");
  if (result.is_error) throw new Error(`claude -p: ${result.result}`);

  const calls = await sessionCalls(setup.mcpUrl, sessionId);
  if (!calls.some((call) => call.method === "tools/list")) {
    throw new Error(
      `no tools/list in mcp_calls for session ${sessionId}; the connector never reached ${setup.mcpUrl}`,
    );
  }
  return {
    route: calls
      .filter((call) => call.method === "tools/call")
      .map((call) => ({ name: call.tool, args: safeJson(call.args_json) })),
    spend: spendOf(events, result),
    session: {
      sessionId,
      // Claude Code also spends a few Haiku tokens on its own; this is the
      // model that answered the turn.
      servedBy: events.find((event) => event.subtype === "init")?.model ?? null,
      ...hooksFired(events),
      sent,
    },
  };
}

/**
 * One executable per stubbed command, answering every invocation with the
 * case's output and exit code, or only the invocation whose arguments are
 * the stub's `args`: any other exits 0, so a corrected typo succeeds. Only
 * the stubbed commands are allowed, so a model that reaches for anything
 * else is refused rather than running it on this machine.
 */
function stubCommands(dir, sessionId, shell) {
  const bin = join(dir, `${sessionId}.bin`);
  mkdirSync(bin);
  for (const [command, stub] of Object.entries(shell)) {
    const file = join(bin, command);
    const fail = `cat >&2 <<'VALISE_STUB'\n${stub.stderr}\nVALISE_STUB\nexit ${stub.exit}\n`;
    writeFileSync(
      file,
      stub.args
        ? `#!/bin/sh\nif [ "$*" = '${stub.args}' ]; then\n${fail}fi\nexit 0\n`
        : `#!/bin/sh\n${fail}`,
    );
    chmodSync(file, 0o755);
  }
  const allowed = Object.keys(shell)
    .map((command) => `Bash(${command}:*)`)
    .join(",");
  return { bin, allowed };
}

/**
 * The case as one turn. `{{hook:SessionStart}}` and `{{hook:Stop}}` are left
 * out of the plugin lane because the plugin's real hooks deliver them; the
 * MCP lane has no hooks, so it reads them inline, as the OpenRouter lane does.
 */
export function buildTurn(testCase, fill, plugin) {
  const realHook = (text, name) => plugin && text?.includes(`{{${name}}}`);
  let context = testCase.context;
  if (realHook(context, "hook:SessionStart")) {
    context = context.replace("{{hook:SessionStart}}", "").trim();
  }
  const stopFromHook = realHook(testCase.prompt, "hook:Stop");
  const turns = [
    ...(testCase.history ?? []),
    ...(testCase.prompt && !stopFromHook
      ? [{ role: "user", content: testCase.prompt }]
      : []),
  ].map((message) => ({ ...message, content: fill(message.content) }));
  const prompt =
    turns.length === 1
      ? turns[0].content
      : turns.map((turn) => `[${turn.role}] ${turn.content}`).join("\n\n");
  return {
    prompt,
    appendSystemPrompt: context ? fill(context) : null,
    stopEvery: stopFromHook ? 1 : null,
  };
}

function claude(args, env, cwd) {
  return new Promise((resolve, reject) => {
    // A session that never ends would hold the whole run; five minutes is
    // twenty times the slowest case seen.
    const child = spawn("claude", args, { env, cwd, timeout: 300_000 });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const events = out
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => safeJson(line))
        .filter(Boolean);
      if (code !== 0 && !events.some((event) => event.type === "result")) {
        reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
      } else resolve(events);
    });
  });
}

/**
 * SessionStart and PostToolUseFailure report themselves as hook events; a
 * blocking Stop hook shows up as the user turn Claude Code writes for it.
 * `callsBeforeStop` splits the route: a save before the Stop text is the
 * model's own, one after it is the nudge's. `injected` is each context a
 * PostToolUseFailure hook added, so the run file shows the text arrived.
 */
function hooksFired(events) {
  const fired = new Set();
  const injected = [];
  let calls = 0;
  let callsBeforeStop = null;
  for (const event of events) {
    if (event.subtype === "hook_response") {
      fired.add(event.hook_event);
      const context = safeJson(event.output ?? "")?.hookSpecificOutput
        ?.additionalContext;
      if (event.hook_event === "PostToolUseFailure" && context)
        injected.push(context);
    }
    const content = event.message?.content;
    if (!Array.isArray(content)) continue;
    if (event.type === "assistant") {
      calls += content.filter((part) => part.type === "tool_use").length;
    }
    if (
      event.type === "user" &&
      callsBeforeStop === null &&
      content.some((part) => part.text?.startsWith("Stop hook feedback:"))
    ) {
      fired.add("Stop");
      callsBeforeStop = calls;
    }
  }
  return { hooks: [...fired], callsBeforeStop, injected };
}

function spendOf(events, result) {
  const inputOf = (usage) =>
    (usage?.input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0);
  const first = events.find((event) => event.type === "assistant");
  return {
    turns: result.num_turns ?? 0,
    firstPromptTokens: inputOf(first?.message?.usage),
    promptTokens: inputOf(result.usage),
    completionTokens: result.usage?.output_tokens ?? 0,
    reasoningTokens: result.usage?.output_tokens_details?.thinking_tokens ?? 0,
    costUsd: result.total_cost_usd ?? 0,
  };
}

/** Re-seed, and put the seed to-do back to pending through the coordinator. */
export async function resetStore(devRoute) {
  const seeded = await devRoute("/__dev/seed");
  await devRoute(
    `/__dev/todos/reset?todo=${encodeURIComponent(seeded.seeded.todo)}`,
  );
}

/**
 * The calls one session made, read from the local D1 through the dev
 * server's own Local Explorer, so reading needs no lever of ours. Rows land
 * in `waitUntil` after the response, so the read waits for the count to
 * settle.
 */
export async function sessionCalls(mcpUrl, sessionId) {
  const explorer = `${new URL(mcpUrl).origin}/cdn-cgi/local/explorer/api/d1/database`;
  const databases = await getJson(explorer);
  const db = databases.result.find((entry) => entry.name === "DB");
  if (!db) throw new Error(`no D1 named DB at ${explorer}`);
  let rows = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise((settle) => setTimeout(settle, 400));
    const response = await fetch(`${explorer}/${db.uuid}/raw`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sql: "SELECT at, method, tool, args_json FROM mcp_calls WHERE session = ? AND agent = ? ORDER BY at, call_id",
        params: [sessionId, AGENT],
      }),
    });
    if (!response.ok)
      throw new Error(`call-log read answered ${response.status}`);
    const body = await response.json();
    const { columns, rows: raw } = body.result[0].results;
    const next = raw.map((row) =>
      Object.fromEntries(columns.map((name, index) => [name, row[index]])),
    );
    if (next.length > 0 && next.length === rows.length) return next;
    rows = next;
  }
  return rows;
}

async function getJson(url) {
  const response = await fetch(url);
  const body = await response.text();
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return JSON.parse(body);
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
