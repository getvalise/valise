import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MEMORY_TYPES } from "~/concepts/memory-types";
import { saveMemoryInput } from "~/mcp/contracts";
import { callMcp } from "./fixture-worker";

describe("memory capture guidance", () => {
  it("teaches human approval and insight defaults through the served schema", async () => {
    const { value } = await callMcp("tools/list", {});
    const tools = z
      .array(
        z.object({
          name: z.string(),
          inputSchema: z.object({
            properties: z.record(
              z.string(),
              z.object({ description: z.string().optional() }),
            ),
            required: z.array(z.string()).optional(),
          }),
        }),
      )
      .parse(value.result.tools);
    const memory = tools.find((tool) => tool.name === "save_memory");
    expect(memory).toBeDefined();
    const schema = memory?.inputSchema;
    expect(schema?.properties.type.description).toContain(
      "a person explicitly chose or approved",
    );
    expect(schema?.properties.type.description).toContain(
      "Default session learnings to insight",
    );
    expect(schema?.properties.type.description).toContain("who decided");
    expect(schema?.properties.body.description).toContain("rule first");
    expect(schema?.required).toEqual(["type", "title", "body", "tags"]);
  });

  it("keeps classification advisory and accepts existing and custom types", () => {
    for (const type of [...MEMORY_TYPES.map(([name]) => name), "experiment"]) {
      expect(
        saveMemoryInput.safeParse({
          type,
          title: "A captured claim",
          body: "Evidence belongs in prose, not a new required field.",
          tags: ["capture"],
        }).success,
        type,
      ).toBe(true);
    }
  });
});
