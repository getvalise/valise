import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { AssetThumbnail } from "../../app/components/asset-thumbnail";

export { epubCover, epubPath } from "../../app/lib/document-preview/epub";
export {
  previewDimensions,
  rasterInfo,
} from "../../app/lib/document-preview/image";
export {
  abortable,
  PREVIEW_LIMITS,
  previewBytes,
  previewSlot,
} from "../../app/lib/document-preview/limits";

let root;
export function mount(files, offscreen = false) {
  root?.unmount();
  const host = document.createElement("div");
  host.id = "thumbnail-test";
  if (offscreen) host.style.marginTop = "3000px";
  document.body.replaceChildren(host);
  root = createRoot(host);
  root.render(
    createElement(
      "div",
      null,
      files.map((file) =>
        createElement(AssetThumbnail, { ...file, key: file.objectId }),
      ),
    ),
  );
}
export function unmount() {
  root?.unmount();
}

export function raster() {
  const canvas = document.createElement("canvas");
  canvas.width = 20;
  canvas.height = 10;
  const context = canvas.getContext("2d");
  context.fillStyle = "#123456";
  context.fillRect(0, 0, 20, 10);
  return canvas.toDataURL().split(",")[1];
}

export function trackUrls() {
  const create = URL.createObjectURL.bind(URL);
  const revoke = URL.revokeObjectURL.bind(URL);
  const urls = { created: [], revoked: [] };
  URL.createObjectURL = (blob) => {
    const url = create(blob);
    urls.created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url) => {
    urls.revoked.push(url);
    revoke(url);
  };
  return urls;
}

export async function streamedLimit() {
  const original = globalThis.fetch;
  let cancelled = false;
  let read = 0;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          read++;
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  try {
    const { previewBytes } = await import(
      "../../app/lib/document-preview/limits"
    );
    await previewBytes("/files/stream", new AbortController().signal);
    return { rejected: false };
  } catch {
    return { rejected: true, cancelled, read };
  } finally {
    globalThis.fetch = original;
  }
}
