import { canvasBlob, previewDimensions } from "./image";
import { abortable, checkAbort, PREVIEW_LIMITS } from "./limits";

/** No viewer, scripting manager, annotations or document URLs: page-one canvas only. */
export async function pdfThumbnail(bytes: Uint8Array, signal: AbortSignal) {
  const [pdf, { default: workerUrl }] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  checkAbort(signal);
  const password = new AbortController();
  signal = AbortSignal.any([signal, password.signal]);
  const workerPort = new Worker(workerUrl, { type: "module" });
  const worker = pdf.PDFWorker.create({ port: workerPort });
  const task = pdf.getDocument({
    data: bytes,
    worker,
    enableXfa: false,
    useWasm: false,
    useWorkerFetch: false,
    disableFontFace: true,
    useSystemFonts: true,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    maxImageSize: PREVIEW_LIMITS.imagePixels,
    canvasMaxAreaInBytes: PREVIEW_LIMITS.canvasPixels * 4,
    stopAtErrors: true,
    verbosity: 0,
  });
  const canvas = document.createElement("canvas");
  const cancel = () => {
    void task.destroy().catch(() => {});
    workerPort.terminate();
  };
  signal.addEventListener("abort", cancel, { once: true });
  // Password-protected documents fail instead of leaving a worker waiting for UI.
  task.onPassword = () => password.abort(new Error("Password-protected PDF"));
  try {
    const doc = await abortable(task.promise, signal);
    checkAbort(signal);
    if (doc.numPages > PREVIEW_LIMITS.pdfPages)
      throw new Error("PDF preview page limit");
    const page = await abortable(doc.getPage(1), signal);
    const natural = page.getViewport({ scale: 1 });
    const size = previewDimensions(natural.width, natural.height);
    const viewport = page.getViewport({ scale: size.scale });
    canvas.width = size.width;
    canvas.height = size.height;
    const render = page.render({
      canvas,
      viewport,
      annotationMode: pdf.AnnotationMode.DISABLE,
    });
    const cancelRender = () => render.cancel();
    signal.addEventListener("abort", cancelRender, { once: true });
    try {
      await abortable(render.promise, signal);
      checkAbort(signal);
      return await canvasBlob(canvas);
    } finally {
      signal.removeEventListener("abort", cancelRender);
      page.cleanup();
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    void task.destroy().catch(() => {});
    worker.destroy();
    workerPort.terminate();
    canvas.width = canvas.height = 0;
  }
}
