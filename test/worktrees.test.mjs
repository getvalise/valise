import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const script = resolve("scripts/worktrees.mjs");
const OLD = "2020-01-01T00:00:00Z";

let dir;
let repo;
let root;
let stubs;

async function git(cwd, args, date) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.test",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.test",
  };
  if (date) {
    env.GIT_AUTHOR_DATE = date;
    env.GIT_COMMITTER_DATE = date;
  }
  return (await exec("git", args, { cwd, env })).stdout;
}

// A worktree on a new branch with one commit, dated `date` when given.
async function worktree(name, { at = join(root, name), date } = {}) {
  await git(repo, ["worktree", "add", "-q", "-b", name, at, "main"]);
  await writeFile(join(at, `${name}.txt`), name);
  await git(at, ["add", "."]);
  await git(at, ["commit", "-q", "-m", name], date);
  return at;
}

async function cli(args, { lsof = "", worktreeRoot = root } = {}) {
  await writeFile(join(stubs, "lsof.out"), lsof);
  const env = {
    ...process.env,
    PATH: `${stubs}${delimiter}${process.env.PATH}`,
    VALISE_WORKTREE_ROOT: worktreeRoot,
  };
  if (worktreeRoot === null) delete env.VALISE_WORKTREE_ROOT;
  const { stdout } = await exec(process.execPath, [script, ...args], {
    cwd: repo,
    env,
  });
  return stdout;
}

before(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), "valise-worktrees-")));
  repo = join(dir, "repo");
  root = join(dir, "worktrees");
  stubs = join(dir, "bin");
  await mkdir(repo);
  await mkdir(root);
  await mkdir(stubs);

  // gh answers from a fixture and logs each call; lsof prints a canned file.
  await writeFile(
    join(stubs, "gh"),
    `#!/bin/sh\necho "$@" >> "${join(stubs, "gh.calls")}"\ncat <<'EOF'\n${JSON.stringify(
      [
        { number: 1, state: "MERGED", headRefName: "merged" },
        { number: 2, state: "CLOSED", headRefName: "closed" },
        { number: 3, state: "OPEN", headRefName: "open-old" },
        { number: 4, state: "MERGED", headRefName: "dirty-merged" },
        { number: 5, state: "MERGED", headRefName: "busy" },
        { number: 6, state: "MERGED", headRefName: "outside" },
      ],
    )}\nEOF\n`,
  );
  await writeFile(
    join(stubs, "lsof"),
    `#!/bin/sh\ncat "${join(stubs, "lsof.out")}"\n`,
  );
  await chmod(join(stubs, "gh"), 0o755);
  await chmod(join(stubs, "lsof"), 0o755);

  await git(repo, ["init", "-q", "-b", "main"]);
  await writeFile(join(repo, "README"), "repo\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "init"], OLD);
  await git(repo, ["update-ref", "refs/remotes/origin/main", "main"]);

  await worktree("merged");
  await worktree("closed");
  await worktree("open-old", { date: OLD });
  await worktree("idle", { date: OLD });
  await worktree("fresh");
  await worktree("busy");
  const dirty = await worktree("dirty-merged");
  await writeFile(join(dirty, "scratch.txt"), "uncommitted\n");
  await worktree("outside", { at: join(dir, "elsewhere", "outside") });
});

after(() => rm(dir, { recursive: true, force: true }));

test("list flags nothing as outside when no root is configured", async () => {
  const out = await cli(["list", "--json"], { worktreeRoot: null });
  assert.ok(JSON.parse(out).every((row) => row.outsideRoot === false));
});

test("list reports every worktree with dirt, divergence, PR and flags", async () => {
  await rm(join(stubs, "gh.calls"), { force: true });
  const out = await cli(["list", "--json"]);
  const rows = Object.fromEntries(
    JSON.parse(out).map((row) => [row.branch, row]),
  );

  assert.equal(Object.keys(rows).length, 9);
  assert.equal(rows.main.main, true);
  assert.equal(rows.main.outsideRoot, false);
  assert.deepEqual(rows["dirty-merged"].dirty, ["?? scratch.txt"]);
  assert.equal(rows.merged.dirty.length, 0);
  assert.equal(rows.merged.ahead, 1);
  assert.equal(rows.merged.behind, 0);
  assert.deepEqual(rows.closed.pr, { number: 2, state: "CLOSED" });
  assert.equal(rows.idle.pr, null);
  assert.ok(rows.idle.ageDays > 365);
  assert.equal(rows.outside.outsideRoot, true);
  assert.equal(rows.merged.outsideRoot, false);
  assert.equal(rows.merged.sizeKb, null);

  // One gh call covers every branch.
  const calls = (await exec("cat", [join(stubs, "gh.calls")])).stdout
    .trim()
    .split("\n");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /pr list --state all/);
});

test("list --size measures each worktree", async () => {
  const rows = JSON.parse(await cli(["list", "--size", "--json"]));
  assert.ok(rows.every((row) => row.sizeKb > 0));
});

test("prune --dry-run names what it would remove and removes nothing", async () => {
  const busy = join(root, "busy");
  const out = await cli(["prune", "--dry-run"], {
    lsof: `p1\nfcwd\nn${busy}/src\n`,
  });

  for (const name of ["merged", "closed", "idle"]) {
    assert.match(out, new RegExp(`would remove .*/${name} `));
    assert.ok(existsSync(join(root, name)));
  }
  assert.match(out, /keep .*\/repo +\(main checkout\)/);
  assert.match(out, /keep .*\/open-old +\(PR #3 open\)/);
  assert.match(out, /keep .*\/fresh +\(active/);
  assert.match(out, /keep .*\/busy +\(a process is running inside it\)/);
  assert.match(out, /keep .*\/dirty-merged +\(dirty files: 1\)/);
  assert.match(out, /would remove .*\/outside /);
});

test("prune removes clean finished worktrees and keeps branch refs", async () => {
  const busy = join(root, "busy");
  const out = await cli(["prune"], { lsof: `p1\nfcwd\nn${busy}\n` });

  assert.match(out, /removed 4 of 9 worktrees/);
  for (const name of ["merged", "closed", "idle"]) {
    assert.equal(existsSync(join(root, name)), false);
  }
  assert.equal(existsSync(join(dir, "elsewhere", "outside")), false);
  for (const name of ["open-old", "fresh", "busy", "dirty-merged"]) {
    assert.ok(existsSync(join(root, name)), name);
  }
  assert.ok(existsSync(join(root, "dirty-merged", "scratch.txt")));
  const branches = await git(repo, ["branch", "--format=%(refname:short)"]);
  for (const name of ["merged", "closed", "idle", "outside"]) {
    assert.match(branches, new RegExp(`^${name}$`, "m"));
  }
});

test("prune --delete-merged-branches drops merged branches only", async () => {
  // busy's process has gone (merged PR #5); closed gets a worktree again.
  await git(repo, ["worktree", "add", "-q", join(root, "closed"), "closed"]);
  const out = await cli(["prune", "--delete-merged-branches"]);

  assert.match(out, /deleted branch busy/);
  assert.equal(existsSync(join(root, "busy")), false);
  assert.equal(existsSync(join(root, "closed")), false);
  const branches = await git(repo, ["branch", "--format=%(refname:short)"]);
  assert.doesNotMatch(branches, /^busy$/m);
  assert.match(branches, /^closed$/m);
  assert.match(branches, /^dirty-merged$/m);
});

test("prune keeps everything when gh or lsof cannot answer", async () => {
  const at = await worktree("idle-2", { date: OLD });
  await writeFile(join(stubs, "gh"), "#!/bin/sh\nexit 1\n");
  const out = await cli(["prune"]);
  assert.match(out, /keep .*\/idle-2 +\(PR state unknown/);
  assert.ok(existsSync(at));

  await writeFile(join(stubs, "lsof"), "#!/bin/sh\nexit 2\n");
  const out2 = await cli(["prune"]);
  assert.match(out2, /keep .*\/idle-2 +\(lsof unavailable\)/);
});
