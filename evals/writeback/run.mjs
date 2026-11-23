#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { runUiTestServer } from "../../scripts/ui-test-server.mjs";
import { runCase } from "./case.mjs";
import { Budget, hash, scenarios } from "./core.mjs";
import { mcpClient } from "./harness.mjs";
import { agentA, agentB, variants } from "./scripted.mjs";
import { observer } from "./store.mjs";

// Importing the helper modules is provider and server free. This executable
// is an explicit runtime lever, never part of unit tests or npm run verify.
const { values: options } = parseArgs({
  options: {
    endpoint: { type: "string" },
    serve: { type: "string" },
    revision: { type: "string" },
    case: { type: "string" },
    model: { type: "string" },
    arm: { type: "string", default: "hookless" },
    output: { type: "string" },
    ledger: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "a-variant": { type: "string", default: "good" },
    "b-variant": { type: "string", default: "good" },
    "allow-expensive": { type: "boolean", default: false },
    "max-cost": { type: "string", default: "1" },
    "max-episodes": { type: "string", default: "24" },
    rounds: { type: "string", default: "12" },
    "max-calls": { type: "string", default: "32" },
    "max-tokens": { type: "string", default: "1024" },
    catalog: { type: "string", default: "64" },
  },
});
const dry = options["dry-run"];
const fail = (message) => {
  throw new Error(message);
};
const cases =
  options.case === "all"
    ? scenarios
    : (options.case ?? "")
        .split(",")
        .map((id) => scenarios.find((s) => s.id === id));
if (!options.case || cases.some((s) => !s))
  fail(`--case must be all or a list of: ${scenarios.map((s) => s.id)}`);
if (!options.endpoint === !options.serve)
  fail("Pass --serve <port> for a fresh store, or --endpoint <loopback /mcp>");
if (!["hookless", "injected"].includes(options.arm))
  fail("--arm hookless|injected");
const knobs = {
  maxCost: Number(options["max-cost"]),
  maxEpisodes: Number(options["max-episodes"]),
  rounds: Number(options.rounds),
  maxCalls: Number(options["max-calls"]),
  maxTokens: Number(options["max-tokens"]),
  catalog: Number(options.catalog),
};
if (
  !(knobs.maxCost > 0) ||
  ![knobs.maxEpisodes, knobs.rounds, knobs.maxCalls, knobs.maxTokens].every(
    (n) => Number.isInteger(n) && n > 0,
  ) ||
  !(Number.isInteger(knobs.catalog) && knobs.catalog >= 0)
)
  fail("Knobs must be positive integers; --max-cost a positive dollar amount");
if (dry) {
  if (!variants.a.includes(options["a-variant"]))
    fail(`--a-variant: ${variants.a}`);
  if (!variants.b.includes(options["b-variant"]))
    fail(`--b-variant: ${variants.b}`);
} else {
  // Each paid case gets its own empty store, so an earlier case's records
  // cannot leak into a later B's unscoped search.
  if (cases.length !== 1) fail("A paid run takes exactly one --case");
  if (!options.model) fail("--model required; there is no default");
  if (!/mini|haiku|flash/i.test(options.model) && !options["allow-expensive"])
    fail("Model above the Mini/Haiku/Flash class: pass --allow-expensive");
  if (!options.ledger || !options.output)
    fail("A paid run needs --ledger (cumulative budget) and --output");
  if (!options.revision) fail("--revision <server commit> required");
  if (!process.env.OPENROUTER_API_KEY)
    fail("OPENROUTER_API_KEY required; no credential discovery");
}

const budget = new Budget({
  usd: dry ? Number.MAX_SAFE_INTEGER : knobs.maxCost,
  episodes: dry ? Number.MAX_SAFE_INTEGER : knobs.maxEpisodes,
  rounds: knobs.rounds,
});
for (const path of [options.ledger, options.output].filter(Boolean))
  await mkdir(dirname(path), { recursive: true });
if (!dry) {
  // One ledger spans every case, model and arm of a budget. Its lock survives
  // a crash so an operator reconciles unknown reservations before resuming.
  await writeFile(`${options.ledger}.lock`, `${process.pid}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    const old = JSON.parse(await readFile(options.ledger, "utf8"));
    if (
      old.cap !== budget.cap ||
      old.episodeLimit !== budget.episodeLimit ||
      old.roundLimit !== budget.roundLimit ||
      !Number.isFinite(old.spent) ||
      !Array.isArray(old.requests)
    )
      fail("Ledger knobs differ from this invocation; reuse the same budget");
    Object.assign(budget, old);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
if (options.output)
  await writeFile(options.output, "{}\n", { flag: "wx", mode: 0o600 });

const runnerRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const run = {
  lane: "writeback-v2",
  mode: dry ? "dry-run" : "model",
  at: new Date().toISOString(),
  serverRevision: options.revision ?? runnerRevision,
  runnerRevision,
  sourceHash: hash(
    await Promise.all(
      [
        "case.mjs",
        "core.mjs",
        "harness.mjs",
        "store.mjs",
        "scripted.mjs",
        "run.mjs",
      ].map((f) => readFile(new URL(f, import.meta.url), "utf8")),
    ),
  ),
  model: dry
    ? `scripted:a=${options["a-variant"]},b=${options["b-variant"]}`
    : options.model,
  arm: options.arm,
  endpoint: options.endpoint,
  knobs,
  lifecycle: options.arm === "injected" ? "injected-start-and-stop" : "absent",
  limitations: [
    dry
      ? "Scripted agents: proves the harness and scorer, not model behavior"
      : "OpenRouter sessions, not actual host-client lifecycle",
    "Loopback development identity, not deployed OAuth acceptance",
    "Synthetic allowlisted checksum execution, not arbitrary coding work",
  ],
  cases: [],
};
const checkpoint = async () => {
  const files = [];
  if (options.output) files.push([options.output, { ...run, budget }]);
  if (!dry) files.push([options.ledger, budget]);
  for (const [path, value] of files) {
    await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(`${path}.tmp`, path);
  }
};
await checkpoint();

let complete;
let reserveCost = () => Number.EPSILON;
if (!dry) {
  // Read public model metadata before reserving or dispatching inference.
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) fail("Model metadata unavailable");
  const model = (await response.json()).data.find(
    (m) => m.id === options.model,
  );
  if (!model?.supported_parameters?.includes("tools"))
    fail("Model or its tool support is not advertised");
  // The model's listed price is its cheapest provider's, and OpenRouter may
  // route a request to a dearer one: GLM 5.3 billed about 20x its listing in
  // the first paid run. Reserve at the highest price any provider lists.
  const listed = await fetch(
    `https://openrouter.ai/api/v1/models/${options.model}/endpoints`,
    { signal: AbortSignal.timeout(30000) },
  );
  if (!listed.ok) fail("Provider pricing unavailable");
  const endpoints = (await listed.json()).data?.endpoints ?? [];
  const highest = (...keys) =>
    Math.max(
      ...[model.pricing, ...endpoints.map((e) => e.pricing)].flatMap((p) =>
        keys.map((k) => Number(p?.[k] ?? 0)),
      ),
    );
  // A cache write is billed at its own input rate, above the prompt rate.
  const input = highest("prompt", "input_cache_write");
  const output = highest("completion");
  const perRequest = highest("request");
  if (
    !endpoints.length ||
    ![input, output, perRequest].every((n) => Number.isFinite(n) && n >= 0) ||
    input + output <= 0
  )
    fail("Unknown pricing; refuse inference");
  run.modelMetadata = {
    id: model.id,
    pricing: model.pricing,
    reservedAt: { input, output, perRequest },
    providers: endpoints.map((e) => ({ tag: e.tag, pricing: e.pricing })),
    observedAt: new Date().toISOString(),
  };
  // UTF-8 bytes bound ordinary tokenization; the allowance covers framing.
  reserveCost = ({ messages, tools }) =>
    (Buffer.byteLength(JSON.stringify({ messages, tools })) + 32768) * input +
    knobs.maxTokens * output +
    perRequest;
  complete = async ({ messages, tools }) => {
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        signal: AbortSignal.timeout(120000),
        headers: {
          authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: options.model,
          temperature: 0,
          max_tokens: knobs.maxTokens,
          messages,
          tools: tools.map((t) => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.inputSchema,
              // Unset, OpenAI models fill every optional field: in round 2
              // Luna and Sol sent a made-up fetch cursor on 392 of 392
              // fetches, and 375 failed. evals/README.md has the same fix.
              strict: false,
            },
          })),
          usage: { include: true },
        }),
      },
    );
    if (!response.ok)
      throw new Error(`Provider HTTP ${response.status}; reservation retained`);
    const body = await response.json();
    if (body.error) throw new Error("Provider error; reservation retained");
    run.usage ??= [];
    run.usage.push(body.usage ?? null);
    return { message: body.choices?.[0]?.message, costUsd: body.usage?.cost };
  };
}

// --serve starts the repository's isolated test server on a fresh state
// directory and removes that directory when the run ends.
const stopServer = new AbortController();
let server;
if (options.serve) {
  const port = Number(options.serve);
  options.endpoint = `http://localhost:${port}/mcp`;
  server = runUiTestServer({ port, signal: stopServer.signal });
  server.catch(() => stopServer.abort());
  for (let i = 0; ; i++) {
    if (stopServer.signal.aborted || i > 240) {
      stopServer.abort();
      await server.catch(() => {});
      fail("Test server did not start");
    }
    const up = await fetch(`http://localhost:${port}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (up) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
let failed = false;
try {
  run.endpoint = options.endpoint;
  const setup = mcpClient(options.endpoint, "j4-setup");
  const other = mcpClient(options.endpoint, "j4-unrelated-owner");
  const a = mcpClient(options.endpoint, "j4-agent-a");
  const b = mcpClient(options.endpoint, "j4-agent-b");
  const observe = await observer(options.endpoint);
  // Never a developer's store or a prior run's: refuse anything nonempty.
  await observe.assertEmpty();
  const permitted = new Set([
    "search",
    "fetch",
    "get_brief",
    "list_todos",
    "list_ready",
    "get_skill",
    "list_skills",
    "read_skill_file",
    "save_memory",
    "edit_memory",
    "create_todo",
    "comment_todo",
    "claim_todo",
    "update_todo",
    "complete_todo",
  ]);
  const tools = (await a.tools()).filter((t) => permitted.has(t.name));
  run.toolHash = hash(tools);
  const hooks = {};
  if (options.arm === "injected") {
    // An empty, isolated config keeps account-customized hooks out.
    const printed = JSON.parse(
      execFileSync(
        process.execPath,
        ["clients/valise/scripts/valise-hook.mjs", "--print"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            VALISE_CONFIG: join(tmpdir(), "j4-missing.json"),
          },
        },
      ),
    );
    hooks.start = printed.entries.find((e) => e.id === "recall-reminder").text;
    hooks.stop = printed.entries.find((e) => e.id === "capture-nudge").text;
  }
  run.hooks = hooks;

  const bytes = (result) =>
    result ? result.requestBytes.reduce((x, y) => x + y, 0) : 0;
  for (const [index, scenario] of cases.entries()) {
    const suffix = dry
      ? `-${options["a-variant"]}-${options["b-variant"]}`
      : "";
    const project = `j4-${scenario.id}-${options.arm}${suffix}`;
    const entry = {
      scenario,
      project,
      fixtureHash: hash({ scenario, catalog: knobs.catalog }),
    };
    run.cases.push(entry);
    await runCase(entry, {
      clients: { setup, other, a, b },
      observe,
      tools,
      // The skill catalog is shared by every case in the store.
      catalog: index === 0 ? knobs.catalog : 0,
      completeA: dry
        ? agentA({ scenario, project, variant: options["a-variant"] })
        : complete,
      completeB: dry
        ? agentB({ project, variant: options["b-variant"] })
        : complete,
      budget,
      reserveCost,
      hooks,
      maxCalls: knobs.maxCalls,
      checkpoint,
    });
    failed ||= !entry.result.pass;
    await checkpoint();
    console.log(
      JSON.stringify({
        case: scenario.id,
        pass: entry.result.pass,
        failures: entry.result.failures,
        ...(entry.resultOnFinalMessage && {
          passOnFinalMessage: entry.resultOnFinalMessage.pass,
        }),
        rounds: { a: entry.a?.turns ?? 0, b: entry.b?.turns ?? 0 },
        calls: { a: entry.a?.calls.length ?? 0, b: entry.b?.calls.length ?? 0 },
        // About four UTF-8 bytes per token for this JSON-heavy input.
        inputTokensEstimate: {
          a: Math.round(bytes(entry.a) / 4),
          b: Math.round(bytes(entry.b) / 4),
        },
      }),
    );
  }
  console.log(
    JSON.stringify({
      mode: run.mode,
      passed: run.cases.filter((c) => c.result.pass).length,
      cases: run.cases.length,
      chargedOrReserved: dry ? 0 : budget.spent,
      output: options.output ?? null,
    }),
  );
  if (!dry) await unlink(`${options.ledger}.lock`);
} finally {
  // --serve removes its own state; execution directories stay for inspection.
  stopServer.abort();
  await server?.catch(() => {});
}
if (failed) process.exitCode = 1;
