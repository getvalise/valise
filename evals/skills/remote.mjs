const url =
  process.argv[2] ??
  "https://mcp.skillsovermcp.com/mcp/spencerpauly/skills-repo";
let session;
let protocol = "2025-11-25";
async function call(method, params = {}) {
  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": protocol,
      ...(session ? { "Mcp-Session-Id": session } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(method.startsWith("notifications/")
        ? {}
        : { id: crypto.randomUUID() }),
      method,
      params,
    }),
  });
  session = response.headers.get("mcp-session-id") ?? session;
  const text = await response.text();
  if (!response.ok) return { httpStatus: response.status, body: text };
  if (!text.trim()) return {};
  const event = text.split("\n").find((line) => line.startsWith("data:"));
  return JSON.parse(event ? event.slice(5) : text);
}
const initialize = await call("initialize", {
  protocolVersion: protocol,
  capabilities: { extensions: { "io.modelcontextprotocol/skills": {} } },
  clientInfo: { name: "valise-compat-probe", version: "1.0.0" },
});
protocol = initialize.result?.protocolVersion ?? protocol;
const results = { url, at: new Date().toISOString(), initialize };
if (!initialize.result) {
  console.log(JSON.stringify(results, null, 2));
  process.exit(1);
}
results.initialized = await call("notifications/initialized");
for (const method of [
  "tools/list",
  "prompts/list",
  "resources/list",
  "skills/list",
]) {
  results[method] = await call(method);
}
console.log(JSON.stringify(results, null, 2));
