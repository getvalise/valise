import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { heartbeatPath } from "./watch.mjs";

/**
 * Runs `valise watch` as a macOS launchd agent that starts at login and is
 * restarted when it exits. Nothing else on the machine depends on it: when
 * it is down, sessions wait in their clients' own files until it runs again.
 */

export const LABEL = "run.valise.watch";

export function paths(home = homedir()) {
  return {
    plist: path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
    log: path.join(home, "Library", "Logs", "valise", "watch.log"),
  };
}

/**
 * The `node` launchd should run: the first one on PATH, which for Homebrew
 * or a version manager is a stable link, rather than `process.execPath`,
 * which resolves into a versioned directory that an upgrade deletes.
 */
export function nodeBinary(envPath = process.env.PATH ?? "") {
  for (const dir of envPath.split(":")) {
    if (!dir) continue;
    const candidate = path.join(dir, "node");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return process.execPath;
}

const xml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export function plist({ node, script, log, env = {} }) {
  const args = [node, script, "watch"]
    .map((a) => `    <string>${xml(a)}</string>`)
    .join("\n");
  const vars = Object.entries(env)
    .filter(([, v]) => v)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

/** What the running watcher last wrote about itself, or null. */
export function readHeartbeat(file = heartbeatPath()) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const launchctl = (...args) =>
  execFileSync("launchctl", args, { stdio: ["ignore", "pipe", "pipe"] });

const domain = () => `gui/${process.getuid()}`;

function requireMac(platform) {
  if (platform !== "darwin") {
    throw new Error(
      "valise install supports macOS launchd only. Elsewhere, run `valise watch` under your own service manager.",
    );
  }
}

export async function install({
  script,
  platform = process.platform,
  home = homedir(),
  run = launchctl,
  heartbeat = heartbeatPath(),
  startTimeoutMs = 15_000,
  step = () => {},
}) {
  requireMac(platform);
  const where = paths(home);
  mkdirSync(path.dirname(where.plist), { recursive: true });
  mkdirSync(path.dirname(where.log), { recursive: true });
  writeFileSync(
    where.plist,
    plist({
      node: nodeBinary(),
      script,
      log: where.log,
      env: {
        VALISE_HOME: process.env.VALISE_HOME,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        XDG_DATA_HOME: process.env.XDG_DATA_HOME,
        OPENCODE_DB: process.env.OPENCODE_DB,
      },
    }),
  );
  step("Wrote the login agent", where.plist);
  const startedAfter = Date.now();
  const deadline = startedAfter + startTimeoutMs;
  try {
    run("bootout", `${domain()}/${LABEL}`);
  } catch {}
  // bootout returns while a running watcher is still exiting, and a bootstrap
  // sent before it has gone fails with "Bootstrap failed: 5: Input/output
  // error". Retry until the old job is gone or the start deadline passes.
  for (;;) {
    try {
      run("bootstrap", domain(), where.plist);
      break;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  let beat = readHeartbeat(heartbeat);
  while (!(beat?.started_at >= startedAfter && alive(beat.pid))) {
    if (Date.now() > deadline) {
      throw new Error(
        `The watcher did not start within ${startTimeoutMs / 1000} s. See ${where.log}.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    beat = readHeartbeat(heartbeat);
  }
  step(
    "Started the watcher; launchd restarts it if it exits",
    `pid ${beat.pid}`,
  );
  return { plist: where.plist, log: where.log, pid: beat.pid };
}

export function uninstall({
  platform = process.platform,
  home = homedir(),
  run = launchctl,
  step = () => {},
}) {
  requireMac(platform);
  const where = paths(home);
  try {
    run("bootout", `${domain()}/${LABEL}`);
  } catch {}
  step("Stopped the watcher", LABEL);
  const existed = existsSync(where.plist);
  rmSync(where.plist, { force: true });
  if (existed) step("Removed the login agent", where.plist);
}
