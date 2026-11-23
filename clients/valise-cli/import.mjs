import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { configDir } from "./config.mjs";
import {
  DISTILL_VERSION,
  distillChatGpt,
  distillClaudeAi,
  distillClaudeCode,
  distillCodex,
  distillOpenCode,
} from "./distill.mjs";
import { pushTurns, turnHash } from "./sync.mjs";

/**
 * Every session this machine holds, distilled and sent: Claude Code from
 * `~/.claude/projects`, Codex from `~/.codex/sessions`, OpenCode from its
 * SQLite file. Every session goes, in any directory; the git repository a
 * session ran in becomes its project label, and a session outside one has
 * none. `createSender` is shared by `valise import` and `valise watch`.
 */

export function claudeCodeSessions(
  root = path.join(homedir(), ".claude", "projects"),
) {
  const out = [];
  for (const dir of safeList(root)) {
    const full = path.join(root, dir);
    if (!statSync(full).isDirectory()) continue;
    for (const file of safeList(full)) {
      if (!/^[0-9a-f]{8}-[0-9a-f-]{27}\.jsonl$/.test(file)) continue;
      out.push({
        client: "claude-code",
        file: path.join(full, file),
        sessionId: file.replace(/\.jsonl$/, ""),
      });
    }
  }
  return out;
}

export function codexSessions(
  root = path.join(homedir(), ".codex", "sessions"),
) {
  const out = [];
  const walk = (dir) => {
    for (const entry of safeList(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".jsonl"))
        out.push({
          client: "codex",
          file: full,
          sessionId: entry.replace(/\.jsonl$/, ""),
        });
    }
  };
  walk(root);
  return out;
}

export function openCodeDbPath() {
  if (process.env.OPENCODE_DB) return process.env.OPENCODE_DB;
  const data =
    process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
  return path.join(data, "opencode", "opencode.db");
}

/** OpenCode sessions with their messages, read through node:sqlite read-only. */
export async function openCodeSessions(file = openCodeDbPath()) {
  if (!safeStat(file)) return [];
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const sessions = db
      .prepare(
        "SELECT id, directory, title, model, time_created FROM session_v2",
      )
      .all();
    return sessions.map((session) => ({
      client: "opencode",
      sessionId: session.id,
      cwd: session.directory,
      title: session.title,
      rows: db
        .prepare(
          "SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq",
        )
        .all(session.id),
    }));
  } finally {
    db.close();
  }
}

export function distillSession(session) {
  if (session.client === "claude-ai")
    return distillClaudeAi(session.conversation);
  if (session.client === "chatgpt") return distillChatGpt(session.conversation);
  if (session.client === "claude-code") {
    const lines = readFileSync(session.file, "utf8").split("\n");
    const distilled = distillClaudeCode(lines);
    return {
      ...distilled,
      sessionId: distilled.sessionId ?? session.sessionId,
    };
  }
  if (session.client === "codex") {
    const lines = readFileSync(session.file, "utf8").split("\n");
    const distilled = distillCodex(lines);
    return {
      ...distilled,
      sessionId: distilled.sessionId ?? session.sessionId,
    };
  }
  const distilled = distillOpenCode(session.rows);
  return {
    ...distilled,
    sessionId: session.sessionId,
    cwd: session.cwd,
    gitBranch: null,
  };
}

/** What `createSender().send` did with one session. */
export const OUTCOMES = ["sent", "held", "unchanged", "empty", "failed"];

/**
 * Sends sessions and remembers, in `sent.json` beside the config, how many
 * turns of each Valise holds and the hash of the last one. An unchanged file
 * costs one `stat`; a grown one resends from where Valise stopped without
 * asking first, and anything else falls back to the resume handshake.
 */
export function createSender({
  config,
  api,
  stateFile = path.join(configDir(), "sent.json"),
  log = console.error,
  repo = repoName,
  onlyNew = false,
}) {
  let state = {};
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {}
  const repos = new Map();
  const project = (cwd) => {
    if (!cwd) return null;
    if (!repos.has(cwd)) repos.set(cwd, repo(cwd));
    return repos.get(cwd);
  };

  async function send(session) {
    const key = `${session.client}:${session.file ?? session.sessionId}`;
    // An entry written by an older distiller says nothing about what this
    // one yields, so the session goes through the resume handshake again.
    const known = state[key]?.v === DISTILL_VERSION ? state[key] : undefined;
    const mtimeMs = session.file ? safeStat(session.file)?.mtimeMs : null;
    if (mtimeMs && known?.mtimeMs === mtimeMs) return "unchanged";
    let distilled;
    try {
      distilled = distillSession(session);
    } catch (error) {
      log(
        `valise: cannot read ${session.file ?? session.source ?? session.sessionId}: ${error.message}`,
      );
      return "failed";
    }
    const { turns } = distilled;
    if (turns.length === 0) {
      state[key] = { v: DISTILL_VERSION, mtimeMs };
      return "empty";
    }
    const last = turnHash(turns[turns.length - 1]);
    if (known?.count === turns.length && known.last === last) {
      state[key] = { ...known, mtimeMs };
      return "unchanged";
    }
    const from =
      known?.count &&
      turns.length > known.count &&
      turnHash(turns[known.count - 1]) === known.last
        ? known.count
        : null;
    try {
      const result = await pushTurns(
        api,
        {
          client: session.client,
          device: session.device ?? config.device,
          session_id: distilled.sessionId,
          cwd: distilled.cwd ?? null,
          git_branch: distilled.gitBranch ?? null,
          project: project(distilled.cwd),
          model: distilled.model ?? null,
        },
        turns,
        { from, onlyNew },
      );
      state[key] = { v: DISTILL_VERSION, mtimeMs, count: turns.length, last };
      return result.skipped ? "held" : "sent";
    } catch (error) {
      log(`valise: ${session.client} ${distilled.sessionId}: ${error.message}`);
      return "failed";
    }
  }

  return {
    send,
    save: () => writeFileSync(stateFile, JSON.stringify(state)),
    count: () => Object.values(state).filter((s) => s.count).length,
  };
}

/** The name of the repository `cwd` is in; a worktree reports its main repository. */
export function repoName(cwd) {
  try {
    const common = execFileSync(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 },
    ).trim();
    const dir =
      path.basename(common) === ".git" ? path.dirname(common) : common;
    return path.basename(dir).replace(/\.git$/, "") || null;
  } catch {
    return null;
  }
}

export const CLIENTS = ["claude-code", "codex", "opencode"];

/** What an archive can hold: the coding clients' files and two chat exports. */
export const ARCHIVE_CLIENTS = ["claude-code", "codex", "claude-ai", "chatgpt"];

/**
 * A chat export is not from this machine: its conversations are named by the
 * service they ran on, so a second export, from any machine, lands on the
 * same sessions instead of beside them.
 */
const EXPORT_DEVICES = { "claude-ai": "claude.ai", chatgpt: "chatgpt.com" };

const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f-]{27}\.jsonl$/;
const CODEX_FILE = /^rollout-.+\.jsonl$/;

/**
 * Every session in a directory of copies or exports, in any layout: a copy
 * of `~/.claude/projects` or `~/.codex/sessions`, dated folders of session
 * files, a claude.ai export (`conversations.json`, or one
 * `conversation.json` per chat) or a ChatGPT `conversations.json`. A file is
 * read by its name and, for JSON, its shape; anything else, compressed
 * copies included, is passed over. A session found twice is listed once, from
 * its largest copy.
 */
export function archiveSessions(root) {
  const found = new Map();
  const add = (session, size) => {
    const key = `${session.client}:${session.sessionId}`;
    const held = found.get(key);
    if (!held || size > held.size) found.set(key, { session, size });
  };
  const walk = (dir) => {
    for (const entry of safeList(dir)) {
      const full = path.join(dir, entry);
      const stat = safeStat(full);
      if (!stat) continue;
      if (stat.isDirectory()) {
        // Claude Code keeps a subagent's transcript under its session.
        if (entry !== "subagents") walk(full);
        continue;
      }
      if (SESSION_FILE.test(entry)) {
        add(
          {
            client: "claude-code",
            file: full,
            sessionId: entry.replace(/\.jsonl$/, ""),
          },
          stat.size,
        );
      } else if (CODEX_FILE.test(entry)) {
        add(
          {
            client: "codex",
            file: full,
            sessionId: entry.replace(/\.jsonl$/, ""),
          },
          stat.size,
        );
      } else if (entry.endsWith(".json")) {
        for (const session of exportSessions(full)) {
          add(
            session,
            session.conversation.chat_messages?.length ??
              Object.keys(session.conversation.mapping ?? {}).length,
          );
        }
      }
    }
  };
  walk(root);
  return [...found.values()].map((entry) => entry.session);
}

/** The conversations in one export file, or none when it is not an export. */
function exportSessions(file) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const out = [];
  for (const conversation of Array.isArray(data) ? data : [data]) {
    if (!conversation || typeof conversation !== "object") continue;
    const client = Array.isArray(conversation.chat_messages)
      ? "claude-ai"
      : conversation.mapping && typeof conversation.mapping === "object"
        ? "chatgpt"
        : null;
    const sessionId =
      client === "claude-ai"
        ? conversation.uuid
        : (conversation.conversation_id ?? conversation.id);
    if (!client || typeof sessionId !== "string") continue;
    out.push({
      client,
      device: EXPORT_DEVICES[client],
      sessionId,
      source: file,
      conversation,
    });
  }
  return out;
}

export async function listSessions(clients = CLIENTS, roots = {}) {
  if (roots.archive)
    return archiveSessions(roots.archive).filter((s) =>
      clients.includes(s.client),
    );
  return [
    ...(clients.includes("claude-code")
      ? claudeCodeSessions(roots.claude)
      : []),
    ...(clients.includes("codex") ? codexSessions(roots.codex) : []),
    ...(clients.includes("opencode")
      ? await openCodeSessions(roots.opencode)
      : []),
  ];
}

/**
 * Send every session of `clients` once. `onProgress(report, session)` runs
 * after each one, so a caller can show how far the import is.
 */
export async function runImport({
  sender,
  clients = CLIENTS,
  roots = {},
  onProgress = () => {},
  concurrency = 6,
  saveEvery = 50,
}) {
  const found = await listSessions(clients, roots);
  const report = { found: found.length, done: 0 };
  for (const outcome of OUTCOMES) report[outcome] = 0;
  // Each session waits on its own round trips to Valise; sending several at
  // once overlaps them. One session is never sent twice at once: each is
  // taken from the list by exactly one worker.
  let next = 0;
  const worker = async () => {
    while (next < found.length) {
      const session = found[next++];
      report[await sender.send(session)]++;
      report.done++;
      if (report.done % saveEvery === 0) sender.save();
      onProgress(report, session);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  sender.save();
  return report;
}

function safeList(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function safeStat(file) {
  try {
    return statSync(file);
  } catch {
    return null;
  }
}
