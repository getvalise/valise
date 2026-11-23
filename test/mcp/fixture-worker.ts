import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { handleMcp } from "../../workers/mcp";

export async function callMcp(
  method: string,
  params: Record<string, unknown>,
  agent = "vitest",
  accept = "application/json, text/event-stream",
  headers: Record<string, string> = {},
  /** Bindings laid over the test env, such as a secret one test needs. */
  bindings: Partial<Env> = {},
) {
  const request = new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: {
      accept,
      "content-type": "application/json",
      host: "127.0.0.1",
      "mcp-protocol-version": "2025-11-25",
      "x-valise-agent": agent,
      "x-valise-client": "test",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params,
    }),
  });
  const ctx = createExecutionContext();
  const response = await handleMcp(request, { ...env, ...bindings }, ctx);
  const raw = await response.text();
  // The call log is written behind `waitUntil`; flush it before asserting.
  await waitOnExecutionContext(ctx);
  const json = raw
    .split("\n")
    .find((line) => line.startsWith("data:"))
    ?.slice("data:".length)
    .trim();
  return { raw, response, value: JSON.parse(json || raw) as McpResponse };
}

type McpResponse = {
  result: Record<string, unknown> & {
    tools?: unknown;
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
  error?: { code: number; message: string };
};
