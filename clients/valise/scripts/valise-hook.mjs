#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// SessionStart waits on the hook, so the git lookups get half a second each;
// past that the session is briefed without a project.
const GIT_TIMEOUT_MS = 500;
const MAX_PROJECT_LENGTH = 200;

const CAPTURE_NUDGE_TEXT =
  "If this session produced a decision, insight, or dead end another session " +
  "would pay to rediscover, and Valise's save_memory tool is available, save " +
  "it following the capture-this skill. Leave unfinished work as a to-do " +
  "whose next step copies identifiers, paths and values exactly as the user " +
  "or a tool gave them; never invent a command. If nothing new came up or " +
  "it is already saved, saving nothing is fine: stop.";

const RECALL_REMINDER_TEXT =
  "Valise is connected. Before re-deriving prior work, search it for " +
  "decisions and skills. When a command fails with an error the message " +
  "itself does not explain how to fix, search Valise for the error text " +
  "before trying something else. When you leave work for another session, " +
  "name its next step with identifiers, file paths and values exactly as " +
  "the user or a tool gave them. Never invent a command nobody gave.";

const RECALL_ON_ERROR_TEXT =
  "This command failed. Unless the error is a typo in the command you just " +
  "ran, search Valise for the error text before trying something else; a " +
  "stored memory may explain it.";

const MAX_TEXT_LENGTH = 2000;

const CONTRACT = {
  "capture-nudge": {
    event: "Stop",
    defaults: { enabled: true, every_turns: 10, text: CAPTURE_NUDGE_TEXT },
  },
  "recall-reminder": {
    event: "SessionStart",
    defaults: { enabled: true, text: RECALL_REMINDER_TEXT },
  },
  // Parsed so one document serves the console, the server and this script;
  // the plugin's mcp_tool hook asks the server, which reads the entry itself.
  "recall-on-error": {
    event: "PostToolUseFailure",
    defaults: { enabled: true, text: RECALL_ON_ERROR_TEXT },
  },
};

function defaultConfig() {
  const config = {};
  for (const id of Object.keys(CONTRACT)) {
    config[id] = { ...CONTRACT[id].defaults };
  }
  config.custom = [];
  return config;
}

function validateField(id, field, value) {
  if (field === "enabled") {
    if (typeof value !== "boolean") return `"${id}.enabled" must be a boolean`;
    return null;
  }
  if (field === "every_turns") {
    if (!Number.isInteger(value) || value < 1) {
      return `"${id}.every_turns" must be an integer >= 1`;
    }
    return null;
  }
  if (field === "text") {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > MAX_TEXT_LENGTH
    ) {
      return `"${id}.text" must be a non-empty string of at most ${MAX_TEXT_LENGTH} characters`;
    }
    return null;
  }
  return `unknown field "${field}" on "${id}"`;
}

const CUSTOM_FIELDS = ["event", "text", "enabled", "every_turns"];
const CUSTOM_EVENTS = ["Stop", "SessionStart", "PostToolUseFailure"];
const MAX_COMBINED_TEXT_LENGTH = 8000;

function validateCustomEntry(index, raw) {
  const label = `custom[${index}]`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: `"${label}" must be an object` };
  }
  for (const field of Object.keys(raw)) {
    if (!CUSTOM_FIELDS.includes(field)) {
      return { error: `unknown field "${field}" on "${label}"` };
    }
  }
  if (!CUSTOM_EVENTS.includes(raw.event)) {
    return {
      error: `"${label}.event" must be "Stop", "SessionStart" or "PostToolUseFailure"`,
    };
  }
  const event = raw.event;

  const textError = validateField(label, "text", raw.text);
  if (textError) return { error: textError };
  const text = raw.text;

  let enabled = true;
  if ("enabled" in raw) {
    const enabledError = validateField(label, "enabled", raw.enabled);
    if (enabledError) return { error: enabledError };
    enabled = raw.enabled;
  }

  if ("every_turns" in raw) {
    if (event !== "Stop") {
      return {
        error: `"${label}.every_turns" is only valid when event is "Stop"`,
      };
    }
    const everyTurnsError = validateField(
      label,
      "every_turns",
      raw.every_turns,
    );
    if (everyTurnsError) return { error: everyTurnsError };
    return { entry: { event, text, enabled, every_turns: raw.every_turns } };
  }

  if (event === "Stop") {
    return { entry: { event, text, enabled, every_turns: 1 } };
  }
  return { entry: { event, text, enabled } };
}

function combinedTextLength(config, event, shippedId) {
  const shippedEntry = config[shippedId];
  let total = shippedEntry.enabled ? shippedEntry.text.length : 0;
  for (const entry of config.custom) {
    if (entry.event === event && entry.enabled) total += entry.text.length;
  }
  return total;
}

function parseConfig(raw) {
  const config = defaultConfig();
  if (raw === null) return { config };

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { error: "config is not valid JSON" };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { error: "config must be a JSON object" };
  }

  for (const id of Object.keys(data)) {
    if (id === "custom") {
      if (!Array.isArray(data.custom)) {
        return { error: '"custom" must be an array' };
      }
      const custom = [];
      for (let i = 0; i < data.custom.length; i++) {
        const { entry, error } = validateCustomEntry(i, data.custom[i]);
        if (error) return { error };
        custom.push(entry);
      }
      config.custom = custom;
      continue;
    }

    const contractEntry = CONTRACT[id];
    if (!contractEntry) return { error: `unknown config key "${id}"` };
    const entry = data[id];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { error: `config entry "${id}" must be an object` };
    }
    const merged = { ...contractEntry.defaults };
    for (const field of Object.keys(entry)) {
      if (!(field in contractEntry.defaults)) {
        return { error: `unknown field "${field}" on "${id}"` };
      }
      const fieldError = validateField(id, field, entry[field]);
      if (fieldError) return { error: fieldError };
      merged[field] = entry[field];
    }
    config[id] = merged;
  }

  for (const id of Object.keys(CONTRACT)) {
    const event = CONTRACT[id].event;
    if (combinedTextLength(config, event, id) > MAX_COMBINED_TEXT_LENGTH) {
      return {
        error: `combined enabled "${event}" text exceeds ${MAX_COMBINED_TEXT_LENGTH} characters`,
      };
    }
  }

  return { config };
}

/** Valise tools that write durable context, under any client's MCP prefix. */
const VALISE_WRITE =
  /(?:^|__|\.)(save_memory|edit_memory|create_todo|update_todo|complete_todo|comment_todo)$/;

/**
 * Whether a Stop entry is on cadence: the first turn, so a short or headless
 * session gets one capture moment, then every `everyTurns`-th turn.
 */
export function stopTurn(turn, everyTurns) {
  return turn === 1 || turn % everyTurns === 0;
}

/**
 * Whether the capture nudge has anything to ask about, given the tool calls
 * made since the last time it was due. No tool call means the stretch was
 * conversation, with nothing new to save. A Valise write means the agent
 * already saved what it judged worth saving; asking again is what pushed
 * models into saving noise. `null` means the calls are unknown, and the
 * cadence alone decides.
 */
export function captureDue(toolNames) {
  if (toolNames === null) return true;
  return toolNames.length > 0 && !toolNames.some((n) => VALISE_WRITE.test(n));
}

/**
 * Tool names called in transcript lines, for Claude Code (`tool_use`) and
 * Codex (`function_call`, `custom_tool_call`) records alike.
 */
export function toolNamesIn(jsonl) {
  const names = [];
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (value && typeof value === "object") {
      if (
        ["tool_use", "function_call", "custom_tool_call"].includes(
          value.type,
        ) &&
        typeof value.name === "string"
      )
        names.push(value.name);
      for (const item of Object.values(value)) walk(item);
    }
  };
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      walk(JSON.parse(line));
    } catch {
      // A partly written last line is not a tool call yet.
    }
  }
  return names;
}

/**
 * The tool names added to the transcript since `offset` bytes, and its
 * current size. Unreadable or missing means unknown, never "nothing new".
 */
function transcriptSince(transcriptPath, offset) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return null;
  let fd;
  try {
    fd = openSync(transcriptPath, "r");
    const size = statSync(transcriptPath).size;
    // A rewritten (shorter) transcript starts the window over.
    const start = offset <= size ? offset : 0;
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    return { names: toolNamesIn(buffer.toString("utf8")), size };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * What SessionStart tells the agent about Valise's brief. The hook makes no
 * network call: the agent asks with get_brief over its own MCP sign-in.
 * ADR-0004, 2026-11-04.
 */
export function briefLine(source, project) {
  if (source === "resume") {
    return (
      "This session resumed. If it held a Valise to-do, get_brief" +
      (project ? ` with project "${project}"` : "") +
      " lists it under claimed; fetch it for its fencing token before continuing."
    );
  }
  if (!project) {
    return (
      "Call Valise's get_brief before starting work, for recent projects, " +
      "ready to-dos, claims and changed memories."
    );
  }
  return (
    `This directory is Valise project "${project}". Call get_brief with ` +
    `project "${project}" before starting work, for its ready to-dos, ` +
    "claims and changed memories. If it says nothing is filed under that " +
    "project, ask the user which project this is."
  );
}

function decide(
  payload,
  config,
  counterValue,
  project = null,
  captureToolNames = null,
) {
  if (payload.hook_event_name === "SessionStart") {
    const source = payload.source;
    const entry = config["recall-reminder"];
    // Resume keeps the conversation, reminder included; what can fall out is
    // which to-do this worktree holds, and the MCP server is not connected
    // yet at launch, so the hook can only point at get_brief. Compaction is
    // answered by the plugin's mcp_tool hook, which can reach the server.
    if (source === "resume") {
      if (!entry.enabled) return null;
      return {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: briefLine("resume", project),
        },
      };
    }
    if (source !== undefined && source !== "startup" && source !== "clear")
      return null;

    const texts = [];
    if (entry.enabled) {
      texts.push(entry.text);
      texts.push(briefLine(source, project));
    }
    for (const custom of config.custom) {
      if (custom.event === "SessionStart" && custom.enabled) {
        texts.push(custom.text);
      }
    }
    if (texts.length === 0) return null;
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: texts.join("\n\n"),
      },
    };
  }

  if (payload.hook_event_name === "Stop") {
    const turn = counterValue + 1;
    const texts = [];
    const entry = config["capture-nudge"];
    if (
      entry.enabled &&
      stopTurn(turn, entry.every_turns) &&
      captureDue(captureToolNames)
    )
      texts.push(entry.text);
    for (const custom of config.custom) {
      if (
        custom.event === "Stop" &&
        custom.enabled &&
        stopTurn(turn, custom.every_turns)
      ) {
        texts.push(custom.text);
      }
    }
    if (texts.length === 0) return null;
    return { decision: "block", reason: texts.join("\n\n") };
  }

  return null;
}

/** One file per session and counter; the Stop turn counter has no name. */
function counterPath(sessionId, name = "") {
  const key = name ? `${sessionId}:${name}` : String(sessionId);
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return path.join(tmpdir(), "valise", hash);
}

function readCounter(sessionId, name) {
  const file = counterPath(sessionId, name);
  try {
    const raw = readFileSync(file, "utf8");
    const value = Number.parseInt(raw, 10);
    return { value: Number.isInteger(value) && value >= 0 ? value : 0 };
  } catch (err) {
    if (err.code === "ENOENT") return { value: 0 };
    return {
      error: `valise-hook: counter unreadable (${err.code ?? err.message})`,
    };
  }
}

function writeCounter(sessionId, value, name) {
  const file = counterPath(sessionId, name);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmpFile = `${file}.${process.pid}.tmp`;
    writeFileSync(tmpFile, String(value), "utf8");
    renameSync(tmpFile, file);
    return {};
  } catch (err) {
    return {
      error: `valise-hook: counter unwritable (${err.code ?? err.message})`,
    };
  }
}

function configFilePath() {
  return (
    process.env.VALISE_CONFIG || path.join(homedir(), ".valise", "config.json")
  );
}

function loadConfig() {
  const configPath = configFilePath();
  let raw = null;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") {
      return {
        error: `valise-hook: config unreadable (${err.code ?? err.message})`,
        configPath,
      };
    }
  }
  return { ...parseConfig(raw), configPath };
}

/**
 * The repository name of a git `origin` remote URL, in either form. null for
 * an empty one.
 */
export function projectFromRemote(remote) {
  const name = remote
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split(/[/:]/)
    .pop();
  return name ? name : null;
}

/** The `project` of a `.valise.json` document, or null when it names none. */
export function projectFromFile(text) {
  try {
    const project = JSON.parse(text)?.project;
    if (typeof project !== "string") return null;
    const trimmed = project.trim();
    return trimmed && trimmed.length <= MAX_PROJECT_LENGTH ? trimmed : null;
  } catch {
    return null;
  }
}

function git(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/**
 * The Valise project a working directory belongs to: a committed
 * `.valise.json` `{ "project": "..." }` at the repository root (or in the
 * directory itself outside git), else the `origin` remote's repository name,
 * which is what this repo's to-dos use as `project` and which a worktree
 * shares. null when neither answers; get_brief then briefs every project.
 */
export function projectOf(cwd) {
  if (typeof cwd !== "string" || !cwd) return null;
  const root = git(cwd, ["rev-parse", "--show-toplevel"]) || cwd;
  try {
    const named = projectFromFile(
      readFileSync(path.join(root, ".valise.json"), "utf8"),
    );
    if (named) return named;
  } catch {
    // No override: the remote decides.
  }
  const remote = git(cwd, ["remote", "get-url", "origin"]);
  return remote ? projectFromRemote(remote) : null;
}

function printEffectiveConfig(config, configPath) {
  const entries = Object.keys(CONTRACT).map((id) => {
    const entry = config[id];
    const shaped = {
      id,
      event: CONTRACT[id].event,
      enabled: entry.enabled,
      text: entry.text,
    };
    if ("every_turns" in CONTRACT[id].defaults)
      shaped.every_turns = entry.every_turns;
    return shaped;
  });
  for (const custom of config.custom) {
    const shaped = {
      event: custom.event,
      enabled: custom.enabled,
      text: custom.text,
    };
    if (custom.event === "Stop") shaped.every_turns = custom.every_turns;
    entries.push(shaped);
  }
  process.stdout.write(`${JSON.stringify({ configPath, entries }, null, 2)}\n`);
}

async function main() {
  const { config, error, configPath } = loadConfig();
  if (error) {
    process.stderr.write(`${error}\n`);
    process.exit(1);
  }

  if (process.argv.includes("--print")) {
    printEffectiveConfig(config, configPath);
    process.exit(0);
  }

  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0);
  }

  const eventName = payload.hook_event_name;
  if (eventName !== "Stop" && eventName !== "SessionStart") {
    process.exit(0);
  }
  if (eventName === "Stop" && payload.stop_hook_active === true) {
    process.exit(0);
  }

  let counterValue = 0;
  if (eventName === "Stop") {
    const read = readCounter(payload.session_id, "");
    if (read.error) {
      process.stderr.write(`${read.error}\n`);
      process.exit(0);
    }
    counterValue = read.value;
    // A Stop counter that cannot advance would make every turn the first
    // one, and the first turn nudges, so it advances before anything else.
    const written = writeCounter(payload.session_id, counterValue + 1, "");
    if (written.error) {
      process.stderr.write(`${written.error}\n`);
      process.exit(0);
    }
  }

  const project =
    eventName === "SessionStart" && config["recall-reminder"].enabled
      ? projectOf(payload.cwd)
      : null;
  // On a turn the capture nudge is due, read what the transcript gained since
  // the last due turn, and move the window on whether or not it fires.
  let captureToolNames = null;
  const nudge = config["capture-nudge"];
  if (
    eventName === "Stop" &&
    nudge.enabled &&
    stopTurn(counterValue + 1, nudge.every_turns)
  ) {
    const offset = readCounter(payload.session_id, "capture-offset");
    const since = transcriptSince(
      payload.transcript_path,
      offset.error ? 0 : offset.value,
    );
    if (since) {
      captureToolNames = since.names;
      writeCounter(payload.session_id, since.size, "capture-offset");
    }
  }
  const output = decide(
    payload,
    config,
    counterValue,
    project,
    captureToolNames,
  );
  if (output) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }
  process.exit(0);
}

// Imported, as the writeback eval does for captureDue, it runs nothing.
const invoked = (() => {
  try {
    return (
      realpathSync(process.argv[1] ?? "") ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();
if (invoked) await main();
