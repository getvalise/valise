import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureDue } from "../../clients/valise/scripts/valise-hook.mjs";
import { answerContract } from "./core.mjs";

export function localEndpoint(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/mcp" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Use an explicitly isolated loopback /mcp endpoint");
  }
  return url;
}

/** No SDK credential discovery; no redirects to a remote origin. */
export function mcpClient(endpoint, actor, request = fetch) {
  const url = localEndpoint(endpoint);
  let seq = 0;
  const rpc = async (method, params) => {
    const id = ++seq;
    const response = await request(url, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
        "x-valise-agent": actor,
        "x-valise-client": "j4-isolated-eval",
        "x-valise-session": actor,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(30000),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
    const messages = raw.startsWith("{")
      ? [JSON.parse(raw)]
      : raw.split(/\r?\n\r?\n/).flatMap((event) => {
          const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          return data && data !== "[DONE]" ? [JSON.parse(data)] : [];
        });
    const message = messages.find((m) => m.id === id);
    if (!message || message.error)
      throw new Error(
        `MCP missing/mismatched/error response: ${JSON.stringify(message?.error ?? null)}`,
      );
    return message.result;
  };
  return {
    actor,
    async tools() {
      return (await rpc("tools/list", {})).tools;
    },
    async call(name, args) {
      const result = await rpc("tools/call", { name, arguments: args });
      if (result.isError) throw new Error(JSON.stringify(result));
      return (
        result.structuredContent ??
        JSON.parse(result.content.find((c) => c.type === "text").text)
      );
    },
  };
}

export const executionTool = {
  name: "run_checksum_check",
  description:
    "Run the authorized local checksum verification on the fixture input and write a receipt. Requires your current claim token, the saved step identifier and algorithm. No shell or network is available.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      task_id: { type: "string" },
      token: { type: "integer", minimum: 1 },
      step: { type: "string" },
      algorithm: { type: "string" },
    },
    required: ["task_id", "token", "step", "algorithm"],
  },
};

/** Safe allowlisted execution, with independent re-read of bytes for scoring. */
export async function executeCheck({
  args,
  client,
  directory,
  allowedTaskId,
  now = Date.now,
  mirrorRetries = 20,
}) {
  // A spelling of the algorithm is not a different algorithm: SHA-256, SHA256
  // and sha256 name one hash. The step is an identifier and stays exact.
  const algorithm = String(args.algorithm ?? "")
    .toLowerCase()
    .replace(/[-_\s]/g, "");
  // Name each rejected field and what was sent, never the accepted value, so
  // the error says where to look without handing over the saved step.
  const rejected = [
    args.task_id !== allowedTaskId &&
      `task_id ${JSON.stringify(args.task_id)} is not the authorized task`,
    args.step !== "checksum-check" &&
      `step ${JSON.stringify(args.step)} is not an authorized step identifier`,
    algorithm !== "sha256" &&
      `algorithm ${JSON.stringify(args.algorithm)} is not an authorized algorithm`,
  ].filter(Boolean);
  if (rejected.length) throw new Error(`Rejected: ${rejected.join("; ")}`);
  // The row mirrors the coordinator and can trail a fresh claim by a moment;
  // the fencing token is written synchronously, so a stale token fails at once.
  const live = (m) =>
    m.state === "claimed" &&
    m.fencing_token === args.token &&
    m.lease_holder === client.actor &&
    m.lease_expires_at * 1000 > now();
  let m = (await client.call("fetch", { id: args.task_id })).metadata;
  for (
    let i = 0;
    i < mirrorRetries && !live(m) && m.fencing_token === args.token;
    i++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    m = (await client.call("fetch", { id: args.task_id })).metadata;
  }
  if (!live(m))
    throw new Error("Execution requires this client's current live claim");
  const bytes = await readFile(join(directory, "payload.txt"));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const receipt = {
    taskId: args.task_id,
    step: args.step,
    algorithm,
    digest,
    token: args.token,
    actor: client.actor,
  };
  const path = join(directory, "checksum-receipt.json");
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  const saved = JSON.parse(await readFile(path, "utf8"));
  const reread = createHash("sha256")
    .update(await readFile(join(directory, "payload.txt")))
    .digest("hex");
  return {
    ...saved,
    path,
    verified: saved.digest === reread && saved.taskId === args.task_id,
  };
}

/** Both clients get new message arrays. Stop text here is injection, never lifecycle proof. */
export async function episode({
  prompt,
  tools,
  call,
  complete,
  budget,
  reserveCost,
  hooks = {},
  maxCalls = 32,
  checkpoint = () => {},
}) {
  budget.startEpisode();
  const messages = [
    {
      role: "system",
      content: `${answerContract}${hooks.start ? `\n${hooks.start}` : ""}`,
    },
    { role: "user", content: prompt },
  ];
  const result = {
    answer: "",
    error: null,
    capped: false,
    calls: [],
    messages,
    lifecycle: hooks.start || hooks.stop ? "injected" : "absent",
    turns: 0,
    requestBytes: [],
  };
  let stopInjected = false;
  try {
    for (let round = 0; round < budget.roundLimit; round++) {
      // Request size is the input-token proxy behind a cost estimate.
      result.requestBytes.push(
        Buffer.byteLength(JSON.stringify({ messages, tools })),
      );
      const reservation = budget.reserve(reserveCost({ messages, tools }));
      // Persist reservation BEFORE any provider call; a crash retains unknown spend.
      await checkpoint({ result, budget });
      const response = await complete({ messages, tools });
      budget.settle(reservation, response.costUsd);
      if (!response.message || response.message.role !== "assistant")
        throw new Error("Provider omitted assistant message");
      result.turns++;
      messages.push(response.message);
      const requested = response.message.tool_calls ?? [];
      if (!requested.length) {
        if (
          hooks.stop &&
          !stopInjected &&
          captureDue(result.calls.map((c) => c.name))
        ) {
          stopInjected = true;
          result.answerBeforeStop = response.message.content ?? "";
          messages.push({ role: "user", content: hooks.stop });
          continue;
        }
        result.answer = response.message.content ?? "";
        return result;
      }
      // Even malformed/unsupported siblings get a matching tool result.
      for (const request of requested) {
        const entry = {
          name: request.function?.name,
          args: null,
          result: null,
          error: null,
        };
        result.calls.push(entry);
        try {
          if (result.calls.length > maxCalls)
            throw new Error("Episode tool-call cap reached");
          if (!tools.some((t) => t.name === entry.name))
            throw new Error("Tool not exposed");
          entry.args = JSON.parse(request.function.arguments);
          entry.result = await call(entry.name, entry.args);
        } catch (error) {
          entry.error = String(error);
        }
        messages.push({
          role: "tool",
          tool_call_id: request.id,
          content: JSON.stringify(
            entry.error ? { error: entry.error } : entry.result,
          ),
        });
      }
      await checkpoint({ result, budget });
      if (result.calls.length >= maxCalls) {
        result.capped = true;
        return result;
      }
    }
    result.capped = true;
  } catch (error) {
    result.error = String(error);
  } finally {
    await checkpoint({ result, budget });
  }
  return result;
}

/**
 * One real Claude Code session, read from `claude -p --output-format
 * stream-json --verbose --include-hook-events`: tool calls with their results,
 * the final answer, hook responses and the reported cost.
 */
export function readClientStream(text) {
  const events = text
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const init = events.find((e) => e.type === "system" && e.subtype === "init");
  const result = events.findLast((e) => e.type === "result");
  const calls = [];
  const byId = new Map();
  for (const event of events) {
    for (const block of event.message?.content ?? []) {
      if (event.type === "assistant" && block.type === "tool_use") {
        // mcp__valise__fetch and mcp__j4exec__run_checksum_check score as
        // the bare tool names the OpenRouter lane records.
        const name = block.name.split("__").at(-1);
        const call = {
          name,
          fullName: block.name,
          args: block.input,
          result: null,
          error: null,
        };
        calls.push(call);
        byId.set(block.id, call);
      }
      if (event.type === "user" && block.type === "tool_result") {
        const call = byId.get(block.tool_use_id);
        if (!call) continue;
        const raw = Array.isArray(block.content)
          ? block.content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("")
          : String(block.content ?? "");
        if (block.is_error) call.error = raw;
        else
          try {
            call.result = JSON.parse(raw);
          } catch {
            call.result = raw;
          }
      }
    }
  }
  const hooks = events
    .filter((e) => e.type === "system" && e.subtype === "hook_response")
    .map((e) => ({
      event: e.hook_event,
      outcome: e.outcome,
      output: e.output,
    }));
  return {
    sessionId: init?.session_id ?? null,
    model: init?.model ?? null,
    mcpServers: init?.mcp_servers ?? [],
    plugins: (init?.plugins ?? []).map((p) => p.name),
    answer: result?.result ?? "",
    calls,
    hooks,
    turns: result?.num_turns ?? 0,
    costUsd: result?.total_cost_usd ?? null,
    usage: result?.usage ?? null,
    durationMs: result?.duration_ms ?? null,
    error: !result
      ? "no result event"
      : result.is_error || result.subtype !== "success"
        ? `${result.subtype}: ${result.result ?? ""}`.slice(0, 500)
        : null,
    capped:
      result?.subtype === "error_max_budget_usd" ||
      result?.subtype === "error_max_turns",
  };
}
