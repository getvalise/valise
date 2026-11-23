#!/usr/bin/env node
/**
 * Does a model pick the right Valise tool from the tool descriptions alone?
 *
 * ADR-0003 says description text is the only discovery mechanism in fallback
 * clients. That makes the descriptions a product surface with no test behind
 * it. This is the test: every case goes to every model with the real tool
 * definitions read from a live `tools/list`, and the run records which tool
 * the model chose and whether it built valid arguments.
 *
 *   node evals/run.mjs --list                       print the cases, call nothing
 *   node evals/run.mjs                              run the default models
 *   node evals/run.mjs --models a,b --case memory-preference
 *   node evals/run.mjs --harness claude --case todo-claim   headless Claude Code
 *   node evals/run.mjs --harness opencode --case todo-claim headless OpenCode V2
 *   node evals/run.mjs --repeat 3 --case todo-claim  each cell three times
 *   node evals/run.mjs --distractors 50             50 rival tools beside Valise's
 *   node evals/run.mjs --memories 500 --case retrieval-*    on 500 memories
 *   node evals/run.mjs --case save-* --note "save_memory leads with durable"
 *   node evals/run.mjs --rerank jev ...             against a dev server with
 *                                                   TYPESAFE_API_KEY in .dev.vars
 *   node evals/run.mjs --rerank hybrid ...          against a dev server started
 *                                                   with VALISE_RERANK=hybrid
 *
 * Needs OPENROUTER_API_KEY and a Valise endpoint, VALISE_MCP_URL, default
 * http://localhost:5173/mcp. Claude needs its CLI logged in; OpenCode needs its
 * CLI and a supported provider environment key. The harness modules isolate them.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { functionTool, wrongArguments } from "./arguments.mjs";
import {
  deliveredCalls,
  emptySpend,
  endingCall,
  runEpisode,
} from "./episode.mjs";
import {
  harnessVersion,
  LANES,
  prepareLanes,
  runHarnessEpisode,
  skipReason,
} from "./harness.mjs";
import {
  divergence,
  divergenceLine,
  readNotes,
  readSkillFirst,
  writeIndex,
  writeNotes,
} from "./index.mjs";
import * as opencode from "./opencode.mjs";
import { buildCorpus } from "./retrieval/corpus.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_URL = process.env.VALISE_MCP_URL ?? "http://localhost:5173/mcp";

/** A skill read, then the action it names, then one more if asked. */
const MAX_ROUNDS = 3;

/**
 * Routine runs use the cheaper models. Sonnet remains available for targeted
 * tests and deliberate validation, but its OpenRouter spend is disproportionate.
 * Every slug is checked against `openrouter.ai/api/v1/models` before it
 * lands; a typo answers 404 per case and reads as a model-wide failure.
 */
const DEFAULT_MODELS = [
  "anthropic/claude-haiku-5.5",
  "openai/gpt-6-luna",
  "openai/gpt-5.4-mini",
  "google/gemini-3.8-flash",
  "x-ai/grok-4.3",
  "moonshotai/kimi-k2.6",
];

/** The placeholders the hook prints, by the config key that sets each one. */
const HOOK_ENTRY = {
  "hook:Stop": "capture-nudge",
  "hook:SessionStart": "recall-reminder",
  "hook:PostToolUseFailure": "recall-on-error",
};

/**
 * The skill tools a run may see: the one `/__dev/seed` puts in the store.
 * Every published skill is a tool, so a skill left behind by `npm run
 * test:ui` or the console changes what every case is shown. A run on any
 * other skill set is refused rather than recorded, so two runs are comparable
 * by construction rather than by someone checking the count.
 */
const PINNED_SKILLS = ["skill_capture-this"];

const suite = JSON.parse(readFileSync(join(HERE, "cases.json"), "utf8"));
/**
 * The model calls a good route needs, where a case does not set its own
 * `turnBudget`. Most turns name their tool outright; a case whose good route
 * reads first, a skill or the hook entries, raises it.
 */
const TURN_BUDGET = suite.turnBudget ?? 1;
const options = parseArgv(process.argv.slice(2));
const NUDGES = readNudges();
/**
 * Whether the plugin as shipped answers a failed Bash call with the
 * recall-on-error line. `{{shipped:PostToolUseFailure}}` reads it, so a case
 * that plays the shipped defaults follows the hook's default rather than
 * pinning it.
 */
const ON_ERROR_SHIPPED = printHookEntries({})["recall-on-error"].enabled;
if (
  options.harness !== undefined &&
  !["claude", "opencode"].includes(options.harness)
) {
  fail(`--harness takes claude or opencode, not ${options.harness}`);
}
if (options.harness && options.distractors > 0) {
  fail("--distractors applies to the OpenRouter lane only");
}
const distractors = pickDistractors(options.distractors);
const selected = options.case
  ? suite.cases.filter((c) => matchesCase(c.id))
  : suite.cases;
// A case the harness cannot send as one turn, or one whose answer is in a
// memory store this run did not seed, is printed and recorded in the run,
// never dropped without a word.
const skipped = selected
  .map((c) => ({
    case: c.id,
    reason:
      c.corpus && !options.memories
        ? "needs the retrieval store: --memories N"
        : options.harness
          ? skipReason(c, options.harness)
          : c.shell
            ? "runs a real command, which only the harness lane does"
            : null,
  }))
  .filter((skip) => skip.reason !== null);
for (const skip of skipped) {
  process.stderr.write(`skip  ${skip.case}: ${skip.reason}\n`);
}
const cases = selected
  .filter((c) => !skipped.some((skip) => skip.case === c.id))
  .map(resolveCase);
if (cases.length === 0) fail(`no case matches ${options.case}`);

if (options.list) {
  for (const c of cases) {
    process.stdout.write(`${c.id.padEnd(22)} → ${c.tool ?? "(no tool)"}\n`);
    process.stdout.write(`${" ".repeat(24)}${c.why}\n`);
  }
  process.exit(0);
}

const repeat = options.repeat;
const requestedModels = options.models ?? DEFAULT_MODELS;
if (
  !options.harness &&
  cases.length * repeat > 1 &&
  requestedModels.includes("anthropic/claude-sonnet-5.5") &&
  !options.allowExpensive
) {
  fail(
    "Sonnet is expensive on OpenRouter; for multi-cell runs, pass --allow-expensive to confirm the cost",
  );
}
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey && !options.harness) fail("OPENROUTER_API_KEY is not set");
// A live search shapes the route, so the store it reads is part of the run.
// Seeding first puts the three seed rows back as they ship; the hash says
// whether anything else was in the store too.
await callDevRoute("/__dev/seed");
// The retrieval corpus at one size. Its rows are in the store hash, so a run
// on 500 memories and a run on 5000 never read as the same store.
if (options.memories) {
  const { memories } = buildCorpus(
    options.memories,
    JSON.parse(
      readFileSync(join(HERE, "fixtures/retrieval-memories.json"), "utf8"),
    ),
    JSON.parse(
      readFileSync(join(HERE, "fixtures/retrieval-pool.json"), "utf8"),
    ),
  );
  await callDevRoute("/__dev/memories", memories);
}
const storeHash = digest(await callDevRoute("/__dev/store"));
// A reranked `search` (ADR-0013) ranks the same store differently, so the
// flag has to name what the server runs, both ways: a plain run against a
// reranking server would record the wrong surface. A server with
// TYPESAFE_API_KEY in `.dev.vars` reranks with Jev unless told otherwise.
const { mode: rerank } = await callDevRoute("/__dev/rerank");
if ((options.rerank ?? null) !== rerank) {
  fail(
    rerank
      ? `the dev server reranks search with ${rerank}; pass --rerank ${rerank}, or restart it with VALISE_RERANK=off`
      : options.rerank === "jev"
        ? "--rerank jev needs a dev server with TYPESAFE_API_KEY in .dev.vars"
        : `--rerank ${options.rerank} needs a dev server started with VALISE_RERANK=${options.rerank}`,
  );
}
// A harness column is a lane plus its client model reference. OpenCode keeps
// provider/model intact; Claude's plugin and MCP rows sit side by side.
const driver =
  options.harness === "opencode"
    ? opencode
    : {
        harnessVersion,
        prepareLanes,
        LANES,
        runHarnessEpisode,
        DEFAULT_MODELS: ["sonnet"],
      };
const harness = options.harness
  ? {
      name: options.harness === "opencode" ? "opencode" : "claude-code",
      version: driver.harnessVersion(),
    }
  : null;
const lanes = harness ? driver.prepareLanes(MCP_URL, callDevRoute) : null;
const models = harness
  ? driver.LANES.flatMap((lane) =>
      (options.models ?? driver.DEFAULT_MODELS).map(
        (model) => `${lane}/${model}`,
      ),
    )
  : (options.models ?? DEFAULT_MODELS);
const tools = await readToolSurface();
assertPinnedSkills(tools);
const toolsHash = digest(tools);
const clash = distractors.find((rival) =>
  tools.some((tool) => tool.function.name === rival.function.name),
);
if (clash) fail(`distractor ${clash.function.name} shadows a Valise tool`);
/**
 * Which tools advertise an optional `why`, read off the live surface rather
 * than listed here, so the set cannot drift from what the server serves.
 * ADR-0007 keeps the field out of `requiredArgs`: the argument column fails
 * nothing today, so gating on an advisory field could only turn volunteered
 * silence into a regression. Fill rate asks the question that matters — do
 * models offer it at all.
 */
const offersWhy = new Set(
  tools
    .filter((tool) => tool.function.parameters?.properties?.why !== undefined)
    .map((tool) => tool.function.name),
);
process.stderr.write(
  `${tools.length} tools ${toolsHash}${distractors.length ? ` + ${distractors.length} distractors` : ""}, store ${storeHash}, from ${MCP_URL}, ${cases.length} cases, ${models.length} models, ${repeat}× each\n`,
);

const rows = [];
for (const model of models) {
  for (const testCase of cases) {
    // Temperature 0 is not determinism across providers, so a cell run once
    // is one sample; the repeats are what put an interval on it.
    for (let index = 0; index < repeat; index++) {
      const row = {
        ...(await scoreOne(model, testCase, surfaceFor(testCase, tools))),
        repeat: index,
      };
      rows.push(row);
      process.stderr.write(
        `${row.pass ? "pass" : "FAIL"}  ${model}  ${testCase.id}${repeat > 1 ? ` #${index + 1}` : ""}  → ${cellText(row)}\n`,
      );
    }
  }
}

const run = {
  at: new Date().toISOString(),
  endpoint: MCP_URL,
  // Only on harness runs, which is how trends keeps their cells apart from
  // the OpenRouter ones.
  ...(harness ? { harness } : {}),
  ...(skipped.length > 0 ? { skipped } : {}),
  // Only on runs that seeded the retrieval corpus, which is how trends keeps
  // a cell on 50 memories apart from the same cell on 5000.
  ...(options.memories ? { memories: options.memories } : {}),
  ...(rerank ? { rerank } : {}),
  ...(!harness ? { episodeProtocol: "all-tool-calls-v1" } : {}),
  models,
  toolNames: tools.map((tool) => tool.function.name),
  // Two runs compare only when they saw the same surface and the same store.
  toolsHash,
  // One digest per tool, so the evals tab can name the description that
  // changed between two runs of a case rather than only that one did.
  toolHashes: Object.fromEntries(
    tools.map((tool) => [tool.function.name, digest(tool)]),
  ),
  storeHash,
  // Rows per cell. Totals count every row, so a model's 37/37 at one repeat
  // reads 111/111 at three.
  repeat,
  // Rivals on the surface beside Valise's. trends.mjs keeps each count in its
  // own cells, so the same case reads as a curve over N.
  ...(distractors.length
    ? {
        distractors: {
          count: distractors.length,
          hash: digest(distractors),
          names: distractors.map((tool) => tool.function.name),
        },
      }
    : {}),
  // The cases as they stood at run time. Deriving them from `cases.json` when
  // the tab renders would print an edited prompt under an old score, which is
  // the one thing a kept run exists to prevent.
  system: suite.system,
  cases: cases.map(({ messages, raw, ...testCase }) => testCase),
  rows,
};
const stamp = run.at.replaceAll(":", "-").slice(0, 19);
mkdirSync(join(HERE, "runs"), { recursive: true });
writeFileSync(
  join(HERE, "runs", `${stamp}.json`),
  `${JSON.stringify(run, null, 2)}\n`,
);
const report = markdownReport(run, cases);
writeFileSync(join(HERE, "runs", `${stamp}.md`), report);
// What the run tests, said when it starts rather than reconstructed later.
// The verdict follows once the run is read: `npm run evals:verdict`.
if (options.note) {
  writeNotes({ ...readNotes(), [stamp]: { note: options.note } });
}
// The console's evals tab reads the index, not the run files. ADR-0006.
writeIndex();
process.stdout.write(report);
process.stderr.write(
  `\nRecord what became of it: npm run evals:verdict -- ${stamp} kept|dropped|baseline "why"\n`,
);

/**
 * The nudge texts as the clients emit them, read from their sources rather
 * than copied into `cases.json`, so a wording change is what the next run
 * scores. The hook's `--print` reports its shipped defaults when no config
 * file exists; the server's tier-2 line is the JSON `app/mcp/tools.ts` imports.
 */
function readNudges() {
  const hook = printHookEntries({});
  const server = JSON.parse(
    readFileSync(join(HERE, "../app/mcp/nudges.json"), "utf8"),
  );
  return {
    "hook:Stop": hook["capture-nudge"].text,
    "hook:SessionStart": hook["recall-reminder"].text,
    "hook:PostToolUseFailure": hook["recall-on-error"].text,
    "server:claim_todo": server.claim_todo,
    "server:complete_todo": server.complete_todo,
    "server:save_memory": server.save_memory,
  };
}

/**
 * The hook's entries as `--print` reports them under a config. With no config
 * file that is the shipped defaults. A case that overrides a hook text goes
 * through the hook's own parser, so a variant past MAX_TEXT_LENGTH or the
 * combined limit fails the run rather than scoring a text no client could
 * ship.
 */
function printHookEntries(config) {
  const dir = mkdtempSync(join(tmpdir(), "valise-eval-"));
  const file = join(dir, "config");
  if (Object.keys(config).length > 0)
    writeFileSync(file, JSON.stringify(config));
  let printed;
  try {
    printed = JSON.parse(
      execFileSync(
        process.execPath,
        [join(HERE, "../clients/valise/scripts/valise-hook.mjs"), "--print"],
        { encoding: "utf8", env: { ...process.env, VALISE_CONFIG: file } },
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return Object.fromEntries(
    printed.entries
      .filter((entry) => entry.id)
      .map((entry) => [entry.id, entry]),
  );
}

/**
 * `nudges` on a case replaces a placeholder's text for that case alone, so a
 * wording variant runs beside the shipped one without editing the default.
 */
function nudgesFor(raw) {
  if (!raw.nudges) return NUDGES;
  const hookConfig = {};
  for (const [name, text] of Object.entries(raw.nudges)) {
    // A misspelt override would leave the shipped text in place and score it
    // under the variant's name.
    if (!(name in NUDGES)) fail(`${raw.id}: no nudge named ${name}`);
    if (HOOK_ENTRY[name]) hookConfig[HOOK_ENTRY[name]] = { text };
  }
  let hookEntries;
  try {
    hookEntries = printHookEntries(hookConfig);
  } catch (cause) {
    fail(`${raw.id}: the hook refused the override: ${cause.stderr ?? cause}`);
  }
  const resolved = { ...NUDGES, ...raw.nudges };
  for (const [name, id] of Object.entries(HOOK_ENTRY)) {
    if (name in raw.nudges) resolved[name] = hookEntries[id].text;
  }
  return resolved;
}

/**
 * A case is one user turn, or a scenario: `context` is appended to the system
 * prompt the way a SessionStart hook adds context, and `history` is the
 * conversation so far, ending on a user turn or a tool result. `{{name}}`
 * placeholders take the live nudge texts, or the case's own `nudges` entry
 * for that name, so a candidate wording runs beside the shipped one in the
 * same run without editing the file the server ships. `prompt` on the
 * resolved case is the whole scenario as text, because that is what the
 * evals tab shows.
 */
function resolveCase(raw) {
  const fill = filler(raw);
  const system = raw.context
    ? `${suite.system}\n\n${fill(raw.context)}`
    : suite.system;
  const history = (raw.history ?? []).map((message) => ({
    ...message,
    ...(typeof message.content === "string"
      ? { content: fill(message.content) }
      : {}),
  }));
  const turns = raw.prompt
    ? [...history, { role: "user", content: fill(raw.prompt) }]
    : history;
  if (turns.length === 0) fail(`${raw.id}: needs a prompt or a history`);
  const turnBudget = raw.turnBudget ?? TURN_BUDGET;
  const maxRounds = raw.maxRounds ?? MAX_ROUNDS;
  // A budget past the cap could never be spent, so it would score every
  // route as within it.
  if (!Number.isInteger(turnBudget) || turnBudget < 1 || turnBudget > maxRounds)
    fail(
      `${raw.id}: turnBudget ${turnBudget} is not between 1 and ${maxRounds}`,
    );
  const scenario = raw.context !== undefined || raw.history !== undefined;
  return {
    ...raw,
    turnBudget,
    maxRounds,
    // The harness lane builds its own turn, leaving hook texts to the hooks.
    raw,
    prompt: scenario
      ? [
          ...(raw.context ? [`[context] ${fill(raw.context)}`] : []),
          ...turns.map(transcriptLine),
        ].join("\n\n")
      : raw.prompt,
    messages: [{ role: "system", content: system }, ...turns],
  };
}

/** `{{name}}` placeholders take the case's nudge texts, `{{fixture:…}}` a file. */
function filler(raw) {
  const nudges = nudgesFor(raw);
  return (text) =>
    text.replace(/\{\{([a-z0-9_:.-]+)\}\}/gi, (_, name) => {
      if (name.startsWith("fixture:")) return readFixture(raw.id, name);
      if (name === "shipped:PostToolUseFailure") {
        return ON_ERROR_SHIPPED
          ? onErrorBlock(nudges["hook:PostToolUseFailure"])
          : "";
      }
      if (!(name in nudges)) fail(`${raw.id}: unknown placeholder {{${name}}}`);
      return nudges[name];
    });
}

/**
 * What Claude Code appends to a failed Bash result when the hook answers, as
 * `recall-on-error-hook*` spell it out around `{{hook:PostToolUseFailure}}`.
 */
function onErrorBlock(text) {
  return `\n\n<system-reminder>\nPostToolUseFailure:Bash hook additional context: ${text}\n</system-reminder>`;
}

/**
 * `{{fixture:<file>}}` is a file in `evals/fixtures/`, for a context or a tool
 * result too long to read inline: a startup brief, a `list_ready` payload.
 */
function readFixture(caseId, name) {
  const file = name.slice("fixture:".length);
  try {
    return readFileSync(join(HERE, "fixtures", file), "utf8").trim();
  } catch {
    fail(`${caseId}: no fixture evals/fixtures/${file}`);
  }
}

/**
 * `--distractors N`: the first N tools of `fixtures/distractors.json`, taken
 * one per server in turn, so 20 holds a tool from every server and 20, 50 and
 * 100 nest. Each server lists its most rivalrous tool first, a generic
 * `remember` before `list_memories`, because that is the tool a client
 * carrying that server would have on the surface.
 */
function pickDistractors(count) {
  if (count === 0) return [];
  const { servers } = JSON.parse(
    readFileSync(join(HERE, "fixtures", "distractors.json"), "utf8"),
  );
  const rounds = Math.max(...servers.map((server) => server.tools.length));
  const ordered = [];
  for (let round = 0; round < rounds; round++) {
    for (const server of servers) {
      if (server.tools[round]) ordered.push(server.tools[round]);
    }
  }
  if (!Number.isInteger(count) || count < 0 || count > ordered.length) {
    fail(`--distractors takes 0 to ${ordered.length}, not ${count}`);
  }
  return ordered
    .slice(0, count)
    .map((tool) => functionTool(tool.name, tool.description, tool.parameters));
}

/** `--case id`, `--case prefix*` for a family, or a comma list of either. */
function matchesCase(id) {
  return options.case
    .split(",")
    .some((pattern) =>
      pattern.endsWith("*")
        ? id.startsWith(pattern.slice(0, -1))
        : id === pattern,
    );
}

/**
 * The tools one case sees. `hideTools` takes names, or `prefix*`, off the
 * live surface, which is how a case plays a connector with no skills over
 * MCP. `harnessTools` adds the harness's own tools, a native skill registry
 * for instance, each answered with the canned `result` the case gives it.
 * Distractors come first and Valise last, the order Claude Code lists other
 * servers before `valise`. A call to one ends the episode as a miss.
 */
function surfaceFor(testCase, tools) {
  const hidden = testCase.hideTools ?? [];
  const isHidden = (name) =>
    hidden.some((pattern) =>
      pattern.endsWith("*")
        ? name.startsWith(pattern.slice(0, -1))
        : name === pattern,
    );
  return [
    ...distractors,
    ...tools.filter((tool) => !isHidden(tool.function.name)),
    ...(testCase.harnessTools ?? []).map((tool) =>
      functionTool(
        tool.name,
        tool.description,
        tool.parameters ?? { type: "object", properties: {} },
      ),
    ),
  ];
}

function transcriptLine(message) {
  if (message.tool_calls) {
    return message.tool_calls
      .map(
        (call) =>
          `[assistant → ${call.function.name}] ${call.function.arguments}`,
      )
      .join("\n");
  }
  return `[${message.role}] ${message.content}`;
}

/**
 * One case, one model, scored on where the model ends up rather than on its
 * first move. A skill tool returns instructions and takes no action, so a
 * model that reads `skill_capture-this` and then calls `save_memory` has done
 * the right thing; stopping at the first call would score that as a miss.
 * Skill calls and the `READ_ONLY` tools are executed for real against the
 * endpoint and fed back. Everything else stops the episode before it writes.
 */
async function scoreOne(model, testCase, tools) {
  let route = [];
  let spend = emptySpend();
  let error = null;
  let session = null;
  let capped = false;
  let answer = null;
  let endingIndex;
  try {
    const episode = harness
      ? await driver.runHarnessEpisode(
          lanes,
          model,
          testCase.raw,
          filler(testCase.raw),
        )
      : await runEpisode(model, testCase, tools, { apiKey, callLiveTool });
    route = episode.route;
    spend = episode.spend;
    session = episode.session ?? null;
    capped = episode.capped === true;
    answer = episode.answer ?? null;
    error = episode.error ?? null;
    endingIndex = episode.endingIndex;
  } catch (cause) {
    error = String(cause.message ?? cause);
  }
  const accepted = [testCase.tool, ...(testCase.alsoAccept ?? [])];
  // `get_skill` on a skill's name returns the same body as its `skill_*`
  // tool, so it is the same door: for `via`, and for a skill in `alsoAccept`.
  const reads = (step, skill) =>
    step?.name === skill ||
    (skill?.startsWith("skill_") &&
      step?.name === "get_skill" &&
      step.args?.name === skill.slice("skill_".length));
  const isAccepted = (step) => accepted.some((name) => reads(step, name));
  // A harness session keeps going past the call a case is about: it claims,
  // then fetches what it claimed. So it is scored on whether it made the
  // expected call at all, where the OpenRouter lane ends its episode there.
  const last =
    (harness &&
      (route.find((step) => step.name === testCase.tool) ??
        route.find(isAccepted))) ||
    endingCall({ route, endingIndex }) ||
    null;
  const chose = last?.name ?? null;
  // `accepted.includes(chose)` also covers `tool: null` with an empty route.
  // A route the cap cut off had not ended, even on a skill the case accepts.
  // A `tool: null` case asks whether Valise fires on a turn it should not.
  // A rival answering it is the other server doing its job, such as a
  // filesystem tool on "add a line to ./notes.txt", not Valise misfiring.
  const rivalOnNull =
    testCase.tool === null &&
    distractors.some((rival) => rival.function.name === chose);
  const toolMatch =
    error === null &&
    !capped &&
    (accepted.includes(chose) || isAccepted(last) || rivalOnNull);
  const names = route.map((step) => step.name);
  // `via` names a skill the route had to pass through to count.
  const viaMissing =
    testCase.via &&
    !(harness ? route : deliveredCalls(route)).some((step) =>
      reads(step, testCase.via),
    )
      ? testCase.via
      : null;
  const missingArgs =
    chose === testCase.tool && !capped
      ? (testCase.requiredArgs ?? []).filter(
          (key) => last?.args?.[key] === undefined,
        )
      : [];
  // `expectArgs` scores a value, not a key: which memory a model fetched out
  // of ten that look alike is the whole question on the retrieval cases.
  const wrongArgs =
    chose === testCase.tool && !capped
      ? wrongArguments(testCase, last?.args ?? {})
      : [];
  // `expectAnswer` scores a prose ending: the answer has to name one of its
  // strings. On the check-on-save duplicate, naming the restated id is the
  // only action the nudge can ask for.
  const answerMissing =
    testCase.expectAnswer !== undefined &&
    toolMatch &&
    chose === null &&
    !testCase.expectAnswer.some((text) => answer?.includes(text));
  const pass =
    toolMatch &&
    missingArgs.length === 0 &&
    wrongArgs.length === 0 &&
    viaMissing === null &&
    !answerMissing;
  return {
    model,
    case: testCase.id,
    expected: testCase.tool,
    chose,
    route: names,
    ...(!harness
      ? { routeCalls: route, endingIndex: endingIndex ?? null }
      : {}),
    // The input at the first decision: the system prompt, any startup context,
    // and the history. What a startup brief costs before the model has acted.
    firstPromptTokens: spend.firstPromptTokens,
    args: last?.args ?? null,
    toolMatch,
    viaMissing,
    missingArgs,
    wrongArgs,
    answerMissing,
    pass,
    capped,
    turnBudget: testCase.turnBudget,
    // The second number, beside pass rather than inside it: a route that
    // reads twice before the right call is slower, not wrong, and folding the
    // two would make old runs incomparable. A harness session runs on past
    // its answer and counts its turns its own way, so it has no budget.
    withinBudget: harness ? null : pass && spend.turns <= testCase.turnBudget,
    // What the answer cost. A description two models both read correctly can
    // still cost one of them a skill round trip and four thousand reasoning
    // tokens, and tool choice alone never says so.
    ...spend,
    whyOffered: chose !== null && offersWhy.has(chose),
    whyFilled:
      typeof last?.args?.why === "string" && last.args.why.trim() !== "",
    error,
    // Scored whole, stored cut: the id an answer names can sit past 600.
    ...(answer ? { answer: answer.slice(0, 600) } : {}),
    ...(harness ? { lane: model.split("/")[0], session } : {}),
  };
}

/**
 * Skill tools only ever read, so the episode can run them for real, and so
 * can `READ_ONLY` and whatever a case adds in `live`.
 */
async function callLiveTool(name, args) {
  const answered = await rpc("tools/call", { name, arguments: args ?? {} });
  return JSON.stringify(answered.result ?? answered);
}

/** The live surface, never a hand-kept copy, so a stale eval cannot pass. */
async function readToolSurface() {
  const listed = await rpc("tools/list", {});
  if (!Array.isArray(listed.result?.tools)) {
    fail(
      `tools/list returned no tools: ${JSON.stringify(listed).slice(0, 300)}`,
    );
  }
  return listed.result.tools.map((tool) =>
    functionTool(tool.name, tool.description, tool.inputSchema),
  );
}

function assertPinnedSkills(tools) {
  const skills = tools
    .map((tool) => tool.function.name)
    .filter((name) => name.startsWith("skill_"));
  const extra = skills.filter((name) => !PINNED_SKILLS.includes(name));
  const missing = PINNED_SKILLS.filter((name) => !skills.includes(name));
  if (extra.length === 0 && missing.length === 0) return;
  fail(
    [
      `${MCP_URL} serves a skill set other than ${PINNED_SKILLS.join(", ")}.`,
      ...(extra.length ? [`  not seeded: ${extra.join(", ")}`] : []),
      ...(missing.length ? [`  missing: ${missing.join(", ")}`] : []),
      "Point the runner at a fresh store: npm run evals:store, then VALISE_STATE=.wrangler/evals npm run dev.",
    ].join("\n"),
  );
}

/**
 * The loopback levers `npm run seed` uses, on the same origin as MCP. A body
 * makes it a POST.
 */
async function callDevRoute(path, body) {
  const url = new URL(path, MCP_URL);
  const response = await fetch(
    url,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  ).catch(() => null);
  if (!response?.ok) {
    fail(
      `${url} answered ${response?.status ?? "nothing"}. The runner needs a local \`npm run dev\`.`,
    );
  }
  return response.json();
}

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 12);
}

async function rpc(method, params) {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
      "x-valise-agent": "valise-eval",
      "x-valise-client": "script",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(
      `${MCP_URL} answered ${response.status}. Start it with \`npm run dev\`.`,
    );
  }
  const line = raw
    .split("\n")
    .find((l) => l.startsWith("data:"))
    ?.slice("data:".length)
    .trim();
  return JSON.parse(line || raw);
}

function markdownReport(run, cases) {
  const byModel = new Map(run.models.map((model) => [model, []]));
  for (const row of run.rows) byModel.get(row.model)?.push(row);

  const lane = run.harness
    ? ` · ${run.harness.name} ${run.harness.version}`
    : "";
  const skips = (run.skipped ?? [])
    .map((skip) => `- skipped ${skip.case}: ${skip.reason}\n`)
    .join("");
  const rivals = run.distractors
    ? ` · ${run.distractors.count} distractors \`${run.distractors.hash}\``
    : "";
  // The production log reads capture-this before 6 of 37 real saves (research
  // note 2026-10-18). This is the same ratio over every route in the run that
  // ended on save_memory, so the two read side by side.
  const saves = run.rows.filter((row) => row.chose === "save_memory");
  const savesAfterSkill = saves.filter(readSkillFirst).length;
  const header = [
    "# Valise tool-choice eval",
    "",
    `${run.at} · ${run.endpoint} · ${run.toolNames.length} tools \`${run.toolsHash}\`${rivals} · store \`${run.storeHash}\`${run.memories ? ` (${run.memories} memories)` : ""}${run.rerank ? ` · search reranked (${run.rerank})` : ""}${lane}${run.repeat > 1 ? ` · ${run.repeat} repeats per cell` : ""}`,
    "",
    `${skips}${skips ? "\n" : ""}${divergenceLine(divergence(run.rows))} · save_memory after a skill read: ${savesAfterSkill}/${saves.length}`,
    "",
    "",
  ].join("\n");
  const summary = [
    "| Model | Primary tool | Primary or accepted | Arguments valid | Within budget | Capped | Turns | Tokens | Cost | Said why | Errors |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...run.models.map((model) => {
      const rows = byModel.get(model) ?? [];
      const exact = rows.filter((row) => row.chose === row.expected).length;
      const matched = rows.filter((row) => row.toolMatch).length;
      const passed = rows.filter((row) => row.pass).length;
      const inBudget = run.harness
        ? "—"
        : `${rows.filter((row) => row.withinBudget).length}/${rows.length}`;
      const capped = rows.filter((row) => row.capped).length;
      const errors = rows.filter((row) => row.error !== null).length;
      const total = (key) =>
        rows.reduce((sum, row) => sum + (row[key] ?? 0), 0);
      const tokens = total("promptTokens") + total("completionTokens");
      const offered = rows.filter((row) => row.whyOffered).length;
      const filled = rows.filter(
        (row) => row.whyOffered && row.whyFilled,
      ).length;
      const why = offered === 0 ? "—" : `${filled}/${offered}`;
      return `| \`${model}\` | ${exact}/${rows.length} | ${matched}/${rows.length} | ${passed}/${rows.length} | ${inBudget} | ${capped || "—"} | ${total("turns")} | ${tokens} | $${total("costUsd").toFixed(4)} | ${why} | ${errors} |`;
    }),
  ].join("\n");

  const detail = [
    "",
    "",
    "## Per case",
    "",
    `| Case | Expected | Budget | ${run.models.map((m) => `\`${run.harness ? m : m.split("/").pop()}\``).join(" | ")} | Read a skill |`,
    `| --- | --- | --- | ${run.models.map(() => "---").join(" | ")} | --- |`,
    ...cases.map((testCase) => {
      const cells = run.models.map((model) => {
        const rows = run.rows.filter(
          (r) => r.model === model && r.case === testCase.id,
        );
        if (rows.length === 0) return "—";
        if (run.repeat === 1) return cellText(rows[0]);
        // The count first, then the turns each pass took, then each distinct
        // way the cell ended, so 2/3 says what the third did. ✓ alone stays
        // out: k/N already says it.
        const passes = rows.filter((row) => row.pass);
        const turns = run.harness
          ? []
          : passes.map((row) => row.turns).sort((a, b) => a - b);
        const endings = [...new Set(rows.map(endingText))].filter(
          (text) => text !== "✓",
        );
        return [
          `${passes.length}/${rows.length}`,
          ...(turns.length ? [`${turns.join(",")}t`] : []),
          ...endings,
        ].join(" · ");
      });
      // Apart from pass, because a case with no `via` passes either way, and
      // how often a model reads the skill unprompted is the number the capture
      // nudges are meant to move.
      const caseRows = run.rows.filter((r) => r.case === testCase.id);
      const read = `${caseRows.filter(readSkillFirst).length}/${caseRows.length}`;
      const budget = run.harness ? "—" : testCase.turnBudget;
      return `| ${testCase.id} | ${testCase.tool ?? "(no tool)"} | ${budget} | ${cells.join(" | ")} | ${read} |`;
    }),
    "",
  ].join("\n");

  return `${header}${summary}${detail}`;
}

/**
 * A pass carries the turns it took, and `over` when that ran past the case's
 * budget, so the right call on turn 3 of 3 does not read like one on turn 1.
 */
function cellText(row) {
  const ending = endingText(row);
  // A harness session counts its own turns past the answer; see withinBudget.
  if (!row.pass || row.withinBudget === null) return ending;
  return `${ending} ${row.turns}t${row.withinBudget === false ? " over" : ""}`;
}

function endingText(row) {
  if (row.error) return "error";
  // An accepted alternative is not the same as the primary answer, and a
  // table that prints both as ✓ hides the thing worth looking at.
  if (row.pass) return row.chose === row.expected ? "✓" : `≈ ${row.chose}`;
  // The right tool by a route that skipped the skill the case requires.
  if (row.viaMissing) return `skipped ${row.viaMissing}`;
  if (row.toolMatch && row.wrongArgs?.length > 0)
    return `wrong ${row.wrongArgs.join(", ")}`;
  if (row.answerMissing) return "unnamed";
  if (row.toolMatch) return `missing ${row.missingArgs.join(", ")}`;
  // Out of rounds is the runner's limit, not the model picking a wrong tool.
  if (row.capped) return "(cap)";
  return row.chose ?? "(none)";
}

function parseArgv(argv) {
  const options = { list: argv.includes("--list"), repeat: 1, distractors: 0 };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--models") options.models = argv[++index]?.split(",");
    if (argv[index] === "--allow-expensive") options.allowExpensive = true;
    if (argv[index] === "--case") options.case = argv[++index];
    if (argv[index] === "--harness") options.harness = argv[++index];
    if (argv[index] === "--repeat") options.repeat = Number(argv[++index]);
    if (argv[index] === "--distractors")
      options.distractors = Number(argv[++index]);
    if (argv[index] === "--memories") options.memories = Number(argv[++index]);
    if (argv[index] === "--note") options.note = argv[++index];
    if (argv[index] === "--rerank") options.rerank = argv[++index];
  }
  if (!Number.isInteger(options.repeat) || options.repeat < 1) {
    fail("--repeat takes a whole number of 1 or more");
  }
  return options;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
