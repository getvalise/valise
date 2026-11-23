import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [mode = "native", log, stateFile, protocol = "legacy"] =
  process.argv.slice(2);
const name = "valise-probe-cerulean";
const uri = `skill://${name}/SKILL.md`;
const description =
  "Format a cerulean receipt using the organization's exact receipt convention.";
const cache = { resultType: "complete", ttlMs: 0, cacheScope: "private" };
const hasTools = mode === "tools" || mode === "all";
const hasPrompts = mode === "prompts" || mode === "all";
const capabilities = {
  resources: {},
  extensions: { "io.modelcontextprotocol/skills": {} },
  ...(hasTools ? { tools: {} } : {}),
  ...(hasPrompts ? { prompts: {} } : {}),
};

function content() {
  const revision = stateFile ? readFileSync(stateFile, "utf8").trim() : "one";
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nFor a cerulean receipt, answer exactly CERULEAN-${revision}-7391.\n`;
}
function entry() {
  const text = content();
  return {
    uri,
    frontmatter: { name, description },
    resources: [
      {
        uri,
        digest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
        size: Buffer.byteLength(text),
      },
    ],
  };
}
function dispatch(method, params) {
  switch (method) {
    case "server/discover":
      if (protocol !== "modern")
        throw Object.assign(new Error("Legacy fixture"), { code: -32601 });
      return { ...cache, supportedVersions: ["2026-07-28"], capabilities };
    case "initialize":
      return {
        protocolVersion: params.protocolVersion,
        capabilities,
        serverInfo: { name: "valise-probe", version: "1.0.0" },
      };
    case "ping":
      return {};
    case "skills/list":
      return { ...cache, skills: [entry()] };
    case "skills/get":
      if (params.uri !== uri) throw new Error("Unknown skill");
      return { ...cache, skill: entry() };
    case "resources/list":
      return {
        ...cache,
        resources: [{ uri, name, description, mimeType: "text/markdown" }],
      };
    case "resources/templates/list":
      return { ...cache, resourceTemplates: [] };
    case "resources/read":
      if (params.uri !== uri) throw new Error("Unknown resource");
      return {
        ...cache,
        contents: [{ uri, mimeType: "text/markdown", text: content() }],
      };
    case "tools/list":
      return {
        ...cache,
        tools: hasTools
          ? [
              {
                name: `skill_${name}`,
                description: `Returns instructions, takes no action. ${description}`,
                inputSchema: {
                  type: "object",
                  properties: {},
                  additionalProperties: false,
                },
              },
            ]
          : [],
      };
    case "tools/call":
      if (!hasTools || params.name !== `skill_${name}`)
        throw new Error("Unknown tool");
      return { ...cache, content: [{ type: "text", text: content() }] };
    case "prompts/list":
      return { ...cache, prompts: hasPrompts ? [{ name, description }] : [] };
    case "prompts/get":
      if (!hasPrompts || params.name !== name)
        throw new Error("Unknown prompt");
      return {
        ...cache,
        description,
        messages: [
          { role: "user", content: { type: "text", text: content() } },
        ],
      };
    default:
      throw Object.assign(new Error(`Unsupported method: ${method}`), {
        code: -32601,
      });
  }
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  if (log)
    appendFileSync(
      log,
      `${JSON.stringify({ at: new Date().toISOString(), ...request })}\n`,
    );
  if (request.id === undefined) continue;
  let response;
  try {
    response = { result: dispatch(request.method, request.params ?? {}) };
  } catch (error) {
    response = {
      error: { code: error.code ?? -32602, message: error.message },
    };
  }
  console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...response }));
}
