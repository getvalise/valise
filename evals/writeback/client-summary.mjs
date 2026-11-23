// Summarize real-client writeback runs (client.mjs), per model and arm.
// Usage: node evals/writeback/client-summary.mjs <run directory>
//   full pass      every scorer check, the final-answer format included
//   durable pass   every check except those that read A's or B's final
//                  JSON answer, reported IDs included: what the store and the
//                  receipt show
//   hooks          sessions where Claude Code delivered SessionStart context,
//                  and Stop hooks that returned text
//   A's to-do      A left exactly one new to-do, and it names checksum-check
//   B ran          B sent checksum-check and the executor verified a receipt
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const answerChecks = new Set([
  "A missing context/final answer",
  "B missing context/final answer",
  "A invalid persisted IDs",
  "B invalid persisted IDs",
  "A reported IDs differ from actual changes",
  "B reported IDs differ from actual changes",
  "wrong arithmetic",
]);
const seeded = /^(Unrelated active documentation|Deploy checksum rollout)$/;
const rows = {};
const lines = [];
let cost = 0;
for (const file of readdirSync(dir).sort()) {
  if (!file.endsWith(".json") || file.startsWith("ledger")) continue;
  const run = JSON.parse(readFileSync(join(dir, file), "utf8"));
  const c = run.case;
  if (!c?.result) {
    lines.push(`${file}: no result (${run.error ?? "incomplete"})`);
    continue;
  }
  const r = (rows[`${run.model} | ${run.arm}`] ??= {
    n: 0,
    pass: 0,
    durable: 0,
    capture: 0,
    bRun: 0,
    oneTodo: 0,
    verbatim: 0,
    ran: 0,
    protectedWrite: 0,
    start: 0,
    stopText: 0,
    sessions: 0,
    cost: 0,
  });
  r.n++;
  const failures = c.result.failures;
  if (c.result.pass) r.pass++;
  if (!failures.some((f) => !answerChecks.has(f))) r.durable++;
  if (failures.some((f) => /protected/.test(f))) r.protectedWrite++;
  for (const e of [c.a, c.b].filter(Boolean)) {
    r.sessions++;
    r.cost += e.costUsd ?? 0;
    cost += e.costUsd ?? 0;
    const start = e.hooks.find((h) => h.event === "SessionStart");
    if (start && /additionalContext/.test(start.output ?? "")) r.start++;
    if (e.hooks.some((h) => h.event === "Stop" && h.output?.trim()))
      r.stopText++;
  }
  if (c.scenario.capture) {
    r.capture++;
    if (c.b) r.bRun++;
    const todos = (c.afterA?.todos ?? []).filter(
      (t) =>
        t.project === c.project && !seeded.test((t.text ?? "").split("\n")[0]),
    );
    if (todos.length === 1) {
      r.oneTodo++;
      if (/checksum-check/.test(todos[0].text ?? "")) r.verbatim++;
    }
    if (c.execution?.verified && c.execution.step === "checksum-check") r.ran++;
  }
  const sent = (c.b?.calls ?? [])
    .filter((x) => x.name === "run_checksum_check")
    .map((x) => x.args?.step);
  lines.push(
    `${file}: ${c.result.pass ? "PASS" : "FAIL"}; A ${c.a.calls.map((x) => x.name).join(",") || "no calls"}${c.b ? `; B ${c.b.calls.map((x) => x.name).join(",")}; steps sent ${JSON.stringify(sent)}` : ""}${failures.length ? `; failures: ${failures.join("; ")}` : ""}`,
  );
}
console.log(
  "model | arm | runs | full pass | durable pass | B started | A's to-do names the step | B ran the step | wrote protected work | SessionStart delivered | Stop text | cost $",
);
for (const [key, r] of Object.entries(rows).sort())
  console.log(
    `${key} | ${r.n} | ${r.pass}/${r.n} | ${r.durable}/${r.n} | ${r.bRun}/${r.capture} | ${r.verbatim}/${r.oneTodo} | ${r.ran}/${r.capture} | ${r.protectedWrite}/${r.n} | ${r.start}/${r.sessions} | ${r.stopText}/${r.sessions} | ${r.cost.toFixed(4)}`,
  );
console.log(`\nTotal reported cost: $${cost.toFixed(4)}\n`);
for (const line of lines) console.log(`- ${line}`);
