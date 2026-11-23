import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/*
 * One full `npm run verify` per machine at a time, across every worktree.
 * Parallel full runs each start a Playwright worker pool with its own
 * `wrangler dev` per worker, and together they push an 8-core Mac past a
 * load of 40, where UI specs time out on load verify itself created.
 * The lock is a directory, because mkdir is atomic; a holder whose process
 * is gone is cleared by the next caller. `verify:ci`, which the Workers
 * Build runs, does not take it.
 */

export const LOCK_DIR =
  process.env.VALISE_VERIFY_LOCK_DIR ??
  join(homedir(), ".valise", "verify.lock");

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function holder(dir) {
  try {
    return JSON.parse(await readFile(join(dir, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Takes the lock, waiting while a live process holds it. Returns a release
 * function. A lock with no readable owner is cleared once it is older than
 * `orphanMs`, which covers a holder killed between mkdir and writing owner.json.
 */
export async function acquire(
  dir = LOCK_DIR,
  {
    pid = process.pid,
    pollMs = 2_000,
    orphanMs = 10_000,
    log = console.error,
    now = Date.now,
  } = {},
) {
  await mkdir(resolve(dir, ".."), { recursive: true });
  let announced = null;
  let firstOrphanAt = null;
  for (;;) {
    try {
      await mkdir(dir);
      await writeFile(
        join(dir, "owner.json"),
        JSON.stringify({ pid, cwd: process.cwd(), started: now() }),
      );
      return async () => {
        const owner = await holder(dir);
        if (owner?.pid === pid) await rm(dir, { recursive: true, force: true });
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const owner = await holder(dir);
    if (owner && !alive(owner.pid)) {
      await rm(dir, { recursive: true, force: true });
      continue;
    }
    if (!owner) {
      firstOrphanAt ??= now();
      if (now() - firstOrphanAt >= orphanMs) {
        await rm(dir, { recursive: true, force: true });
        firstOrphanAt = null;
        continue;
      }
    } else {
      firstOrphanAt = null;
      if (announced !== owner.pid) {
        announced = owner.pid;
        const since = new Date(owner.started).toISOString();
        log(
          `verify-lock: waiting for the full verify held by pid ${owner.pid} in ${owner.cwd}, since ${since}`,
        );
      }
    }
    await new Promise((done) => setTimeout(done, pollMs));
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const command = process.argv.slice(2).join(" ");
  if (!command) throw new Error("Supply the command to run under the lock");
  const waited = Date.now();
  const release = await acquire();
  const waitMs = Date.now() - waited;
  if (waitMs > 1_000)
    console.error(`verify-lock: acquired after ${Math.round(waitMs / 1000)} s`);
  const child = spawn(command, { shell: true, stdio: "inherit" });
  const forward = (signal) => child.kill(signal);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.on(signal, forward);
  const code = await new Promise((done) =>
    child.once("close", (exit, signal) => done(exit ?? (signal ? 1 : 0))),
  );
  await release();
  process.exitCode = code;
}
