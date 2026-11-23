#!/usr/bin/env node
// The checksum executor as a stdio MCP server, so a real client's Agent B
// calls the same `run_checksum_check` the OpenRouter harness exposes. The
// runner starts it through `--mcp-config` and reads the attempts it records.
// Newline-delimited JSON-RPC, tools only; nothing here reaches a network
// beyond the loopback store.
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { executeCheck, executionTool, mcpClient } from "./harness.mjs";

const { J4_ENDPOINT, J4_DIRECTORY, J4_TASK, J4_ACTOR } = process.env;
if (!J4_ENDPOINT || !J4_DIRECTORY || !J4_TASK || !J4_ACTOR)
  throw new Error("J4_ENDPOINT, J4_DIRECTORY, J4_TASK and J4_ACTOR required");
const client = mcpClient(J4_ENDPOINT, J4_ACTOR);
const log = join(J4_DIRECTORY, "executor-attempts.jsonl");

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

async function handle({ id, method, params }) {
  if (method === "initialize")
    return {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "j4-executor", version: "1.0.0" },
    };
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: [executionTool] };
  if (method === "tools/call") {
    if (params?.name !== executionTool.name)
      throw Object.assign(new Error("Unknown tool"), { code: -32602 });
    const args = params.arguments ?? {};
    let result;
    let error = null;
    try {
      result = await executeCheck({
        args,
        client,
        directory: J4_DIRECTORY,
        allowedTaskId: J4_TASK,
      });
    } catch (e) {
      error = String(e);
    }
    await appendFile(
      log,
      `${JSON.stringify({ at: new Date().toISOString(), id, args, result, error })}\n`,
    );
    return {
      content: [
        { type: "text", text: JSON.stringify(error ? { error } : result) },
      ],
      ...(error && { isError: true }),
    };
  }
  throw Object.assign(new Error(`Method not found: ${method}`), {
    code: -32601,
  });
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (message.id === undefined) continue; // notifications need no answer
  try {
    send({ id: message.id, result: await handle(message) });
  } catch (error) {
    send({
      id: message.id,
      error: { code: error.code ?? -32603, message: error.message },
    });
  }
}
