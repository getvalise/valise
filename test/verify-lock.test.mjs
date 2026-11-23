import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquire } from "../scripts/verify-lock.mjs";

const scratch = () => mkdtemp(join(tmpdir(), "valise-verify-lock-"));
const quiet = { pollMs: 10, log: () => {} };

test("a second caller waits until the first releases", async () => {
  const dir = join(await scratch(), "verify.lock");
  const release = await acquire(dir, quiet);
  const order = [];
  const second = acquire(dir, { ...quiet, pid: process.pid }).then((r) => {
    order.push("second");
    return r;
  });
  await new Promise((done) => setTimeout(done, 50));
  order.push("first released");
  await release();
  await (await second)();
  assert.deepEqual(order, ["first released", "second"]);
  await assert.rejects(stat(dir), { code: "ENOENT" });
});

test("a holder whose process is gone is cleared", async () => {
  const dir = join(await scratch(), "verify.lock");
  const dead = spawn(process.execPath, ["-e", ""]);
  await new Promise((done) => dead.once("exit", done));
  await mkdir(dir);
  await writeFile(
    join(dir, "owner.json"),
    JSON.stringify({ pid: dead.pid, cwd: "/gone", started: 0 }),
  );
  const release = await acquire(dir, quiet);
  const owner = JSON.parse(await readFile(join(dir, "owner.json"), "utf8"));
  assert.equal(owner.pid, process.pid);
  await release();
});

test("a lock with no owner file is cleared once it is older than orphanMs", async () => {
  const dir = join(await scratch(), "verify.lock");
  await mkdir(dir);
  let clock = 0;
  const release = await acquire(dir, {
    ...quiet,
    orphanMs: 100,
    now: () => (clock += 60),
  });
  assert.ok(clock >= 100);
  await release();
});

test("the waiting message names the live holder once", async () => {
  const dir = join(await scratch(), "verify.lock");
  const release = await acquire(dir, quiet);
  const lines = [];
  const waiting = acquire(dir, { ...quiet, log: (line) => lines.push(line) });
  await new Promise((done) => setTimeout(done, 60));
  await release();
  await (await waiting)();
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`held by pid ${process.pid} in `));
});
