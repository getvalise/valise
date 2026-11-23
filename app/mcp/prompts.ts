import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { skillUri } from "~/mcp/resources";
import type { SkillStore } from "~/store/skills.server";

/** User-invoked skills, read from the same live head as tools and resources. */
export function registerSkillPrompts(
  server: McpServer,
  skills: Pick<SkillStore, "list" | "get">,
) {
  server.server.registerCapabilities({ prompts: {} });
  // Resolve the catalog on each request, including when it is empty. A
  // previously listed command cannot keep serving a disabled skill.
  server.server.setRequestHandler(
    "prompts/list",
    { params: z.object({ cursor: z.string().optional() }).loose().optional() },
    async () => ({
      prompts: (await skills.list()).map(({ name, description }) => ({
        name,
        description,
      })),
    }),
  );
  server.server.setRequestHandler(
    "prompts/get",
    {
      params: z
        .object({
          name: z.string(),
          arguments: z.record(z.string(), z.string()).optional(),
        })
        .loose(),
    },
    async ({ name }) => {
      const skill = await skills.get(name);
      if (skill === null) {
        throw Object.assign(new Error(`No active skill exists for ${name}.`), {
          code: -32602,
        });
      }
      return {
        description: skill.description,
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: skill.body },
          },
          ...(skill.files.length
            ? [
                {
                  role: "user" as const,
                  content: {
                    type: "text" as const,
                    text: `Supporting files for this skill are available as MCP resources. For text files, you can also call read_skill_file with name=${JSON.stringify(skill.name)} and the listed path. Read only those needed:\n${skill.files.map((file) => `${file.path}: ${skillUri(skill.name, file.path)}`).join("\n")}`,
                  },
                },
              ]
            : []),
        ],
      };
    },
  );
}
