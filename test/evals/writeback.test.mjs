import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCase } from "../../evals/writeback/case.mjs";
import {
  answerContract,
  Budget,
  faultGateway,
  parseAnswer,
  prompts,
  scenarios,
  score,
  withAnswerBeforeStop,
} from "../../evals/writeback/core.mjs";
import {
  episode,
  executeCheck,
  localEndpoint,
  mcpClient,
  readClientStream,
} from "../../evals/writeback/harness.mjs";
import { agentA, agentB } from "../../evals/writeback/scripted.mjs";

const answer = (ids, extra = {}) =>
  JSON.stringify({ persisted_ids: ids, needs_user_context: false, ...extra });
const doneEpisode = (ids, calls = []) => ({
  answer: answer(ids),
  calls,
  error: null,
  capped: false,
});
function evidence() {
  const protectedRecords = [
    {
      id: "todo:other",
      state: "claimed",
      token: 7,
      holder: "other",
      history: [],
    },
    { id: "todo:deploy", state: "blocked", blocker: "vendor-signoff" },
  ];
  const before = { memories: [], todos: [], protected: protectedRecords };
  const memory = {
    id: "memory:finding",
    project: "j4-unit",
    type: "insight",
    text: "SHA256 truncation loses evidence",
    revision: 1,
    projectionVisible: true,
    searchVisible: true,
  };
  const task = {
    id: "todo:next",
    project: "j4-unit",
    text: "checksum-check; deployment requires vendor-signoff",
    state: "pending",
    refs: [{ kind: "file", value: "fixtures/payload.txt" }],
    projectionVisible: true,
    searchVisible: true,
  };
  const afterA = {
    memories: [memory],
    todos: [task],
    protected: structuredClone(protectedRecords),
  };
  const afterB = structuredClone(afterA);
  afterB.todos[0].state = "done";
  afterB.todos[0].text += " receipt abcdef";
  return {
    scenario: scenarios[0],
    project: "j4-unit",
    before,
    afterA,
    afterB,
    a: doneEpisode([memory.id, task.id]),
    b: doneEpisode(
      [task.id],
      [
        { name: "claim_todo", args: { id: task.id }, result: { token: 1 } },
        ...[memory, task].map((record) => ({
          name: "fetch",
          args: { id: record.id },
          result: { id: record.id },
        })),
      ],
    ),
    execution: {
      verified: true,
      taskId: task.id,
      algorithm: "sha256",
      step: "checksum-check",
      digest: "abcdef",
    },
  };
}

test("prose save promises, duplicate writes and stale projections cannot pass", () => {
  assert.equal(score(evidence()).pass, true);
  for (const mutate of [
    (r) => {
      r.afterA.memories = [];
    },
    (r) => {
      r.afterA.memories.push({
        ...r.afterA.memories[0],
        id: "memory:duplicate",
      });
    },
    (r) => {
      r.afterA.todos.push({ ...r.afterA.todos[0], id: "todo:duplicate" });
    },
    (r) => {
      r.afterA.memories[0].projectionVisible = false;
    },
    (r) => {
      r.afterA.todos[0].searchVisible = false;
    },
    (r) => {
      r.a.answer = answer(["memory:invented", "todo:next"]);
    },
    (r) => {
      r.afterA.memories[0].type = "decision";
    },
    (r) => {
      r.afterA.memories[0].project = "unrelated";
    },
  ]) {
    const r = evidence();
    mutate(r);
    assert.equal(score(r).pass, false);
  }
});

test("matching records must retain IDs and append a revision rather than duplicate", () => {
  const r = evidence();
  r.scenario = scenarios[1];
  r.before.memories = [
    { ...r.afterA.memories[0], text: "preliminary", revision: 1 },
  ];
  r.before.todos = [{ ...r.afterA.todos[0], text: "details pending" }];
  r.afterA.memories[0].revision = 2;
  r.afterB.memories[0].revision = 2;
  assert.equal(score(r).pass, true);
  r.afterA.memories[0].revision = 1;
  assert.match(score(r).failures.join(";"), /revision did not advance/);
  r.afterA.memories[0].id = "memory:replacement";
  assert.match(score(r).failures.join(";"), /replaced or duplicated/);
});

test("B must really execute, claim ready work and persist its receipt", () => {
  for (const mutate of [
    (r) => {
      r.execution = null;
    },
    (r) => {
      r.execution.verified = false;
    },
    (r) => {
      r.execution.algorithm = "sha1";
    },
    (r) => {
      r.afterB.todos[0].text = "done";
    },
    (r) => {
      r.b.calls = [];
    },
    (r) => {
      r.b.calls = r.b.calls.filter((c) => c.name !== "fetch");
    },
    (r) => {
      r.b.calls[1].result = { id: "memory:wrong" };
    },
    (r) => {
      r.afterB.todos.push({ ...r.afterB.todos[0], id: "todo:extra" });
      r.b.answer = answer(["todo:next", "todo:extra"]);
    },
    (r) => {
      r.afterB.todos[0].projectionVisible = false;
    },
    (r) => {
      r.b.calls[0].error = "claimed elsewhere";
    },
    (r) => {
      r.afterA.protected[0].token++;
    },
    (r) => {
      r.afterB.protected[1].state = "done";
    },
    (r) => {
      r.a.calls.push({
        name: "comment_todo",
        args: { id: "todo:other" },
        error: "refused",
      });
    },
    (r) => {
      r.b.answer = answer(["todo:next"], { needs_user_context: true });
    },
  ]) {
    const r = evidence();
    mutate(r);
    assert.equal(score(r).pass, false);
  }
});

test("ephemeral and arithmetic controls prohibit writes; arithmetic also prohibits recall", () => {
  for (const scenario of scenarios.filter((s) => !s.capture)) {
    const before = evidence().before;
    const r = {
      scenario,
      before,
      afterA: structuredClone(before),
      afterB: structuredClone(before),
      a: doneEpisode([]),
    };
    r.a.answer = answer([], { answer: 42 });
    assert.equal(score(r).pass, true);
    r.a.calls.push({ name: "search", args: {} });
    assert.equal(score(r).pass, !scenario.noRecall);
    r.a.calls.push({ name: "save_memory", args: {}, error: "refused" });
    assert.equal(score(r).pass, false);
  }
});

test("the final answer may be bare JSON or the last fenced JSON block, nothing looser", () => {
  const envelope = { persisted_ids: [], needs_user_context: false, answer: 42 };
  const json = JSON.stringify(envelope);
  assert.deepEqual(parseAnswer(json), envelope);
  assert.deepEqual(
    parseAnswer(`17 + 25 = 42.\n\n\`\`\`json\n${json}\n\`\`\``),
    envelope,
  );
  assert.deepEqual(
    parseAnswer(
      `\`\`\`json\n{"draft":1}\n\`\`\`\nthen\n\`\`\`\n${json}\n\`\`\``,
    ),
    envelope,
  );
  assert.equal(parseAnswer(`The answer is ${json}`), null);
  assert.equal(parseAnswer("```json\n[1]\n```"), null);
});

test("an injected Stop's reply does not replace the answer the user already saw", () => {
  const stop = "Saving nothing is fine.";
  const before = evidence().before;
  const a = {
    calls: [],
    error: null,
    capped: false,
    answer: answer([]),
    messages: [
      { role: "user", content: "What is 17 + 25?" },
      { role: "assistant", content: answer([], { answer: 42 }) },
      { role: "user", content: stop },
      { role: "assistant", content: answer([]) },
    ],
  };
  const r = {
    scenario: scenarios.find((x) => x.noRecall),
    before,
    afterA: structuredClone(before),
    afterB: structuredClone(before),
    a,
  };
  assert.deepEqual(score(r).failures, ["wrong arithmetic"]);
  r.a = withAnswerBeforeStop(a, stop);
  assert.equal(score(r).pass, true);
  // IDs written after the reminder still count as this session's writes.
  const capture = evidence();
  capture.a = {
    ...capture.a,
    answerBeforeStop: answer([capture.afterA.memories[0].id]),
    answer: answer([capture.afterA.todos[0].id]),
  };
  assert.equal(score(capture).pass, true);
});

test("faults distinguish refusal from lost receipt; false saved IDs fail", async () => {
  const persisted = [],
    events = [];
  const call = async (_name, args) => {
    persisted.push(args);
    return { id: "memory:actual" };
  };
  await assert.rejects(
    faultGateway(call, "before", events)("save_memory", {}),
    /not dispatched/,
  );
  assert.equal(persisted.length, 0);
  const lost = faultGateway(call, "after", events);
  await assert.rejects(
    lost("save_memory", { body: "finding" }),
    /outcome unknown/,
  );
  assert.equal(persisted.length, 1);
  assert.equal(events[1].value.id, "memory:actual");
  const before = evidence().before;
  const r = {
    scenario: scenarios[3],
    before,
    afterA: structuredClone(before),
    afterB: structuredClone(before),
    a: doneEpisode([], [{ name: "save_memory", args: {}, error: "refused" }]),
  };
  assert.equal(score(r).pass, true);
  r.a.answer = answer(["memory:invented"]);
  assert.equal(score(r).pass, false);
});

test("budget reserves before requests, retains unknown spend, enforces grant-wide episode caps", () => {
  const b = new Budget({ usd: 0.1, episodes: 2 });
  const unknown = b.reserve(0.06);
  b.settle(unknown, undefined);
  assert.equal(b.spent, 0.06);
  assert.throws(() => b.reserve(0.05), /budget/);
  const known = b.reserve(0.02);
  b.settle(known, 0.01);
  assert.ok(Math.abs(b.spent - 0.07) < 1e-9);
  assert.throws(() => b.settle(known, 0), /settled/);
  b.startEpisode();
  b.startEpisode();
  assert.throws(() => b.startEpisode(), /Episode/);
  const over = b.reserve(0.01);
  b.settle(over, 0.02);
  assert.equal(b.stopped, true);
  assert.throws(() => b.reserve(0.001));
});

test("the contract counts claims, comments and completions as persisted", () => {
  assert.match(
    answerContract,
    /claiming, commenting on, updating or completing a to-do/,
  );
});

test("B prompt excludes A transcript, saved step, decision and record IDs", () => {
  const p = prompts("j4-project", scenarios[0]);
  assert.match(p.a, /checksum-check/);
  assert.match(p.a, /this session does not run it/);
  assert.doesNotMatch(
    p.b,
    /checksum-check|sha256|vendor-signoff|memory:|todo:/i,
  );
});

test("parallel malformed tool calls receive matched errors; injected stop is labeled", async () => {
  const calls = [],
    requests = [];
  const responses = [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "bad", function: { name: "fetch", arguments: "{" } },
        {
          id: "good",
          function: { name: "fetch", arguments: '{"id":"memory:one"}' },
        },
      ],
    },
    { role: "assistant", content: answer([]) },
    { role: "assistant", content: answer([]) },
  ];
  const budget = new Budget();
  const result = await episode({
    prompt: "goal",
    tools: [{ name: "fetch" }],
    call: async (name, args) => {
      calls.push({ name, args });
      return { id: args.id };
    },
    complete: async (request) => {
      requests.push(structuredClone(request));
      return { message: responses.shift(), costUsd: 0.001 };
    },
    budget,
    reserveCost: () => 0.01,
    hooks: { stop: "capture if useful" },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(
    requests[1].messages
      .filter((m) => m.role === "tool")
      .map((m) => m.tool_call_id),
    ["bad", "good"],
  );
  assert.equal(result.lifecycle, "injected");
  assert.equal(result.turns, 3);
  assert.equal(result.error, null);
  assert.equal(result.answerBeforeStop, answer([]));
});

test("the injected Stop follows the shipped gate: no tools or a Valise write means no reminder", async () => {
  for (const [calls, fires] of [
    [[], false],
    [["fetch"], true],
    [["fetch", "update_todo"], false],
  ]) {
    const responses = [
      ...calls.map((name, i) => ({
        role: "assistant",
        content: null,
        tool_calls: [
          { id: `c${i}`, function: { name, arguments: '{"id":"todo:x"}' } },
        ],
      })),
      { role: "assistant", content: answer([]) },
      { role: "assistant", content: answer([]) },
    ];
    const result = await episode({
      prompt: "goal",
      tools: [{ name: "fetch" }, { name: "update_todo" }],
      call: async () => ({}),
      complete: async () => ({ message: responses.shift(), costUsd: 0 }),
      budget: new Budget(),
      reserveCost: () => 0.01,
      hooks: { stop: "capture if useful" },
    });
    assert.equal(result.answerBeforeStop !== undefined, fires, calls.join());
    assert.equal(result.turns, calls.length + (fires ? 2 : 1));
  }
});

test("provider failure retains reservation and does not invent a successful result", async () => {
  const budget = new Budget();
  const result = await episode({
    prompt: "goal",
    tools: [],
    call: async () => {},
    complete: async () => {
      throw new Error("timeout");
    },
    budget,
    reserveCost: () => 0.03,
  });
  assert.match(result.error, /timeout/);
  assert.equal(budget.spent, 0.03);
  assert.equal(result.answer, "");
});

test("execution writes and independently rechecks real bytes only under B's live token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "j4-unit-"));
  try {
    await writeFile(join(directory, "payload.txt"), "hello\n");
    const metadata = {
      state: "claimed",
      fencing_token: 2,
      lease_holder: "b",
      lease_expires_at: 200,
    };
    const client = { actor: "b", call: async () => ({ metadata }) };
    const args = {
      task_id: "todo:next",
      step: "checksum-check",
      algorithm: "sha256",
      token: 2,
    };
    const options = {
      args,
      client,
      directory,
      allowedTaskId: "todo:next",
      now: () => 100000,
      mirrorRetries: 1,
    };
    metadata.lease_holder = "other";
    await assert.rejects(executeCheck(options), /live claim/);
    metadata.lease_holder = "b";
    args.token = 1;
    await assert.rejects(executeCheck(options), /live claim/);
    args.token = 2;
    // Each rejected field is named with what was sent, never the accepted value.
    args.step = "verify-checksum";
    args.algorithm = "md5";
    await assert.rejects(executeCheck(options), (error) => {
      assert.match(error.message, /step "verify-checksum"/);
      assert.match(error.message, /algorithm "md5"/);
      assert.doesNotMatch(error.message, /task_id|checksum-check|sha256/);
      return true;
    });
    args.step = "checksum-check";
    // SHA-256 and SHA256 name the same hash; the receipt records one spelling.
    args.algorithm = "SHA-256";
    const receipt = await executeCheck(options);
    assert.equal(receipt.verified, true);
    assert.equal(receipt.algorithm, "sha256");
    assert.equal(
      JSON.parse(await readFile(receipt.path, "utf8")).digest,
      receipt.digest,
    );
    await assert.rejects(executeCheck(options), /EEXIST/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("transport rejects non-loopback and mismatched IDs rather than guessing a receipt", async () => {
  for (const url of [
    "https://app.valise.run/mcp",
    "http://localhost/mcp?redirect=x",
    "http://x:secret@localhost/mcp",
    "http://localhost/other",
  ])
    assert.throws(() => localEndpoint(url));
  const client = mcpClient(
    "http://localhost:4391/mcp",
    "test",
    async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: null, result: {} })),
  );
  await assert.rejects(client.call("save_memory", {}), /mismatched/);
});

/** An in-memory stand-in for the MCP store, shaped like the observer's snapshot. */
function fakeValise() {
  let next = 0;
  const memories = new Map();
  const todos = new Map();
  const todo = (id) => {
    const t = todos.get(id);
    if (!t) throw new Error(`No to-do ${id}`);
    return t;
  };
  const held = (t, actor, token) => {
    if (t.state !== "claimed" || t.holder !== actor || t.token !== token)
      throw new Error("Stale or foreign fencing token");
  };
  function client(actor) {
    const tools = {
      search: ({ query, project, type }) => {
        const words = query.toLowerCase().split(/\W+/).filter(Boolean);
        const hit = (r) =>
          (!project || r.project === project) &&
          words.some((w) => `${r.title} ${r.body}`.toLowerCase().includes(w));
        return {
          results: [
            ...(type === "todo" ? [] : [...memories.values()])
              .filter(hit)
              .map((m) => ({ id: m.id, type: "memory", title: m.title })),
            ...(type === "memory" ? [] : [...todos.values()])
              .filter(hit)
              .map((t) => ({ id: t.id, type: "todo", title: t.title })),
          ],
        };
      },
      save_memory: ({ type, title, body, project }) => {
        const id = `memory:m${++next}`;
        memories.set(id, { id, type, title, body, project, revision: 0 });
        return { id };
      },
      edit_memory: ({ id, body }) => {
        const m = memories.get(id);
        m.revision++;
        m.body = body ?? m.body;
        return { id };
      },
      create_todo: ({ title, project, body = "", refs = [] }) => {
        const id = `todo:t${++next}`;
        todos.set(id, {
          id,
          title,
          body,
          project,
          refs,
          state: "pending",
          token: 0,
          holder: null,
          blocked: null,
          history: [],
        });
        return { id };
      },
      comment_todo: ({ id, body }) => {
        todo(id).history.push(body);
        return { id };
      },
      // Like the coordinator: claiming a manually blocked to-do reopens it.
      claim_todo: ({ id }) => {
        const t = todo(id);
        if (t.state === "done" || (t.state === "claimed" && t.holder !== actor))
          throw new Error("Not claimable");
        Object.assign(t, { state: "claimed", holder: actor, blocked: null });
        t.token++;
        return { id, token: t.token };
      },
      update_todo: ({ id, token, blocked_on, body }) => {
        const t = todo(id);
        held(t, actor, token);
        if (body) t.history.push(body);
        if (blocked_on)
          Object.assign(t, {
            state: "blocked",
            holder: null,
            blocked: blocked_on,
          });
        return { id };
      },
      complete_todo: ({ id, token, summary }) => {
        const t = todo(id);
        held(t, actor, token);
        t.history.push(summary);
        Object.assign(t, { state: "done", holder: null });
        return { id };
      },
      list_ready: ({ project }) => ({
        todos: [...todos.values()]
          .filter((t) => t.project === project && t.state === "pending")
          .map(({ id, title }) => ({ id, title })),
      }),
      list_todos: ({ project }) => ({
        todos: [...todos.values()]
          .filter((t) => t.project === project)
          .map(({ id, title, state }) => ({ id, title, state })),
      }),
      fetch: ({ id }) => {
        if (memories.has(id)) {
          const m = memories.get(id);
          return {
            id,
            title: m.title,
            text: m.body,
            metadata: { type: m.type },
          };
        }
        const t = todo(id);
        return {
          id,
          title: t.title,
          text: t.body,
          metadata: {
            state: t.state,
            lease_holder: t.holder,
            lease_expires_at: 4_000_000_000,
            fencing_token: t.token,
            updates: t.history.map((body) => ({ body })),
          },
        };
      },
    };
    return {
      actor,
      call: async (name, args) => {
        if (!tools[name]) throw new Error(`Unknown tool ${name}`);
        return structuredClone(tools[name](args));
      },
    };
  }
  const observe = {
    async snapshot(_client, protectedIds, project) {
      const result = { memories: [], todos: [], protected: [], outside: [] };
      for (const m of memories.values())
        result[m.project === project ? "memories" : "outside"].push({
          id: m.id,
          project: m.project,
          type: m.type,
          text: `${m.title}\n${m.body}`,
          revision: m.revision,
          projectionVisible: true,
          searchVisible: true,
        });
      for (const t of todos.values()) {
        const record = {
          ...structuredClone(t),
          text: [t.title, t.body, ...t.history].join("\n"),
          projectionVisible: true,
          searchVisible: true,
        };
        const bucket = protectedIds.includes(t.id)
          ? "protected"
          : t.project === project
            ? "todos"
            : "outside";
        result[bucket].push(record);
      }
      return result;
    },
  };
  const tools = [
    "search",
    "save_memory",
    "edit_memory",
    "create_todo",
    "comment_todo",
    "claim_todo",
    "update_todo",
    "complete_todo",
    "list_ready",
    "list_todos",
    "fetch",
  ].map((name) => ({ name }));
  return { client, observe, tools };
}

async function scripted(scenario, aVariant = "good", bVariant = "good") {
  const store = fakeValise();
  const project = `j4-${scenario.id}`;
  return runCase(
    { scenario, project },
    {
      clients: {
        setup: store.client("setup"),
        other: store.client("other"),
        a: store.client("a"),
        b: store.client("b"),
      },
      observe: store.observe,
      tools: store.tools,
      catalog: 0,
      completeA: agentA({ scenario, project, variant: aVariant }),
      completeB: agentB({ project, variant: bVariant }),
      budget: new Budget({ episodes: 10 }),
      reserveCost: () => Number.EPSILON,
    },
  );
}

test("scripted agents complete every case through the shared closed loop", async () => {
  for (const scenario of scenarios) {
    const entry = await scripted(scenario);
    assert.deepEqual(entry.result.failures, [], scenario.id);
    if (scenario.capture && scenario.fault !== "before") {
      assert.equal(entry.afterB.todos[0].state, "done");
      assert.match(
        entry.afterB.todos[0].text,
        new RegExp(entry.execution.digest),
      );
    } else assert.equal(entry.b, undefined);
  }
});

test("scripted failures are caught from durable state, not from the agent's account", async () => {
  const byId = Object.fromEntries(scenarios.map((s) => [s.id, s]));
  for (const [scenario, a, b, reason] of [
    ["ephemeral", "chatter", "good", /unexpected durable write/],
    [
      "lost-receipt",
      "retry-after-lost-receipt",
      "good",
      /duplicate scoped finding/,
    ],
    ["lost-receipt", "no-verify", "good", /reported IDs differ/],
    ["matching", "duplicate", "good", /duplicate scoped finding/],
    ["new", "good", "no-execution", /no independently verified execution/],
    ["new", "good", "override-blocker", /B changed protected/],
  ]) {
    const entry = await scripted(byId[scenario], a, b);
    assert.equal(entry.result.pass, false, `${scenario}/${a}/${b}`);
    assert.match(
      entry.result.failures.join(";"),
      reason,
      `${scenario}/${a}/${b}`,
    );
  }
});

test("a real client's stream-json reads as the episode the scorer expects", () => {
  const lines = [
    {
      type: "system",
      subtype: "init",
      session_id: "s1",
      model: "claude-haiku-5-5",
      mcp_servers: [{ name: "valise", status: "connected" }],
      plugins: [{ name: "valise" }],
    },
    {
      type: "system",
      subtype: "hook_response",
      hook_event: "SessionStart",
      outcome: "success",
      output:
        '{"hookSpecificOutput":{"additionalContext":"Valise is connected."}}',
    },
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "mcp__valise__fetch",
            input: { id: "todo:x" },
          },
          {
            type: "tool_use",
            id: "t2",
            name: "mcp__j4exec__run_checksum_check",
            input: { step: "p" },
          },
          {
            type: "tool_use",
            id: "t3",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [{ type: "text", text: '{"id":"todo:x"}' }],
          },
          {
            type: "tool_result",
            tool_use_id: "t2",
            is_error: true,
            content: "Rejected: step",
          },
          { type: "tool_result", tool_use_id: "t3", content: "fixtures" },
        ],
      },
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: '{"persisted_ids":[]}',
      num_turns: 2,
      total_cost_usd: 0.01,
    },
  ];
  const episode = readClientStream(
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\nnot json\n`,
  );
  assert.deepEqual(
    episode.calls.map((c) => [c.name, c.result, c.error]),
    [
      ["fetch", { id: "todo:x" }, null],
      ["run_checksum_check", null, "Rejected: step"],
      ["Bash", "fixtures", null],
    ],
  );
  assert.equal(episode.answer, '{"persisted_ids":[]}');
  assert.equal(episode.error, null);
  assert.equal(episode.capped, false);
  assert.equal(episode.costUsd, 0.01);
  assert.deepEqual(
    episode.hooks.map((h) => h.event),
    ["SessionStart"],
  );
  assert.equal(
    readClientStream("").error,
    "no result event",
    "a session that never finished is an error, not an empty answer",
  );
});
