import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Runs npm scripts in order and stops at the first failure, like &&, with
 * wall time even on a failed stage. A stage written `a+b+c` runs its scripts
 * at once; it fails if any of them fails, after all of them have finished.
 */
export async function runStages(stages, execute = npmRun, log = console.log) {
  const started = performance.now();
  const timed = async (stage, concurrent) => {
    const before = performance.now();
    const exit = await execute(stage, { concurrent });
    log(
      `Build timing: ${JSON.stringify({ stage, ms: Math.round(performance.now() - before), exit })}`,
    );
    return exit;
  };
  let code = 0;
  try {
    for (const group of stages) {
      const names = group.split("+");
      const exits =
        names.length === 1
          ? [await timed(names[0], false)]
          : await Promise.all(names.map((name) => timed(name, true)));
      code = exits.find((exit) => exit !== 0) ?? 0;
      if (code !== 0) break;
    }
    return code;
  } catch (error) {
    code = 1;
    throw error;
  } finally {
    log(
      `Build timing: ${JSON.stringify({ stage: "total", ms: Math.round(performance.now() - started), exit: code })}`,
    );
  }
}

/**
 * A script that runs beside others prints its output in one piece when it
 * finishes, so three test suites do not interleave line by line.
 */
function npmRun(stage, { concurrent }) {
  return new Promise((done, reject) => {
    const child = spawn(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["run", stage],
      {
        stdio: concurrent ? ["ignore", "pipe", "pipe"] : "inherit",
        env: concurrent ? { ...process.env, FORCE_COLOR: "1" } : process.env,
      },
    );
    const output = [];
    child.stdout?.on("data", (chunk) => output.push(chunk));
    child.stderr?.on("data", (chunk) => output.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (concurrent) process.stdout.write(Buffer.concat(output));
      done(code ?? 1);
    });
  });
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const stages = process.argv.slice(2);
  if (!stages.length)
    throw new Error("Supply npm script names, joined with + to run at once");
  process.exitCode = await runStages(stages);
}
