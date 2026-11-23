import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error: plain .mjs scripts have no declarations.
import { buildTurn, skipReason } from "../../evals/harness.mjs";
// @ts-expect-error: plain .mjs scripts have no declarations.
import * as opencode from "../../evals/opencode.mjs";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function runtime() {
  const result = opencode.isolatedRuntime(
    "http://localhost:4476/mcp",
    "ses_example",
    { appendSystemPrompt: "case context" },
    {
      PATH: process.env.PATH,
      OPENROUTER_API_KEY: "secret",
      HOME: "/personal",
      XDG_CONFIG_HOME: "/personal/config",
      OPENCODE_DB: "/personal/auth.db",
      OPENCODE_CONFIG_CONTENT: '{"plugins":["personal-hooks"]}',
      OPENCODE_SESSION_ID: "ses_parent",
      OPENCODE_SERVER: "http://personal-server",
      NODE_OPTIONS: "--require personal-plugin",
      VALISE_CONFIG: "/personal/hook-config",
    },
  );
  dirs.push(result.dir);
  return result;
}

function configEntries(r: ReturnType<typeof runtime>) {
  return [
    {
      type: "document",
      path: join(r.configDir, "opencode.json"),
      info: r.config,
    },
    { type: "directory", path: r.configDir },
  ];
}

const tokens = {
  input: 10,
  output: 3,
  reasoning: 1,
  cache: { read: 7, write: 2 },
};
const session = {
  id: "ses_example",
  outcome: "succeeded",
  tokens,
  cost: 0.001,
  model: { providerID: "openrouter", id: "openai/gpt-5.4-mini" },
};
const messages = [
  {
    type: "assistant",
    time: { created: 1, completed: 2 },
    tokens,
    finish: "stop",
    content: [{ type: "text", text: "answer" }],
  },
];

/** Real foreground subprocess and HTTP protocol, with no provider spending. */
function executable(mode = "ok") {
  for (const key of [
    "OPENROUTER_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
  ])
    vi.stubEnv(key, "test-key");
  mkdirSync(join(tmpdir(), "opencode"), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "opencode/valise-eval-double-"));
  dirs.push(dir);
  const log = join(dir, "invocations.jsonl");
  writeFileSync(
    join(dir, "opencode"),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), cwd = process.cwd();
const configDir = process.env.XDG_CONFIG_HOME + '/opencode';
const config = JSON.parse(fs.readFileSync(configDir + '/opencode.json'));
const id = config.mcp.servers.valise.headers['x-valise-session'];
const mode = ${JSON.stringify(mode)}, log = ${JSON.stringify(log)};
const record = value => fs.appendFileSync(log, JSON.stringify(value)+'\\n');
record({kind:'spawn',args,cwd,env:process.env,id});
fs.readFileSync(0, 'utf8'); // Headless processes must receive stdin EOF.
let connected = false;
const server = require('node:http').createServer(async(req,res)=>{
  let raw = ''; for await(const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : undefined;
  const path = new URL(req.url, 'http://localhost').pathname;
  record({kind:'api',path,body,id,cwd,method:req.method,auth:req.headers.authorization});
  if(req.headers.authorization !== 'Basic '+Buffer.from('opencode:private-fixture-password').toString('base64')) {res.writeHead(401);res.end('SECRET');return;}
  const json = value => {res.setHeader('content-type','application/json');res.end(JSON.stringify(value))};
  const empty = () => {res.writeHead(204);res.end()};
  if(path === '/hang') return;
  if(path === '/api/config') {
    if(mode === 'malformed') {res.end('SECRET not JSON');return;}
    const entries = [{type:'document',path:configDir+'/opencode.json',info:config},{type:'directory',path:configDir}];
    if(mode === 'contaminated') entries.push({type:'directory',path:'/personal/plugins'});
    return json(entries);
  }
  if(path.endsWith('/connect')) {
    if(mode === 'connect-failure') {res.writeHead(503);res.end('SECRET');return;}
    connected = true; return empty();
  }
  if(path === '/api/mcp') return json({data:[{name:'valise',status:{status:connected?'connected':'pending'}},...(mode === 'extra-server'?[{name:'personal',status:{status:'connected'}}]:[])]});
  if(path === '/api/session' || path.endsWith('/prompt')) return json({data:body});
  if(path.includes('/experimental/')) return empty();
  if(path.endsWith('/message')) return json({data:${JSON.stringify(messages)}});
  return json({data:{...${JSON.stringify(session)},id:mode === 'wrong-session'?'ses_other':id,outcome:mode === 'provider-failure'?'failed':'succeeded'}});
});
if(mode === 'hang-start') setInterval(()=>{},1000);
else server.listen(0,'127.0.0.1',()=>{
  console.log('server listening on http://127.0.0.1:'+server.address().port);
  console.log('server password private-fixture-password');
});
`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", dir);
  return {
    dir,
    log,
    invocations: () =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}

function callLog(log: string, withList = true) {
  const nativeFetch = globalThis.fetch;
  const queries: { sql: string; params: string[] }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.includes("/cdn-cgi/local/explorer/"))
        return nativeFetch(url, init);
      if (!init) return Response.json({ result: [{ name: "DB", uuid: "db" }] });
      const query = JSON.parse(String(init.body));
      queries.push(query);
      appendFileSync(
        log,
        `${JSON.stringify({ kind: "call-log", id: query.params[0] })}\n`,
      );
      return Response.json({
        result: [
          {
            results: {
              columns: ["at", "method", "tool", "args_json"],
              rows: [
                ...(withList ? [[1, "tools/list", null, null]] : []),
                [2, "tools/call", "claim_todo", '{"id":"todo:seed"}'],
              ],
            },
          },
        ],
      });
    }),
  );
  return queries;
}

describe("OpenCode eval isolation", () => {
  test("allowlists environment auth without importing personal configs, hooks, DB, or runtime", () => {
    const r = runtime();
    expect(Object.keys(r.env).sort()).toEqual(
      [
        "PATH",
        "OPENROUTER_API_KEY",
        "OPENCODE_DISABLE_PROJECT_CONFIG",
        "HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
        "XDG_RUNTIME_DIR",
        "TMPDIR",
      ].sort(),
    );
    for (const key of [
      "HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "XDG_RUNTIME_DIR",
      "TMPDIR",
    ]) {
      expect(r.env[key].startsWith(`${r.dir}/`)).toBe(true);
      expect(statSync(r.env[key]).mode & 0o777).toBe(0o700);
    }
    expect(statSync(r.dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(r.configDir, "opencode.json")).mode & 0o777).toBe(
      0o600,
    );
    expect(Object.keys(r.config.mcp.servers)).toEqual(["valise"]);
    expect(r.config.mcp.servers.valise).toMatchObject({
      oauth: false,
      codemode: false,
      headers: { "x-valise-session": "ses_example" },
    });
    expect(r.config.permissions).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: "valise_*", resource: "*", effect: "allow" },
    ]);
    expect(r.config.plugins).toEqual([]);
    // Code Mode is opt-in, and turning it on must also allow execute:
    // OpenCode exposes the tools directly when execute is denied.
    const coded = opencode.isolatedRuntime(
      "http://localhost:4476/mcp",
      "ses_example",
      {},
      { PATH: process.env.PATH },
      { codemode: true },
    );
    dirs.push(coded.dir);
    expect(coded.config.mcp.servers.valise.codemode).toBe(true);
    expect(coded.config.permissions).toContainEqual({
      action: "execute",
      resource: "*",
      effect: "allow",
    });
    expect(readFileSync(r.config.instructions[0], "utf8")).toBe("case context");
    expect(JSON.stringify(r.config)).not.toContain("secret");
    expect(() =>
      opencode.assertIsolatedConfig(configEntries(r), r),
    ).not.toThrow();
  });

  test("refuses extra global/system sources or modified config instead of merging silently", () => {
    const r = runtime();
    expect(() =>
      opencode.assertIsolatedConfig(
        [...configEntries(r), { type: "directory", path: "/personal" }],
        r,
      ),
    ).toThrow("contaminated");
    const entries = configEntries(r);
    entries[0] = {
      ...entries[0],
      info: { ...r.config, plugins: ["personal-hook"] },
    };
    expect(() => opencode.assertIsolatedConfig(entries, r)).toThrow(
      "contaminated",
    );
  });

  test("refuses nonlocal stores and records unsupported Claude-only scenarios", () => {
    expect(() =>
      opencode.prepareLanes("https://valise.example/mcp", () => {}),
    ).toThrow("loopback");
    expect(skipReason({ shell: { gh: {} } }, "opencode")).toContain(
      "Claude Code",
    );
    expect(skipReason({ hideTools: ["fetch"] }, "opencode")).toContain(
      "OpenCode",
    );
    expect(
      skipReason(
        { history: [{ role: "tool", content: "result" }] },
        "opencode",
      ),
    ).toContain("replays");
    expect(
      buildTurn(
        { context: "{{hook:SessionStart}}", prompt: "{{hook:Stop}}" },
        (text: string) => text.replaceAll("{{hook:", "inline-"),
        false,
      ),
    ).toMatchObject({
      appendSystemPrompt: "inline-SessionStart}}",
      prompt: "inline-Stop}}",
      stopEvery: null,
    });
  });
});

describe("OpenCode headless results", () => {
  test("reads answer and accounting only from a complete successful session", () => {
    expect(opencode.readResult(session, messages, "ses_example")).toEqual({
      capped: false,
      clientTools: [],
      answer: "answer",
      spend: {
        turns: 1,
        firstPromptTokens: 19,
        promptTokens: 19,
        completionTokens: 3,
        reasoningTokens: 1,
        costUsd: 0.001,
      },
    });
    expect(() =>
      opencode.readResult(
        { ...session, id: "ses_other" },
        messages,
        "ses_example",
      ),
    ).toThrow();
    expect(() =>
      opencode.readResult(
        { ...session, outcome: "failed" },
        messages,
        "ses_example",
      ),
    ).toThrow();
    expect(() => opencode.readResult(session, [], "ses_example")).toThrow(
      "incomplete",
    );
    expect(() =>
      opencode.readResult(
        session,
        [{ ...messages[0], finish: "length" }],
        "ses_example",
      ),
    ).toThrow("incomplete");
    expect(
      opencode.readResult(session, Array(12).fill(messages[0]), "ses_example")
        .capped,
    ).toBe(true);
  });

  test("runs privately, connects and settles the catalog before prompting, reads D1 routes, and cleans up", async () => {
    const fake = executable();
    const queries = callLog(fake.log);
    const devRoute = vi.fn(async () => ({ seeded: { todo: "todo:seed" } }));
    const setup = opencode.prepareLanes("http://localhost:4476/mcp", devRoute);
    const results = [];
    for (let i = 0; i < 2; i++)
      results.push(
        await opencode.runHarnessEpisode(
          setup,
          "opencode+mcp/openrouter/openai/gpt-5.4-mini",
          { prompt: "claim it" },
          (text: string) => text,
        ),
      );
    expect(devRoute.mock.calls).toHaveLength(4);
    expect(results[0].route).toEqual([
      { name: "claim_todo", args: { id: "todo:seed" } },
    ]);
    expect(results[0].session.sessionId).not.toBe(results[1].session.sessionId);
    for (const query of queries) {
      expect(query.sql).toContain("WHERE session = ? AND agent = ?");
      expect(query.params[1]).toBe("valise-eval-harness");
      expect(results.some((r) => r.session.sessionId === query.params[0])).toBe(
        true,
      );
    }
    const calls = fake.invocations();
    for (const invocation of calls.filter((c) => c.kind === "spawn")) {
      expect(invocation.args).toEqual([
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        "0",
      ]);
      expect(invocation.env.OPENCODE_SESSION_ID).toBeUndefined();
      expect(existsSync(invocation.cwd)).toBe(false);
    }
    for (const result of results) {
      const own = calls.filter((c) => c.id === result.session.sessionId);
      const promptIndex = own.findIndex((c) => c.path?.endsWith("/prompt"));
      expect(
        own.slice(0, promptIndex).filter((c) => c.kind === "call-log"),
      ).toHaveLength(2);
      expect(
        own.slice(0, promptIndex).some((c) => c.path?.endsWith("/connect")),
      ).toBe(true);
      expect(own.find((c) => c.path === "/api/session").body.model).toEqual({
        providerID: "openrouter",
        id: "openai/gpt-5.4-mini",
      });
    }
  }, 10000);

  test.each([
    "contaminated",
    "malformed",
    "connect-failure",
    "extra-server",
    "wrong-session",
    "provider-failure",
  ])("fails closed and removes the private runtime on %s", async (mode) => {
    const fake = executable(mode);
    callLog(fake.log);
    const setup = opencode.prepareLanes(
      "http://localhost:4476/mcp",
      async () => ({ seeded: { todo: "todo:seed" } }),
    );
    const error = await opencode
      .runHarnessEpisode(
        setup,
        "opencode+mcp/openai/model",
        { prompt: "hello" },
        (text: string) => text,
      )
      .catch((cause: Error) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain("SECRET");
    for (const call of fake.invocations().filter((c) => c.kind === "spawn"))
      expect(existsSync(call.cwd)).toBe(false);
    if (
      ["contaminated", "malformed", "connect-failure", "extra-server"].includes(
        mode,
      )
    )
      expect(fake.invocations().some((c) => c.path?.endsWith("/prompt"))).toBe(
        false,
      );
  });

  test("missing tools/list evidence prevents model admission rather than passing as no-tool", async () => {
    const fake = executable();
    callLog(fake.log, false);
    const setup = opencode.prepareLanes(
      "http://localhost:4476/mcp",
      async () => ({ seeded: { todo: "todo:seed" } }),
    );
    await expect(
      opencode.runHarnessEpisode(
        setup,
        "opencode+mcp/openai/model",
        { prompt: "hello" },
        (text: string) => text,
      ),
    ).rejects.toThrow("no tools/list");
    expect(fake.invocations().some((c) => c.path?.endsWith("/prompt"))).toBe(
      false,
    );
  });

  test("bounds private-server startup, API waits, and spawn failure", async () => {
    executable("hang-start");
    const r = runtime();
    await expect(opencode.startServer(r, 100)).rejects.toThrow(/start/);
    const fake = executable();
    r.env.PATH = fake.dir;
    const server = await opencode.startServer(r);
    try {
      await expect(
        opencode.apiRequest(server, "/hang", "GET", undefined, 50),
      ).rejects.toThrow("timed out");
    } finally {
      await server.stop();
    }
    r.env.PATH = join(fake.dir, "does-not-exist");
    await expect(opencode.startServer(r)).rejects.toThrow("could not start");
  });
});
