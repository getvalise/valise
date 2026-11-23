#!/usr/bin/env node
/**
 * Which cells fail more than once? One run is one sample per case and model,
 * and a single ✓ or ✗ cannot tell a flaky model from a broken description.
 * This folds every run on disk into a pass rate per cell, so a regression
 * is read against how the cell has behaved, not against the last run.
 *
 *   node evals/trends.mjs                 every full run on disk
 *   node evals/trends.mjs --min-rows 20   count only runs with at least 20 rows
 *   node evals/trends.mjs --case stop-    cases whose id starts with stop-
 *   node evals/trends.mjs --tools 72d0dbe0bdaf   runs that saw one tool surface
 *
 * Under each case, the turns its passing rows took, per model: the mean, and
 * with -v the spread. A clause that removes a read before the right call
 * moves that line, 2.4 to 1.1 turns, while the pass rate stays at 100%.
 *
 * A run with `--distractors N` keeps its own cells, `haiku-5.5 +50`, and
 * adds a curve per tool and store hash: pass rate by N for each model and
 * for each case that drops below its rate at zero.
 *
 * A full run is one that covered the whole suite; a `--case` run of one or
 * two cells is skipped by default so a focused rerun cannot inflate a rate.
 * Rows are counted per repeat, so `--repeat 3` on two cases stays a focused
 * run, and a full run at three repeats adds three samples to every cell.
 *
 * A rate folds every surface the runs saw, which is the point when the
 * question is whether a description change moved a cell. It is noise when the
 * surfaces differ by skills nobody meant to test, so the output opens with the
 * surfaces behind the rate and names the runs that saw unseeded skills.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { divergence, divergenceLine, runStamps } from "./index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS = join(HERE, "runs");
const options = parseArgv(process.argv.slice(2));

const runs = runStamps()
  .map((stamp) => ({
    stamp,
    ...JSON.parse(readFileSync(join(RUNS, `${stamp}.json`), "utf8")),
  }))
  .filter((run) => run.rows.length / (run.repeat ?? 1) >= options.minRows)
  .filter((run) => !options.tools || surfaceKey(run) === options.tools);

if (runStamps().length === 0) {
  fail(
    "no runs in evals/runs; recorded runs stay local, so run `npm run evals` first",
  );
}
if (runs.length === 0) {
  fail(
    `no run has ${options.minRows} rows or more${options.tools ? ` on tools ${options.tools}` : ""}`,
  );
}

const cells = new Map();
const endings = new Map();
for (const run of runs) {
  for (const row of run.rows) {
    if (options.case && !row.case.startsWith(options.case)) continue;
    // A harness row keeps its lane: Sonnet through Claude Code with the
    // plugin is not the same cell as Sonnet over OpenRouter.
    // So does a run with rivals on the surface: the same model at 50
    // distractors is the point on a curve, not another sample of zero.
    // A run on the retrieval store keeps its size the same way, and a run
    // with a reranked search keeps its mode.
    const rivals = run.distractors?.count ?? 0;
    const model = `${row.lane ? row.model : row.model.split("/").pop()}${rivals ? ` +${rivals}` : ""}${run.memories ? `@${run.memories}` : ""}${run.rerank ? ` reranked-${run.rerank}` : ""}`;
    const key = `${row.case}\u0000${model}`;
    const cell = cells.get(key) ?? {
      case: row.case,
      model,
      pass: 0,
      n: 0,
      turns: [],
    };
    cell.n += 1;
    if (row.pass) {
      cell.pass += 1;
      // A harness session's turns run on past the answer, so only the
      // OpenRouter lane's count is turns to the right call.
      if (!row.lane && row.turns !== undefined) cell.turns.push(row.turns);
    } else {
      const ended = row.error
        ? "error"
        : row.capped
          ? "(cap)"
          : (row.chose ?? "(none)");
      const tally = endings.get(row.case) ?? new Map();
      tally.set(
        `${model} → ${ended}`,
        (tally.get(`${model} → ${ended}`) ?? 0) + 1,
      );
      endings.set(row.case, tally);
    }
    cells.set(key, cell);
  }
}

const byCase = new Map();
for (const cell of cells.values()) {
  const agg = byCase.get(cell.case) ?? { pass: 0, n: 0, models: [] };
  agg.pass += cell.pass;
  agg.n += cell.n;
  agg.models.push(cell);
  byCase.set(cell.case, agg);
}

const first = runs[0].stamp;
const last = runs.at(-1).stamp;
process.stdout.write(
  `${runs.length} runs from ${first} to ${last}, ${options.minRows}+ rows per repeat each\n\n`,
);

printSurfaces(runs);

// Per run, not pooled: the share is a property of one surface shown to every
// model at once, and pooling runs would mix surfaces the hashes say differ.
for (const run of runs) {
  const rows = options.case
    ? run.rows.filter((row) => row.case.startsWith(options.case))
    : run.rows;
  process.stdout.write(`${run.stamp}  ${divergenceLine(divergence(rows))}\n`);
}
process.stdout.write("\n");

const ranked = [...byCase.entries()].sort(
  ([, a], [, b]) => a.pass / a.n - b.pass / b.n,
);
for (const [id, agg] of ranked) {
  const rate = Math.round((100 * agg.pass) / agg.n);
  const weak = agg.models
    .filter((cell) => cell.pass < cell.n)
    .sort((a, b) => a.pass / a.n - b.pass / b.n)
    .map((cell) => `${cell.model} ${cell.pass}/${cell.n}`)
    .join(", ");
  process.stdout.write(
    `${id.padEnd(28)} ${String(rate).padStart(3)}%  ${agg.pass}/${agg.n}`,
  );
  if (weak) process.stdout.write(`   ${weak}`);
  process.stdout.write("\n");
  const turned = agg.models.filter((cell) => cell.turns.length > 0);
  if (turned.length > 0) {
    const turns = turned
      .sort((a, b) => mean(a.turns) - mean(b.turns))
      .map(
        (cell) =>
          `${cell.model} ${mean(cell.turns).toFixed(1)}${options.verbose ? ` (${spread(cell.turns)})` : ""}`,
      )
      .join(", ");
    process.stdout.write(`${" ".repeat(30)}turns  ${turns}\n`);
  }
  const tally = endings.get(id);
  if (tally && options.verbose) {
    const top = [...tally.entries()].sort(([, a], [, b]) => b - a).slice(0, 4);
    for (const [ending, count] of top)
      process.stdout.write(`${" ".repeat(30)}${count}× ${ending}\n`);
  }
}

// One curve per surface that carried distractors, oldest first. A rewritten
// description is a new tool hash, so each attempt reads as its own curve.
const curves = new Map();
for (const run of runs.filter((run) => run.distractors)) {
  curves.set(`${run.toolsHash}\u0000${run.storeHash}`, run);
}
for (const newest of curves.values()) printCurve(newest);

/**
 * Runs from before the runner hashed its surface carry only the tool names,
 * so they group on a hash of those, marked as such: two of them can share
 * names and still differ in a description. A skill other than the one the
 * seed publishes was left in the store by a console session or `npm run
 * test:ui`. Runs recorded before the runner refused them carry them, so they
 * are named here rather than folded in silently.
 */
function printSurfaces(runs) {
  const surfaces = new Map();
  for (const run of runs) {
    const key = surfaceKey(run);
    const surface = surfaces.get(key) ?? {
      tools: run.toolNames.length,
      stamps: [],
    };
    surface.stamps.push(run.stamp);
    surfaces.set(key, surface);
  }
  process.stdout.write(`${plural(surfaces.size, "tool surface")}\n`);
  for (const [key, surface] of surfaces) {
    process.stdout.write(
      `  ${`${key}, ${surface.tools} tools`.padEnd(30)} ${plural(surface.stamps.length, "run")}, last ${surface.stamps.at(-1)}\n`,
    );
  }
  const drifted = runs.filter((run) =>
    run.toolNames.some(
      (name) => name.startsWith("skill_") && name !== "skill_capture-this",
    ),
  );
  if (drifted.length > 0) {
    process.stdout.write(
      `  ${plural(drifted.length, "run")} saw unseeded skills: ${drifted.map((run) => run.stamp).join(", ")}\n`,
    );
  }
  process.stdout.write("\n");
}

/** The runner's tool hash, or `names <hash>` of the tool names before it had one. */
function surfaceKey(run) {
  return run.toolsHash ?? `names ${digest(run.toolNames)}`;
}

/** The same 12-character digest the runner prints. */
function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 12);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** `1×3 2×1`: three passes in one turn, one in two. */
function spread(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .sort(([a], [b]) => a - b)
    .map(([turns, count]) => `${turns}×${count}`)
    .join(" ");
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Pass rate by distractor count over the runs that share one surface: the
 * same Valise tools and the same store. A case is listed when it passes less
 * often at some N than at zero, which is where its description stopped
 * winning.
 */
function printCurve(newest) {
  const comparable = runs.filter(
    (run) =>
      run.toolsHash === newest.toolsHash && run.storeHash === newest.storeHash,
  );
  const counts = [
    ...new Set(comparable.map((run) => run.distractors?.count ?? 0)),
  ].sort((a, b) => a - b);
  const tally = (keyOf) => {
    const table = new Map();
    for (const run of comparable) {
      const column = counts.indexOf(run.distractors?.count ?? 0);
      for (const row of run.rows) {
        if (options.case && !row.case.startsWith(options.case)) continue;
        const key = keyOf(row);
        const cells = table.get(key) ?? counts.map(() => ({ pass: 0, n: 0 }));
        cells[column].n += 1;
        if (row.pass) cells[column].pass += 1;
        table.set(key, cells);
      }
    }
    return table;
  };
  const rate = ({ pass, n }) =>
    n === 0 ? "—" : `${Math.round((100 * pass) / n)}%`;
  const line = (label, cells) =>
    `${label.padEnd(28)} ${cells.map((cell) => rate(cell).padStart(6)).join("")}\n`;
  process.stdout.write(
    `\nDistractor curve, ${comparable.length} runs on tools ${newest.toolsHash}, store ${newest.storeHash}\n\n`,
  );
  process.stdout.write(
    `${"".padEnd(28)} ${counts.map((n) => `+${n}`.padStart(6)).join("")}\n`,
  );
  for (const [model, cells] of tally((row) => row.model.split("/").pop()))
    process.stdout.write(line(model, cells));
  process.stdout.write("\n");
  const share = ({ pass, n }) => (n === 0 ? null : pass / n);
  for (const [id, cells] of tally((row) => row.case)) {
    const base = share(cells[0]);
    if (
      cells.slice(1).some((cell) => share(cell) !== null && share(cell) < base)
    )
      process.stdout.write(line(id, cells));
  }
}

function parseArgv(argv) {
  const options = { minRows: 16, verbose: false };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--min-rows") options.minRows = Number(argv[++index]);
    else if (argv[index] === "--case") options.case = argv[++index];
    else if (argv[index] === "--tools") options.tools = argv[++index];
    else if (argv[index] === "--verbose" || argv[index] === "-v")
      options.verbose = true;
    else fail(`unknown option ${argv[index]}`);
  }
  return options;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
