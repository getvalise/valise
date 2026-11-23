/** Ephemeral browser previews; none of these limits affect original downloads. */
export const PREVIEW_LIMITS = {
  downloadBytes: 25 * 1024 * 1024,
  imageBytes: 8 * 1024 * 1024,
  imagePixels: 16_000_000,
  canvasPixels: 512 * 512,
  edge: 512,
  pdfPages: 5_000,
  zipEntries: 2_000,
  zipBytes: 64 * 1024 * 1024,
  xmlBytes: 512 * 1024,
  coverBytes: 4 * 1024 * 1024,
  concurrency: 2,
  timeoutMs: 15_000,
} as const;

export function checkAbort(signal: AbortSignal) {
  signal.throwIfAborted();
}

/** A terminated PDF worker may never reply; cancellation must still free its slot. */
export function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Read the stream, not arrayBuffer(): Content-Length is optional and untrusted. */
export async function previewBytes(url: string, signal: AbortSignal) {
  const response = await fetch(url, {
    signal,
    redirect: "error",
  });
  if (!response.ok || !response.body) throw new Error("Preview unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (
      Number(response.headers.get("content-length")) >
      PREVIEW_LIMITS.downloadBytes
    )
      throw new Error("Preview download limit");
    while (true) {
      checkAbort(signal);
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > PREVIEW_LIMITS.downloadBytes)
        throw new Error("Preview download limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

let active = 0;
const waiting: (() => void)[] = [];

/** Queued cards do not start downloads or parsers, and unmount removes waiters. */
export async function previewSlot<T>(
  signal: AbortSignal,
  work: () => Promise<T>,
) {
  checkAbort(signal);
  await new Promise<void>((resolve, reject) => {
    const enter = () => {
      signal.removeEventListener("abort", abort);
      active++;
      resolve();
    };
    const abort = () => {
      const index = waiting.indexOf(enter);
      if (index >= 0) waiting.splice(index, 1);
      reject(signal.reason);
    };
    if (active < PREVIEW_LIMITS.concurrency) enter();
    else {
      waiting.push(enter);
      signal.addEventListener("abort", abort, { once: true });
    }
  });
  try {
    checkAbort(signal);
    return await work();
  } finally {
    active--;
    waiting.shift()?.();
  }
}
