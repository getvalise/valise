#!/usr/bin/env node
// J4 with a real client. Agent A and a fresh Agent B are separate headless
// Claude Code sessions (`claude -p`) against an isolated loopback store. The
// hooked arm loads the shipped plugin from clients/valise, so Claude Code
// itself fires valise-hook.mjs on SessionStart and Stop; the hookless arm
// loads no plugin. Seeding, the executor and the scorer are the OpenRouter
// lane's, so the two lanes score the same rows the same way.
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runUiTestServer } from "../../scripts/ui-test-server.mjs";
import { payload } from "./case.mjs";
import { answerContract, hash, prompts, scenarios, score } from "./core.mjs";
import { mcpClient, readClientStream } from "./harness.mjs";
import { observer, seed } from "./store.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, "../../clients/valise");
const { values: options } = parseArgs({
  options: {
    serve: { type: "string" },
    case: { type: "string" },
    model: { type: "string" },
    arm: { type: "string" },
    output: { type: "string" },
    ledger: { type: "string" },
    "max-cost": { type: "string" },
    "session-cap": { type: "string", default: "0.40" },
    catalog: { type: "string", default: "64" },
  },
});
const fail = (message) => {
  throw new Error(message);
};
const scenario = scenarios.find((s) => s.id === options.case);
// Faults sit in the OpenRouter harness's transport; a real client talks to
// the store directly, so only fault-free cases run here.
if (!scenario || scenario.fault !== "none")
  fail(
    "--case must be one of: new, matching, approved-decision, ephemeral, arithmetic",
  );
if (!["hooked", "hookless"].includes(options.arm))
  fail("--arm hooked|hookless");
if (!options.serve || !options.model || !options.output || !options.ledger)
  fail("--serve, --model, --output and --ledger are required");
const maxCost = Number(options["max-cost"]);
const sessionCap = Number(options["session-cap"]);
if (!(maxCost > 0) || !(sessionCap > 0)) fail("--max-cost and --session-cap");

// One ledger spans every invocation of a budget. A session reserves its own
// cap before it starts and settles to the client's reported cost after.
async function ledger(update) {
  let state = { cap: maxCost, spent: 0, sessions: [] };
  try {
    state = JSON.parse(await readFile(options.ledger, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (state.cap !== maxCost) fail("Ledger cap differs from --max-cost");
  update(state);
  await mkdir(dirname(options.ledger), { recursive: true });
  await writeFile(
    `${options.ledger}.tmp`,
    `${JSON.stringify(state, null, 2)}\n`,
  );
  await rename(`${options.ledger}.tmp`, options.ledger);
  return state;
}

async function session({ prompt, actor, endpoint, executor }) {
  await ledger((s) => {
    if (s.spent + sessionCap > s.cap)
      fail(`Budget: ${s.spent} spent of ${s.cap}`);
    s.spent += sessionCap;
  });
  const cwd = await mkdtemp(join(tmpdir(), `valise-j4-client-${actor}-`));
  // Each session works in its own copy of a one-file synthetic checkout, as
  // a person would start Claude Code in their project. Separate directories
  // keep Claude Code's per-directory auto-memory from carrying A to B.
  await mkdir(join(cwd, "fixtures"));
  await writeFile(join(cwd, "fixtures", "payload.txt"), payload);
  // Harness files live outside the checkout the agent can read.
  const harnessDir = await mkdtemp(
    join(tmpdir(), `valise-j4-harness-${actor}-`),
  );
  const servers = {
    valise: {
      type: "http",
      url: endpoint,
      headers: {
        "x-valise-agent": actor,
        "x-valise-client": "claude-code-j4",
        "x-valise-session": `${actor}-${Date.now()}`,
      },
    },
  };
  if (executor)
    servers.j4exec = {
      type: "stdio",
      command: process.execPath,
      args: [join(here, "executor-server.mjs")],
      env: executor,
    };
  await writeFile(
    join(harnessDir, "mcp.json"),
    JSON.stringify({ mcpServers: servers }),
  );
  const args = [
    "-p",
    prompt,
    "--model",
    options.model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-hook-events",
    // Only this run's servers; no user settings, plugins or hooks.
    "--strict-mcp-config",
    "--mcp-config",
    join(harnessDir, "mcp.json"),
    "--setting-sources",
    "project",
    "--append-system-prompt",
    answerContract,
    "--allowedTools",
    "mcp__valise",
    "mcp__j4exec",
    "--max-budget-usd",
    String(sessionCap),
  ];
  if (options.arm === "hooked") args.push("--plugin-dir", pluginDir);
  const started = Date.now();
  const stdout = await new Promise((done, failed) => {
    const child = spawn("claude", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // The hook reads an empty, isolated config and never refreshes from
        // production: no token, and the origin is the loopback store.
        VALISE_CONFIG: join(harnessDir, "valise", "config.json"),
        VALISE_MCP_URL: endpoint,
        VALISE_TOKEN: "",
      },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), 15 * 60 * 1000);
    child.on("error", failed);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!out.trim())
        failed(new Error(`claude exited ${code}: ${err.slice(0, 500)}`));
      else done(out);
    });
  });
  await writeFile(join(harnessDir, "stream.jsonl"), stdout);
  const episode = {
    ...readClientStream(stdout),
    actor,
    cwd,
    harnessDir,
    wallMs: Date.now() - started,
  };
  const settled = await ledger((s) => {
    s.spent +=
      (Number.isFinite(episode.costUsd) ? episode.costUsd : sessionCap) -
      sessionCap;
    s.sessions.push({
      actor,
      case: scenario.id,
      arm: options.arm,
      model: options.model,
      costUsd: episode.costUsd,
    });
  });
  episode.ledgerSpent = settled.spent;
  return episode;
}

const runnerRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const clientVersion = execFileSync("claude", ["--version"], {
  encoding: "utf8",
}).trim();
const project = `valise-eval-j4-${scenario.id}-${options.arm}`;
const run = {
  lane: "writeback-real-client",
  at: new Date().toISOString(),
  runnerRevision,
  client: clientVersion,
  model: options.model,
  arm: options.arm,
  lifecycle:
    options.arm === "hooked"
      ? "Claude Code fires the shipped plugin's SessionStart and Stop hooks"
      : "no plugin, no hooks",
  limitations: [
    "Loopback development identity, not deployed OAuth acceptance",
    "MCP server registered by --mcp-config with loopback headers, not the plugin's .mcp.json",
    "Synthetic allowlisted checksum execution, not arbitrary coding work",
  ],
  sessionCap,
  case: { scenario, project },
};
await mkdir(dirname(options.output), { recursive: true });
const save = () =>
  writeFile(options.output, `${JSON.stringify(run, null, 2)}\n`);

const port = Number(options.serve);
const endpoint = `http://localhost:${port}/mcp`;
const stopServer = new AbortController();
const server = runUiTestServer({ port, signal: stopServer.signal });
server.catch(() => stopServer.abort());
try {
  for (let i = 0; ; i++) {
    if (stopServer.signal.aborted || i > 240) fail("Test server did not start");
    if (
      await fetch(`http://localhost:${port}/health`).then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const setup = mcpClient(endpoint, "j4-setup");
  const other = mcpClient(endpoint, "j4-unrelated-owner");
  const observe = await observer(endpoint);
  await observe.assertEmpty();
  const entry = run.case;
  entry.fixtureHash = hash({ scenario, catalog: Number(options.catalog) });
  const directory = await mkdtemp(join(tmpdir(), "valise-j4-execution-"));
  entry.executionDirectory = directory;
  await writeFile(join(directory, "payload.txt"), payload, { mode: 0o600 });
  entry.fixture = await seed({
    setup,
    other,
    scenario,
    project,
    catalog: Number(options.catalog),
  });
  const { protectedIds } = entry.fixture;
  entry.before = await observe.snapshot(setup, protectedIds, project);
  const prompt = prompts(project, scenario);
  entry.a = await session({ prompt: prompt.a, actor: "j4-agent-a", endpoint });
  entry.afterA = await observe.snapshot(setup, protectedIds, project);
  entry.afterB = entry.afterA;
  await save();
  if (scenario.capture && entry.afterA.todos.length === 1) {
    // B is a new process with its own cwd: no A transcript, no shared
    // auto-memory, no IDs or expected step in its prompt.
    entry.b = await session({
      prompt: prompt.b,
      actor: "j4-agent-b",
      endpoint,
      executor: {
        J4_ENDPOINT: endpoint,
        J4_DIRECTORY: directory,
        J4_TASK: entry.afterA.todos[0].id,
        J4_ACTOR: "j4-agent-b",
      },
    });
    const attempts = await readFile(
      join(directory, "executor-attempts.jsonl"),
      "utf8",
    ).then(
      (t) =>
        t
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l)),
      () => [],
    );
    entry.executorAttempts = attempts;
    entry.execution = attempts.findLast((x) => x.result)?.result;
    entry.afterB = await observe.snapshot(setup, protectedIds, project);
  }
  entry.result = score(entry);
  await save();
  console.log(
    JSON.stringify({
      case: scenario.id,
      arm: options.arm,
      model: options.model,
      pass: entry.result.pass,
      failures: entry.result.failures,
      a: {
        turns: entry.a.turns,
        calls: entry.a.calls.map((c) => c.name),
        cost: entry.a.costUsd,
        hooks: entry.a.hooks.map((h) => h.event),
      },
      b: entry.b && {
        turns: entry.b.turns,
        calls: entry.b.calls.map((c) => c.name),
        cost: entry.b.costUsd,
      },
    }),
  );
  if (!entry.result.pass) process.exitCode = 1;
} catch (error) {
  run.error = String(error);
  await save();
  throw error;
} finally {
  stopServer.abort();
  await server.catch(() => {});
}
