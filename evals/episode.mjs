/** OpenRouter episode protocol, separate from CLI setup and report writing. */
const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";
// Everything else ends the episode before it can write, unless a case opts
// it into live execution. Skills return instructions, not actions.
const READ_ONLY = [
  "search",
  "fetch",
  "list_ready",
  "get_brief",
  "list_todos",
  "list_memories",
  "list_sources",
  "list_skills",
  "get_skill",
  "list_hooks",
];

export async function runEpisode(
  model,
  testCase,
  tools,
  { apiKey, callLiveTool, fetchImpl = fetch },
) {
  const messages = [...testCase.messages];
  const route = [];
  const spend = emptySpend();
  const harness = new Map(
    (testCase.harnessTools ?? []).map((tool) => [tool.name, tool.result]),
  );
  const endings = new Set([
    testCase.tool,
    ...(testCase.alsoAccept ?? []),
    ...(testCase.stopOn ?? []),
  ]);
  const live = new Set(
    [...READ_ONLY, ...(testCase.live ?? [])].filter(
      (name) => !endings.has(name),
    ),
  );
  const ids = new Set();
  const isLive = (call) =>
    call.name?.startsWith("skill_") || live.has(call.name);
  const isFixture = (call) => harness.has(call.name) && !endings.has(call.name);
  const result = (extra = {}) => ({ route, spend, error: null, ...extra });
  try {
    for (let round = 0; round < testCase.maxRounds; round++) {
      const { message, calls, usage } = await chooseTool(
        model,
        messages,
        tools,
        apiKey,
        fetchImpl,
      );
      addSpend(spend, usage);
      if (!message || message.role !== "assistant")
        throw new Error("completion returned no assistant message");
      if (!calls.length) return result({ answer: message.content ?? null });
      // Retain every requested call and its exact argument string, even when
      // validation, a transport failure or a terminal sibling ends the batch.
      const offset = route.length;
      const batch = calls.map((call) => ({
        ...call,
        round,
        status: "not_executed",
      }));
      route.push(...batch);
      for (const call of batch) {
        if (call.parseError || !call.id || !call.name || ids.has(call.id)) {
          call.status = "invalid";
          throw new Error(
            call.parseError ?? "missing or duplicate tool call id/name",
          );
        }
        ids.add(call.id);
      }
      // Fetch-choice/stopOn/write cases still end before tool execution. Select
      // the FIRST terminal request in provider order, not a favourable sibling.
      // No call in this simultaneous batch can have informed another call.
      const terminal = batch.findIndex(
        (call) => !isFixture(call) && !isLive(call),
      );
      if (terminal !== -1) return result({ endingIndex: offset + terminal });
      const outputs = [];
      for (const call of batch) {
        let content;
        try {
          if (isFixture(call)) content = harness.get(call.name);
          else content = await callLiveTool(call.name, call.args);
          if (typeof content !== "string")
            throw new Error(`no string tool output for ${call.name}`);
          call.status = "executed";
        } catch (cause) {
          call.status = "error";
          throw cause;
        }
        outputs.push({ role: "tool", tool_call_id: call.id, content });
      }
      // Preserve the assistant message verbatim (including reasoning metadata).
      // Continue only after ALL its calls have actual, ID-matched outputs.
      messages.push(message, ...outputs);
    }
    return result({ capped: true });
  } catch (cause) {
    // Errors remain failures, but must not erase earlier calls or paid usage.
    return result({ error: String(cause.message ?? cause) });
  }
}

export function endingCall({ route, endingIndex }) {
  return (
    (endingIndex === undefined || endingIndex === null
      ? route.at(-1)
      : route[endingIndex]) ?? null
  );
}

/** Only delivered reads can satisfy a procedure's prerequisite. */
export function deliveredCalls(route) {
  return route.filter((call) => call.status === "executed");
}

export function emptySpend() {
  return {
    turns: 0,
    firstPromptTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
  };
}

function addSpend(spend, usage) {
  // One completion is one round even when it requests several tools.
  spend.turns += 1;
  if (!usage) return;
  if (spend.turns === 1) spend.firstPromptTokens = usage.prompt_tokens ?? 0;
  spend.promptTokens += usage.prompt_tokens ?? 0;
  spend.completionTokens += usage.completion_tokens ?? 0;
  spend.reasoningTokens +=
    usage.completion_tokens_details?.reasoning_tokens ?? 0;
  spend.costUsd += usage.cost ?? 0;
}

async function chooseTool(model, messages, tools, apiKey, fetchImpl) {
  const response = await fetchImpl(OPENROUTER, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "x-title": "Valise tool-choice eval",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 4096,
      tools,
      tool_choice: "auto",
      usage: { include: true },
      messages,
    }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${body.slice(0, 300)}`);
  const parsed = JSON.parse(body);
  if (parsed.error) throw new Error(JSON.stringify(parsed.error).slice(0, 300));
  const choice = parsed.choices?.[0];
  const usage = parsed.usage ?? null;
  const calls = (choice?.message?.tool_calls ?? []).map((call) => {
    const args = safeJson(call.function?.arguments);
    return {
      id: call.id,
      name: call.function?.name ?? null,
      args,
      argumentsJson: call.function?.arguments ?? null,
      ...(typeof call.function?.arguments !== "string"
        ? { parseError: "tool arguments must be a JSON string" }
        : args === null
          ? {
              parseError: `truncated tool arguments (finish_reason=${choice?.finish_reason})`,
            }
          : {}),
    };
  });
  return { message: choice?.message, calls, usage };
}

function safeJson(value) {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
