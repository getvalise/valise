import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Test-only, config-relative Wrangler runner. No SQL, paths or credentials in timing output. */
export function drillRunner(
  signal,
  {
    executable = process.execPath,
    prefix = [resolve("node_modules/wrangler/bin/wrangler.js")],
  } = {},
) {
  const started = performance.now();
  const commands = [];
  let active;
  const run = async (args) => {
    signal.throwIfAborted();
    const before = performance.now();
    const label =
      args[0] === "-e"
        ? "synthetic child"
        : args.slice(0, args[0] === "r2" ? 3 : 2).join(" ");
    try {
      return await new Promise((resolve, reject) => {
        const grouped = process.platform !== "win32";
        const child = spawn(executable, [...prefix, ...args], {
          detached: grouped,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        });
        let stdout = "";
        let size = 0;
        let failure;
        let escalation;
        const kill = (name) => {
          if (!child.pid) return;
          try {
            if (grouped) process.kill(-child.pid, name);
            else child.kill(name);
          } catch (error) {
            // macOS answers EPERM, not ESRCH, for a group whose members
            // have all exited but are not yet reaped.
            if (error.code !== "ESRCH" && error.code !== "EPERM") throw error;
          }
        };
        const stop = (reason) => {
          if (failure) return;
          failure = reason;
          kill("SIGTERM");
          escalation = setTimeout(() => kill("SIGKILL"), 2_000);
        };
        const aborted = () => stop(new Error("Recovery drill aborted"));
        const timeout = setTimeout(
          () => stop(new Error("Wrangler command exceeded 300s")),
          300_000,
        );
        active = {
          stop,
          exited: new Promise((done) => child.once("close", done)),
        };
        signal.addEventListener("abort", aborted, { once: true });
        // Abort may race the listener registration, before spawn has returned.
        if (signal.aborted) aborted();
        child.stdout.on("data", (chunk) => {
          size += chunk.length;
          if (size > 32 * 1024 * 1024)
            stop(new Error("Wrangler output exceeded 32MiB"));
          else stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          size += chunk.length;
          if (size > 32 * 1024 * 1024)
            stop(new Error("Wrangler output exceeded 32MiB"));
        });
        child.once("error", () => stop(new Error(`Could not start ${label}`)));
        child.once("close", (code, exitSignal) => {
          clearTimeout(timeout);
          clearTimeout(escalation);
          signal.removeEventListener("abort", aborted);
          // A terminated Wrangler may leave a descendant after its own exit.
          if (failure) kill("SIGKILL");
          active = undefined;
          if (failure) reject(failure);
          else if (code !== 0)
            reject(new Error(`${label} failed (${exitSignal ?? code})`));
          else resolve(stdout);
        });
      });
    } finally {
      commands.push({
        command: label,
        ms: Math.round(performance.now() - before),
      });
    }
  };
  const stage = async (name, work) => {
    const before = performance.now();
    const count = commands.length;
    try {
      return await work();
    } finally {
      console.log(
        `Recovery timing: ${JSON.stringify({ stage: name, ms: Math.round(performance.now() - before), wranglerCommands: commands.length - count })}`,
      );
    }
  };
  return {
    run,
    stage,
    async close() {
      if (active) {
        const { exited, stop } = active;
        stop(new Error("Recovery drill cleanup"));
        await exited;
      }
      const byCommand = {};
      for (const { command, ms } of commands) {
        const entry = (byCommand[command] ??= { calls: 0, ms: 0 });
        entry.calls++;
        entry.ms += ms;
      }
      console.log(
        `Recovery timing: ${JSON.stringify({ stage: "total", ms: Math.round(performance.now() - started), wranglerCommands: commands.length, byCommand })}`,
      );
    },
  };
}

/** Each assertion keeps its own result set; no combined counts or swallowed errors. */
export async function readD1Batch(run, config, directory, statements) {
  if (!statements.length) return [];
  const path = join(directory, `assertions-${randomUUID()}.sql`);
  try {
    await writeFile(
      path,
      statements.map((sql) => `${sql.replace(/;\s*$/, "")};`).join("\n"),
      { mode: 0o600 },
    );
    const replies = JSON.parse(
      await run([
        "d1",
        "execute",
        "DB",
        "--config",
        config,
        "--local",
        "--json",
        "--file",
        path,
      ]),
    );
    if (
      !Array.isArray(replies) ||
      replies.length !== statements.length ||
      replies.some(
        (reply) => reply.success === false || !Array.isArray(reply.results),
      )
    )
      throw new Error(
        "Recovery assertion batch returned missing or failed result sets",
      );
    return replies.map((reply) => reply.results);
  } finally {
    await rm(path, { force: true });
  }
}
