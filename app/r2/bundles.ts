/**
 * One bundled file. Text is a string; anything that is not UTF-8, such as an
 * image or a PDF, is its bytes. Digests and sizes are over the bytes either
 * way, so a text file hashes the same as it always has.
 */
export type BundleFile = {
  path: string;
  content: string | Uint8Array;
};

export type BundleManifestEntry = {
  path: string;
  r2Key: string;
  sha256: string;
  size: number;
};

export async function writeBundle(
  bucket: R2Bucket,
  input: {
    userId: string;
    skillId: string;
    version: number;
    files: BundleFile[];
  },
): Promise<BundleManifestEntry[]> {
  const seen = new Set<string>();
  const manifest: BundleManifestEntry[] = [];
  for (const file of input.files) {
    const path = safePath(file.path);
    if (seen.has(path))
      throw new Error(`files contains ${path} more than once`);
    seen.add(path);

    const sha256 = await sha256Hex(file.content);
    const r2Key = `u/${input.userId}/skills/${input.skillId}/${input.version}/${path}`;
    const size = bytesOf(file.content).byteLength;
    const existing = await bucket.head(r2Key);
    if (existing !== null) {
      if (existing.customMetadata?.sha256 !== sha256) {
        throw new Error(
          `bundle path already exists with different content: ${path}`,
        );
      }
    } else {
      const written = await bucket.put(r2Key, file.content, {
        httpMetadata: { contentType: "application/octet-stream" },
        customMetadata: { sha256, size: String(size) },
        onlyIf: { etagDoesNotMatch: "*" },
      });
      if (written === null) {
        const raced = await bucket.head(r2Key);
        if (raced?.customMetadata?.sha256 !== sha256) {
          throw new Error(
            `bundle path already exists with different content: ${path}`,
          );
        }
      }
    }
    manifest.push({ path, r2Key, sha256, size });
  }
  return manifest;
}

function safePath(path: string): string {
  const cleaned = path.trim().replaceAll("\\", "/");
  if (
    !cleaned ||
    cleaned.startsWith("/") ||
    cleaned.includes("//") ||
    cleaned.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error(`invalid bundle path: ${path}`);
  }
  return cleaned;
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytesOf(input));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function bytesOf(content: string | Uint8Array): Uint8Array {
  return typeof content === "string"
    ? new TextEncoder().encode(content)
    : content;
}
