import {
  type Asset,
  type AssetEnv,
  AssetRefused,
  type BeginAssetUpload,
  MAX_ASSET_BYTES,
} from "~/concepts/assets";
import { storeAssetBytes } from "~/concepts/library";
import type { Provenance } from "~/concepts/memories";
import {
  type Fetcher,
  fetchableUrl,
  fetchFollowing,
  readBytesCapped,
} from "~/concepts/source-fetch";

/**
 * A file the MCP client attached to a tool call, which Valise downloads
 * itself. ChatGPT declares such arguments through the tool's
 * `_meta["openai/fileParams"]` and fills each with a temporary download URL
 * and a file id (https://developers.openai.com/apps-sdk/reference, "Define
 * file inputs"). The bytes then never pass through a sandbox that may not
 * reach Valise's upload URL. ADR-0015, amendment of 2026-11-25.
 *
 * The URL is a short-lived capability to someone else's copy, so nothing
 * here keeps it: it is read once, and only the stored bytes, their name and
 * their type survive the call.
 */
export type AttachedFile = {
  download_url: string;
  file_id: string;
  mime_type?: string | null;
  file_name?: string | null;
};

/** Long enough for 25 MiB over a slow origin, short of a client's tool timeout. */
const ATTACHED_TIMEOUT_MS = 30_000;

export type FetchedAttachment =
  | { ok: true; bytes: Uint8Array; contentType: string | null }
  | { ok: false; reason: string };

/**
 * GET the attachment with no credentials, following at most three
 * redirects, each to a public https host name, and reading at most
 * `MAX_ASSET_BYTES`. Every failure names what the person can do next,
 * which is almost always to attach the file again.
 */
export async function fetchAttachedFile(
  file: AttachedFile,
  fetcher: Fetcher = fetch,
): Promise<FetchedAttachment> {
  const url = fetchableUrl(file.download_url);
  if (url === null || url.protocol !== "https:")
    return {
      ok: false,
      reason:
        "The attached file's download_url is not a public https URL. Attach the file in the chat instead of naming a link.",
    };
  const response = await fetchFollowing(
    url,
    "*/*",
    fetcher,
    ATTACHED_TIMEOUT_MS,
  );
  if (response === null)
    return {
      ok: false,
      reason:
        "Valise could not download the attached file: the link timed out, failed, or redirected somewhere private. Attach the file again and retry.",
    };
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const expired = [401, 403, 404, 410].includes(response.status);
    return {
      ok: false,
      reason: expired
        ? `The attached file's download link was refused (HTTP ${response.status}), most likely because it expired. Attach the file again and retry.`
        : `Downloading the attached file failed with HTTP ${response.status}. Retry, or attach the file again.`,
    };
  }
  const length = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(length) && length > MAX_ASSET_BYTES) {
    await response.body?.cancel().catch(() => {});
    return tooLarge();
  }
  const { bytes, over } = await readBytesCapped(response, MAX_ASSET_BYTES);
  if (over) return tooLarge();
  if (bytes.byteLength === 0)
    return { ok: false, reason: "The attached file is empty." };
  const header = response.headers.get("content-type");
  return {
    ok: true,
    bytes,
    contentType: header ? header.split(";")[0].trim() : null,
  };
}

/**
 * Downloads the attachment and stores it as a ready asset. A download that
 * fails writes nothing, so the same call can simply be sent again. The
 * client's own name and type win over the download response's.
 */
export async function storeAttachedFile(
  env: AssetEnv,
  file: AttachedFile,
  details: Omit<BeginAssetUpload, "size" | "fileName" | "contentType"> & {
    fileName?: string;
    contentType?: string;
  },
  provenance: Provenance,
  fetcher: Fetcher = fetch,
): Promise<Asset> {
  const fetched = await fetchAttachedFile(file, fetcher);
  if (!fetched.ok) throw new AssetRefused(fetched.reason);
  const { fileName, contentType, ...rest } = details;
  return storeAssetBytes(
    env,
    {
      ...rest,
      fileName: fileName ?? file.file_name ?? nameFromUrl(file.download_url),
      contentType:
        contentType ?? file.mime_type ?? fetched.contentType ?? undefined,
    },
    fetched.bytes.buffer.slice(
      fetched.bytes.byteOffset,
      fetched.bytes.byteOffset + fetched.bytes.byteLength,
    ) as ArrayBuffer,
    provenance,
  );
}

function tooLarge(): FetchedAttachment {
  return {
    ok: false,
    reason: `The attached file is larger than Valise keeps; the limit is ${MAX_ASSET_BYTES} bytes.`,
  };
}

/** The URL path's last segment when it looks like a file name, else "attachment". */
function nameFromUrl(raw: string): string {
  try {
    const last = decodeURIComponent(
      new URL(raw).pathname.split("/").pop() ?? "",
    );
    return /\.[A-Za-z0-9]{1,8}$/.test(last) ? last : "attachment";
  } catch {
    return "attachment";
  }
}
