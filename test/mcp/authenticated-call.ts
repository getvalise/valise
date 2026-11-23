import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { expect } from "vitest";
import { mcpHandler } from "../../workers/mcp";

export type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown> & {
    id?: string;
    token?: number;
    metadata?: Record<string, unknown>;
  };
  content: { type: string; text: string }[];
};

/**
 * One tool call through the provider-authenticated MCP handler as `userId`,
 * with the OAuth context the provider would set. A forged loopback identity
 * header rides along on purpose: it must never choose the tenant.
 */
export async function authenticatedTool(
  userId: string,
  scopes: string[],
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<ToolResult> {
  const body = await authenticatedRpc(
    userId,
    scopes,
    "tools/call",
    { name, arguments: args },
    headers,
  );
  return body.result as ToolResult;
}

/** Any JSON-RPC method through the same authenticated path; the whole reply. */
export async function authenticatedRpc(
  userId: string,
  scopes: string[],
  method: string,
  params: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}> {
  const ctx = createExecutionContext();
  Object.assign(ctx, {
    auth: { clientId: `client-${userId}`, scope: scopes },
    props: { userId },
  });
  const response = await mcpHandler.fetch(
    new Request("https://valise.test/mcp", {
      method: "POST",
      headers: {
        host: "valise.test",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-valise-user": "local",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
    ctx,
  );
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  expect(response.status, text).toBe(200);
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : text);
}
