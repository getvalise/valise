// Whether this build's commit may deploy, and how the deployment names it.
//
// Workers Builds runs one build per push, concurrently, and whichever finishes
// last deploys. On 2026-11-01 the build for cbc05cf (#277) finished four
// minutes after the build for 6a4ef19 (#278) and put production back on the
// older commit. deploy.sh asks this script first and skips the whole deploy,
// migrations included, when a newer commit has reached the branch: that
// commit's own build deploys it.
//
//   node scripts/deploy-head.mjs check <branch>
//     prints `deploy` or `skip` and exits 0, with the reason on stderr. In a
//     Workers Build that cannot read its commit or the branch head, it exits 1
//     and prints nothing: the build fails and nothing is migrated or deployed.
//     Outside a Workers Build (a self-host or staging deploy by hand) there is
//     no build commit to compare, and it prints `deploy`.
//   node scripts/deploy-head.mjs message <branch>
//     the version message wrangler deploy records: `<branch>@<sha>`.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const MESSAGE = /@([0-9a-f]{40})\b/;

/** The commit this build serves: Workers Builds' WORKERS_CI_COMMIT_SHA, else HEAD. */
export function buildCommit(env = process.env, git = runGit) {
  const sha = env.WORKERS_CI_COMMIT_SHA?.trim().toLowerCase();
  if (sha) return SHA.test(sha) ? sha : null;
  const head = git(["rev-parse", "HEAD"]);
  return head && SHA.test(head) ? head : null;
}

export function versionMessage(branch, sha) {
  return sha ? `${branch}@${sha}` : null;
}

/** The commit a version message names, or null for a version deployed before this. */
export function messageCommit(message) {
  return MESSAGE.exec(message ?? "")?.[1] ?? null;
}

/**
 * The decision for a Workers Build. `sha` is the build's commit and `head` the
 * branch's head on the remote; either is null when it could not be read, and
 * then the build fails rather than guess (owner's decision, 2026-11-03).
 */
export function decide({ sha, head }) {
  if (!sha) return { error: "WORKERS_CI_COMMIT_SHA is not a commit sha" };
  if (!head)
    return {
      error: `branch head unreachable (git ls-remote origin); not deploying ${sha}`,
    };
  return head === sha
    ? { deploy: true, reason: `${sha} is the branch head` }
    : {
        deploy: false,
        reason: `superseded: ${sha} is no longer the branch head; ${head} is, and its build deploys it`,
      };
}

function runGit(args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
  } catch {
    return null;
  }
}

export function remoteHead(branch, git = runGit) {
  const line = git(["ls-remote", "origin", `refs/heads/${branch}`]);
  const sha = line?.split(/\s+/)[0];
  return sha && SHA.test(sha) ? sha : null;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, branch] = process.argv.slice(2);
  if (command === "message" && branch) {
    const message = versionMessage(branch, buildCommit());
    if (message) console.log(message);
  } else if (command === "check" && branch) {
    if (!process.env.WORKERS_CI_COMMIT_SHA) {
      console.error("deploy: not a Workers Build; no branch head to compare");
      console.log("deploy");
    } else {
      const verdict = decide({ sha: buildCommit(), head: remoteHead(branch) });
      if (verdict.error) {
        console.error(`deploy: ${verdict.error}`);
        process.exit(1);
      }
      console.error(`deploy: ${verdict.reason}`);
      console.log(verdict.deploy ? "deploy" : "skip");
    }
  } else {
    console.error("usage: deploy-head.mjs check|message <branch>");
    process.exit(2);
  }
}
