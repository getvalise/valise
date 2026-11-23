import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runNode, runUiTestServer } from "../scripts/ui-test-server.mjs";

test("consecutive suites get fresh state and never remove inherited state", async () => {
  const inherited = await mkdtemp(join(tmpdir(), "valise-ui-sentinel-"));
  const previous = process.env.VALISE_STATE;
  const states = [];
  process.env.VALISE_STATE = inherited;
  try {
    await writeFile(join(inherited, "sentinel"), "do not remove");
    for (let run = 0; run < 2; run++) {
      let state;
      let calls = 0;
      await runUiTestServer({
        port: 4321,
        signal: new AbortController().signal,
        run: async (args, { env }) => {
          assert.equal(env.VALISE_UI_TEST, "1");
          assert.equal(env.VALISE_RERANK, "off");
          assert.equal(process.env.VALISE_STATE, inherited);
          calls++;
          if (calls === 1) {
            state = args.at(-1);
            states.push(state);
            assert.notEqual(state, inherited);
            assert.deepEqual(args.slice(1, -1), [
              "d1",
              "migrations",
              "apply",
              "DB",
              "--local",
              "--persist-to",
            ]);
            assert.equal(env.VALISE_STATE, state);
            await assert.rejects(access(join(state, "old-run")));
            await writeFile(join(state, "old-run"), "dirty");
          } else {
            assert.equal(env.VALISE_STATE, state);
            assert.equal(args[0], "--conditions=development");
            assert.deepEqual(args.slice(2), [
              "dev",
              "--port",
              "4321",
              "--strictPort",
            ]);
            // The child still has its state until it exits.
            await access(join(state, "old-run"));
          }
        },
      });
      assert.equal(calls, 2);
      await assert.rejects(access(state));
      assert.equal(
        await readFile(join(inherited, "sentinel"), "utf8"),
        "do not remove",
      );
    }
    assert.notEqual(states[0], states[1]);
  } finally {
    if (previous === undefined) delete process.env.VALISE_STATE;
    else process.env.VALISE_STATE = previous;
    await rm(inherited, { recursive: true, force: true });
  }
});

for (const stage of [1, 2]) {
  test(`removes only its own directory when command ${stage} fails`, async () => {
    const failure = new Error("command failed");
    let state;
    let calls = 0;
    await assert.rejects(
      runUiTestServer({
        port: 4321,
        signal: new AbortController().signal,
        run: async (_args, { env }) => {
          state = env.VALISE_STATE;
          await access(state);
          if (++calls === stage) throw failure;
        },
      }),
      failure,
    );
    assert.equal(calls, stage);
    await assert.rejects(access(state));
  });
}

test("shutdown during migration cleans state without starting a server", async () => {
  const controller = new AbortController();
  let state;
  let calls = 0;
  await runUiTestServer({
    port: 4321,
    signal: controller.signal,
    run: async (_args, { env }) => {
      state = env.VALISE_STATE;
      calls++;
      controller.abort();
    },
  });
  assert.equal(calls, 1);
  await assert.rejects(access(state));
});

test("publishes only an owned local fixture descriptor and removes it with the server state", async () => {
  const root = await mkdtemp(join(tmpdir(), "valise-ui-descriptor-"));
  const stateFile = join(root, "state.json");
  let state;
  try {
    await runUiTestServer({
      port: 4321,
      stateFile,
      signal: new AbortController().signal,
      run: async (_args, { env }) => {
        const descriptor = JSON.parse(await readFile(stateFile, "utf8"));
        state = descriptor.state;
        assert.equal(descriptor.pid, process.pid);
        assert.equal(descriptor.state, env.VALISE_STATE);
        await access(state);
      },
    });
    await assert.rejects(access(stateFile));
    await assert.rejects(access(state));
    await writeFile(stateFile, "do not overwrite another descriptor");
    await assert.rejects(
      runUiTestServer({
        port: 4321,
        stateFile,
        signal: new AbortController().signal,
        run: async () =>
          assert.fail("must not start with an unowned descriptor"),
      }),
      /EEXIST/,
    );
    assert.equal(
      await readFile(stateFile, "utf8"),
      "do not overwrite another descriptor",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("waits for an aborted child to exit before resolving", async () => {
  const controller = new AbortController();
  const child = runNode(["-e", "setInterval(() => {}, 1000)"], {
    env: process.env,
    signal: controller.signal,
  });
  controller.abort();
  await child;
});

test("propagates a failed child command", async () => {
  await assert.rejects(
    runNode(["-e", "process.exit(23)"], {
      env: process.env,
      signal: new AbortController().signal,
    }),
    /exited with code 23/,
  );
});
