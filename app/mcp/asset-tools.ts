import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import {
  ASSET_COVERAGE,
  type Asset,
  AssetRefused,
  assetIdOf,
  assetRef,
  MAX_ASSET_BYTES,
} from "~/concepts/assets";
import { resourceContents } from "~/mcp/attachment-resources";
import {
  getAssetDownloadInput,
  getAssetDownloadOutput,
  updateAssetInput,
  updateAssetOutput,
  uploadAssetInput,
  uploadAssetOutput,
} from "~/mcp/contracts";
import { textResult, toolError } from "~/mcp/results";
import { MAX_OBJECT_BYTES } from "~/r2/objects";
import type { LibraryStore } from "~/store/library.server";

/**
 * The three asset tools and the asset resource, ADR-0015. Bytes never travel
 * through a tool result: an upload goes to an HTTP URL, a download comes from
 * one, and only a client that asks reads them as an MCP resource.
 */
export function registerAssetTools(
  server: McpServer,
  library: LibraryStore,
  origin: string | undefined,
) {
  server.registerTool(
    "upload_asset",
    {
      title: "Upload a file to Valise",
      description:
        "Store a file, such as a screenshot or PDF, so another session or machine can fetch it later by id. When the user attached the file in this chat and your client passes attachments as file, send it as file: Valise downloads and stores it, and the call returns it ready. Otherwise give file_name and size: the result has the asset id and a short-lived HTTP PUT URL, and running the returned command sends the bytes and stores the file. Never put file contents in a tool argument. Pass folder with a stored asset's id to keep the new file in that asset's folder, such as a page's stylesheet beside the page.",
      inputSchema: uploadAssetInput,
      outputSchema: uploadAssetOutput,
      // ChatGPT fills `file` with a download URL for a file the user
      // attached; other clients ignore the key. ADR-0015, 2026-11-25.
      _meta: { "openai/fileParams": ["file"] },
    },
    async (input) => {
      try {
        const folderId =
          input.folder === undefined
            ? undefined
            : await library.joinableFolder(assetIdOf(input.folder) ?? "");
        const details = {
          sha256: input.sha256,
          title: input.title,
          description: input.description,
          project: input.project,
          tags: input.tags,
          expiresInSeconds: input.expires_in_seconds,
          folderId,
        };
        if (input.file) {
          const asset = await library.storeAttached(input.file, {
            ...details,
            fileName: input.file_name,
            contentType: input.content_type,
          });
          return withCoverage(
            textResult({
              id: assetRef(asset.assetId),
              ...(folderId ? { folder: assetRef(folderId) } : {}),
              state: "ready" as const,
              file_name: asset.fileName,
              content_type: asset.contentType,
              size: asset.size ?? asset.declaredSize,
              sha256: asset.sha256 ?? undefined,
              max_bytes: MAX_ASSET_BYTES,
              next: "The file is stored. Keep the asset id; the chat's attachment link is not kept.",
            }),
          );
        }
        if (input.file_name === undefined || input.size === undefined)
          return toolError(
            "Give file_name and size for a PUT upload, or pass the attached file as file.",
          );
        if (!origin) return toolError("This server has no upload origin.");
        const { asset, token } = await library.beginUpload({
          fileName: input.file_name,
          contentType: input.content_type,
          size: input.size,
          ...details,
        });
        const url = new URL(`/uploads/${asset.assetId}`, origin);
        url.searchParams.set("token", token);
        const headers = { "content-type": asset.contentType };
        return withCoverage(
          textResult({
            id: assetRef(asset.assetId),
            ...(folderId ? { folder: assetRef(folderId) } : {}),
            state: "pending" as const,
            upload: {
              method: "PUT" as const,
              url: url.href,
              headers,
              expires_at: asset.uploadExpiresAt ?? 0,
              command: `curl --fail-with-body -X PUT -H 'content-type: ${asset.contentType}' --data-binary @${shellWord(asset.fileName)} '${url.href}'`,
            },
            max_bytes: MAX_ASSET_BYTES,
            next: "Run the command. A 200 answer means the file is stored and ready under this id; an error answer says what to fix. The URL is a credential for this one file; do not save it.",
          }),
        );
      } catch (error) {
        if (error instanceof AssetRefused) return toolError(error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    "update_asset",
    {
      title: "Update a Valise file's details",
      description:
        "Change a stored file's title, description, project, tags, or expiry, or group it: folder moves it into another file's folder and folder_name renames its folder. Send only the fields you are changing. The file's bytes never change; a new version is a new upload. fetch lists a file's folder and the files in it.",
      inputSchema: updateAssetInput,
      outputSchema: updateAssetOutput,
    },
    async ({ id, folder, folder_name, ...patch }) => {
      const assetId = assetIdOf(id);
      if (assetId === null) return toolError(`${id} is not an asset id.`);
      try {
        // Every refusal is found before the first write, so a refused call
        // changes nothing and the same call can simply be sent again.
        const current = await library.asset(assetId);
        if (current === null || current.state !== "ready")
          return toolError(`No ready asset exists for ${id}.`);
        let destination: string | null = null;
        if (folder !== undefined) {
          const targetId = assetIdOf(folder) ?? "";
          const target = await library.asset(targetId);
          const into = target ? await library.folderOf(targetId) : null;
          if (target === null || target.state !== "ready" || into === null)
            return toolError(
              `No ready asset exists for ${folder}. Nothing was changed.`,
            );
          const here = await library.folderOf(assetId);
          if (here?.folderId !== into.folderId) {
            if (((await library.folderFill(into.folderId)) ?? 100) >= 100)
              return toolError(
                "That folder already holds 100 files. Nothing was changed.",
              );
            destination = into.folderId;
          }
        }
        const metadata =
          patch.title !== undefined ||
          patch.description !== undefined ||
          patch.project !== undefined ||
          patch.tags !== undefined ||
          patch.expires_in_seconds !== undefined;
        const asset = metadata
          ? await library.update(assetId, {
              title: patch.title,
              description: patch.description,
              project: patch.project,
              tags: patch.tags,
              expiresInSeconds: patch.expires_in_seconds,
            })
          : current;
        if (asset === null)
          return toolError(`No ready asset exists for ${id}.`);
        if (destination) await library.moveToFolder(assetId, destination);
        if (folder_name !== undefined) {
          const own = await library.folderOf(assetId);
          if (own) await library.renameFolder(own.folderId, folder_name);
        }
        return textResult({
          ...assetOutput(asset),
          folder: await folderSummary(library, assetId),
        });
      } catch (error) {
        if (error instanceof AssetRefused) return toolError(error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    "get_asset_download",
    {
      title: "Get a Valise file download URL",
      description:
        "Get a short-lived URL that downloads a stored file's original bytes, for an asset id from search, fetch, or a note. Download it right away with any HTTP client; keep the asset id, not the URL.",
      inputSchema: getAssetDownloadInput,
      outputSchema: getAssetDownloadOutput,
    },
    async ({ id }) => {
      const assetId = assetIdOf(id);
      if (assetId === null) return toolError(`${id} is not an asset id.`);
      if (!origin) return toolError("This server has no download origin.");
      const asset = await library.asset(assetId);
      if (asset === null || asset.size === null || asset.sha256 === null)
        return toolError(`No ready asset exists for ${id}.`);
      const download = await library.issueDownload(asset, origin);
      if (download === null)
        return toolError(`No ready asset exists for ${id}.`);
      return textResult({
        id: assetRef(asset.assetId),
        url: download.url,
        expires_at: download.expiresAt,
        file_name: asset.fileName,
        content_type: asset.contentType,
        size: asset.size,
        sha256: asset.sha256,
      });
    },
  );

  server.registerResource(
    "asset-file",
    new ResourceTemplate("valise://asset/{assetId}", { list: undefined }),
    {
      title: "Valise stored file",
      description: "The original bytes of a ready asset, by its id.",
    },
    async (uri) => {
      const content = await readAssetResource(library, uri.href);
      if (content === null)
        throw Object.assign(new Error("Asset not found."), { code: -32602 });
      if ("error" in content)
        throw Object.assign(new Error(content.error), { code: -32602 });
      return { contents: [{ uri: uri.href, ...content }] };
    },
  );
}

export function assetUri(assetId: string): string {
  return `valise://asset/${assetId}`;
}

/** `valise://asset/ast_…` → `ast_…`, canonicalized the way scope checks see it. */
export function parseAssetUri(uri: string): string | null {
  let canonical: string;
  try {
    canonical = new URL(uri).href;
  } catch {
    return null;
  }
  const match = /^valise:\/\/asset\/(ast_[0-9a-f-]{36})$/.exec(canonical);
  return match ? match[1] : null;
}

/**
 * Owner and state checks precede R2. Over the 10 MiB resource cap the read
 * refuses and names the download tool, since base64 in a JSON-RPC result is
 * the wrong carrier for a large file.
 */
export async function readAssetResource(
  library: Pick<LibraryStore, "asset" | "readObject">,
  uri: string,
): Promise<
  | { mimeType: string; text: string }
  | { mimeType: string; blob: string }
  | { error: string }
  | null
> {
  const assetId = parseAssetUri(uri);
  if (assetId === null) return null;
  const asset = await library.asset(assetId);
  if (asset === null) return null;
  if ((asset.size ?? 0) > MAX_OBJECT_BYTES) {
    return {
      error: `${assetRef(assetId)} is larger than a resource read carries; use get_asset_download.`,
    };
  }
  const stored = await library.readObject(asset);
  if (stored === null) return null;
  return resourceContents(
    new Uint8Array(await stored.object.arrayBuffer()),
    stored.metadata.contentType,
  );
}

export function assetOutput(asset: Asset) {
  return {
    id: assetRef(asset.assetId),
    state: asset.state,
    title: asset.title,
    description: asset.description,
    file_name: asset.fileName,
    content_type: asset.contentType,
    size: asset.size,
    sha256: asset.sha256,
    project: asset.project,
    tags: asset.tags,
    expires_at: asset.expiresAt,
    created_at: asset.createdAt,
    updated_at: asset.updatedAt,
    finalized_at: asset.finalizedAt,
    content_indexed: false as const,
  };
}

/**
 * What `fetch` returns for an asset: metadata and how to reach the bytes,
 * never binary bytes, with bounded derived text and provenance when processed.
 */
/**
 * The folder a file is in and the files it holds, up to its 100, so an agent
 * sees the group without knowing folder ids: a folder is addressed by any
 * file in it. ADR-0015, amendment of 2026-11-02 (folders over MCP).
 */
export async function folderSummary(
  library: Pick<LibraryStore, "folderOf" | "folderFiles">,
  assetId: string,
) {
  const folder = await library.folderOf(assetId);
  if (folder === null) return null;
  const files = await library.folderFiles(folder.folderId);
  return {
    name: folder.title,
    tags: folder.tags,
    notes: folder.notes,
    count: files.length,
    files: files.map((file) => ({
      id: assetRef(file.assetId),
      title: file.title,
      file_name: file.fileName,
    })),
  };
}

export async function fetchAsset(
  library: Pick<
    LibraryStore,
    "asset" | "extraction" | "folderOf" | "folderFiles"
  >,
  id: string,
) {
  const assetId = assetIdOf(id);
  if (assetId === null) return null;
  const asset = await library.asset(assetId);
  if (asset === null) return null;
  const extracted = await library.extraction(assetId);
  const { id: _id, title, description, ...metadata } = assetOutput(asset);
  return {
    id: assetRef(asset.assetId),
    title,
    text: extracted
      ? `${description}\n\nDerived content (${extracted.extractor}; not authoritative metadata):\n${extracted.text}`
      : description,
    metadata: {
      ...metadata,
      uri: assetUri(asset.assetId),
      archived: asset.archivedAt !== null,
      source_agent: asset.sourceAgent,
      source_client: asset.sourceClient,
      source_session: asset.sourceSession,
      coverage: ASSET_COVERAGE,
      folder: await folderSummary(library, asset.assetId),
      extracted_content_indexed: extracted !== null,
      extraction: extracted
        ? {
            processing_id: extracted.processing_id,
            processor_version: extracted.processor_version,
            extractor: extracted.extractor,
            original_sha256: extracted.original_sha256,
            truncated: Boolean(extracted.truncated),
            max_text_bytes: 65536,
          }
        : null,
      bytes:
        "Call get_asset_download for a short-lived URL, or read uri as an MCP resource.",
    },
  };
}

/** Appends the coverage statement as its own text block. */
function withCoverage<T extends { content: { type: "text"; text: string }[] }>(
  result: T,
): T {
  return {
    ...result,
    content: [
      ...result.content,
      { type: "text" as const, text: ASSET_COVERAGE },
    ],
  };
}

/** A file name inside a shell command, quoted unless it is plainly safe. */
function shellWord(name: string): string {
  return /^[\w.@%+=:,/-]+$/.test(name)
    ? name
    : `'${name.replaceAll("'", "'\\''")}'`;
}
