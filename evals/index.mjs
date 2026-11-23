#!/usr/bin/env node
/**
 * Fold `evals/runs/*.json` into one `evals/runs/index.json` for the console's
 * evals tab to read on the server. ADR-0006.
 *
 * The tab reads the suite, not a run. Each case's cell for a model is that
 * model's newest result on the case, from whichever run produced it, so a
 * `--case` rerun of one cell updates that cell and leaves the other cells as
 * they were. A run whose verdict is `dropped` tested a change that did not
 * ship, so it stays in the history and never counts as the newest result.
 *
 * Results are kept apart by condition: a run with rival tools on the surface,
 * one on a seeded memory corpus, and one through a real harness each measure
 * something the plain surface does not, so none of them overwrites a plain
 * cell.
 *
 * The index carries scores, not payloads: per-model totals, one cell per
 * case and model, and the route the model took. Arguments stay in the per-run
 * file and, for real traffic, in `mcp_calls`. The harness talks to a live
 * endpoint, so its own calls are in the logs tab under the agent `valise-eval`.
 *
 *   node evals/index.mjs      rebuild from whatever is on disk
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS = join(HERE, "runs");

export const VERDICTS = ["kept", "dropped", "baseline"];

/**
 * Run files only: `index.json` and `notes.json` live in the same folder.
 * Recorded runs stay local and are not published, so a fresh checkout has no
 * folder at all; that reads as no runs.
 */
export function runStamps(dir = RUNS) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter((name) => /^\d{4}-\d{2}-\d{2}T[\d-]+\.json$/.test(name))
    .map((name) => name.replace(/\.json$/, ""))
    .sort();
}

/**
 * What each run tested and what became of it, keyed by stamp. The run files
 * stay as the runner wrote them; this is the one file a person edits, through
 * `--note` on the runner and `npm run evals:verdict`.
 */
export function readNotes(dir = RUNS) {
  try {
    return JSON.parse(readFileSync(join(dir, "notes.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

export function writeNotes(notes, dir = RUNS) {
  const sorted = Object.fromEntries(
    Object.entries(notes).sort(([a], [b]) => a.localeCompare(b)),
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "notes.json"),
    `${JSON.stringify(sorted, null, 2)}\n`,
  );
}

/**
 * The condition a run measured under, as a URL-safe key. A harness run's
 * models already name their lane, but it still gets its own key: its turn
 * counts are a session's, not turns to the call.
 */
export function conditionOf(run) {
  const parts = [];
  if (run.harness) parts.push(run.harness.name);
  if (run.distractors) parts.push(`rivals-${run.distractors.count}`);
  if (run.memories) parts.push(`memories-${run.memories}`);
  return parts.join(".") || "plain";
}

function conditionLabel(run) {
  const parts = [];
  if (run.harness)
    parts.push(
      run.harness.name === "claude-code"
        ? "Claude Code"
        : run.harness.name === "opencode"
          ? "OpenCode"
          : run.harness.name,
    );
  if (run.distractors) parts.push(`+${run.distractors.count} rival tools`);
  if (run.memories)
    parts.push(`${run.memories.toLocaleString("en-US")} memories`);
  return parts.join(", ") || "Plain surface";
}

/** `dir` and `suite` are for tests; the tab reads the runs on this disk. */
export function buildIndex(
  dir = RUNS,
  suite = JSON.parse(readFileSync(join(HERE, "cases.json"), "utf8")),
) {
  const notes = readNotes(dir);
  const runs = runStamps(dir).map((stamp) => ({
    stamp,
    ...JSON.parse(readFileSync(join(dir, `${stamp}.json`), "utf8")),
  }));

  return {
    generatedAt: new Date().toISOString(),
    conditions: conditions(runs, notes),
    cases: suiteCases(suite, runs, notes),
    history: history(suite, runs),
    runs: runs
      .map((run) => ({
        stamp: run.stamp,
        at: run.at,
        condition: conditionOf(run),
        cases: new Set(run.rows.map((row) => row.case)).size,
        models: run.models.length,
        repeat: run.repeat ?? 1,
        rows: run.rows.length,
        passes: run.rows.filter((row) => row.pass === true).length,
        toolsHash: run.toolsHash ?? null,
        ...annotation(notes[run.stamp]),
      }))
      .reverse(),
  };
}

function annotation(note) {
  return {
    note: note?.note ?? null,
    verdict: VERDICTS.includes(note?.verdict) ? note.verdict : null,
    why: note?.why ?? null,
  };
}

/**
 * The newest result per case and model under each condition, oldest run
 * first so a later run replaces an earlier one. `was` is the result it
 * replaced, which is what a delta on the tab compares with.
 */
function conditions(runs, notes) {
  const byCondition = new Map();
  for (const run of runs) {
    const key = conditionOf(run);
    const condition = byCondition.get(key) ?? {
      key,
      label: conditionLabel(run),
      runs: 0,
      newest: null,
      models: [],
      latest: new Map(),
    };
    byCondition.set(key, condition);
    condition.runs += 1;
    if (notes[run.stamp]?.verdict === "dropped") continue;
    condition.newest = run.stamp;
    condition.models = [
      ...run.models,
      ...condition.models.filter((model) => !run.models.includes(model)),
    ];
    for (const rows of groupRows(run.rows).values()) {
      const key = `${rows[0].case}\u0000${rows[0].model}`;
      const prior = condition.latest.get(key);
      condition.latest.set(key, {
        stamp: run.stamp,
        rows,
        was: prior ? { stamp: prior.stamp, rows: prior.rows } : null,
      });
    }
  }

  return [...byCondition.values()].map((condition) => {
    const latest = [...condition.latest.values()];
    const now = latest.flatMap((entry) => entry.rows);
    // A delta is a move only between results of the same size: a cell at
    // three repeats against one at a single row counts rows, not passes.
    const before = latest.flatMap((entry) =>
      entry.was && entry.was.rows.length === entry.rows.length
        ? entry.was.rows
        : entry.rows,
    );
    const cells = cellsOf(now);
    for (const entry of latest) {
      const { case: id, model } = entry.rows[0];
      Object.assign(cells[id][model], {
        stamp: entry.stamp,
        was: entry.was
          ? {
              stamp: entry.was.stamp,
              passes: entry.was.rows.filter((row) => row.pass === true).length,
              n: entry.was.rows.length,
            }
          : null,
      });
    }
    return {
      key: condition.key,
      label: condition.label,
      runs: condition.runs,
      newest: condition.newest,
      models: condition.models,
      summary: summaryOf(condition.models, now),
      before: summaryOf(condition.models, before),
      divergence: divergence(now),
      cells,
    };
  });
}

/** A run's rows by case and model, so a repeated cell travels as one. */
function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.case}\u0000${row.model}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return groups;
}

/**
 * Every case in `cases.json`, in its order, with the definition the newest
 * run that kept it scored against. A case no run has sent yet carries its
 * definition from the file, so the tab can say it has not run.
 */
function suiteCases(suite, runs, notes) {
  return suite.cases.map((raw) => {
    const run = runs.findLast(
      (run) =>
        notes[run.stamp]?.verdict !== "dropped" &&
        (run.cases ?? []).some((testCase) => testCase.id === raw.id),
    );
    const scored = run?.cases.find((testCase) => testCase.id === raw.id);
    return {
      ...caseDefinition(scored ?? raw),
      // Only a run carries the prompt as sent; the file holds templates.
      prompt: scored?.prompt ?? null,
      system: run?.system ?? null,
      scoredIn: run?.stamp ?? null,
    };
  });
}

/**
 * Every run that sent each case, newest first, with what changed since the
 * run before it that sent the same case. That is what a row of marks cannot
 * say on its own: whether the case moved because the case was rewritten, the
 * description of the tool it expects was, or neither.
 *
 * An entry names its run by stamp and nothing more; the note and verdict are
 * the run's, in `runs`, so fifty cases do not carry fifty copies. Marks are
 * `[passes, n]` in the order of the case's `models`, null where a model did
 * not run.
 */
function history(suite, runs) {
  const ids = new Set(suite.cases.map((testCase) => testCase.id));
  const byCase = {};
  const previous = new Map();
  for (const run of runs) {
    for (const rows of groupByCase(run.rows).values()) {
      const id = rows[0].case;
      if (!ids.has(id)) continue;
      const definition = (run.cases ?? []).find((c) => c.id === id) ?? null;
      const before = previous.get(id);
      previous.set(id, { run, definition });
      const entry = (byCase[id] ??= { models: [], entries: [], marks: [] });
      const cells = new Map();
      for (const group of groupRows(rows).values()) {
        const model = group[0].model;
        if (!entry.models.includes(model)) entry.models.push(model);
        cells.set(model, [
          group.filter((row) => row.pass === true).length,
          group.length,
        ]);
      }
      entry.entries.unshift({
        stamp: run.stamp,
        cells,
        ...changesSince(before, run, definition),
      });
    }
  }
  return Object.fromEntries(
    Object.entries(byCase).map(([id, { models: seen, entries }]) => {
      // The newest run's order, which is the matrix's, then any model only
      // older runs sent.
      const newest = [...entries[0].cells.keys()];
      const models = [
        ...newest,
        ...seen.filter((model) => !newest.includes(model)),
      ];
      return [
        id,
        {
          models,
          entries: entries.map(({ cells, ...entry }) => ({
            ...entry,
            marks: models.map((model) => cells.get(model) ?? null),
          })),
        },
      ];
    }),
  );
}

function groupByCase(rows) {
  const groups = new Map();
  for (const row of rows)
    groups.set(row.case, [...(groups.get(row.case) ?? []), row]);
  return groups;
}

/**
 * Whether the case text moved, and which tool texts did. `why` is commentary
 * and does not count. Per-tool hashes arrived after the surface hash, which
 * arrived after the tool names, so an older pair can only say the surface
 * changed, and the oldest only that its tool list did.
 */
function changesSince(before, run, definition) {
  if (!before)
    return {
      edited: false,
      changedTools: [],
      otherTools: 0,
      surfaceChanged: false,
    };
  const edited =
    before.definition !== null &&
    definition !== null &&
    digest(withoutWhy(before.definition)) !== digest(withoutWhy(definition));
  if (before.run.toolHashes && run.toolHashes) {
    const names = new Set([
      ...Object.keys(before.run.toolHashes),
      ...Object.keys(run.toolHashes),
    ]);
    const changed = [...names].filter(
      (name) => before.run.toolHashes[name] !== run.toolHashes[name],
    );
    const relevant = new Set(
      [
        definition?.tool,
        ...(definition?.alsoAccept ?? []),
        definition?.via,
      ].filter(Boolean),
    );
    const changedTools = changed.filter((name) => relevant.has(name));
    return {
      edited,
      changedTools,
      otherTools: changed.length - changedTools.length,
      surfaceChanged: changed.length > 0,
    };
  }
  return {
    edited,
    changedTools: [],
    otherTools: 0,
    surfaceChanged: surfaceKey(before.run) !== surfaceKey(run),
  };
}

function withoutWhy({ why, ...definition }) {
  return definition;
}

/** The runner's tool hash, or a digest of the tool names before it had one. */
export function surfaceKey(run) {
  return run.toolsHash ?? `names ${digest(run.toolNames ?? [])}`;
}

/** The same 12-character digest the runner prints. */
export function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 12);
}

/** One cell per case and model. A repeated cell folds its rows into one. */
function cellsOf(rows) {
  const cells = {};
  for (const row of rows) {
    const byModel = (cells[row.case] ??= {});
    const seen = byModel[row.model];
    const passes = (seen?.passes ?? 0) + (row.pass === true ? 1 : 0);
    const n = (seen?.n ?? 0) + 1;
    // Null on a run from before the budget, and on a harness run, where a
    // session's turn count runs on past the answer.
    const withinBudget =
      row.withinBudget === undefined || row.withinBudget === null
        ? null
        : (seen?.withinBudget ?? 0) + (row.withinBudget ? 1 : 0);
    // The turns each passing row took, so 1,1,3 reads apart from 1,1,1. A
    // harness row is left out: its num_turns is not turns to the call.
    const turnsToPass = [
      ...(seen?.turnsToPass ?? []),
      ...(row.pass === true && !row.lane && row.turns !== undefined
        ? [row.turns]
        : []),
    ];
    const capped = (seen?.capped ?? 0) + (row.capped === true ? 1 : 0);
    const counts = { passes, n, withinBudget, turnsToPass, capped };
    // A repeated cell keeps one row's route for the tab to show, and the
    // first miss is the one worth reading; `pass` holds only when all did.
    if (seen && (!seen.pass || row.pass === true)) {
      Object.assign(seen, { ...counts, pass: passes === n });
      continue;
    }
    byModel[row.model] = {
      ...counts,
      routeCapped: row.capped === true,
      chose: row.chose ?? null,
      pass: passes === n,
      toolMatch: row.toolMatch === true,
      missingArgs: row.missingArgs ?? [],
      viaMissing: row.viaMissing ?? null,
      wrongArgs: row.wrongArgs ?? [],
      answerMissing: row.answerMissing === true,
      route: row.route ?? [],
      turns: row.turns ?? null,
      tokens: spent(row),
      costUsd: row.costUsd ?? null,
      error: row.error ?? null,
    };
  }
  return cells;
}

function summaryOf(models, allRows) {
  return models.map((model) => {
    const rows = allRows.filter((row) => row.model === model);
    // Null, not zero, when the run predates the counter. A run that cost
    // nothing and a run that counted nothing read very differently.
    const total = (key) =>
      rows.some((row) => row[key] !== undefined)
        ? rows.reduce((sum, row) => sum + (row[key] ?? 0), 0)
        : null;
    return {
      model,
      total: rows.length,
      /* The model answered with the tool the case names. */
      exact: rows.filter((row) => row.chose === row.expected).length,
      /* That, or something in the case's `alsoAccept`. */
      accepted: rows.filter((row) => row.toolMatch).length,
      argsValid: rows.filter((row) => row.pass).length,
      /*
       * Passed in no more turns than the case's budget. Null on a run from
       * before the budget and on a harness run.
       */
      withinBudget: rows.some((row) => typeof row.withinBudget === "boolean")
        ? rows.filter((row) => row.withinBudget === true).length
        : null,
      /* Ran every round on reads; the cap, not a wrong tool, ended it. */
      capped: rows.filter((row) => row.capped === true).length,
      /*
       * Read a skill before acting, which is what a skills-first surface is
       * for. Counted by name, because a search before acting is a route of
       * two as well.
       */
      viaSkill: rows.filter(readSkillFirst).length,
      /* Model calls, not tool calls. A skill round trip costs a second one. */
      turns: total("turns"),
      promptTokens: total("promptTokens"),
      completionTokens: total("completionTokens"),
      /* Inside the completion count too, and the half worth watching. */
      reasoningTokens: total("reasoningTokens"),
      costUsd: total("costUsd"),
      /* Of the calls landing on a tool that offers `why`, how many said. */
      whyOffered: rows.filter((row) => row.whyOffered).length,
      whyFilled: rows.filter((row) => row.whyOffered && row.whyFilled).length,
      errors: rows.filter(
        (row) => row.error !== null && row.error !== undefined,
      ).length,
    };
  });
}

/** A skill read before the call the route ended on. */
export function readSkillFirst(row) {
  if (row.routeCalls) {
    return row.routeCalls
      .slice(0, row.endingIndex ?? -1)
      .some(
        (call) =>
          call.status === "executed" &&
          (call.name?.startsWith("skill_") || call.name === "get_skill"),
      );
  }
  return (row.route ?? [])
    .slice(0, -1)
    .some((name) => name.startsWith("skill_") || name === "get_skill");
}

/**
 * Cases where the models did not all end on the same tool, after Macomber's
 * consensus divergence at Ramp: models disagreeing on a turn reads as the
 * surface leaving the choice open, not as one model's fault. A description
 * change that lowers it is clearer for every model, which a higher score on
 * one model does not show. An errored row ended nowhere and is left out, and
 * a case one model answered has nothing to agree with, so it is not counted.
 * Harness rows compare within their lane: the with- and without-plugin lanes
 * differ by design, so a case counts once per lane. Under `--repeat` each
 * model stands for its most common ending, so a model that wavers on its own
 * is not counted as the models disagreeing.
 */
export function divergence(rows) {
  const byCase = new Map();
  for (const row of rows) {
    if (row.error) continue;
    const key = `${row.lane ?? ""}\u0000${row.case}`;
    const byModel = byCase.get(key) ?? new Map();
    const counts = byModel.get(row.model) ?? new Map();
    // A capped route had not ended anywhere, so its last read is no answer
    // to agree or disagree with.
    const ending = row.capped ? "(cap)" : (row.chose ?? "(none)");
    counts.set(ending, (counts.get(ending) ?? 0) + 1);
    byModel.set(row.model, counts);
    byCase.set(key, byModel);
  }
  const compared = [...byCase.values()].filter((byModel) => byModel.size > 1);
  const usual = (counts) =>
    [...counts].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
  return {
    divergent: compared.filter(
      (byModel) => new Set([...byModel.values()].map(usual)).size > 1,
    ).length,
    cases: compared.length,
  };
}

/** `divergent cases: 15/37 (41%)`, the same line in the report and trends. */
export function divergenceLine({ divergent, cases }) {
  const share = cases === 0 ? 0 : Math.round((100 * divergent) / cases);
  return `divergent cases: ${divergent}/${cases} (${share}%)`;
}

function spent(row) {
  if (row.promptTokens === undefined) return null;
  return (row.promptTokens ?? 0) + (row.completionTokens ?? 0);
}

/** The case as a run recorded it, or as `cases.json` holds it. */
function caseDefinition(testCase) {
  return {
    id: testCase.id,
    expected: testCase.tool ?? null,
    why: testCase.why ?? null,
    via: testCase.via ?? null,
    alsoAccept: testCase.alsoAccept ?? [],
    requiredArgs: testCase.requiredArgs ?? [],
    turnBudget: testCase.turnBudget ?? null,
  };
}

export function writeIndex() {
  const index = buildIndex();
  mkdirSync(RUNS, { recursive: true });
  writeFileSync(
    join(RUNS, "index.json"),
    `${JSON.stringify(index, null, 2)}\n`,
  );
  return index;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const index = writeIndex();
  process.stdout.write(
    `evals/runs/index.json: ${index.runs.length} run${
      index.runs.length === 1 ? "" : "s"
    }, ${index.conditions.length} conditions, newest ${index.runs[0]?.stamp ?? "none"}\n`,
  );
}
