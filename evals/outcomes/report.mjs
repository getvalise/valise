#!/usr/bin/env node
import { readFileSync } from "node:fs";

const files = process.argv.slice(2);
if (!files.length) throw new Error("Pass outcome run JSON paths");
const runs = files.map((file) => JSON.parse(readFileSync(file, "utf8")));

/**
 * A list_todos cursor that no earlier call in the episode returned as
 * next_cursor. Null and "" are omission, not a cursor.
 */
function inventedCursors(row) {
  const issued = new Set();
  let invented = 0;
  for (const call of row.route) {
    if (call.name === "list_todos" && call.args?.cursor) {
      if (!issued.has(call.args.cursor)) invented++;
    }
    if (call.result?.next_cursor) issued.add(call.result.next_cursor);
  }
  return invented;
}

console.log(
  "| Model | Run | Scoring | Arm | Outcomes | Correct answers | Authoritative reads | Missed blockers | Extra searches | Writes | Invented cursors | Calls | Input / output tokens | Cost | Tool errors / episode errors |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
);
for (const run of runs) {
  for (const client of [...new Set(run.rows.map((row) => row.client))]) {
    const rows = run.rows.filter((row) => row.client === client);
    const sum = (key) =>
      rows.reduce((total, row) => total + (row[key] ?? 0), 0);
    const count = (predicate) =>
      `${rows.filter(predicate).length}/${rows.length}`;
    console.log(
      `| ${run.model} | ${run.label} · ${run.serverRevision} | ${run.scoringVersion ?? "pilot (fetch required)"} | ${client} | ${count((row) => row.pass)} | ${count((row) => row.wrong.length === 0 && !row.needsUserContext)} | ${count((row) => row.missingEvidence.length === 0)} | ${rows.reduce((n, row) => n + row.missedBlockers.length, 0)} | ${sum("needlessSearches")} | ${sum("needlessWrites")} | ${rows.reduce((n, row) => n + inventedCursors(row), 0)} | ${sum("calls")} | ${sum("promptTokens")} / ${sum("completionTokens")} | ${rows.some((row) => row.usageMissing) ? "incomplete " : ""}$${sum("costUsd").toFixed(4)} | ${rows.reduce((n, row) => n + row.route.filter((call) => call.error).length, 0)} / ${rows.filter((row) => row.error).length} |`,
    );
  }
}

// Passes per case, one column per run and arm.
const columns = runs.flatMap((run) =>
  [...new Set(run.rows.map((row) => row.client))].map((client) => ({
    run,
    client,
  })),
);
const caseIds = [
  ...new Set(runs.flatMap((run) => run.rows.map((row) => row.case))),
];
console.log(
  `\n| Case | ${columns.map(({ run, client }) => `${run.model.split("/").at(-1)} ${run.label} ${client}`).join(" | ")} |\n|---|${columns.map(() => "---").join("|")}|`,
);
for (const id of caseIds) {
  const cells = columns.map(({ run, client }) => {
    const rows = run.rows.filter(
      (row) => row.case === id && row.client === client,
    );
    return `${rows.filter((row) => row.pass).length}/${rows.length}`;
  });
  console.log(`| ${id} | ${cells.join(" | ")} |`);
}
