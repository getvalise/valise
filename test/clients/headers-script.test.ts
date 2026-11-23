import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const PLUGIN = path.resolve(__dirname, "../../clients/valise");
const SCRIPT = path.join(PLUGIN, "scripts/valise-headers.mjs");
const VERSION = JSON.parse(
  readFileSync(path.join(PLUGIN, ".claude-plugin/plugin.json"), "utf8"),
).version as string;

/**
 * The script reads the session of its parent process. Spawned with
 * `execFile`, the parent is this test runner, so its pid names the file.
 */
function headers(configDir: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [SCRIPT],
      { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir } },
      (error, stdout) => (error ? reject(error) : resolve(JSON.parse(stdout))),
    );
  });
}

const dirs: string[] = [];

function configDir(session?: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "valise-headers-"));
  dirs.push(dir);
  if (session) {
    mkdirSync(path.join(dir, "sessions"));
    writeFileSync(
      path.join(dir, "sessions", `${process.pid}.json`),
      JSON.stringify(session),
    );
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

describe("valise-headers.mjs", () => {
  test("names the Claude Code session that spawned it", async () => {
    const sent = await headers(
      configDir({ pid: process.pid, sessionId: "ddd24d1a", name: "valise-34" }),
    );
    expect(sent).toMatchObject({
      "X-Valise-Plugin": `valise/${VERSION}`,
      "X-Valise-Session": "ddd24d1a",
      "X-Valise-Session-Name": "valise-34",
    });
    expect(sent["X-Valise-Host"]).not.toBe("");
  });

  test("falls back to pid@host when Claude Code left no session file", async () => {
    const sent = await headers(configDir());
    expect(sent["X-Valise-Session"]).toBe(
      `${process.pid}@${sent["X-Valise-Host"]}`,
    );
    expect(sent).not.toHaveProperty("X-Valise-Session-Name");
  });

  test("keeps a non-ASCII session name a legal header value", async () => {
    const sent = await headers(
      configDir({ sessionId: "s", name: "café-ünïcode" }),
    );
    expect(sent["X-Valise-Session-Name"]).toBe("caf?-?n?code");
  });
});

describe("the Codex manifest", () => {
  const read = (file: string) =>
    JSON.parse(readFileSync(path.join(PLUGIN, file), "utf8"));

  // Codex reads its own manifest and MCP file, so the version is written in
  // three places. A release that bumps one and not the others reports a
  // plugin version on the logs tab that no install has.
  test("carries the same version as the Claude Code manifest", () => {
    const codex = read(".codex-plugin/plugin.json");
    const server = read(".codex.mcp.json").mcpServers.valise;
    expect(codex.version).toBe(VERSION);
    expect(server.http_headers["X-Valise-Plugin"]).toBe(`valise/${VERSION}`);
  });

  // Codex expands no `${VAR:-default}`; a placeholder is a URL that never
  // resolves.
  test("names the endpoint without a placeholder", () => {
    const server = read(".codex.mcp.json").mcpServers.valise;
    expect(server.url).toMatch(/^https:\/\/[^$]+\/mcp$/);
  });
});
