/**
 * The Workers AI model that writes summaries and key concepts for processed
 * files and bookmarks. The call, the stored model name, the estimate shown
 * before processing and the bookmark budget all read this one record.
 *
 * Chosen from the live catalog (`npx wrangler ai models list`) on the date in
 * `catalogReadOn`; `evals/summary-model/README.md` has the comparison. Re-read
 * the catalog before changing it rather than copying a model id from code.
 */
export const SUMMARY_MODEL = {
  /** Replaced `@cf/zai-org/glm-5.3-flash`, which Cloudflare retired on
   * 2026-11-20 (HTTP 410, error 5028). Owner's choice of 2026-11-23, from the
   * 2026-10-29 comparison in `evals/summary-model/README.md`. */
  id: "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
  catalogReadOn: "2026-11-23",
  /** List prices, USD per million tokens, which equals micro-dollars per token. */
  inputUsdPerMillion: 0.3,
  outputUsdPerMillion: 1.2,
  contextTokens: 1_048_576,
  /** The catalog lists this model as vision-capable. */
  vision: true,
  /** Reasoning is optional on this model; the eval ran it at "none". */
  options: { reasoning_effort: "none" },
} as const;

/** How much of a bookmark's article the model reads. Latency did not grow
 * with input size in the eval; cost does, linearly. */
export const SOURCE_PROMPT_BYTES = 32 * 1024;
/** Images a bookmark's summary looks at, in link order. */
export const SUMMARY_IMAGES = 2;
/** Largest stored image sent, in bytes. Larger ones are left out. */
export const SUMMARY_IMAGE_BYTES = 1024 * 1024;
/** Tokens charged per image when none is reported. Measured on GLM 5.3
 * Flash on 2026-11-01: a 256 px square took 121 prompt tokens, 1024 px 1,390
 * and 2048 px 5,062, so about 1,200 per megapixel; this covers 13
 * megapixels, more than a 1 MiB image reaches in practice. Not re-measured
 * on DeepSeek V4.1 Flash; it sizes the per-item ceiling, not the charge. */
export const SUMMARY_IMAGE_TOKENS = 16_384;
export const SUMMARY_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;
/** How much of a processed file's text the model reads, JSON-escaped. */
export const FILE_PROMPT_BYTES = 64 * 1024;

export function summaryCostMicrousd(usage: {
  input: number;
  output: number;
}): number {
  return Math.ceil(
    usage.input * SUMMARY_MODEL.inputUsdPerMillion +
      usage.output * SUMMARY_MODEL.outputUsdPerMillion,
  );
}

/** JSON mode returns a parsed object on some bindings, JSON text on others,
 * and OpenAI-style choices on newer models. Callers validate the result with
 * a bounded schema, never a type cast. */
export function modelJson(result: unknown): unknown {
  if (typeof result !== "object" || result === null)
    throw new Error("invalid response");
  if ("response" in result && result.response != null)
    return typeof result.response === "string"
      ? JSON.parse(result.response)
      : result.response;
  if ("choices" in result && Array.isArray(result.choices)) {
    const content = (result.choices[0] as { message?: { content?: unknown } })
      ?.message?.content;
    if (typeof content === "string") return JSON.parse(content);
  }
  throw new Error("invalid response");
}
