import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runStages } from "../scripts/run-stages.mjs";

test("build timings retain sequential order, fail-fast exit and the strict CI subset", async () => {
  const calls = [];
  const logs = [];
  assert.equal(
    await runStages(
      ["first", "fails", "never"],
      async (name) => {
        calls.push(name);
        return name === "fails" ? 7 : 0;
      },
      (line) => logs.push(line),
    ),
    7,
  );
  assert.deepEqual(calls, ["first", "fails"]);
  assert.equal(logs.length, 3);
  const timings = logs.map((line) =>
    JSON.parse(line.slice("Build timing: ".length)),
  );
  assert.deepEqual(
    timings.map(({ stage, exit }) => ({ stage, exit })),
    [
      { stage: "first", exit: 0 },
      { stage: "fails", exit: 7 },
      { stage: "total", exit: 7 },
    ],
  );
  assert.ok(timings.every(({ ms }) => Number.isFinite(ms) && ms >= 0));
  const { scripts } = JSON.parse(await readFile("package.json", "utf8"));
  // The full gate runs under the machine-wide lock; verify:ci, which the
  // Workers Build runs, does not take it.
  assert.equal(
    scripts.verify,
    'node scripts/verify-lock.mjs "npm run verify:ci && npm run test:ui"',
  );
  assert.equal(
    scripts["verify:ci"],
    "node scripts/run-stages.mjs css:build lint+typecheck+db:audit test:d1+test:mcp test:clients",
  );
  assert.match(scripts["test:clients"], /test\/backup\.test\.mjs/);
  // verify:ci is verify minus the browser suite, so a green verify never
  // hides a red build.
  assert.equal(scripts["test:ui"], "playwright test");
  assert.equal(
    scripts.build,
    "node scripts/run-stages.mjs css:build build:bundle",
  );
  assert.equal(scripts["build:bundle"], "react-router build");
});

test("a + stage runs its scripts at once and fails after all of them finish", async () => {
  const running = new Set();
  let overlap = 0;
  const finished = [];
  const logs = [];
  const exit = await runStages(
    ["first", "a+b+c", "never"],
    async (name, { concurrent }) => {
      assert.equal(concurrent, name !== "first");
      running.add(name);
      overlap = Math.max(overlap, running.size);
      await new Promise((done) => setTimeout(done, name === "b" ? 5 : 20));
      running.delete(name);
      finished.push(name);
      return name === "b" ? 3 : 0;
    },
    (line) => logs.push(JSON.parse(line.slice("Build timing: ".length))),
  );
  assert.equal(exit, 3);
  assert.equal(overlap, 3);
  assert.deepEqual(finished.sort(), ["a", "b", "c", "first"]);
  assert.deepEqual(logs.map(({ stage, exit }) => ({ stage, exit })).at(-1), {
    stage: "total",
    exit: 3,
  });
  assert.equal(logs.length, 5);
});
