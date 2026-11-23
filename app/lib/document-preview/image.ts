import { checkAbort, PREVIEW_LIMITS } from "./limits";

/** Inspect raster headers before asking the browser to allocate decoded pixels. */
export function rasterInfo(bytes: Uint8Array): {
  mime: string;
  width: number;
  height: number;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 24 && ascii(0, 8) === "\x89PNG\r\n\x1a\n")
    return {
      mime: "image/png",
      width: view.getUint32(16),
      height: view.getUint32(20),
    };
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(ascii(0, 6)))
    return {
      mime: "image/gif",
      width: view.getUint16(6, true),
      height: view.getUint16(8, true),
    };
  if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    const kind = ascii(12, 16);
    if (kind === "VP8X")
      return {
        mime: "image/webp",
        width: 1 + (view.getUint32(24, true) & 0xffffff),
        height: 1 + (view.getUint32(26, true) >>> 8),
      };
    if (kind === "VP8 " && ascii(23, 26) === "\x9d\x01\x2a")
      return {
        mime: "image/webp",
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    if (kind === "VP8L" && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      return {
        mime: "image/webp",
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >>> 14) & 0x3fff),
      };
    }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker) &&
        length >= 7
      )
        return {
          mime: "image/jpeg",
          width: view.getUint16(offset + 5),
          height: view.getUint16(offset + 3),
        };
      offset += length;
    }
  }
  throw new Error("Unsupported raster image");
}

export function previewDimensions(width: number, height: number) {
  if (!Number.isFinite(width * height) || width <= 0 || height <= 0)
    throw new Error("Invalid preview dimensions");
  const scale = Math.min(
    1,
    PREVIEW_LIMITS.edge / width,
    PREVIEW_LIMITS.edge / height,
    Math.sqrt(PREVIEW_LIMITS.canvasPixels / (width * height)),
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    scale,
  };
}

export function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Preview encoding failed")),
      "image/png",
    ),
  );
}

export async function rasterThumbnail(bytes: Uint8Array, signal: AbortSignal) {
  checkAbort(signal);
  if (bytes.length > PREVIEW_LIMITS.imageBytes)
    throw new Error("Image preview byte limit");
  const info = rasterInfo(bytes);
  if (info.width * info.height > PREVIEW_LIMITS.imagePixels)
    throw new Error("Image preview pixel limit");
  const requested = previewDimensions(info.width, info.height);
  const bitmap = await createImageBitmap(
    new Blob([bytes.slice().buffer], { type: info.mime }),
    {
      resizeWidth: requested.width,
      resizeHeight: requested.height,
      resizeQuality: "low",
    },
  );
  const canvas = document.createElement("canvas");
  try {
    checkAbort(signal);
    const size = previewDimensions(bitmap.width, bitmap.height);
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await canvasBlob(canvas);
  } finally {
    bitmap.close();
    canvas.width = canvas.height = 0;
  }
}
