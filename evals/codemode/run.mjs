#!/usr/bin/env node
// Code Mode against direct calls, for one batched discovery task: every
// to-do two levels under a parent. A parent's fetch lists up to 50 children
// with their states, so one level is a single call and gives Code Mode
// nothing to batch; two levels take one fetch per child.
//
// The program runs in the client, OpenCode V2's `execute`, not in Valise:
// Valise already returns paged, schema'd relations, and a sandbox inside an
// MCP server cannot call the client's other tools.
//
//   VALISE_STATE=.wrangler/evals VALISE_RERANK=off npm run dev -- --port 5291
//   VALISE_MCP_URL=http://localhost:5291/mcp OPENROUTER_API_KEY=... \
//     node evals/codemode/run.mjs --repeat 3 --max-cost 3
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  harnessVersion,
  prepareLanes,
  runHarnessEpisode,
} from "../opencode.mjs";
import { mcpClient } from "../writeback/harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { values: options } = parseArgs({
  options: {
    model: { type: "string", default: "openrouter/anthropic/claude-haiku-5.5" },
    repeat: { type: "string", default: "3" },
    "max-cost": { type: "string", default: "3" },
    sizes: { type: "string", default: "small,larger" },
  },
});
const MCP_URL = process.env.VALISE_MCP_URL ?? "http://localhost:5173/mcp";
const SIZES = {
  small: { children: 3, grandchildren: 3 },
  larger: { children: 8, grandchildren: 6 },
};
const repeat = Number(options.repeat);
const cap = Number(options["max-cost"]);
const sizes = options.sizes.split(",");
if (!(repeat >= 1) || !(cap > 0) || sizes.some((s) => !SIZES[s]))
  throw new Error("--repeat >= 1, --max-cost > 0, --sizes from small,larger");
if (!process.env.OPENROUTER_API_KEY && options.model.startsWith("openrouter/"))
  throw new Error("OPENROUTER_API_KEY is required for an openrouter/ model");

async function devRoute(path, body) {
  const response = await fetch(new URL(path, MCP_URL), {
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.json();
}

/** A fresh hierarchy in its own project, so no other episode's rows match. */
async function seed(size) {
  const setup = mcpClient(MCP_URL, "codemode-seed");
  const project = `codemode-eval-${randomUUID().slice(0, 8)}`;
  const create = (title, parent) =>
    setup.call("create_todo", {
      title,
      project,
      ...(parent ? { parent } : {}),
    });
  const parent = await create("Ship the reading-list import");
  const grandchildren = [];
  for (let c = 0; c < size.children; c++) {
    const child = await create(`Import step ${c + 1}`, parent.id);
    for (let g = 0; g < size.grandchildren; g++) {
      const grandchild = await create(
        `Import step ${c + 1}.${g + 1}`,
        child.id,
      );
      grandchildren.push(grandchild.id);
    }
  }
  return { project, parent: parent.id, grandchildren };
}

function score(answer, expected) {
  const found = new Set(
    (answer.match(/todo:tdo_[0-9a-f-]{36}|tdo_[0-9a-f-]{36}/g) ?? []).map(
      (id) => (id.startsWith("todo:") ? id : `todo:${id}`),
    ),
  );
  const hits = expected.filter((id) => found.has(id)).length;
  const extra = [...found].filter((id) => !expected.includes(id)).length;
  return {
    recall: hits / expected.length,
    extraIds: extra,
    correct: hits === expected.length && extra === 0,
  };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};
const p95 = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.ceil(0.95 * s.length) - 1] : null;
};

const setup = prepareLanes(MCP_URL, devRoute);
const column = `opencode+mcp/${options.model}`;
const rows = [];
let spent = 0;
outer: for (const size of sizes) {
  for (const codemode of [false, true]) {
    for (let r = 0; r < repeat; r++) {
      if (spent >= cap) {
        console.error(`stopping: $${spent.toFixed(4)} spent of $${cap}`);
        break outer;
      }
      const fixture = await seed(SIZES[size]);
      const prompt = `In Valise, find every to-do two levels under ${fixture.parent}: the children of each of its children. Reply with each one's id on its own line, then one sentence saying whether the list is complete.`;
      const started = Date.now();
      const row = { size, codemode, repeat: r, parent: fixture.parent };
      try {
        const result = await runHarnessEpisode(
          setup,
          column,
          { prompt },
          (text) => text,
          { codemode },
        );
        Object.assign(row, {
          wallMs: Date.now() - started,
          ...score(result.answer, fixture.grandchildren),
          expected: fixture.grandchildren.length,
          mcpCalls: result.route.length,
          tools: result.route.map((call) => call.name),
          clientTools: result.clientTools,
          ranExecute: result.clientTools.includes("execute"),
          capped: result.capped,
          ...result.spend,
        });
        spent += result.spend.costUsd;
      } catch (error) {
        Object.assign(row, {
          wallMs: Date.now() - started,
          error: String(error).slice(0, 300),
          correct: false,
        });
      }
      rows.push(row);
      console.log(
        `${size} codemode=${codemode} #${r} correct=${row.correct} ${row.wallMs}ms $${(row.costUsd ?? 0).toFixed(4)} calls=${row.mcpCalls ?? "-"} execute=${row.ranExecute ?? "-"}${row.error ? ` error=${row.error}` : ""}`,
      );
    }
  }
}

const summary = [];
for (const size of sizes)
  for (const codemode of [false, true]) {
    const cell = rows.filter((r) => r.size === size && r.codemode === codemode);
    if (!cell.length) continue;
    const ok = cell.filter((r) => r.correct);
    const cost = cell.reduce((a, r) => a + (r.costUsd ?? 0), 0);
    summary.push({
      size,
      arm: codemode ? "codemode" : "direct",
      runs: cell.length,
      correct: ok.length,
      ranExecute: cell.filter((r) => r.ranExecute).length,
      medianMs: median(cell.map((r) => r.wallMs)),
      p95Ms: p95(cell.map((r) => r.wallMs)),
      medianTurns: median(cell.map((r) => r.turns ?? 0)),
      medianPromptTokens: median(cell.map((r) => r.promptTokens ?? 0)),
      medianMcpCalls: median(cell.map((r) => r.mcpCalls ?? 0)),
      costUsd: Number(cost.toFixed(4)),
      costPerSuccess: ok.length ? Number((cost / ok.length).toFixed(4)) : null,
      errors: cell.filter((r) => r.error).length,
    });
  }
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = join(here, "..", "runs", "codemode", `${stamp}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  `${JSON.stringify(
    {
      at: new Date().toISOString(),
      client: harnessVersion(),
      model: options.model,
      endpoint: MCP_URL,
      sizes: Object.fromEntries(sizes.map((s) => [s, SIZES[s]])),
      repeat,
      spent: Number(spent.toFixed(4)),
      summary,
      rows,
    },
    null,
    2,
  )}\n`,
);
console.table(summary);
console.log(out);
