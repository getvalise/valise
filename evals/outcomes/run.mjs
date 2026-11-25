#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  answerContract,
  cases,
  decisions,
  project,
  score,
  tasks,
  window,
} from "./fixtures.mjs";

const { values: options } = parseArgs({
  options: {
    endpoint: { type: "string", default: "http://localhost:5291/mcp" },
    model: { type: "string", default: "openai/gpt-5.4-mini" },
    label: { type: "string" },
    revision: { type: "string" },
    repeat: { type: "string", default: "1" },
    catalog: { type: "string", default: "64" },
    case: { type: "string" },
    "allow-expensive": { type: "boolean", default: false },
    "seed-only": { type: "boolean", default: false },
    "max-cost": { type: "string", default: "1" },
    arms: { type: "string", default: "hookless,reminder,hooked" },
  },
});
const arms = options.arms.split(",");
if (
  !arms.length ||
  arms.some((arm) => !["hookless", "reminder", "hooked"].includes(arm))
)
  throw new Error("--arms takes hookless, reminder and hooked");
// The hooked arm mints a bearer token in the store, which needs the pepper
// the server was started with.
if (arms.includes("hooked") && !process.env.VALISE_TOKEN_PEPPER)
  throw new Error(
    "The hooked arm needs VALISE_TOKEN_PEPPER, the server's TOKEN_PEPPER",
  );
const endpoint = new URL(options.endpoint);
if (!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))
  throw new Error("Outcome fixtures require a dedicated loopback store");
if (!options.label || !options.revision)
  throw new Error(
    "Pass --label baseline|candidate and --revision <server git head>",
  );
const repeat = Number(options.repeat);
const catalog = Number(options.catalog);
const maxCost = Number(options["max-cost"]);
if (
  !Number.isInteger(repeat) ||
  repeat < 1 ||
  !Number.isInteger(catalog) ||
  catalog < 0 ||
  catalog > 100 ||
  !(maxCost > 0)
)
  throw new Error("Invalid repeat, catalog (0–100), or max-cost");
if (/sonnet|opus/i.test(options.model) && !options["allow-expensive"])
  throw new Error("Expensive model: pass --allow-expensive explicitly");
if (!options["seed-only"] && !process.env.OPENROUTER_API_KEY)
  throw new Error("OPENROUTER_API_KEY required");
const directory = new URL("../runs/outcomes/", import.meta.url);
mkdirSync(directory, { recursive: true });
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const manifestPath = new URL(`fixture-${endpoint.port}.json`, directory);
const databases = await json(
  new URL("/cdn-cgi/local/explorer/api/d1/database", endpoint),
);
const database = databases.result.find((entry) => entry.name === "DB");
if (!database) throw new Error("No local DB");
async function sql(statement, params = []) {
  const body = await json(
    new URL(
      `/cdn-cgi/local/explorer/api/d1/database/${database.uuid}/raw`,
      endpoint,
    ),
    { sql: statement, params: params.map(String) },
  );
  if (!body.success) throw new Error(JSON.stringify(body));
  const result = body.result[0].results;
  return result.rows.map((row) =>
    Object.fromEntries(result.columns.map((key, index) => [key, row[index]])),
  );
}
async function json(url, body) {
  const response = await fetch(url, {
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok)
    throw new Error(
      `${url}: ${response.status} ${(await response.text()).slice(0, 500)}`,
    );
  return response.json();
}
async function rpc(method, params) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
      "x-valise-agent": "valise-outcome-eval",
      "x-valise-client": "script",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30000),
  });
  const raw = await response.text();
  if (!response.ok)
    throw new Error(`MCP ${response.status}: ${raw.slice(0, 500)}`);
  const result = JSON.parse(
    raw
      .split("\n")
      .find((line) => line.startsWith("data:"))
      ?.slice(5) || raw,
  );
  if (result.error) throw new Error(JSON.stringify(result.error));
  return result.result;
}
async function call(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result));
  return (
    result.structuredContent ??
    JSON.parse(result.content.find((part) => part.type === "text").text)
  );
}

// Seed through real write tools/coordinator. SQL only pins timestamps; no state
// transitions or searchable text bypass the production write/projection batch.
const counts = await sql(
  "SELECT (SELECT COUNT(*) FROM todos) + (SELECT COUNT(*) FROM memories) + (SELECT COUNT(*) FROM skills) AS n",
);
let fixture;
if (counts[0].n) {
  fixture = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (fixture.catalog !== catalog)
    throw new Error("Catalog changed: start a fresh isolated store");
  for (const id of Object.values(fixture.ids)) await call("fetch", { id });
} else {
  const ids = {};
  for (const task of tasks) {
    const created = await call("create_todo", {
      title: task.title,
      project,
      body: task.body ?? task.title,
      refs: [{ kind: "file", value: "fixtures/checksum.spec.ts" }],
    });
    ids[task.key] = created.id;
    if (task.progress)
      await call("comment_todo", { id: created.id, body: task.progress });
    if (task.state !== "pending") {
      const claim = await call("claim_todo", {
        id: created.id,
        ttl_seconds: 86400,
      });
      if (task.state === "done")
        await call("complete_todo", {
          ...claimArgs(claim),
          summary: "Merged; verification evidence retained in checksum report.",
        });
      if (task.state === "blocked")
        await call("update_todo", {
          ...claimArgs(claim),
          blocked_on: task.blocker,
        });
    }
  }
  for (const decision of decisions)
    ids[decision.key] = (
      await call("save_memory", {
        type: "decision",
        title: decision.title,
        body: decision.body,
        project,
        tags: ["checksum"],
      })
    ).id;
  const domains = [
    "postgres",
    "python",
    "react",
    "terraform",
    "kubernetes",
    "duckdb",
    "swift",
    "rust",
  ];
  const jobs = [
    "profiling",
    "migration",
    "testing",
    "release",
    "logging",
    "packaging",
    "accessibility",
    "monitoring",
    "backup",
    "configuration",
    "linting",
    "debugging",
    "documentation",
  ];
  for (let i = 0; i < catalog; i++) {
    const name = `${domains[i % domains.length]}-${jobs[Math.floor(i / domains.length)]}`;
    await call("publish_skill", {
      body: `---\nname: ${name}\ndescription: Guide ${name.replaceAll("-", " ")} with reproducible commands and checks. Use when modifying that technology's workflow.\n---\n# ${name}\nInspect the existing configuration, run the relevant check, and record the result. This procedure does not supply project status or historical decisions.`,
      project: "skill-catalog",
    });
  }
  // Wait for the coordinator's asynchronous mirrors before pinning dates.
  for (let attempt = 0; attempt < 30; attempt++) {
    const rows = await sql("SELECT todo_id, state FROM todos");
    if (
      tasks.every((task) =>
        rows.some(
          (row) =>
            `todo:${row.todo_id}` === ids[task.key] && row.state === task.state,
        ),
      )
    )
      break;
    if (attempt === 29)
      throw new Error("Fixture coordinator mirrors did not settle");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const task of tasks.filter((task) => task.completed !== undefined))
    await sql(
      "UPDATE todos SET completed_at = ?, updated_at = ? WHERE todo_id = ?",
      [task.completed, window.since + 3600, ids[task.key].slice(5)],
    );
  fixture = { ids, catalog, tasks, decisions, window };
  writeFileSync(manifestPath, `${JSON.stringify(fixture, null, 2)}\n`);
}
function claimArgs(claim) {
  return { id: claim.id, token: claim.token };
}
if (options["seed-only"]) {
  console.log(manifestPath.pathname);
  process.exit(0);
}

const listed = await rpc("tools/list", {});
const tools = listed.tools.map((tool) => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    // Unset, OpenAI models fill optional fields with invented values.
    strict: false,
  },
}));
const hookDir = mkdtempSync(join(tmpdir(), "valise-outcome-hook-"));
let hook;
try {
  const printed = JSON.parse(
    execFileSync(
      process.execPath,
      [
        new URL("../../clients/valise/scripts/valise-hook.mjs", import.meta.url)
          .pathname,
        "--print",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, VALISE_CONFIG: join(hookDir, "missing.json") },
      },
    ),
  );
  hook = printed.entries.find((entry) => entry.id === "recall-reminder").text;
} finally {
  rmSync(hookDir, { recursive: true });
}
const hooked = arms.includes("hooked") ? await sessionStart() : null;

/**
 * What the shipped hook prints at SessionStart for this store: a token holding
 * config:read, the hook's own --refresh against the server (hook config and
 * /config/brief into its cache), then the hook run on a SessionStart payload.
 * The text is injected into the system prompt: the hook's real output, not a
 * client's lifecycle delivery of it.
 */
async function sessionStart() {
  const token = `vls_${randomBytes(32).toString("base64url")}`;
  const tokenId = `btk_outcome_${randomBytes(8).toString("hex")}`;
  const digest = createHmac("sha256", process.env.VALISE_TOKEN_PEPPER)
    .update(token)
    .digest("hex");
  await sql(
    "INSERT INTO bearer_tokens (token_id, user_id, label, token_digest, created_at, revoked_at) VALUES (?, 'local', 'outcome-eval hook', ?, ?, NULL)",
    [tokenId, digest, Math.floor(Date.now() / 1000)],
  );
  await sql(
    "INSERT INTO bearer_token_grants (token_id, scope) VALUES (?, 'config:read')",
    [tokenId],
  );
  const dir = mkdtempSync(join(tmpdir(), "valise-outcome-hooked-"));
  const script = new URL(
    "../../clients/valise/scripts/valise-hook.mjs",
    import.meta.url,
  ).pathname;
  const env = {
    ...process.env,
    VALISE_TOKEN: token,
    VALISE_MCP_URL: endpoint.href,
    VALISE_CONFIG: join(dir, "config.json"),
    // Keep the hook from starting a detached refresh of its own.
    VALISE_CONFIG_TTL: "86400",
  };
  try {
    execFileSync(process.execPath, [script, "--refresh"], { env });
    writeFileSync(`${env.VALISE_CONFIG}.checked`, new Date().toISOString());
    const brief = readFileSync(join(dir, "brief.md"), "utf8").trim();
    if (!brief) throw new Error("The hook cached an empty brief");
    const output = execFileSync(process.execPath, [script], {
      env,
      encoding: "utf8",
      input: JSON.stringify({
        hook_event_name: "SessionStart",
        source: "startup",
        session_id: "outcome-eval",
      }),
    });
    return JSON.parse(output).hookSpecificOutput.additionalContext;
  } finally {
    rmSync(dir, { recursive: true });
  }
}
const selected = cases(fixture.ids).filter(
  (testCase) => !options.case || options.case.split(",").includes(testCase.id),
);
if (!selected.length) throw new Error("No cases selected");
const run = {
  scoringVersion: 2,
  sourceHash: digest([
    readFileSync(new URL("run.mjs", import.meta.url), "utf8"),
    readFileSync(new URL("fixtures.mjs", import.meta.url), "utf8"),
  ]),
  at: new Date().toISOString(),
  label: options.label,
  serverRevision: options.revision,
  runnerRevision: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  endpoint: endpoint.href,
  model: options.model,
  fixture,
  fixtureHash: digest({ tasks, decisions, window, catalog }),
  toolsHash: digest(tools),
  tools,
  hook,
  hooked,
  hookedHash: hooked === null ? null : digest(hooked),
  arms,
  repeat,
  cases: selected,
  rows: [],
  limitations: [
    "OpenRouter fresh-agent read-only handoff assessment, not autonomous code execution",
    "Reminder arm injects the shipped SessionStart reminder text only",
    "Hooked arm injects the shipped hook's own SessionStart output, reminder plus the /config/brief it cached, generated once per run; it is not a client's lifecycle delivery",
    "No previous agent transcript is given; setup writes durable progress through MCP",
    "Write attempts are recorded and refused; reads run against the real Worker",
    "Explicit supersession in memory text; relation-graph candidate is not included",
  ],
};
const file = new URL(
  `${run.at.replaceAll(":", "-")}-${options.label}.json`,
  directory,
);
const save = () => writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`);
const readOnly = new Set([
  "search",
  "fetch",
  "get_brief",
  "list_todos",
  "list_memories",
  "list_sources",
  "list_ready",
  "list_skills",
  "get_skill",
  "read_skill_file",
  "list_hooks",
]);
const system = { hookless: "", reminder: `\n${hook}`, hooked: `\n${hooked}` };
for (const client of arms)
  for (const testCase of selected)
    for (let index = 0; index < repeat; index++) {
      if (run.rows.reduce((sum, row) => sum + row.costUsd, 0) >= maxCost) {
        run.stopped = "cost budget reached (one episode may overshoot)";
        save();
        process.exit(2);
      }
      const episode = {
        route: [],
        answer: "",
        error: null,
        capped: false,
        turns: 0,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        usageMissing: false,
        firstPromptTokens: null,
      };
      const messages = [
        {
          role: "system",
          content: `You are a helpful assistant. ${answerContract}${system[client]}`,
        },
        { role: "user", content: testCase.prompt },
      ];
      try {
        for (let round = 0; round < 8; round++) {
          const response = await fetch(
            "https://openrouter.ai/api/v1/chat/completions",
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "content-type": "application/json",
                "x-title": "Valise resumption outcome eval",
              },
              body: JSON.stringify({
                model: options.model,
                temperature: 0,
                max_tokens: 2048,
                tools,
                tool_choice: "auto",
                usage: { include: true },
                messages,
              }),
              signal: AbortSignal.timeout(120000),
            },
          );
          const body = await response.json();
          if (!response.ok || body.error)
            throw new Error(JSON.stringify(body).slice(0, 1000));
          episode.turns++;
          episode.promptTokens += body.usage?.prompt_tokens ?? 0;
          episode.completionTokens += body.usage?.completion_tokens ?? 0;
          episode.costUsd += body.usage?.cost ?? 0;
          episode.usageMissing ||= body.usage?.cost === undefined;
          episode.firstPromptTokens ??= body.usage?.prompt_tokens ?? null;
          const message = body.choices?.[0]?.message;
          if (!message) throw new Error("Provider omitted message");
          messages.push(message);
          if (!message.tool_calls?.length) {
            episode.answer = message.content ?? "";
            break;
          }
          // Answer every parallel call before sending another model turn.
          for (const requested of message.tool_calls) {
            const name = requested.function.name;
            const args = JSON.parse(requested.function.arguments);
            const step = {
              name,
              args,
              writeAttempt: !readOnly.has(name) && !name.startsWith("skill_"),
            };
            episode.route.push(step);
            try {
              step.result = step.writeAttempt
                ? { error: "Read-only assessment: write refused" }
                : await call(name, args);
            } catch (error) {
              step.error = String(error);
              step.result = { error: String(error) };
            }
            messages.push({
              role: "tool",
              tool_call_id: requested.id,
              content: JSON.stringify(step.result),
            });
          }
          if (round === 7) episode.capped = true;
        }
      } catch (error) {
        episode.error = String(error);
      }
      const row = {
        case: testCase.id,
        client,
        repeat: index,
        ...episode,
        ...score(testCase, episode),
        messages,
      };
      run.rows.push(row);
      save();
      console.log(
        `${row.pass ? "PASS" : "FAIL"} ${client} ${testCase.id} calls=${row.calls} $${row.costUsd.toFixed(4)} ${row.error ?? row.wrong.join(",")}`,
      );
    }
console.log(
  `${run.rows.filter((row) => row.pass).length}/${run.rows.length}; $${run.rows.reduce((sum, row) => sum + row.costUsd, 0).toFixed(4)}; ${file.pathname}`,
);
