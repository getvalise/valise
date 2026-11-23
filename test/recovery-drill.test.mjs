import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { drillRunner, readD1Batch } from "./helpers/recovery-drill.mjs";

test("real D1 assertion batches preserve separate empty results and refuse incomplete/failed replies", async () => {
  const root = await mkdtemp(join(tmpdir(), "recovery-batch-test-"));
  try {
    const statements = ["SELECT 'first' AS value", "SELECT 1 WHERE 0"];
    const run = async (args) => {
      assert.ok(args.includes("--local"));
      assert.ok(args.includes("--json"));
      assert.ok(!args.includes("--command"));
      const sql = await readFile(args[args.indexOf("--file") + 1], "utf8");
      assert.equal(sql, statements.map((s) => `${s};`).join("\n"));
      return JSON.stringify([
        { success: true, results: [{ value: "first" }] },
        { success: true, results: [] },
      ]);
    };
    assert.deepEqual(
      await readD1Batch(run, "synthetic-config", root, statements),
      [[{ value: "first" }], []],
    );
    for (const response of [
      [],
      [{ results: [] }],
      [{ success: false, results: [] }, { results: [] }],
      [{ results: null }, { results: [] }],
    ])
      await assert.rejects(
        readD1Batch(
          async () => JSON.stringify(response),
          "synthetic-config",
          root,
          statements,
        ),
        /missing or failed/,
      );
    await assert.rejects(
      readD1Batch(
        async () => {
          throw new Error("synthetic command failure");
        },
        "synthetic-config",
        root,
        statements,
      ),
      /synthetic command failure/,
    );
    assert.deepEqual(
      await readdir(root),
      [],
      "all SQL files cleaned after success or refusal",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("aborting a drill stops its child group before cleanup and refuses later commands", {
  timeout: 8_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "recovery-abort-test-"));
  const marker = join(root, "ticks");
  const controller = new AbortController();
  const runtime = drillRunner(controller.signal, { prefix: [] });
  let command;
  try {
    // Both parent and descendant ignore TERM, so the finite KILL escalation is exercised.
    const descendant = `process.on('SIGTERM',()=>{}); const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)},'ready'); setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'.'),20);`;
    const parent = `process.on('SIGTERM',()=>{}); require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']}); setInterval(()=>{},1000);`;
    command = runtime.run(["-e", parent]);
    const rejected = assert.rejects(command, /Recovery drill aborted/);
    for (let i = 0; i < 100; i++) {
      if (await readFile(marker, "utf8").catch(() => "")) break;
      await delay(10);
    }
    assert.ok((await readFile(marker, "utf8")).startsWith("ready"));
    controller.abort();
    await rejected;
    await runtime.close();
    const stopped = await readFile(marker, "utf8");
    await delay(100);
    assert.equal(
      await readFile(marker, "utf8"),
      stopped,
      "no descendant writes after runner completion",
    );
    await assert.rejects(runtime.run(["-e", "process.exit(0)"]), /abort/i);
  } finally {
    controller.abort();
    await runtime.close();
    await command?.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
