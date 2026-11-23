import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";
import ts from "typescript";

// Deliberately outside verify: real inference, synthetic empty local store only.
// No remote resource provisioning, existing server reuse, bakeoff or automatic retry.
const execute = promisify(execFile);
const [permission, portText, evidencePath] = process.argv.slice(2);
if (
  permission !== "--allow-four-paid-synthetic-calls" ||
  !/^\d+$/.test(portText ?? "") ||
  Number(portText) < 1024 ||
  Number(portText) > 65535 ||
  !evidencePath
)
  throw new Error(
    "Requires --allow-four-paid-synthetic-calls <unused-port> <new-evidence-directory> and a coordinated runtime grant.",
  );
if (!process.env.OPENROUTER_API_KEY?.trim())
  throw new Error(
    "OPENROUTER_API_KEY is unavailable in this shell. Supply the existing operator key privately in the process environment; this runner loads it only into its temporary local .dev.vars/config, never production.",
  );

const origin = `http://localhost:${portText}`;
const evidence = resolve(evidencePath);
await mkdir(evidence, { mode: 0o700 }); // Refuse an existing evidence directory.
await mkdir(".wrangler", { recursive: true });
const root = await mkdtemp(resolve(".wrangler/valise-j2-"));
const state = join(root, "state");
const configPath = join(root, "wrangler.json");
const password = `synthetic-j2-${randomUUID()}`;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const report = {
  origin,
  startedAt: new Date().toISOString(),
  sourceCommit: (await execute("git", ["rev-parse", "HEAD"])).stdout.trim(),
  runnerSha256: digest(await readFile(new URL(import.meta.url))),
  proofBoundary:
    "Actual local Worker adapter and browser/native forms, fresh loopback HTTP MCP client; not deployed OAuth/client acceptance. Record release Build/version/traffic separately.",
  model: "anthropic/claude-haiku-5.5",
  promptVersion: "memory-review-2",
  maxProviderRequests: 4,
  costTargetUsd: 0.25,
  billedUsage: null,
  billedUsageNote:
    "Adapter returns proposals, not provider usage/invoice metadata. D1 reservations are conservative bounds, not billed usage; no invented token/cost figures.",
  passes: [],
  fixtureIds: [],
  outcome: "incomplete",
};
let server;
let closed;
let serverError;
let browser;
let client;
let sql;
let stopping = false;
const killServer = (signal) => {
  if (!server?.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-server.pid, signal);
    else server.kill(signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};
const stop = () => {
  stopping = true;
  killServer("SIGTERM");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const writeEvidence = async (name, value) => {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(join(evidence, name), text, { mode: 0o600 });
  return digest(text);
};
try {
  const { config, error } = ts.parseConfigFileTextToJson(
    "wrangler.jsonc",
    await readFile("wrangler.jsonc", "utf8"),
  );
  assert.equal(error, undefined);
  // Keep actual local bindings but remove remote-only services and all production IDs.
  config.name = "valise-j2-local-only";
  config.main = resolve(config.main);
  config.d1_databases = [
    {
      binding: "DB",
      database_name: "valise-j2-local-only",
      database_id: randomUUID(),
      migrations_dir: resolve("drizzle"),
    },
  ];
  config.r2_buckets = [
    { binding: "BUNDLES", bucket_name: "valise-j2-local-only" },
  ];
  config.kv_namespaces = [
    { binding: "OAUTH_KV", id: randomUUID().replaceAll("-", "") },
  ];
  delete config.ai;
  delete config.vectorize;
  delete config.previews;
  delete config.triggers;
  config.vars = {
    APP_ORIGIN: origin,
    MCP_RESOURCE_URL: `${origin}/mcp`,
    VALISE_RERANK: "off",
    VALISE_VECTOR_NAMESPACE: "synthetic-j2-local-only",
  };
  const secrets = {
    VALISE_ADMIN_PASSWORD: password,
    SESSION_SECRET: randomUUID(),
    TOKEN_PEPPER: randomUUID(),
    GOOGLE_CLIENT_ID: "none",
    GOOGLE_CLIENT_SECRET: "",
    VALISE_ADMIN_EMAILS: "",
    TYPESAFE_API_KEY: "",
    EMAIL_API_KEY: "",
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  };
  config.secrets = { required: Object.keys(secrets) };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await writeFile(
    join(root, ".dev.vars"),
    Object.entries(secrets)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n"),
    { mode: 0o600 },
  );
  const childEnv = {
    ...process.env,
    VALISE_CONFIG: configPath,
    VALISE_STATE: state,
    VALISE_UI_TEST: "1",
    VALISE_RERANK: "off",
    WRANGLER_SEND_METRICS: "false",
  };
  // Keep Wrangler's required-secret fallback enabled. Secrets still come from
  // this runner's private config-local .dev.vars, never another checkout.
  delete childEnv.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV;
  const wrangler = async (args) =>
    (
      await execute(
        process.execPath,
        [
          resolve("node_modules/wrangler/bin/wrangler.js"),
          ...args,
          "--config",
          configPath,
        ],
        { env: childEnv, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      )
    ).stdout;
  await wrangler([
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--persist-to",
    state,
  ]);
  if (stopping)
    throw new Error("Journey interrupted before local server startup");
  server = spawn(
    process.execPath,
    [
      "--conditions=development",
      resolve("node_modules/@react-router/dev/bin.cjs"),
      "dev",
      "--host",
      "localhost",
      "--port",
      portText,
      "--strictPort",
    ],
    {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  let log = "";
  const append = (chunk) => {
    // Wrangler hides secrets; redact defensively before retaining local startup diagnostics.
    log = (
      log + String(chunk).replaceAll(secrets.OPENROUTER_API_KEY, "[REDACTED]")
    ).slice(-200_000);
  };
  server.stdout.on("data", append);
  server.stderr.on("data", append);
  closed = new Promise((done) => {
    server.once("error", (error) => {
      serverError = error;
      done();
    });
    server.once("close", done);
  });
  let ready = false;
  for (let n = 0; n < 120 && !stopping; n++) {
    if (server.exitCode !== null || serverError) break;
    try {
      ready = (
        await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })
      ).ok;
    } catch {}
    if (ready) break;
    await new Promise((done) => setTimeout(done, 500));
  }
  await writeFile(join(evidence, "server.log"), log, { mode: 0o600 });
  assert.ok(
    ready,
    `Fresh isolated local Worker must become ready: ${serverError ?? "see server.log"}`,
  );
  sql = async (statement) => {
    assert.match(statement, /^SELECT\b/i, "Evidence SQL is read-only");
    const replies = JSON.parse(
      await wrangler([
        "d1",
        "execute",
        "DB",
        "--local",
        "--persist-to",
        state,
        "--json",
        "--command",
        statement,
      ]),
    );
    assert.ok(replies.every((reply) => reply.success !== false));
    return replies[0].results;
  };
  assert.equal((await sql("SELECT COUNT(*) AS n FROM memories"))[0].n, 0);
  const call = async (name, args, agent = "synthetic-j2-source-client") => {
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
        "x-valise-agent": agent,
        "x-valise-client": "j2-acceptance",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "tools/call",
        params: { name, arguments: args },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    assert.ok(response.ok, `MCP ${name} returned HTTP ${response.status}`);
    const text = await response.text();
    const body = JSON.parse(
      text
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5) || text,
    );
    assert.equal(body.error, undefined);
    assert.notEqual(body.result.isError, true, JSON.stringify(body.result));
    return (
      body.result.structuredContent ??
      JSON.parse(
        body.result.content.find((entry) => entry.type === "text").text,
      )
    );
  };
  browser = await chromium.launch();
  client = await browser.newContext({
    baseURL: origin,
    viewport: { width: 1280, height: 900 },
  });
  const page = await client.newPage();
  await page.goto(`${origin}/login?next=/memories%3Ftab%3Dreview`);
  await page.getByLabel("Administrator password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/memories\?tab=review/);
  await expect(
    page.getByRole("heading", { name: "Memories", exact: true }),
  ).toBeVisible();
  await page
    .getByText("Settings: model, limits and ranking", { exact: true })
    .click();
  await expect(page.getByLabel("Provider and model")).toHaveValue(report.model);
  const allow = page.getByRole("switch", { name: "Allow model reviews" });
  const overnight = page.getByRole("switch", {
    name: "Tidy my memories every night",
  });
  // Off, the page is the setup panel: nightly upkeep off and no check to press.
  await expect(allow).toHaveAttribute("aria-checked", "false");
  await expect(overnight).toHaveAttribute("aria-checked", "false");
  await expect(
    page.getByRole("button", { name: "Check waiting memories" }),
  ).toHaveCount(0);

  const fixtures = [
    [
      "compatible",
      "According to fictional grower Ada on 2026-10-24, only ripe apples stay cool, never frozen.",
      "According to fictional grower Ada on 2026-10-24, pears stay dry during transport; this is her claim, not the user's judgment.",
    ],
    [
      "conflicting",
      "Fictional grower Bo claims all blue crates must be chilled on 2026-10-24.",
      "Fictional grower Cy claims all blue crates must never be chilled on 2026-10-24. Neither grower's claim has been verified.",
    ],
    [
      "insufficient",
      "Fictional fragment: it is only valid under the unnamed exception; the omitted source defines it.",
      "Fictional fragment: the unnamed exception might refer to another object. The full context is missing; do not infer its meaning.",
    ],
  ];
  const originals = [];
  for (const [kind, ...bodies] of fixtures) {
    for (const body of bodies) {
      const saved = await call("save_memory", {
        type: "fact",
        title: `Synthetic j2${kind} orchard evidence`,
        body,
        project: `synthetic-j2-${kind}`,
        tags: ["j2-synthetic"],
      });
      report.fixtureIds.push(saved.id);
      if (kind === "compatible" && body === bodies[0])
        await call("edit_memory", {
          id: saved.id,
          title:
            "Synthetic j2compatible orchard evidence, attributed qualification retained",
        });
      originals.push(await call("fetch", { id: saved.id }));
    }
  }
  report.originalsSha256 = await writeEvidence(
    "originals-before.json",
    originals,
  );
  const sourceRows = await sql("SELECT * FROM memories ORDER BY memory_id");
  const sourceHistory = await sql(
    "SELECT * FROM memory_revisions ORDER BY memory_id,revision",
  );
  // Four checks by hand bound the paid calls; at Haiku's largest reservation
  // that is under $0.013. The money cap is an admin's and stays at its default.
  const advanced = page.locator("details", {
    has: page.getByText("Advanced: model, limits and ranking", { exact: true }),
  });
  if (!(await advanced.evaluate((details) => details.open)))
    await page
      .getByText("Advanced: model, limits and ranking", { exact: true })
      .click();
  const checks = page.getByLabel(/Memories checked by hand a day/);
  await checks.fill("4");
  await page.getByRole("button", { name: "Save limits", exact: true }).click();
  await expect(checks).toHaveValue("4");
  await page.screenshot({
    path: join(evidence, "consent-off.png"),
    fullPage: true,
  });
  await allow.click();
  await expect(allow).toHaveAttribute("aria-checked", "true");
  await expect(overnight).toHaveAttribute("aria-checked", "false");
  await expect(
    page.getByRole("button", { name: "Check waiting memories" }),
  ).toBeEnabled();
  const [boundedSettings] = await sql(
    "SELECT model,enabled,overnight,manual_memories FROM memory_review_settings",
  );
  assert.deepEqual(
    boundedSettings,
    {
      model: report.model,
      enabled: 1,
      overnight: 0,
      manual_memories: 4,
    },
    "Persisted consent and caps must match before any paid request",
  );
  let totalCalls = 0;
  for (let n = 0; n < 2; n++) {
    const before = performance.now();
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        /^\/memories(?:\.data)?$/.test(new URL(r.url()).pathname),
      { timeout: 90_000 },
    );
    await page.getByRole("button", { name: "Check waiting memories" }).click();
    await (await response).finished();
    await expect(
      page.getByRole("button", { name: "Check waiting memories" }),
    ).toBeEnabled();
    await expect(page.getByRole("status")).toContainText("model calls");
    const status = (await page.getByRole("status").textContent())
      .replace(/\s+/g, " ")
      .trim();
    const pass = {
      elapsedMs: Math.round(performance.now() - before),
      status,
    };
    report.passes.push(pass);
    const [budget] = await sql(
      "SELECT COALESCE(SUM(calls),0) AS calls, COALESCE(SUM(reserved_microusd),0) AS reserved_microusd FROM memory_review_budgets",
    );
    pass.budget = budget;
    report.groups = await sql(
      "SELECT * FROM memory_review_groups ORDER BY created_at,group_id",
    );
    // Retain the original failed report before any assertion; finally switches off
    // and cleans this store. Failure never authorizes another scheduled paid pass.
    await writeEvidence("report.json", report);
    const parsed = status.match(
      /Reviewed (\d+) queued memories; (\d+) model calls, (\d+) proposals, (\d+) skipped, (\d+) failed\.(?: Stopped: (.+)\.)?$/,
    );
    assert.ok(
      parsed,
      "Unrecognized pass receipt; stop instead of guessing or paying again",
    );
    const [, scanned, calls, proposed, skipped, failed, stopped] = parsed;
    Object.assign(pass, {
      scanned: Number(scanned),
      calls: Number(calls),
      proposed: Number(proposed),
      skipped: Number(skipped),
      failed: Number(failed),
      stopped: stopped ?? null,
    });
    assert.equal(
      pass.failed,
      0,
      "Provider/validation failure: stop before any subsequent paid pass",
    );
    assert.ok(
      pass.stopped === null ||
        (pass.stopped === "pass limit" && pass.calls === 2),
      "Unexpected admission, consent, provider or budget stop: no further paid pass",
    );
    assert.ok(pass.calls >= 0 && pass.calls <= 2);
    totalCalls += pass.calls;
    assert.equal(
      budget.calls,
      totalCalls,
      "Reservation/call mismatch: no further paid pass",
    );
    assert.ok(
      Number.isInteger(budget.calls) &&
        budget.calls <= 4 &&
        Number.isInteger(budget.reserved_microusd) &&
        budget.reserved_microusd >= 0 &&
        budget.reserved_microusd <= 20_000,
      "Unexpected accounting: no further paid pass",
    );
    assert.ok(
      report.groups.every(
        (group) => !["failed", "running"].includes(group.state),
      ),
      "Unfinished/failed attempt: no further paid pass",
    );
  }
  report.groups = await sql(
    "SELECT * FROM memory_review_groups ORDER BY created_at, group_id",
  );
  report.budget = await sql("SELECT * FROM memory_review_budgets");
  const groupFor = (project) =>
    report.groups.find((group) =>
      JSON.parse(group.sources_json).every(
        (snapshot) => snapshot.source.project === `synthetic-j2-${project}`,
      ),
    );
  assert.equal(
    JSON.parse(groupFor("conflicting")?.proposal_json ?? "null")?.kind,
    "contradiction",
    "Actual conflict must not choose a winner",
  );
  assert.equal(
    JSON.parse(groupFor("insufficient")?.proposal_json ?? "null")?.kind,
    "noop",
    "Missing context must not become a fabricated summary",
  );
  const summary = report.groups.find(
    (group) =>
      group.state === "proposal" &&
      ["summary", "consolidation"].includes(
        JSON.parse(group.proposal_json).kind,
      ) &&
      JSON.parse(group.sources_json).every(
        (snapshot) => snapshot.source.project === "synthetic-j2-compatible",
      ),
  );
  assert.ok(
    summary,
    "Actual adapter must produce a usable compatible proposal; never substitute a seeded draft",
  );
  await page.goto(`${origin}/memories?tab=review&open=${summary.group_id}`);
  const card = page.locator("li.todo-card").filter({
    has: page.getByRole("link", { name: summary.draft_title, exact: true }),
  });
  await expect(
    card.getByRole("region", { name: "Source evidence" }),
  ).toBeVisible();
  const proposal = JSON.parse(summary.proposal_json);
  for (const { quote } of proposal.evidence)
    await expect(
      card.locator("blockquote").filter({ hasText: quote }),
    ).toBeVisible();
  await expect(card).toContainText("Revision 1");
  await expect(card).toContainText("Revision 2");
  await expect(card).toContainText("synthetic-j2-source-client");
  await page.screenshot({
    path: join(evidence, "actual-proposal.png"),
    fullPage: true,
  });
  await card.getByRole("link", { name: "Edit draft body" }).click();
  const humanDraft =
    "Human-reviewed fictional Orchard summary: according to grower Ada on 2026-10-24, only ripe apples stay cool, never frozen; pears stay dry during transport. These remain Ada's claims, not the user's judgment.";
  await card.getByRole("textbox", { name: "Draft body" }).fill(humanDraft);
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByRole("textbox", { name: "Draft body" })).toHaveCount(
    0,
  );
  await expect(card).toContainText(humanDraft);
  await card.getByRole("button", { name: "Accept new memory" }).click();
  await expect(card.locator(".pill")).toHaveText("accepted");
  const acceptedLink = await card
    .getByRole("link", { name: "Open accepted memory" })
    .getAttribute("href");
  report.acceptedId = new URL(acceptedLink, origin).searchParams.get("open");
  // New connection/client identity and no browser cookie jar: reads authoritative MCP state.
  const fresh = await call(
    "fetch",
    { id: report.acceptedId },
    "synthetic-j2-fresh-client",
  );
  assert.ok(JSON.stringify(fresh).includes(humanDraft));
  assert.ok(JSON.stringify(fresh).includes("Human-approved"));
  report.acceptedSha256 = await writeEvidence("accepted-fresh-mcp.json", fresh);
  const native = await browser.newContext({
    baseURL: origin,
    javaScriptEnabled: false,
    viewport: { width: 320, height: 740 },
  });
  const nativePage = await native.newPage();
  await nativePage.goto(`${origin}/login?next=/memories%3Ftab%3Dreview`);
  await nativePage.getByLabel("Administrator password").fill(password);
  await nativePage
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await expect(nativePage).toHaveURL(/\/memories\?tab=review/);
  const conflict = groupFor("conflicting");
  await nativePage.goto(
    `${origin}/memories?tab=review&open=${conflict.group_id}`,
  );
  const conflictCard = nativePage.locator("li.todo-card").filter({
    has: nativePage.getByRole("link", {
      name: conflict.draft_title,
      exact: true,
    }),
  });
  await expect(
    conflictCard.getByRole("region", { name: "Source evidence" }),
  ).toBeVisible();
  await conflictCard.getByRole("button", { name: "Dismiss proposal" }).click();
  await expect(conflictCard.locator(".pill")).toHaveText("dismissed");
  await conflictCard.getByRole("button", { name: "Reopen proposal" }).click();
  await expect(conflictCard.locator(".pill")).toHaveText("proposal");
  await expect(conflictCard.locator("blockquote")).toHaveCount(2);
  await conflictCard
    .getByRole("button", { name: "Confirm contradiction link", exact: true })
    .click();
  await expect(conflictCard.locator(".pill")).toHaveText("accepted");
  assert.ok(
    await nativePage.evaluate(
      "document.documentElement.scrollWidth <= window.innerWidth",
    ),
  );
  await nativePage.screenshot({
    path: join(evidence, "native-contradiction-320.png"),
    fullPage: true,
  });
  await native.close();
  const after = [];
  for (const id of report.fixtureIds)
    after.push(await call("fetch", { id }, "synthetic-j2-fresh-client"));
  // Fetch counts/activity can change, but original authoritative wording/revisions must not.
  const rows = (await sql("SELECT * FROM memories ORDER BY memory_id")).filter(
    (row) => report.fixtureIds.includes(`memory:${row.memory_id}`),
  );
  report.originalRows = rows;
  assert.deepEqual(
    rows,
    sourceRows,
    "All original authoritative columns must remain unchanged",
  );
  for (const original of originals) {
    const fetched = after.find((entry) => entry.id === original.id);
    assert.equal(fetched.text, original.text);
  }
  await writeEvidence("originals-after.json", after);
  report.events = await sql(
    "SELECT * FROM memory_review_events ORDER BY created_at,event_id",
  );
  report.revisions = await sql(
    "SELECT * FROM memory_revisions ORDER BY memory_id,revision",
  );
  assert.deepEqual(
    report.revisions,
    sourceHistory,
    "Original revision history remains unchanged",
  );
  await allow.click();
  // Off, the page is the setup panel: no nightly switch and no check to press.
  await expect(allow).toHaveAttribute("aria-checked", "false");
  await expect(overnight).toHaveAttribute("aria-checked", "false");
  await expect(
    page.getByRole("button", { name: "Check waiting memories" }),
  ).toHaveCount(0);
  await page.screenshot({
    path: join(evidence, "accepted-off.png"),
    fullPage: true,
  });
  report.finalSettings = await sql(
    "SELECT model,enabled,overnight,manual_memories FROM memory_review_settings",
  );
  assert.ok(
    report.finalSettings.every(
      (settings) => settings.enabled === 0 && settings.overnight === 0,
    ),
  );
  report.outcome = "local-actual-adapter-path-passed";
} catch (error) {
  report.error = String(error).replaceAll(
    process.env.OPENROUTER_API_KEY,
    "[REDACTED]",
  );
  process.exitCode = 1;
} finally {
  // Best-effort unconditional OFF on failure too, then retire only this runner's private store.
  if (client) {
    for (const field of ["enabled", "overnight"])
      await client.request
        .post(`${origin}/memories?tab=review`, {
          form: { intent: "setting", field, value: "off" },
          headers: { origin },
        })
        .catch(() => {});
  }
  if (sql) {
    report.groups = await sql(
      "SELECT * FROM memory_review_groups ORDER BY created_at,group_id",
    ).catch(() => report.groups ?? null);
    report.finalBudget = await sql("SELECT * FROM memory_review_budgets").catch(
      () => null,
    );
    report.finalSettings = await sql(
      "SELECT model,enabled,overnight FROM memory_review_settings",
    ).catch(() => null);
  }
  await browser?.close();
  if (server) {
    killServer("SIGTERM");
    const kill = setTimeout(() => killServer("SIGKILL"), 10_000);
    await closed;
    clearTimeout(kill);
    killServer("SIGKILL");
  }
  await rm(root, { recursive: true, force: true });
  report.cleanup =
    "Private local config/secrets/D1/R2/KV/coordinator state removed after server exit; no remote resources created or changed.";
  report.endedAt = new Date().toISOString();
  await writeEvidence("report.json", report);
  console.log(
    JSON.stringify({
      evidence,
      outcome: report.outcome,
      budget: report.finalBudget,
      error: report.error,
    }),
  );
}
