import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildCommit,
  decide,
  messageCommit,
  remoteHead,
  versionMessage,
} from "../scripts/deploy-head.mjs";

const older = "c".repeat(40);
const newer = "6".repeat(40);
const never = () => assert.fail("git is not consulted");

test("a build deploys only while its commit is the branch head", () => {
  assert.equal(decide({ sha: newer, head: newer }).deploy, true);
  const stale = decide({ sha: older, head: newer });
  assert.equal(stale.deploy, false);
  assert.match(stale.reason, /^superseded/);
  assert.match(stale.reason, new RegExp(newer));
});

test("a build that cannot read its commit or the branch head is an error", () => {
  assert.match(decide({ sha: older, head: null }).error, /unreachable/);
  assert.match(decide({ sha: null, head: newer }).error, /not a commit/);
});

test("the branch head is the sha ls-remote prints", () => {
  assert.equal(
    remoteHead("main", () => `${newer}\trefs/heads/main`),
    newer,
  );
  assert.equal(
    remoteHead("main", () => null),
    null,
  );
  assert.equal(
    remoteHead("main", () => ""),
    null,
  );
});

test("the version message names the commit and reads back", () => {
  assert.equal(versionMessage("main", newer), `main@${newer}`);
  assert.equal(messageCommit(versionMessage("main", newer)), newer);
  assert.equal(messageCommit(undefined), null);
  assert.equal(messageCommit("hand deploy"), null);
  assert.equal(versionMessage("main", null), null);
});

test("the build commit is Workers Builds' variable, then HEAD", () => {
  assert.equal(buildCommit({ WORKERS_CI_COMMIT_SHA: newer }, never), newer);
  assert.equal(buildCommit({ WORKERS_CI_COMMIT_SHA: "nope" }, never), null);
  assert.equal(
    buildCommit({}, () => older),
    older,
  );
  assert.equal(
    buildCommit({}, () => null),
    null,
  );
});

function fakeBuild(head) {
  const directory = mkdtempSync(join(tmpdir(), "valise-deploy-head-"));
  const calls = join(directory, "calls.jsonl");
  const applied = readdirSync("drizzle")
    .filter((name) => name.endsWith(".sql"))
    .map((name) => ({ name }));
  writeFileSync(
    join(directory, "git"),
    head
      ? `#!/bin/sh\n[ "$1" = ls-remote ] && echo "${head}\trefs/heads/main" && exit 0\nexit 1\n`
      : `#!/bin/sh\nexit 128\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(directory, "npx"),
    `#!/usr/bin/env node
    const fs = require('node:fs');
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
    if (process.argv.includes('execute')) console.log(${JSON.stringify(JSON.stringify([{ results: applied }]))});
  `,
    { mode: 0o755 },
  );
  writeFileSync(
    join(directory, "curl"),
    `#!/bin/sh
for a in "$@"; do last="$a"; done
case "$*" in *%{http_code}*) printf 401; exit 0;; esac
case "$last" in
  */health) echo '{"ok": true}';;
  */login) echo '<link rel="stylesheet">';;
  */oauth-protected-resource/mcp) echo '{"resource_name":"Valise","resource":"https://app.valise.run/mcp","authorization_servers":["https://app.valise.run"]}';;
esac
`,
    { mode: 0o755 },
  );
  const run = spawnSync("bash", ["scripts/deploy.sh"], {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      WORKERS_CI_BRANCH: "main",
      WORKERS_CI_COMMIT_SHA: older,
      VALISE_CONFIG: "",
    },
    encoding: "utf8",
  });
  let commands = [];
  try {
    commands = readFileSync(calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  } catch {}
  rmSync(directory, { recursive: true });
  return { run, commands };
}

test("a superseded build stops before migrations and succeeds", () => {
  const { run, commands } = fakeBuild(newer);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /superseded, nothing deployed/);
  assert.deepEqual(commands, []);
});

test("the head's build migrates, then deploys a version naming its commit", () => {
  const { run, commands } = fakeBuild(older);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(commands[0].includes("execute"));
  assert.deepEqual(commands.at(-1), [
    "wrangler",
    "deploy",
    "--message",
    `main@${older}`,
  ]);
});

test("a build that cannot read the branch head fails before migrations", () => {
  const { run, commands } = fakeBuild(null);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /branch head unreachable/);
  assert.doesNotMatch(run.stderr, /nothing deployed/);
  assert.deepEqual(commands, []);
});
