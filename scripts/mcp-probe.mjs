const [command, rawArgs] = process.argv.slice(2);
const url = process.env.VALISE_MCP_URL ?? "http://127.0.0.1:5173/mcp";
const protocolVersion = process.env.VALISE_MCP_PROTOCOL ?? "2025-11-25";

if (!command) {
  throw new Error(
    "Usage: node scripts/mcp-probe.mjs <rpc/method|tool-name> [json]",
  );
}

const provenance = {
  "x-valise-agent": process.env.VALISE_AGENT ?? "mcp-probe",
  "x-valise-client": process.env.VALISE_CLIENT ?? "script",
  "x-valise-session": process.env.VALISE_SESSION ?? "local",
};

const initialized = await call(
  "initialize",
  {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "valise-mcp-probe", version: "0.1.0" },
  },
  false,
);

if (initialized.error) {
  print(initialized);
  process.exitCode = 1;
} else if (command.includes("/")) {
  // Any protocol method, including the SEP-2640 skills/list and skills/get.
  print(await call(command, rawArgs ? JSON.parse(rawArgs) : {}));
} else {
  const args = rawArgs ? JSON.parse(rawArgs) : {};
  print(await call("tools/call", { name: command, arguments: args }));
}

async function call(method, params, includeProtocolHeader = true) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(includeProtocolHeader
        ? { "mcp-protocol-version": protocolVersion }
        : {}),
      ...provenance,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params,
    }),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}\n${raw}`);
  }
  return parseJsonRpc(raw);
}

function parseJsonRpc(raw) {
  const json = raw
    .split("\n")
    .find((line) => line.startsWith("data:"))
    ?.slice("data:".length)
    .trim();
  return JSON.parse(json || raw);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
