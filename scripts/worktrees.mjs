#!/usr/bin/env node
// Lists and prunes the worktrees of this repository.
//
//   node scripts/worktrees.mjs list [--size] [--json]
//   node scripts/worktrees.mjs prune [--dry-run] [--delete-merged-branches]
//
// Set VALISE_WORKTREE_ROOT to flag worktrees outside the directory you keep
// them in; without it nothing is flagged. Ahead/behind is against the local origin/main ref,
// so run `git fetch origin` first for current numbers.
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const DAY = 86_400;
export const IDLE_DAYS = 7;
const BASE = "origin/main";

export function standardRoot(env = process.env) {
  return env.VALISE_WORKTREE_ROOT ? real(env.VALISE_WORKTREE_ROOT) : null;
}

function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function inside(path, root) {
  return path === root || path.startsWith(root + sep);
}

async function run(cmd, args, cwd) {
  const { stdout } = await exec(cmd, args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

const git = (cwd, ...args) => run("git", args, cwd);

export function parsePorcelain(text) {
  const entries = [];
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n").filter(Boolean);
    if (lines.length === 0) continue;
    const entry = { path: "", head: null, branch: null, locked: false };
    for (const line of lines) {
      const [key, ...rest] = line.split(" ");
      const value = rest.join(" ");
      if (key === "worktree") entry.path = value;
      else if (key === "HEAD") entry.head = value;
      else if (key === "branch")
        entry.branch = value.replace("refs/heads/", "");
      else if (key === "locked") entry.locked = true;
      else if (key === "bare") entry.bare = true;
    }
    entries.push(entry);
  }
  return entries;
}

// One gh call for every branch. A failure returns null, which callers treat
// as "PR state unknown", never as "no PR".
export async function pullRequests(cwd) {
  try {
    const out = await run(
      "gh",
      [
        "pr",
        "list",
        "--state",
        "all",
        "--limit",
        "1000",
        "--json",
        "number,state,headRefName",
      ],
      cwd,
    );
    const byBranch = new Map();
    for (const pr of JSON.parse(out)) {
      const seen = byBranch.get(pr.headRefName);
      // An open PR wins; otherwise the newest one.
      if (
        !seen ||
        (pr.state === "OPEN" && seen.state !== "OPEN") ||
        (seen.state !== "OPEN" && pr.number > seen.number)
      ) {
        byBranch.set(pr.headRefName, { number: pr.number, state: pr.state });
      }
    }
    return byBranch;
  } catch {
    return null;
  }
}

// Paths that are some process's working directory. One lsof call for the
// whole machine. Null means lsof is unavailable, so liveness is unknown.
export async function liveDirectories() {
  try {
    const out = await run("lsof", ["-a", "-d", "cwd", "-Fn"]);
    return out
      .split("\n")
      .filter((line) => line.startsWith("n/"))
      .map((line) => real(line.slice(1)));
  } catch (error) {
    // lsof exits 1 when some processes cannot be inspected; keep what it saw.
    if (typeof error.stdout === "string" && error.stdout.length > 0) {
      return error.stdout
        .split("\n")
        .filter((line) => line.startsWith("n/"))
        .map((line) => real(line.slice(1)));
    }
    return null;
  }
}

async function inspect(entry, ctx) {
  const path = real(entry.path);
  const row = {
    path: entry.path,
    branch: entry.branch,
    main: entry === ctx.main,
    locked: entry.locked,
    missing: !existsSync(entry.path),
    outsideRoot: false,
    dirty: [],
    ahead: null,
    behind: null,
    pr: null,
    ageDays: null,
    sizeKb: null,
    live: false,
  };
  row.outsideRoot = ctx.root !== null && !row.main && !inside(path, ctx.root);
  if (ctx.prs === null) row.pr = "unknown";
  else if (entry.branch) row.pr = ctx.prs.get(entry.branch) ?? null;
  row.live =
    ctx.live === null ? "unknown" : ctx.live.some((dir) => inside(dir, path));
  if (row.missing) return row;

  row.dirty = (await git(entry.path, "status", "--porcelain=v1"))
    .split("\n")
    .filter(Boolean);
  if (entry.head) {
    const committed = Number(
      (await git(ctx.repo, "log", "-1", "--format=%ct", entry.head)).trim(),
    );
    row.ageDays = Math.floor((ctx.now - committed) / DAY);
    if (ctx.hasBase) {
      const [behind, ahead] = (
        await git(
          ctx.repo,
          "rev-list",
          "--left-right",
          "--count",
          `${BASE}...${entry.head}`,
        )
      )
        .trim()
        .split(/\s+/)
        .map(Number);
      row.ahead = ahead;
      row.behind = behind;
    }
  }
  if (ctx.size) {
    row.sizeKb = Number((await run("du", ["-sk", entry.path])).split(/\s/)[0]);
  }
  return row;
}

export async function collect({ cwd = process.cwd(), size = false } = {}) {
  const repo = (
    await git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")
  ).trim();
  const entries = parsePorcelain(
    await git(cwd, "worktree", "list", "--porcelain"),
  );
  const main = entries[0];
  const hasBase = await git(
    main.path,
    "rev-parse",
    "--verify",
    "--quiet",
    BASE,
  ).then(
    () => true,
    () => false,
  );
  const [prs, live] = await Promise.all([
    pullRequests(main.path),
    liveDirectories(),
  ]);
  const ctx = {
    repo,
    main,
    root: standardRoot(),
    prs,
    live,
    hasBase,
    size,
    now: Math.floor(Date.now() / 1000),
  };
  return Promise.all(entries.map((entry) => inspect(entry, ctx)));
}

// Why a worktree stays, or null when prune may remove it.
export function keepReason(row) {
  if (row.main) return "main checkout";
  if (row.missing) return "directory missing; run git worktree prune";
  if (row.locked) return "locked";
  if (row.dirty.length > 0) return `dirty files: ${row.dirty.length}`;
  if (row.live === "unknown") return "lsof unavailable";
  if (row.live) return "a process is running inside it";
  if (row.pr === "unknown") return "PR state unknown (gh failed)";
  if (row.pr?.state === "MERGED" || row.pr?.state === "CLOSED") return null;
  if (row.pr?.state === "OPEN") return `PR #${row.pr.number} open`;
  if (row.ageDays === null || row.ageDays <= IDLE_DAYS) {
    return `active, last commit ${row.ageDays ?? "?"}d ago`;
  }
  return null;
}

function removeReason(row) {
  if (row.pr?.state === "MERGED") return `PR #${row.pr.number} merged`;
  if (row.pr?.state === "CLOSED") return `PR #${row.pr.number} closed`;
  return `idle ${row.ageDays}d, no PR`;
}

export async function prune({
  cwd = process.cwd(),
  dryRun = false,
  deleteMergedBranches = false,
  log = console.log,
} = {}) {
  const rows = await collect({ cwd });
  const main = rows.find((row) => row.main).path;
  const removed = [];
  for (const row of rows) {
    const keep = keepReason(row);
    if (keep) {
      log(`keep    ${row.path}  (${keep})`);
      continue;
    }
    const why = removeReason(row);
    const dropBranch =
      deleteMergedBranches && row.branch && row.pr?.state === "MERGED";
    if (dryRun) {
      log(
        `would remove ${row.path}  (${why})${dropBranch ? `, and branch ${row.branch}` : ""}`,
      );
      removed.push(row);
      continue;
    }
    // No --force: git refuses a worktree that turned dirty since collect().
    try {
      await git(main, "worktree", "remove", row.path);
    } catch (error) {
      log(`failed  ${row.path}  (${error.stderr?.trim() || error.message})`);
      continue;
    }
    log(`removed ${row.path}  (${why})`);
    if (dropBranch) {
      // Squash merges leave the branch unmerged in git's eyes, hence -D.
      await git(main, "branch", "-D", row.branch);
      log(`deleted branch ${row.branch}`);
    }
    removed.push(row);
  }
  log(
    `${dryRun ? "would remove" : "removed"} ${removed.length} of ${rows.length} worktrees`,
  );
  return removed;
}

function formatRow(row) {
  const pr =
    row.pr === "unknown"
      ? "pr?"
      : row.pr
        ? `#${row.pr.number} ${row.pr.state.toLowerCase()}`
        : "no pr";
  const flags = [
    row.main && "main",
    row.outsideRoot && "OUTSIDE ROOT",
    row.locked && "locked",
    row.missing && "missing",
    row.live === true && "live",
  ].filter(Boolean);
  return [
    row.path,
    row.branch ?? "(detached)",
    `dirty ${row.dirty.length}`,
    row.ahead === null ? "+?/-?" : `+${row.ahead}/-${row.behind}`,
    pr,
    row.ageDays === null ? "?" : `${row.ageDays}d`,
    row.sizeKb === null ? null : `${Math.round(row.sizeKb / 1024)}MB`,
    flags.length ? `[${flags.join(", ")}]` : null,
  ]
    .filter((cell) => cell !== null)
    .join("  ");
}

export async function list({
  cwd = process.cwd(),
  size = false,
  json = false,
  log = console.log,
} = {}) {
  const rows = await collect({ cwd, size });
  if (json) {
    log(JSON.stringify(rows, null, 2));
    return rows;
  }
  for (const row of rows) {
    log(formatRow(row));
    for (const file of row.dirty) log(`    ${file}`);
  }
  const outside = rows.filter((row) => row.outsideRoot).length;
  const root = standardRoot();
  log(
    `${rows.length} worktrees, ${rows.filter((row) => row.dirty.length).length} dirty${root ? `, ${outside} outside ${root}` : ""}`,
  );
  return rows;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [command, ...flags] = process.argv.slice(2);
  const has = (flag) => flags.includes(flag);
  if (command === "list") {
    await list({ size: has("--size"), json: has("--json") });
  } else if (command === "prune") {
    await prune({
      dryRun: has("--dry-run"),
      deleteMergedBranches: has("--delete-merged-branches"),
    });
  } else {
    console.error(
      "usage: worktrees.mjs list [--size] [--json] | prune [--dry-run] [--delete-merged-branches]",
    );
    process.exit(2);
  }
}
