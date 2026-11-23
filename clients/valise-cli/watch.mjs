import { watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { configDir } from "./config.mjs";
import { CLIENTS, openCodeDbPath, runImport } from "./import.mjs";

/**
 * Sends sessions as their clients write them. Claude Code and Codex append
 * to one JSONL file per session, so a change to such a file sends that
 * session once the file has been quiet for `debounceMs`. OpenCode keeps one
 * SQLite file, so a change to it sends OpenCode's sessions. A full pass runs
 * at start and every `sweepMs`, which catches events the OS dropped and
 * retries what failed.
 *
 * Nothing here sits between a client and its model: when the watcher is
 * down, sessions are sent on its next pass, and the clients never notice.
 */

export function heartbeatPath() {
  return path.join(configDir(), "watch.json");
}

/** The Claude Code or Codex session a changed file is, or null. */
export function sessionForFile(client, root, name) {
  if (!name?.endsWith(".jsonl")) return null;
  const parts = name.split(path.sep);
  const base = parts[parts.length - 1];
  // Claude Code keeps subagent transcripts in subdirectories; import skips them too.
  if (client === "claude-code") {
    if (parts.length !== 2) return null;
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}\.jsonl$/.test(base)) return null;
  }
  return {
    client,
    file: path.join(root, name),
    sessionId: base.replace(/\.jsonl$/, ""),
  };
}

export function watchSessions({
  sender,
  roots = {},
  debounceMs = 3000,
  sweepMs = 10 * 60 * 1000,
  heartbeat = heartbeatPath(),
  log = console.error,
}) {
  const claudeRoot =
    roots.claude ?? path.join(homedir(), ".claude", "projects");
  const codexRoot = roots.codex ?? path.join(homedir(), ".codex", "sessions");
  const openCodeDb = roots.opencode ?? openCodeDbPath();
  const beat = {
    pid: process.pid,
    started_at: Date.now(),
    last_pass_at: null,
    last_sent_at: null,
    sent: 0,
    last_error: null,
  };
  const writeBeat = () => {
    try {
      writeFileSync(heartbeat, JSON.stringify(beat));
    } catch {}
  };

  // One send at a time, so two events for one session never race.
  let chain = Promise.resolve();
  const enqueue = (job) => {
    chain = chain.then(job).catch((error) => {
      beat.last_error = error.message;
      log(`valise: ${error.message}`);
    });
    return chain;
  };
  const record = (outcome) => {
    if (outcome === "sent") {
      beat.sent++;
      beat.last_sent_at = Date.now();
    }
    if (outcome === "failed") beat.last_error = "a session failed to send";
  };

  const timers = new Map();
  const later = (key, job, delay = debounceMs) => {
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        enqueue(job);
      }, delay),
    );
  };

  const passJob = (clients) => async () => {
    const report = await runImport({ sender, clients, roots });
    for (const outcome of ["sent", "failed"])
      for (let i = 0; i < report[outcome]; i++) record(outcome);
    beat.last_pass_at = Date.now();
    writeBeat();
  };
  const pass = () => enqueue(passJob(CLIENTS));

  const watchers = [];
  const watchTree = (client, root) => {
    try {
      watchers.push(
        watch(root, { recursive: true }, (_event, name) => {
          const session = sessionForFile(client, root, name);
          if (!session) return;
          later(session.file, async () => {
            record(await sender.send(session));
            sender.save();
            writeBeat();
          });
        }),
      );
    } catch {
      log(
        `valise: not watching ${root}; it does not exist yet. The ${sweepMs / 60000}-minute pass covers it.`,
      );
    }
  };
  watchTree("claude-code", claudeRoot);
  watchTree("codex", codexRoot);
  try {
    watchers.push(
      watch(path.dirname(openCodeDb), (_event, name) => {
        if (name?.startsWith(path.basename(openCodeDb)))
          later("opencode", passJob(["opencode"]), debounceMs * 5);
      }),
    );
  } catch {}

  writeBeat();
  const ready = pass();
  const sweep = setInterval(() => pass(), sweepMs);
  log(
    `valise watch: sending new sessions from ${claudeRoot}, ${codexRoot} and ${openCodeDb}`,
  );

  return {
    ready,
    flush: () => chain,
    close() {
      clearInterval(sweep);
      for (const timer of timers.values()) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    },
  };
}
