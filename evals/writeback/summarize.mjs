// Summarize paid writeback runs: per model and arm, pass rate per criterion.
// Usage: node evals/writeback/summarize.mjs <run directory> [mode]
//   strict   the result as recorded when the run was scored (default)
//   lenient  re-scores with the final JSON object extracted from prose or a fence
//   rescore  re-scores with the current scorer: a fenced final answer counts,
//            and an injected Stop's reply does not replace the earlier answer
//   final    the injected arm scored on its last message only, as before
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { score, withAnswerBeforeStop } from "./core.mjs";

const mode = process.argv[3] ?? "strict";
// Lenient: accept the final JSON object even when prose or a code fence wraps it.
const extract = (text) => {
  if (typeof text !== "string") return text;
  try {
    JSON.parse(text);
    return text;
  } catch {}
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) =>
    m[1].trim(),
  );
  for (const f of fences.reverse()) {
    try {
      JSON.parse(f);
      return f;
    } catch {}
  }
  const end = text.lastIndexOf("}");
  for (
    let i = text.lastIndexOf("{", end);
    i >= 0;
    i = text.lastIndexOf("{", i - 1)
  ) {
    const cand = text.slice(i, end + 1);
    try {
      JSON.parse(cand);
      return cand;
    } catch {}
  }
  return text;
};

const dir = process.argv[2];
const files = readdirSync(dir).filter(
  (f) => f.endsWith(".json") && f !== "ledger.json",
);

// Criterion -> failure strings that break it. A criterion applies only to
// cases where at least one of its checks could fire.
const crit = {
  selective: [
    "missing or duplicate scoped finding",
    "missing or duplicate scoped next work",
    "capture escaped project scope",
    "incorrect memory authority/type",
    "finding lost actionable qualification",
    "missing concrete step/blocker",
    "missing work reference",
    "A did not leave ready work",
    "durable content not visible through projection and MCP search",
    "matching record replaced or duplicated",
    "memory revision did not advance",
    "unexpected durable write",
    "unnecessary write attempt",
    "unnecessary recall",
    "wrong arithmetic",
    "A wrote outside its project",
  ],
  noDupChatter: [
    "unexpected durable write",
    "unnecessary write attempt",
    "B created duplicate or unrelated records",
    "matching record replaced or duplicated",
  ],
  verifiedIds: [
    "A invalid persisted IDs",
    "A reported IDs differ from actual changes",
    "B invalid persisted IDs",
    "B reported IDs differ from actual changes",
  ],
  bFound: ["B did not retrieve authoritative saved context"],
  bExecuted: [
    "no independently verified execution artifact",
    "wrong executed step",
    "B did not complete allowed work",
    "execution receipt not in durable task history",
    "B did not acquire ready task claim",
  ],
  blockers: [
    "A changed protected claim/blocker/history",
    "B changed protected claim/blocker/history",
    "A attempted write to protected work",
    "B attempted write to protected work",
  ],
};
const captureCases = new Set([
  "new",
  "approved-decision",
  "matching",
  "lost-receipt",
]);
const applies = (k, c) =>
  ["bFound", "bExecuted"].includes(k) ? captureCases.has(c) : true;

// Duplicate count is measured directly from snapshots, so a missing record is
// not miscounted as a duplicate.
const dupFrom = (e) => {
  const a = e.afterA,
    b = e.afterB;
  if (!a) return false;
  const many = (s) => s && (s.memories.length > 1 || s.todos.length > 1);
  return many(a) || many(b);
};

const rows = {};
const fails = [];
for (const f of files) {
  const run = JSON.parse(readFileSync(join(dir, f), "utf8"));
  const e = run.cases?.[0];
  if (!e?.result) {
    fails.push(`${f}: no result`);
    continue;
  }
  const rep = f.match(/-r(\d)-/)[1];
  const key = `${run.model}|${run.arm}`;
  const r = (rows[key] ??= {
    n: 0,
    pass: 0,
    crit: {},
    billed: 0,
    reserved: 0,
    unbilled: 0,
    cases: {},
    providerErr: 0,
  });
  r.n++;
  let result = e.result;
  if (mode === "lenient" && !e.error) {
    const fix = (ep) => (ep ? { ...ep, answer: extract(ep.answer) } : ep);
    result = score({ ...e, a: fix(e.a), b: fix(e.b) });
  }
  if (mode === "rescore" && !e.error) {
    const fix = (ep) => withAnswerBeforeStop(ep, run.hooks?.stop);
    result = score({ ...e, a: fix(e.a), b: fix(e.b) });
  }
  if (mode === "final" && e.resultOnFinalMessage)
    result = e.resultOnFinalMessage;
  if (result.pass) r.pass++;
  const failures = result.failures;
  const harnessError = Boolean(e.error);
  if (harnessError) r.harnessErr = (r.harnessErr ?? 0) + 1;
  for (const [k, list] of Object.entries(crit)) {
    if (harnessError || !applies(k, e.scenario.id)) continue;
    const c = (r.crit[k] ??= [0, 0]);
    c[1]++;
    let ok = !failures.some((x) => list.includes(x));
    if (k === "noDupChatter" && dupFrom(e)) ok = false;
    if (k === "bExecuted") ok = e.execution?.verified === true;
    if (ok) c[0]++;
  }
  (r.cases[e.scenario.id] ??= []).push(`${result.pass ? "P" : "F"}`);
  const errs = [e.a?.error, e.b?.error, e.error].filter(Boolean).map(String);
  if (errs.some((x) => /Provider|Timeout|aborted/i.test(x))) r.providerErr++;
  if (!result.pass)
    fails.push(
      `${run.model} r${rep} ${run.arm} ${e.scenario.id}: ${failures.join("; ")}${errs.length ? " || errors: " + errs.join(" | ").slice(0, 200) : ""}`,
    );
}
// Cost per model comes from the shared ledger order; per-file usage is the
// provider's own record, summed here.
for (const f of files) {
  const run = JSON.parse(readFileSync(join(dir, f), "utf8"));
  if (!run.cases?.[0]?.result) continue;
  const r = rows[`${run.model}|${run.arm}`];
  for (const u of run.usage ?? []) {
    if (u && Number.isFinite(u.cost)) r.billed += u.cost;
    else r.unbilled++;
  }
}
const pct = ([a, b]) => (b ? `${a}/${b}` : "-");
console.log(
  "model | arm | runs | full pass | selective | no dup/chatter | verified IDs | B found | B executed | blockers | provider/timeout errs | billed $",
);
for (const [k, r] of Object.entries(rows).sort()) {
  const [m, arm] = k.split("|");
  console.log(
    [
      m,
      arm,
      r.n,
      `${r.pass}/${r.n}`,
      ...[
        "selective",
        "noDupChatter",
        "verifiedIds",
        "bFound",
        "bExecuted",
        "blockers",
      ].map((c) => pct(r.crit[c] ?? [0, 0])),
      `${r.providerErr} (${r.harnessErr ?? 0})`,
      r.billed.toFixed(4) + (r.unbilled ? ` (+${r.unbilled} unbilled)` : ""),
    ].join(" | "),
  );
}
console.log("\nPer case (P/F per repeat):");
for (const [k, r] of Object.entries(rows).sort())
  console.log(k, JSON.stringify(r.cases));
console.log("\nFailures:");
for (const f of fails.sort()) console.log("-", f);
const ledger = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8"));
const billed = ledger.requests.reduce((s, q) => s + (q.billed ?? 0), 0);
const reserved = ledger.requests.reduce((s, q) => s + q.reserved, 0);
const open = ledger.requests.filter((q) => q.billed === null);
console.log(
  `\nLedger: spent(charged-or-reserved)=${ledger.spent.toFixed(4)} billed=${billed.toFixed(4)} reservedTotal=${reserved.toFixed(4)} unbilledRequests=${open.length} unbilledReserved=${open.reduce((s, q) => s + q.reserved, 0).toFixed(4)} episodes=${ledger.episodes} stopped=${ledger.stopped}`,
);
// Per-model reserved vs billed: each output embeds the ledger at its end, so a
// file's requests are the slice added since the previous file.
const runs = files
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
  .filter((r) => r.budget)
  .sort((x, y) => x.budget.requests.length - y.budget.requests.length);
const per = {};
let prev = 0;
for (const r of runs) {
  const reqs = r.budget.requests.slice(prev);
  prev = r.budget.requests.length;
  const p = (per[r.model] ??= {
    reserved: 0,
    billed: 0,
    requests: 0,
    unbilled: 0,
    over: 0,
  });
  for (const q of reqs) {
    p.requests++;
    p.reserved += q.reserved;
    if (q.billed === null) p.unbilled++;
    else p.billed += q.billed;
    if (q.billed !== null && q.billed > q.reserved) p.over++;
  }
}
console.log("\nPer model ledger:");
for (const [m, p] of Object.entries(per))
  console.log(
    m,
    `requests=${p.requests} reserved=${p.reserved.toFixed(4)} billed=${p.billed.toFixed(4)} unbilledRequests=${p.unbilled} overReservation=${p.over}`,
  );
