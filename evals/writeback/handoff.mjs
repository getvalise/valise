// The handoff from A to B, per model and arm, in paid writeback runs.
// Usage: node evals/writeback/handoff.mjs <run directory> [steps]
// Over capture runs where A left exactly one to-do of its own in the project:
//   verbatim   A's to-do title or body contains the step `checksum-check`
//   shell      A's to-do contains a shell hashing command nobody gave
//   ran        B sent `checksum-check` to run_checksum_check at least once
//   phrase     B sent a step containing a space, a sentence instead of a name
// Over every run: capture runs where A saved no memory in the project, and
// how many injected episodes received the Stop reminder. `steps` also prints
// every step value B sent.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const capture = /-(new|approved-decision|matching|lost-receipt)\.json$/;
const seeded = /^(Unrelated active documentation|Deploy checksum rollout)$/;
const rows = {};
const steps = {};

for (const file of readdirSync(dir).sort()) {
  if (!file.endsWith(".json") || file.startsWith("ledger")) continue;
  const run = JSON.parse(readFileSync(join(dir, file), "utf8"));
  const c = run.cases?.[0];
  if (!c) continue;
  const key = `${run.model} | ${run.arm}`;
  const r = (rows[key] ??= {
    capture: 0,
    noMemory: 0,
    oneTodo: 0,
    verbatim: 0,
    shell: 0,
    ran: 0,
    phrase: 0,
    stop: 0,
    episodes: 0,
  });
  if (run.arm === "injected") {
    r.episodes += 2;
    r.stop += [c.a, c.b].filter((e) => e?.answerBeforeStop != null).length;
  }
  if (!capture.test(file)) continue;
  r.capture++;
  if (!(c.afterA?.memories ?? []).some((m) => m.project === c.project))
    r.noMemory++;
  const todos = (c.afterA?.todos ?? []).filter(
    (t) => t.project === c.project && !seeded.test(t.title ?? ""),
  );
  if (todos.length !== 1) continue;
  r.oneTodo++;
  const text = `${todos[0].title ?? ""}\n${todos[0].text ?? ""}`;
  if (/checksum-check/.test(text)) r.verbatim++;
  if (/\b(sha256sum|shasum|openssl)\b/.test(text)) r.shell++;
  const sent = (c.b?.calls ?? [])
    .filter((call) => call.name === "run_checksum_check")
    .map((call) => String(call.args?.step));
  if (sent.includes("checksum-check")) r.ran++;
  if (sent.some((s) => s.includes(" "))) r.phrase++;
  (steps[key] ??= []).push(sent);
}

console.log(
  "model | arm | verbatim | shell command | B ran the step | B sent a phrase | no memory | Stop fired",
);
for (const [key, r] of Object.entries(rows).sort())
  console.log(
    `${key} | ${r.verbatim}/${r.oneTodo} | ${r.shell}/${r.oneTodo} | ${r.ran}/${r.oneTodo} | ${r.phrase}/${r.oneTodo} | ${r.noMemory}/${r.capture} | ${r.episodes ? `${r.stop}/${r.episodes}` : "–"}`,
  );
if (process.argv[3] === "steps")
  for (const [key, s] of Object.entries(steps).sort())
    console.log(
      `\n${key}\n${s.map((v) => `  ${JSON.stringify(v)}`).join("\n")}`,
    );
