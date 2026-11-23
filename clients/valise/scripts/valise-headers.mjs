#!/usr/bin/env node
/**
 * Claude Code's `headersHelper` for the Valise connector. Prints the headers
 * that tell Valise which session, on which machine, made a request, and that
 * this plugin is installed.
 *
 * OAuth gives Valise one identity per grant, and every Claude Code on a
 * machine shares the grant, so without these headers parallel sessions are
 * indistinguishable in the call log. Claude Code runs this script as a direct
 * child, so the parent PID is the Claude process, and an interactive session
 * records itself in `<config dir>/sessions/<pid>.json`. That file is Claude
 * Code's, not a documented interface; when it is missing, as it is for
 * `claude -p`, the session falls back to `pid@host`, which still keeps two
 * processes apart.
 */
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Header values must be visible ASCII; a session name is a cwd and need not be. */
function headerSafe(value) {
  return String(value)
    .replace(/[^\x20-\x7e]/g, "?")
    .trim()
    .slice(0, 200);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const plugin = readJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"));
const configDir =
  process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
const pid = process.ppid;
const session = readJson(path.join(configDir, "sessions", `${pid}.json`));
const host = hostname().replace(/\.local$/, "");

const headers = {
  "X-Valise-Plugin": `valise/${plugin?.version ?? "unknown"}`,
  "X-Valise-Host": host,
  "X-Valise-Session":
    typeof session?.sessionId === "string"
      ? session.sessionId
      : `${pid}@${host}`,
};
if (typeof session?.name === "string" && session.name !== "") {
  headers["X-Valise-Session-Name"] = session.name;
}

for (const [name, value] of Object.entries(headers)) {
  headers[name] = headerSafe(value);
}
process.stdout.write(JSON.stringify(headers));
