import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import type { Attachment, AttachmentTarget } from "~/concepts/attachments";
import { MAX_OBJECT_BYTES } from "~/r2/objects";
import type { TenantStore } from "~/store/tenant.server";

type FileReader = Pick<TenantStore["files"], "attached">;

export function attachmentUri(
  target: AttachmentTarget,
  objectId: string,
): string {
  return `valise://${target.concept}/${target.id}/files/${objectId}`;
}

export function parseAttachmentUri(
  uri: string,
): { target: AttachmentTarget; objectId: string } | null {
  let canonical: string;
  try {
    canonical = new URL(uri).href;
  } catch {
    return null;
  }
  const match =
    /^valise:\/\/(todo|memory)\/([a-zA-Z0-9_-]+)\/files\/(obj_[a-zA-Z0-9-]+)$/.exec(
      canonical,
    );
  if (match === null) return null;
  const concept = match[1];
  if (concept !== "todo" && concept !== "memory") return null;
  return { target: { concept, id: match[2] }, objectId: match[3] };
}

/** A parent's files as `fetch` metadata lists them, with their resource URIs. */
export function attachmentEntries(
  target: AttachmentTarget,
  files: readonly Attachment[],
) {
  return files.map((file) => ({
    id: file.objectId,
    name: file.name,
    type: file.contentType,
    size: file.size,
    uri: attachmentUri(target, file.objectId),
  }));
}

export function registerAttachmentResources(
  server: McpServer,
  files: FileReader,
) {
  server.registerResource(
    "attachment-file",
    new ResourceTemplate("valise://{concept}/{id}/files/{objectId}", {
      list: undefined,
    }),
    {
      title: "Valise attached file",
      description:
        "An owned file linked from a to-do or memory returned by fetch.",
    },
    async (uri) => {
      const content = await readAttachment(files, uri.href);
      if (content === null)
        throw Object.assign(new Error("Attached file not found."), {
          code: -32602,
        });
      return { contents: [{ uri: uri.href, ...content }] };
    },
  );
}

/** Link existence and owner checks precede R2; the URI never contains a key. */
export async function readAttachment(
  files: FileReader,
  uri: string,
): Promise<
  { mimeType: string; text: string } | { mimeType: string; blob: string } | null
> {
  const parsed = parseAttachmentUri(uri);
  if (parsed === null) return null;
  const stored = await files.attached(parsed.target, parsed.objectId);
  if (stored === null) return null;
  if (stored.object.size > MAX_OBJECT_BYTES) {
    await stored.object.body.cancel();
    return null;
  }
  return resourceContents(
    new Uint8Array(await stored.object.arrayBuffer()),
    stored.metadata.contentType,
  );
}

/**
 * UTF-8 text types as text, everything else, invalid UTF-8 included, as a
 * base64 blob: the standard MCP resource representation. Shared by
 * attachment and asset reads.
 */
export function resourceContents(
  bytes: Uint8Array,
  mimeType: string,
): { mimeType: string; text: string } | { mimeType: string; blob: string } {
  if (mimeType.startsWith("text/") || mimeType === "application/json") {
    try {
      return {
        mimeType,
        text: new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: false,
        }).decode(bytes),
      };
    } catch {
      // A declared text type does not make invalid UTF-8 into text.
    }
  }
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return { mimeType, blob: btoa(binary) };
}
