#!/usr/bin/env node
/**
 * Record what became of the change a run tested, so the evals tab can show a
 * case's history as tried, kept and dropped rather than as a row of marks.
 *
 *   npm run evals:verdict -- 2026-10-18T13-17-42 dropped "haiku searched 3/8 with and without"
 *   npm run evals:verdict -- last kept "moved on sonnet and gemini, two repeats each"
 *   npm run evals:verdict -- 2026-10-18T13-21-30,2026-10-18T13-21-52 dropped "…"
 *   npm run evals:verdict -- last --note "what the run tested, said afterwards"
 *
 * `kept`: the text under test shipped. `dropped`: it did not, and the run
 * never counts as a case's newest result again. `baseline`: the run a change
 * was compared against. `last` is the newest run on disk.
 *
 * The verdict lands in `evals/runs/notes.json` beside the run's note, and the
 * index is rebuilt. The run file itself is left as the runner wrote it.
 */
import {
  readNotes,
  runStamps,
  VERDICTS,
  writeIndex,
  writeNotes,
} from "./index.mjs";

const [target, ...rest] = process.argv.slice(2);
if (!target) usage();

const known = runStamps();
if (known.length === 0)
  fail(
    "no runs in evals/runs; recorded runs stay local, so run `npm run evals` first",
  );
const stamps = target === "last" ? [known.at(-1)] : target.split(",");
for (const stamp of stamps) {
  if (!known.includes(stamp)) fail(`no run ${stamp} in evals/runs`);
}

const change = {};
if (rest[0] === "--note") {
  if (!rest[1]) usage();
  change.note = rest[1];
} else {
  const [verdict, why] = rest;
  if (!VERDICTS.includes(verdict)) usage();
  change.verdict = verdict;
  if (why) change.why = why;
}

const notes = readNotes();
for (const stamp of stamps) {
  const { why, ...kept } = notes[stamp] ?? {};
  // A new verdict brings its own reason or none; the old one argued for
  // something else.
  notes[stamp] = { ...(change.verdict ? kept : { ...kept, why }), ...change };
}
writeNotes(notes);
writeIndex();
for (const stamp of stamps) {
  process.stdout.write(`${stamp}  ${JSON.stringify(notes[stamp])}\n`);
}

function usage() {
  fail(
    `usage: npm run evals:verdict -- <stamp>[,<stamp>…]|last ${VERDICTS.join("|")} ["why"]\n` +
      `       npm run evals:verdict -- <stamp>|last --note "what it tested"`,
  );
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
