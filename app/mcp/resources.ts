import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { StoredSkill } from "~/concepts/skills";
import type { SkillStore } from "~/store/skills.server";

/**
 * The SEP-2640 Skills extension, served over the resource primitive the spec
 * names: `skill://{name}/SKILL.md` for the instructions, a sibling URI per
 * bundled file, and `skill://index.json` for discovery. The installed SDK has
 * no skills vocabulary, so `skills/list` and `skills/get` ride the low-level
 * request handler while the files themselves go out through `resources/read`.
 */
export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";

/** The tenant's skills, as the bound store reads them. */
type SkillReader = Pick<SkillStore, "list" | "get">;

type SkillManifestEntry = {
  uri: string;
  digest: string;
  size: number;
};

type SkillEntry = {
  uri: string;
  frontmatter: Record<string, string>;
  resources: SkillManifestEntry[];
};

export const INDEX_URI = "skill://index.json";

/**
 * SEP-2640 requires `resultType`, `ttlMs`, and `cacheScope` on every skills
 * result. The SDK fills them only for methods it knows, which does not yet
 * include these two.
 */
const CACHE_FIELDS = {
  resultType: "complete",
  ttlMs: 300_000,
  cacheScope: "private",
} as const;

export function skillUri(name: string, path = "SKILL.md"): string {
  return `skill://${encodeURIComponent(name)}/${path}`;
}

/** `skill://capture-this/references/a.md` → `{ name, path }`. */
export function parseSkillUri(
  uri: string,
): { name: string; path: string } | null {
  const match = /^skill:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (match === null) return null;
  const path = match[2];
  if (path.includes("..")) return null;
  return { name: decodeURIComponent(match[1]), path };
}

export function skillEntry(skill: StoredSkill): SkillEntry {
  return {
    uri: skillUri(skill.name),
    frontmatter: skill.frontmatter,
    resources: [
      {
        uri: skillUri(skill.name),
        digest: `sha256:${skill.sha256}`,
        size: skill.size,
      },
      ...skill.files.map((file) => ({
        uri: skillUri(skill.name, file.path),
        digest: `sha256:${file.sha256}`,
        size: file.size,
      })),
    ],
  };
}

export function registerSkillResources(
  server: McpServer,
  bundles: R2Bucket,
  skillStore: SkillReader,
) {
  server.server.registerCapabilities({
    extensions: { [SKILLS_EXTENSION]: {} },
  });

  server.registerResource(
    "skills-index",
    INDEX_URI,
    {
      mimeType: "application/json",
      title: "Valise skills index",
      description:
        "Every skill Valise serves, with the URI of its SKILL.md and its frontmatter.",
    },
    async (uri) => {
      const skills = await skillStore.list();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({
              skills: skills.map((skill) => ({
                uri: skillUri(skill.name),
                name: skill.name,
                description: skill.description,
                version: skill.version,
              })),
            }),
          },
        ],
      };
    },
  );

  server.registerResource(
    "skill-file",
    new ResourceTemplate("skill://{name}/{+path}", {
      list: async () => {
        const skills = await skillStore.list();
        return {
          resources: skills.map((skill) => ({
            uri: skillUri(skill.name),
            name: skill.name,
            description: skill.description,
            mimeType: "text/markdown",
          })),
        };
      },
      complete: {
        name: async (value) =>
          (await skillStore.list())
            .map((skill) => skill.name)
            .filter((name) => name.startsWith(value)),
      },
    }),
    { mimeType: "text/markdown", title: "Valise skill file" },
    async (uri) => {
      const content = await readSkillFile(bundles, skillStore, uri.href);
      if (content === null) throw new Error(`unknown skill file: ${uri.href}`);
      return { contents: [{ ...content, uri: uri.href }] };
    },
  );

  server.server.setRequestHandler(
    "skills/list",
    { params: z.object({ cursor: z.string().optional() }).loose() },
    async () => {
      const names = (await skillStore.list()).map((skill) => skill.name);
      const skills = await Promise.all(
        names.map((name) => skillStore.get(name)),
      );
      return {
        ...CACHE_FIELDS,
        skills: skills.filter((skill) => skill !== null).map(skillEntry),
      };
    },
  );

  server.server.setRequestHandler(
    "skills/get",
    { params: z.object({ uri: z.string() }).loose() },
    async (params) => {
      const parsed = parseSkillUri(params.uri);
      const skill =
        parsed === null || parsed.path !== "SKILL.md"
          ? null
          : await skillStore.get(parsed.name);
      if (skill === null) invalidParams(`unknown skill: ${params.uri}`);
      return { ...CACHE_FIELDS, skill: skillEntry(skill) };
    },
  );
}

/**
 * Reads one file of a skill bundle by its `skill://` URI. `SKILL.md` comes
 * from the head version row; every other path comes from the R2 key recorded
 * in that version's manifest, so a URI can never reach an object the published
 * manifest does not name.
 */
export async function readSkillFile(
  bundles: R2Bucket,
  skills: Pick<SkillReader, "get">,
  uri: string,
): Promise<
  { mimeType: string; text: string } | { mimeType: string; blob: string } | null
> {
  const parsed = parseSkillUri(uri);
  if (parsed === null) return null;
  const skill = await skills.get(parsed.name);
  if (skill === null) return null;
  if (parsed.path === "SKILL.md") {
    return { mimeType: "text/markdown", text: skill.body };
  }
  const file = skill.files.find((entry) => entry.path === parsed.path);
  if (file === undefined) return null;
  const object = await bundles.get(file.r2Key);
  if (object === null) return null;
  // Text when the bytes are UTF-8, whatever the extension claims; base64
  // otherwise, which is how MCP carries a resource that is not text.
  const bytes = new Uint8Array(await object.arrayBuffer());
  const mimeType = mimeTypeFor(parsed.path);
  try {
    return { mimeType, text: UTF8.decode(bytes) };
  } catch {
    return {
      mimeType: mimeType.startsWith("text/")
        ? "application/octet-stream"
        : mimeType,
      blob: base64(bytes),
    };
  }
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

function base64(bytes: Uint8Array): string {
  let binary = "";
  // In slices, so a 2MB file does not overflow the argument list.
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

/** SEP-2640 answers an unknown skill or file with `-32602`. */
function invalidParams(message: string): never {
  throw Object.assign(new Error(message), { code: -32602 });
}

function mimeTypeFor(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (extension) {
    case "md":
      return "text/markdown";
    case "json":
      return "application/json";
    case "py":
      return "text/x-python";
    case "sh":
      return "application/x-sh";
    case "ts":
    case "js":
      return "text/javascript";
    case "csv":
      return "text/csv";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "pdf":
      return "application/pdf";
    default:
      return "text/plain";
  }
}
