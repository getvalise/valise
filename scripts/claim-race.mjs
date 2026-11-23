const count = Number(process.argv[2] ?? "8");
if (!Number.isInteger(count) || count < 2 || count > 100) {
  throw new Error("Usage: node scripts/claim-race.mjs [2-100 claimants]");
}

const url = process.env.VALISE_MCP_URL ?? "http://127.0.0.1:5173/mcp";
const protocolVersion = process.env.VALISE_MCP_PROTOCOL ?? "2025-11-25";
// A deployed endpoint wants a bearer token per contender; a comma-separated
// list is dealt round-robin, so two tokens make two principals. Loopback
// needs none.
const tokens = (process.env.VALISE_MCP_TOKENS ?? "")
  .split(",")
  .map((token) => token.trim())
  .filter(Boolean);
const project = process.env.VALISE_RACE_PROJECT ?? "valise";
const todo = await tool("race-creator", 0, "create_todo", {
  title: `Claim race with ${count} contenders`,
  project,
  tags: ["race", "evidence"],
});
if (todo.result.isError) throw new Error(toolText(todo.result));

const id = todo.result.structuredContent.id;
const attempts = await Promise.all(
  Array.from({ length: count }, (_, index) =>
    tool(`race-${index + 1}`, index, "claim_todo", { id, ttl_seconds: 60 }),
  ),
);
const successes = attempts.filter(({ result }) => !result.isError);
const failures = attempts.filter(({ result }) => result.isError);
// The winner closes the race to-do, so a run against a live queue leaves
// nothing claimable behind.
if (successes.length === 1) {
  const [winner] = successes;
  const closed = await tool(winner.agent, winner.index, "complete_todo", {
    id,
    token: winner.result.structuredContent.token,
    summary: `Race evidence: ${successes.length} of ${count} claims won.`,
  });
  if (closed.result.isError) throw new Error(toolText(closed.result));
}
process.stdout.write(
  `${JSON.stringify(
    {
      todo: id,
      count,
      successes: successes.map(({ agent, result }) => ({
        agent,
        lease: result.structuredContent,
      })),
      failures: failures.map(({ agent, result }) => ({
        agent,
        error: toolText(result),
      })),
    },
    null,
    2,
  )}\n`,
);

async function tool(agent, index, name, args) {
  const token = tokens.length > 0 ? tokens[index % tokens.length] : undefined;
  await rpc(
    agent,
    token,
    "initialize",
    {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "valise-claim-race", version: "0.1.0" },
    },
    false,
  );
  return {
    agent,
    index,
    result: await rpc(agent, token, "tools/call", { name, arguments: args }),
  };
}

async function rpc(agent, token, method, params, includeProtocolHeader = true) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "x-valise-agent": agent,
      "x-valise-client": "claim-race",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(includeProtocolHeader
        ? { "mcp-protocol-version": protocolVersion }
        : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params,
    }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${raw}`);
  const data = raw
    .split("\n")
    .find((line) => line.startsWith("data:"))
    ?.slice("data:".length)
    .trim();
  return JSON.parse(data || raw).result;
}

function toolText(result) {
  return result.content.map((entry) => entry.text).join("\n");
}
