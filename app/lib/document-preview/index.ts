import { rasterThumbnail } from "./image";
import { checkAbort, previewBytes, previewSlot } from "./limits";

export function thumbnailKind(
  mime: string,
  filename: string,
): "image" | "pdf" | "epub" | null {
  if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime))
    return "image";
  if (mime === "application/pdf") return "pdf";
  if (
    mime === "application/epub+zip" ||
    (mime === "application/octet-stream" && /\.epub$/i.test(filename))
  )
    return "epub";
  return null;
}

export function assetThumbnail(
  objectId: string,
  kind: "image" | "pdf" | "epub",
  signal: AbortSignal,
) {
  return previewSlot(signal, async () => {
    const bytes = await previewBytes(
      `/files/${encodeURIComponent(objectId)}`,
      signal,
    );
    checkAbort(signal);
    if (kind === "pdf") {
      const { pdfThumbnail } = await import("./pdf");
      return pdfThumbnail(bytes, signal);
    }
    if (kind === "epub") {
      const { epubCover } = await import("./epub");
      return rasterThumbnail(await epubCover(bytes, signal), signal);
    }
    return rasterThumbnail(bytes, signal);
  });
}
