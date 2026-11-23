import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [client, mode = "native", test = "plain"] = process.argv.slice(2);
if (
  !["claude", "codex", "opencode"].includes(client) ||
  !["native", "tools", "prompts", "all"].includes(mode) ||
  !["plain", "nudge", "explicit", "unrelated", "nudge-unrelated"].includes(test)
) {
  throw new Error(
    "Usage: probe.mjs <claude|codex|opencode> <native|tools|prompts|all> [plain|nudge|explicit|unrelated]",
  );
}
const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "fixture.mjs");
const tempRoot = process.env.VALISE_PROBE_TMP ?? join(tmpdir(), "opencode");
mkdirSync(tempRoot, { recursive: true });
const dir = mkdtempSync(join(tempRoot, "valise-skill-probe-"));
const log = join(dir, "rpc.jsonl");
const protocol = process.env.VALISE_PROBE_PROTOCOL ?? "legacy";
const fixtureArgs = [fixture, mode, log, "", protocol];
const nudge =
  "Valise skills are also available as MCP tools named skill_<name>. When a skill fits the task, call its tool to read the instructions before doing the work. Load only the skill you need.";
const prompt = test.endsWith("unrelated")
  ? "What is 2 + 2?"
  : "Produce a cerulean receipt using the organization's convention. If the convention is unavailable, say UNAVAILABLE; do not invent it.";
const env = {
  ...process.env,
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
};
delete env.CLAUDECODE;
let args;
if (client === "claude") {
  const config = join(dir, "mcp.json");
  writeFileSync(
    config,
    JSON.stringify({
      mcpServers: {
        valiseprobe: { command: process.execPath, args: fixtureArgs },
      },
    }),
  );
  args = [
    "-p",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    config,
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "haiku",
    "--max-budget-usd",
    "0.25",
    "--tools",
    "Skill,ToolSearch,ListMcpResourcesTool,ReadMcpResourceTool",
    "--allowedTools",
    "mcp__valiseprobe,Skill,ListMcpResourcesTool,ReadMcpResourceTool",
  ];
  if (test.startsWith("nudge")) {
    const hook = join(dir, "session-start.cjs");
    writeFileSync(
      hook,
      `console.log(${JSON.stringify(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: nudge } }))});\n`,
    );
    args.push(
      "--settings",
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}`,
                },
              ],
            },
          ],
        },
      }),
    );
  }
  args.push(
    "--",
    test === "explicit" ? "/mcp__valiseprobe__valise-probe-cerulean" : prompt,
  );
} else if (client === "codex") {
  args = [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--json",
    "-c",
    "features.hooks=false",
    "-c",
    'mcp_servers.valiseprobe.default_tools_approval_mode="approve"',
    "-c",
    `mcp_servers.valiseprobe.command=${JSON.stringify(process.execPath)}`,
    "-c",
    `mcp_servers.valiseprobe.args=${JSON.stringify(fixtureArgs)}`,
  ];
  if (test.startsWith("nudge"))
    args.push("-c", `developer_instructions=${JSON.stringify(nudge)}`);
  args.push(test === "explicit" ? "$valise-probe-cerulean" : prompt);
} else {
  // The registry API does not itself start config-defined MCP connections.
  const endpoint = `/api/experimental/mcp/valiseprobe?location[directory]=${encodeURIComponent(dir)}`;
  const setup = spawnSync(
    client,
    [
      "api",
      "put",
      endpoint,
      "--data",
      JSON.stringify({
        config: {
          type: "local",
          command: [process.execPath, ...fixtureArgs],
          protocol: protocol === "modern" ? "auto" : "legacy",
        },
      }),
    ],
    { cwd: dir, env, encoding: "utf8", timeout: 30_000 },
  );
  if (setup.status !== 0)
    throw new Error(
      `MCP fixture setup failed: ${setup.stdout}\n${setup.stderr}`,
    );
  const route = test === "explicit" ? "/api/command" : "/api/skill";
  args = [
    "api",
    "get",
    `${route}?location[directory]=${encodeURIComponent(dir)}`,
  ];
}
const version = spawnSync(client, ["--version"], {
  encoding: "utf8",
}).stdout?.trim();
const stdoutFd = openSync(join(dir, "stdout.txt"), "w");
const result = spawnSync(client, args, {
  cwd: dir,
  env,
  encoding: "utf8",
  timeout: 120_000,
  maxBuffer: 20 * 1024 * 1024,
  stdio: ["ignore", stdoutFd, "pipe"],
});
closeSync(stdoutFd);
result.stdout = readFileSync(join(dir, "stdout.txt"), "utf8");
if (client === "opencode") {
  const cleanup = spawnSync(
    client,
    [
      "api",
      "delete",
      `/api/experimental/mcp/valiseprobe?location[directory]=${encodeURIComponent(dir)}`,
    ],
    { cwd: dir, env, encoding: "utf8", timeout: 30_000 },
  );
  if (cleanup.status !== 0)
    console.error(
      `Fixture cleanup failed: ${cleanup.stdout} ${cleanup.stderr}`,
    );
}
writeFileSync(join(dir, "stdout.txt"), result.stdout ?? "");
writeFileSync(join(dir, "stderr.txt"), result.stderr ?? "");
const calls = existsSync(log)
  ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
  : [];
let registry;
if (client === "opencode" && result.status === 0) {
  const value = JSON.parse(result.stdout);
  registry = (
    Array.isArray(value)
      ? value
      : (Object.values(value).find(Array.isArray) ?? [])
  )
    .filter((item) => JSON.stringify(item).includes("valise-probe-cerulean"))
    .map(({ content, ...item }) => item);
}
const events =
  client === "opencode"
    ? []
    : (result.stdout ?? "")
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line));
const init = events.find((event) => event.subtype === "init");
const finalText =
  client === "claude"
    ? events.find((event) => event.type === "result")?.result
    : events.filter((event) => event.item?.type === "agent_message").at(-1)
        ?.item.text;
const summary = {
  client,
  version,
  mode,
  test,
  protocol,
  fixtureHash: createHash("sha256").update(readFileSync(fixture)).digest("hex"),
  dir,
  status: result.status,
  error: result.error?.message,
  methods: calls.map((call) => call.method),
  calls: calls.filter((call) => !call.method.startsWith("notifications/")),
  nativeDiscovery: calls.some((call) => call.method === "skills/list"),
  markerReturned: finalText?.trim() === "CERULEAN-one-7391",
  finalText,
  registeredSkills: init?.skills?.filter((name) =>
    name.includes("valise-probe"),
  ),
  registeredCommands: init?.slash_commands?.filter((name) =>
    name.includes("valise-probe"),
  ),
  registry,
};
mkdirSync(resolve("evals/skills/runs"), { recursive: true });
const output = resolve(
  `evals/skills/runs/${new Date().toISOString().replaceAll(":", "-")}-${client}-${mode}-${test}.json`,
);
writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ ...summary, calls: undefined, output }, null, 2));
if (result.status !== 0) process.exitCode = 1;
