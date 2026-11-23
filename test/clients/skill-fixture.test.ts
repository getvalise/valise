import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, it } from "vitest";

it.each(["legacy", "modern"])(
  "decodes skill fixture loads with the %s MCP client",
  async (protocol) => {
    const client = new Client(
      { name: "valise-fixture-check", version: "1.0.0" },
      {
        versionNegotiation: {
          mode: protocol === "modern" ? { pin: "2026-07-28" } : "legacy",
        },
      },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("evals/skills/fixture.mjs"), "all", "", "", protocol],
    });
    try {
      await client.connect(transport);
      const name = "valise-probe-cerulean";
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        [`skill_${name}`],
      );
      expect(
        (await client.listPrompts()).prompts.map((prompt) => prompt.name),
      ).toEqual([name]);
      const resource = await client.readResource({
        uri: `skill://${name}/SKILL.md`,
      });
      const tool = await client.callTool({
        name: `skill_${name}`,
        arguments: {},
      });
      const prompt = await client.getPrompt({ name });
      const content = resource.contents[0];
      if (!("text" in content)) throw new Error("Expected SKILL.md text");
      expect(tool.content).toEqual([{ type: "text", text: content.text }]);
      expect(prompt.messages).toEqual([
        {
          role: "user",
          content: { type: "text", text: content.text },
        },
      ]);
      if (protocol === "legacy") await client.ping();
    } finally {
      await client.close();
    }
  },
  20_000,
);
