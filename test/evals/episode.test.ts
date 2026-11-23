import { describe, expect, test, vi } from "vitest";
// @ts-expect-error: plain .mjs script has no declarations.
import * as protocol from "../../evals/episode.mjs";
// @ts-expect-error: plain .mjs script has no declarations.
import { readSkillFirst } from "../../evals/index.mjs";

const { deliveredCalls, endingCall, runEpisode } = protocol;

const call = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const usage = { prompt_tokens: 20, completion_tokens: 4, cost: 0.002 };
const scenario = {
  tool: "fetch",
  maxRounds: 3,
  messages: [{ role: "user", content: "Find the memory." }],
};
const searches = [
  call("a", "search", { query: "first" }),
  call("b", "search", { query: "second" }),
];

/** Refuse a continuation unless every call in its assistant batch has one output. */
function provider() {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.messages.length === 1)
      return Response.json({
        choices: [
          {
            message: { role: "assistant", content: null, tool_calls: searches },
            finish_reason: "tool_calls",
          },
        ],
        usage,
      });
    const [assistant, ...outputs] = body.messages.slice(1);
    if (
      assistant.tool_calls.some(
        (request: { id: string }) =>
          outputs.filter(
            (output: { tool_call_id: string }) =>
              output.tool_call_id === request.id,
          ).length !== 1,
      )
    ) {
      return Response.json(
        { error: { message: "No tool output found for function call" } },
        { status: 400 },
      );
    }
    expect(
      outputs.map((output: { content: string }) => output.content),
    ).toEqual(["real first", "real second"]);
    return Response.json({
      choices: [
        {
          message: {
            role: "assistant",
            tool_calls: [call("c", "fetch", { id: "memory:target" })],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage,
    });
  });
}

describe("OpenRouter parallel tool protocol", () => {
  test("answers every requested read before the next completion, without executing terminal fetch", async () => {
    const fetchImpl = provider();
    const callLiveTool = vi.fn(
      async (_name: string, args: { query: string }) => `real ${args.query}`,
    );
    const result = await runEpisode("test/model", scenario, [], {
      apiKey: "fixture",
      fetchImpl,
      callLiveTool,
    });
    expect(result.error ?? null).toBeNull();
    expect(result.route.map((step: { name: string }) => step.name)).toEqual([
      "search",
      "search",
      "fetch",
    ]);
    expect(callLiveTool).toHaveBeenCalledTimes(2);
    expect(result.spend.turns).toBe(2);
  });

  test("preserves the complete assistant batch and reasoning metadata verbatim", async () => {
    const message = {
      role: "assistant",
      content: null,
      reasoning_details: [
        { type: "reasoning.text", text: "fixture reasoning" },
      ],
      tool_calls: searches,
    };
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.messages.length === 1) return completion(message);
      expect(body.messages[1]).toEqual(message);
      expect(body.messages.slice(2)).toEqual([
        { role: "tool", tool_call_id: "a", content: "real first" },
        { role: "tool", tool_call_id: "b", content: "real second" },
      ]);
      return completion({ role: "assistant", content: "done" });
    });
    const result = await episode(fetchImpl);
    expect(result.error).toBeNull();
    expect(result.answer).toBe("done");
    expect(result.route).toEqual(
      searches.map((request) => ({
        id: request.id,
        name: "search",
        args: JSON.parse(request.function.arguments),
        argumentsJson: request.function.arguments,
        round: 0,
        status: "executed",
      })),
    );
    expect(result.spend).toMatchObject({
      turns: 2,
      firstPromptTokens: 20,
      promptTokens: 40,
      completionTokens: 8,
      costUsd: 0.004,
    });
  });

  test("keeps every request but selects the first terminal call, not an expected sibling", async () => {
    const batch = [
      searches[0],
      call("write", "save_memory", { title: "not executed" }),
      call("target", "fetch", { id: "memory:correct" }),
    ];
    const callLiveTool = vi.fn();
    const result = await episode(sequence([batch]), { callLiveTool });
    expect(result.error).toBeNull();
    expect(result.route.map((step: { name: string }) => step.name)).toEqual([
      "search",
      "save_memory",
      "fetch",
    ]);
    expect(
      result.route.every(
        (step: { status: string }) => step.status === "not_executed",
      ),
    ).toBe(true);
    expect(result.endingIndex).toBe(1);
    expect(endingCall(result)).toMatchObject({
      name: "save_memory",
      args: { title: "not executed" },
    });
    expect(callLiveTool).not.toHaveBeenCalled();
  });

  test("terminal fetch is never executed, including when followed by a live read", async () => {
    const batch = [
      call("wrong", "fetch", { id: "memory:wrong" }),
      call("correct", "fetch", { id: "memory:correct" }),
      searches[0],
    ];
    const callLiveTool = vi.fn();
    const result = await episode(sequence([batch]), { callLiveTool });
    expect(result.endingIndex).toBe(0);
    expect(endingCall(result).args.id).toBe("memory:wrong");
    expect(result.route[1].args.id).toBe("memory:correct");
    expect(callLiveTool).not.toHaveBeenCalled();
  });

  test("stopOn also wins before returning canned results or running a sibling read", async () => {
    const callLiveTool = vi.fn();
    const result = await episode(
      sequence([[call("bash", "bash", { command: "retry" }), searches[0]]]),
      { callLiveTool },
      {
        tool: "search",
        stopOn: ["bash"],
        harnessTools: [{ name: "bash", result: "canned" }],
      },
    );
    expect(endingCall(result).name).toBe("bash");
    expect(callLiveTool).not.toHaveBeenCalled();
  });

  test("a simultaneous skill request cannot satisfy an unread prerequisite", async () => {
    const result = await episode(
      sequence([
        [
          call("skill", "skill_capture-this", {}),
          call("save", "save_memory", { title: "claim" }),
        ],
      ]),
      {},
      { tool: "save_memory" },
    );
    expect(deliveredCalls(result.route)).toEqual([]);
    expect(
      readSkillFirst({
        routeCalls: result.route,
        endingIndex: result.endingIndex,
      }),
    ).toBe(false);
  });

  test("a delivered skill from an earlier model turn still counts before a terminal sibling", async () => {
    const result = await episode(
      sequence([
        [call("skill", "skill_capture-this", {})],
        [call("save", "save_memory", { title: "claim" }), searches[0]],
      ]),
      {},
      { tool: "save_memory" },
    );
    expect(result.error).toBeNull();
    expect(
      deliveredCalls(result.route).map((step: { name: string }) => step.name),
    ).toEqual(["skill_capture-this"]);
    expect(endingCall(result).name).toBe("save_memory");
    expect(
      readSkillFirst({
        routeCalls: result.route,
        endingIndex: result.endingIndex,
      }),
    ).toBe(true);
  });

  test("counts model rounds once per batch and retains every call at the cap", async () => {
    const callLiveTool = vi.fn(async () => "real result");
    const fetchImpl = sequence([searches]);
    const result = await episode(fetchImpl, { callLiveTool }, { maxRounds: 1 });
    expect(result.capped).toBe(true);
    expect(result.route).toHaveLength(2);
    expect(result.spend.turns).toBe(1);
    expect(callLiveTool).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("retains prior route/arguments/known spend when the next provider request fails", async () => {
    let round = 0;
    const first = sequence([searches]);
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) =>
      round++ === 0
        ? first(url, init)
        : Response.json(
            { error: { message: "provider timeout" } },
            { status: 504 },
          ),
    );
    const result = await episode(fetchImpl);
    expect(result.error).toContain("504");
    expect(result.route.map((step: { args: unknown }) => step.args)).toEqual([
      { query: "first" },
      { query: "second" },
    ]);
    expect(
      result.route.every(
        (step: { status: string }) => step.status === "executed",
      ),
    ).toBe(true);
    expect(result.spend).toMatchObject({
      turns: 1,
      promptTokens: 20,
      costUsd: 0.002,
    });
  });

  test("transport failure retains the full requested batch and never fabricates missing outputs", async () => {
    const callLiveTool = vi.fn(
      async (_name: string, args: { query: string }) => {
        if (args.query === "second") throw new Error("MCP transport failed");
        return "real first";
      },
    );
    const fetchImpl = sequence([
      [...searches, call("third", "list_ready", {})],
    ]);
    const result = await episode(fetchImpl, { callLiveTool });
    expect(result.error).toBe("MCP transport failed");
    expect(result.route.map((step: { status: string }) => step.status)).toEqual(
      ["executed", "error", "not_executed"],
    );
    expect(callLiveTool).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.spend.costUsd).toBe(0.002);
  });

  test("forwards actual MCP error results, rather than swallowing or replacing them", async () => {
    const actualError = JSON.stringify({
      isError: true,
      content: [{ type: "text", text: "not found" }],
    });
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.messages.length === 1)
        return completion({ role: "assistant", tool_calls: searches });
      expect(
        body.messages
          .slice(2)
          .map((output: { content: string }) => output.content),
      ).toEqual([actualError, actualError]);
      return completion({
        role: "assistant",
        tool_calls: [call("target", "fetch", { id: "memory:target" })],
      });
    });
    const result = await episode(fetchImpl, {
      callLiveTool: vi.fn(async () => actualError),
    });
    expect(result.error).toBeNull();
    expect(endingCall(result).name).toBe("fetch");
  });

  test("answers every declared harness fixture without calling the live endpoint", async () => {
    const callLiveTool = vi.fn();
    let turn = 0;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      if (turn++ === 0)
        return completion({
          role: "assistant",
          tool_calls: [
            call("find", "find_skill", {}),
            call("load", "load_skill", {}),
          ],
        });
      const body = JSON.parse(String(init.body));
      expect(body.messages.slice(2)).toEqual([
        { role: "tool", tool_call_id: "find", content: "declared index" },
        { role: "tool", tool_call_id: "load", content: "declared body" },
      ]);
      return completion({ role: "assistant", content: "done" });
    });
    const result = await episode(
      fetchImpl,
      { callLiveTool },
      {
        harnessTools: [
          { name: "find_skill", result: "declared index" },
          { name: "load_skill", result: "declared body" },
        ],
      },
    );
    expect(result.error).toBeNull();
    expect(callLiveTool).not.toHaveBeenCalled();
  });

  test("truncated non-first arguments fail visibly with the entire raw batch and usage intact", async () => {
    const broken = {
      ...searches[1],
      function: { ...searches[1].function, arguments: '{"query":' },
    };
    const callLiveTool = vi.fn();
    const result = await episode(
      sequence([
        [searches[0], broken, call("target", "fetch", { id: "memory:target" })],
      ]),
      { callLiveTool },
    );
    expect(result.error).toContain("truncated tool arguments");
    expect(result.route).toHaveLength(3);
    expect(result.route[1]).toMatchObject({
      argumentsJson: '{"query":',
      args: null,
      status: "invalid",
    });
    expect(result.route[2].args.id).toBe("memory:target");
    expect(result.spend.costUsd).toBe(0.002);
    expect(callLiveTool).not.toHaveBeenCalled();
  });

  test.each(["duplicate", "missing"])(
    "rejects %s call IDs without inventing a pairing",
    async (mode) => {
      const callLiveTool = vi.fn();
      const result = await episode(
        sequence([
          [
            searches[0],
            { ...searches[1], id: mode === "duplicate" ? "a" : "" },
          ],
        ]),
        { callLiveTool },
      );
      expect(result.error).toContain("missing or duplicate");
      expect(result.route).toHaveLength(2);
      expect(callLiveTool).not.toHaveBeenCalled();
    },
  );

  test("missing fixture results are errors, not synthetic empty tool outputs", async () => {
    const fetchImpl = sequence([[call("fixture", "find_skill", {})]]);
    const result = await episode(
      fetchImpl,
      {},
      { harnessTools: [{ name: "find_skill" }] },
    );
    expect(result.error).toContain("no string tool output");
    expect(result.route[0].status).toBe("error");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("single terminal calls and prose endings retain the existing semantics", async () => {
    const callLiveTool = vi.fn();
    const terminal = await episode(
      sequence([[call("target", "fetch", { id: "memory:target" })]]),
      { callLiveTool },
    );
    expect(endingCall(terminal).args.id).toBe("memory:target");
    expect(callLiveTool).not.toHaveBeenCalled();
    const prose = await episode(sequence([[]]));
    expect(prose).toMatchObject({ route: [], answer: "done", error: null });
    expect(prose.spend.turns).toBe(1);
  });
});

function completion(message: object) {
  return Response.json({
    choices: [{ message, finish_reason: "tool_calls" }],
    usage,
  });
}

function sequence(batches: ReturnType<typeof call>[][]) {
  let round = 0;
  return vi.fn(async (_url: string, _init: RequestInit) => {
    const batch = batches[round++];
    if (!batch) throw new Error("unexpected extra model request");
    return completion({
      role: "assistant",
      ...(batch.length ? { tool_calls: batch } : { content: "done" }),
    });
  });
}

function episode(
  fetchImpl: ReturnType<typeof sequence>,
  options = {},
  overrides = {},
) {
  return runEpisode("test/model", { ...scenario, ...overrides }, [], {
    apiKey: "fixture",
    fetchImpl,
    callLiveTool: vi.fn(
      async (_name: string, args: { query: string }) => `real ${args.query}`,
    ),
    ...options,
  });
}
