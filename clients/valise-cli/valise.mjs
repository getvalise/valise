#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { accessToken, login, logout, SignInNeeded } from "./auth.mjs";
import { configPath, readConfig } from "./config.mjs";
import {
  ARCHIVE_CLIENTS,
  CLIENTS,
  createSender,
  runImport,
} from "./import.mjs";
import {
  alive,
  install,
  LABEL,
  paths,
  readHeartbeat,
  uninstall,
} from "./service.mjs";
import { transcriptsApi } from "./sync.mjs";
import {
  bold,
  clearProgress,
  dim,
  done,
  failed,
  heading,
  notice,
  progress,
  todo,
} from "./ui.mjs";
import { watchSessions } from "./watch.mjs";

/**
 * valise: the Valise command line.
 *
 *   valise                         where setup stands, and the next command
 *   valise login [--origin URL]    sign this machine in, once
 *   valise logout                  forget the sign-in
 *   valise install [--origin URL]  sign in if needed, send existing sessions, then watch for new ones at login (macOS)
 *   valise uninstall               stop watching
 *   valise import [--client claude-code|codex|opencode]   send every session once
 *   valise import --from DIR [--client claude-code|codex|claude-ai|chatgpt]
 *                                  send the sessions in copies or exports that Valise does not hold yet
 *   valise watch                   send sessions as they are written; what the login agent runs
 *   valise status                  the same facts as `valise`, tab-separated, on stdout
 */

const NAMES = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  "claude-ai": "Claude",
  chatgpt: "ChatGPT",
};

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = rest[i + 1];
  return value === undefined || value.startsWith("--") ? true : value;
};

async function signedIn() {
  const config = readConfig();
  await accessToken(config);
  // An import outlasts an access token. Each request asks for a live one;
  // concurrent requests share one refresh, because the server rotates the
  // refresh token and a second use of the old one would be refused.
  let refreshing = null;
  const token = () => {
    refreshing ??= accessToken(readConfig()).finally(() => {
      refreshing = null;
    });
    return refreshing;
  };
  const api = transcriptsApi(config.origin, token);
  return { config, api };
}

/** Send every session once, drawing progress, and print one line for the result. */
async function importWithProgress({
  config,
  api,
  clients = CLIENTS,
  archive = undefined,
}) {
  const sender = createSender({
    config,
    api,
    onlyNew: Boolean(archive),
    log: (line) => {
      clearProgress();
      console.error(dim(`    ${line}`));
    },
  });
  const report = await runImport({
    sender,
    clients,
    roots: archive ? { archive } : {},
    onProgress: (r, session) =>
      progress(
        `Sending existing sessions  ${r.done}/${r.found}  ${dim(`${NAMES[session.client]} · ${r.sent} sent · ${r.held + r.unchanged} already in Valise · ${r.failed} failed`)}`,
        { final: r.done === r.found },
      ),
  });
  clearProgress();
  const summary = `${report.found} found: ${report.sent} sent, ${report.held + report.unchanged} already in Valise, ${report.empty} empty`;
  if (report.failed)
    failed(
      `Sent existing sessions; ${report.failed} failed and ${archive ? "are sent if you run the same import again" : "are retried by the watcher"}`,
      summary,
    );
  else done("Sent existing sessions", summary);
  return report;
}

try {
  switch (command) {
    case undefined:
      await setupChecklist();
      break;
    case "login": {
      const result = await login({ origin: flag("origin") });
      done(`Signed in as device "${result.device}"`, result.file);
      console.error(`\n  Next: ${bold("valise install")}\n`);
      break;
    }
    case "logout":
      console.error(`Signed out. ${logout()} keeps the rest of the config.`);
      break;
    case "import": {
      const client = flag("client");
      const from = flag("from");
      if (from === true) throw new Error("--from needs a directory.");
      const known = from ? ARCHIVE_CLIENTS : CLIENTS;
      if (client && !known.includes(client))
        throw new Error(`--client is one of ${known.join(", ")}.`);
      heading(
        from
          ? `Sending sessions from ${from} to Valise`
          : "Sending sessions to Valise",
      );
      await importWithProgress({
        ...(await signedIn()),
        clients: client ? [client] : known,
        archive: from,
      });
      break;
    }
    case "watch": {
      // A watcher that exits on a lapsed sign-in would restart every 10 s
      // under launchd; it keeps watching and its passes retry instead.
      const config = readConfig();
      await accessToken(config).catch((error) =>
        console.error(`valise: ${error.message}`),
      );
      const api = transcriptsApi(
        config.origin,
        () => readConfig().auth?.access_token ?? "",
      );
      setInterval(
        () =>
          accessToken(readConfig()).catch((error) =>
            console.error(`valise: ${error.message}`),
          ),
        15 * 60 * 1000,
      ).unref();
      watchSessions({ sender: createSender({ config, api }) });
      break;
    }
    case "install": {
      heading("Setting up transcript capture");
      const { config, api } = await signedIn().catch(async (error) => {
        if (!(error instanceof SignInNeeded)) throw error;
        todo(error.reason, "opening the sign-in page");
        await login({ origin: flag("origin") });
        return signedIn();
      });
      done("Signed in", `${config.origin} as device "${config.device}"`);
      await importWithProgress({ config, api });
      const result = await install({
        script: realpathSync(fileURLToPath(import.meta.url)),
        step: done,
      });
      notice([
        "Every Claude Code, Codex and OpenCode session on this machine now goes to Valise,",
        "in any directory: your messages, assistant text, thinking, system prompts,",
        "tool names and tool errors. Successful tool output stays on this machine.",
        `Stop with ${bold("valise uninstall")}. Log: ${result.log}`,
      ]);
      break;
    }
    case "uninstall":
      heading("Stopping transcript capture");
      uninstall({ step: done });
      console.error(dim("\n  Sessions already sent stay in Valise.\n"));
      break;
    case "status": {
      const s = facts();
      console.log(
        [
          ["origin", s.config.origin],
          ["device", s.config.device],
          ["config", configPath()],
          ["signed in", s.config.auth ? "yes" : "no"],
          ["sessions sent", s.sent],
          ["login agent", s.installed ? LABEL : "not installed"],
          ["watcher", s.running ? `running, pid ${s.beat.pid}` : "not running"],
          [
            "last sent",
            s.beat?.last_sent_at
              ? new Date(s.beat.last_sent_at).toISOString()
              : "never",
          ],
        ]
          .map((row) => row.join("\t"))
          .join("\n"),
      );
      break;
    }
    default:
      console.error(
        "usage: valise [login|logout|install|uninstall|import|watch|status]",
      );
      process.exit(1);
  }
} catch (error) {
  clearProgress();
  console.error(`valise: ${error.message}`);
  process.exit(1);
}

function facts() {
  const config = readConfig();
  const beat = readHeartbeat();
  let sent = 0;
  try {
    sent = createSender({ config, api: null }).count();
  } catch {}
  return {
    config,
    beat,
    sent,
    installed: existsSync(paths().plist),
    running: Boolean(beat?.pid && alive(beat.pid)),
  };
}

function ago(ms) {
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 120) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

/** Each setup step, done or not, and the command that does the next one. */
async function setupChecklist() {
  const s = facts();
  heading("Valise transcript capture on this machine");
  const steps = [
    [
      Boolean(s.config.auth),
      "Signed in",
      s.config.auth ? s.config.origin : "valise login",
    ],
    [
      s.sent > 0,
      "Existing sessions sent",
      s.sent ? `${s.sent} sessions` : "valise install",
    ],
    [
      s.installed,
      "Watcher starts at login",
      s.installed ? LABEL : "valise install",
    ],
  ];
  for (const [ok, label, detail] of steps) (ok ? done : todo)(label, detail);
  if (s.installed) {
    if (s.running)
      done(
        "Watcher running",
        `pid ${s.beat.pid} · last sent ${s.beat.last_sent_at ? ago(s.beat.last_sent_at) : "nothing new yet"}`,
      );
    else
      failed("Watcher not running; sessions wait until it does", paths().log);
  }
  const next = steps.find(([ok]) => !ok);
  console.error(next ? `\n  Next: ${bold(next[2])}\n` : "");
}
