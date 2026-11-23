/**
 * Plain-language evals: does a SessionStart rule make replies easier to follow?
 * `run.mjs` scores which tool a model picks; this scores the prose it writes.
 *
 * Each case is a document from this repo plus a question about it from a user
 * who has not read it. Every case runs in two arms through headless Claude
 * Code:
 *
 *   control  no hooks
 *   rule     `cases.json`'s rule, delivered as SessionStart additionalContext,
 *            the way the Valise hook delivers a custom entry
 *
 * A judge model then lists the names the reply used without explaining them
 * and the references a reader could not resolve. Fewer is better.
 *
 *   node evals/plain.mjs                         # every case, 3 repeats
 *   node evals/plain.mjs --case adr-0002-lease --repeat 1
 *   node evals/plain.mjs --model sonnet --judge opus
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(HERE, "runs/plain");
const ARMS = ["control", "rule"];

const { values: flags } = parseArgs({
  options: {
    case: { type: "string" },
    repeat: { type: "string", default: "3" },
    model: { type: "string", default: "opus" },
    judge: { type: "string", default: "sonnet" },
    parallel: { type: "string", default: "4" },
  },
});

const spec = JSON.parse(readFileSync(join(HERE, "plain/cases.json"), "utf8"));
const wanted = flags.case?.split(",");
const cases = spec.cases.filter((c) => !wanted || wanted.includes(c.id));
if (cases.length === 0) throw new Error(`no case matches ${flags.case}`);

// The same isolation as the harness lane: no user settings, no tools, no
// claude.ai connectors, and an empty cwd so this repo's CLAUDE.md stays out.
const dir = mkdtempSync(join(tmpdir(), "valise-plain-"));
const ENV = {
  ...process.env,
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
};
const BASE = [
  "-p",
  "--setting-sources",
  "",
  "--tools",
  "",
  "--no-session-persistence",
  "--output-format",
  "json",
];

const hookOutput = join(dir, "rule.json");
writeFileSync(
  hookOutput,
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: spec.rule,
    },
  }),
);
const ruleSettings = join(dir, "settings.json");
writeFileSync(
  ruleSettings,
  JSON.stringify({
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: `cat '${hookOutput}'` }] },
      ],
    },
  }),
);

const VERDICT = {
  type: "object",
  properties: {
    undefined_terms: {
      type: "array",
      items: { type: "string" },
      description:
        "Names the reply uses without explaining them on first use: code identifiers, flags, scope or field names, labels from the document, or labels the reply coined. Not general engineering vocabulary such as PR, commit, OAuth, MCP, SQL, CI, token.",
    },
    vague_refs: {
      type: "array",
      items: { type: "string" },
      description:
        "Short quotes where 'it', 'this', 'the job', 'the repo', or a similar reference could mean more than one thing to this reader.",
    },
    answers_first: {
      type: "boolean",
      description:
        "Whether the first paragraph answers the question the user asked.",
    },
  },
  required: ["undefined_terms", "vague_refs", "answers_first"],
};

/**
 * One `claude -p` call; resolves to its final JSON result event. The judge's
 * structured output fails to parse now and then, and one bad call should not
 * cost the run, so a failure retries twice.
 */
async function claude(args, attempts = 3) {
  try {
    return await claudeOnce(args);
  } catch (error) {
    if (attempts <= 1) throw error;
    process.stderr.write(`retrying: ${error.message.split("\n")[0]}\n`);
    return claude(args, attempts - 1);
  }
}

function claudeOnce(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", [...BASE, ...args], {
      cwd: dir,
      env: ENV,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("close", (code) => {
      try {
        const result = JSON.parse(out);
        if (result.is_error) throw new Error(result.result);
        resolve(result);
      } catch (error) {
        reject(new Error(`claude exited ${code}: ${error.message} ${err}`));
      }
    });
  });
}

function turn(testCase) {
  const doc = readFileSync(join(ROOT, testCase.fixture), "utf8");
  return `You read \`${testCase.fixture}\`:\n\n<document>\n${doc}\n</document>\n\n${testCase.prompt}`;
}

async function episode(testCase, arm, repeat) {
  const args = ["--model", flags.model];
  if (arm === "rule") args.push("--settings", ruleSettings);
  const answer = await claude([...args, "--", turn(testCase)]);
  const reply = answer.result;

  const judged = await claude([
    "--model",
    flags.judge,
    "--json-schema",
    JSON.stringify(VERDICT),
    "--",
    [
      "Score a reply for how easy it is to follow on the first read.",
      "The reader knows the product at a high level and has NOT read the document the reply draws on.",
      "Judge against what this reader knows, not what the document says.",
      `<document path="${testCase.fixture}">\n${readFileSync(join(ROOT, testCase.fixture), "utf8")}\n</document>`,
      `<question>\n${testCase.prompt}\n</question>`,
      `<reply>\n${reply}\n</reply>`,
    ].join("\n\n"),
  ]);
  const verdict = judged.structured_output;
  return {
    case: testCase.id,
    arm,
    repeat,
    words: reply.split(/\s+/).filter(Boolean).length,
    undefined_terms: verdict.undefined_terms,
    vague_refs: verdict.vague_refs,
    answers_first: verdict.answers_first,
    reply,
    cost: answer.total_cost_usd + judged.total_cost_usd,
  };
}

async function pool(jobs, size) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await jobs[index]();
      const row = results[index];
      process.stderr.write(
        `${row.case} ${row.arm} #${row.repeat}: ${row.undefined_terms.length} terms, ${row.vague_refs.length} vague, ${row.words} words\n`,
      );
    }
  }
  await Promise.all(Array.from({ length: size }, worker));
  return results;
}

const repeats = Number(flags.repeat);
const jobs = cases.flatMap((testCase) =>
  ARMS.flatMap((arm) =>
    Array.from(
      { length: repeats },
      (_, repeat) => () => episode(testCase, arm, repeat),
    ),
  ),
);
const rows = await pool(jobs, Number(flags.parallel));

const mean = (values) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;
const summarize = (subset) => ({
  terms: mean(subset.map((row) => row.undefined_terms.length)),
  vague: mean(subset.map((row) => row.vague_refs.length)),
  words: mean(subset.map((row) => row.words)),
  first: subset.filter((row) => row.answers_first).length,
  n: subset.length,
});

const stamp = new Date().toISOString().replace(/:/g, "-").slice(0, 19);
const lines = [
  `# Plain-language run ${stamp}`,
  "",
  `Model \`${flags.model}\`, judge \`${flags.judge}\`, ${repeats} repeat${repeats === 1 ? "" : "s"}. Lower terms and vague references are better.`,
  "",
  `Rule: ${spec.rule}`,
  "",
  "| case | arm | undefined terms | vague refs | words | answers first |",
  "|---|---|---|---|---|---|",
];
for (const id of [...cases.map((c) => c.id), "all"]) {
  for (const arm of ARMS) {
    const s = summarize(
      rows.filter(
        (row) => row.arm === arm && (id === "all" || row.case === id),
      ),
    );
    lines.push(
      `| ${id} | ${arm} | ${s.terms.toFixed(1)} | ${s.vague.toFixed(1)} | ${Math.round(s.words)} | ${s.first}/${s.n} |`,
    );
  }
}
lines.push(
  "",
  `Cost $${rows.reduce((sum, row) => sum + row.cost, 0).toFixed(2)}.`,
  "",
);

mkdirSync(OUT, { recursive: true });
writeFileSync(
  join(OUT, `${stamp}.json`),
  `${JSON.stringify({ stamp, model: flags.model, judge: flags.judge, repeat: repeats, rule: spec.rule, cases, rows }, null, 2)}\n`,
);
writeFileSync(join(OUT, `${stamp}.md`), lines.join("\n"));
process.stdout.write(`${lines.join("\n")}\nevals/runs/plain/${stamp}.md\n`);
