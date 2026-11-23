/**
 * The production prompts, parsers and article fetch, behind a loopback Worker
 * so `run.mjs` can send the same input to several Workers AI models.
 */
import {
  METADATA_INSTRUCTIONS,
  promptText,
  suggestionSchema,
} from "~/concepts/asset-processing";
import {
  SOURCE_SUMMARY_INSTRUCTIONS,
  sourceSummarySchema,
} from "~/concepts/source-enrichment";
import { fetchArticle } from "~/concepts/source-fetch";
import { modelJson } from "~/concepts/summary-model";
import { capBody } from "~/search/project";

type Call = {
  model: string;
  options?: Record<string, unknown>;
  max_tokens: number;
};

export default {
  async fetch(request: Request, env: { AI: Ai }) {
    const body = (await request.json()) as Record<string, any>;
    const path = new URL(request.url).pathname;
    if (path === "/article") return Response.json(await fetchArticle(body.url));
    if (path === "/bookmark")
      return Response.json(
        await run(env.AI, body as Call, sourceSummarySchema, [
          { role: "system", content: SOURCE_SUMMARY_INSTRUCTIONS },
          {
            role: "user",
            content: JSON.stringify({
              title: body.title,
              authors: body.authors,
              text: capBody(body.text, body.prefixBytes),
            }),
          },
        ]),
      );
    if (path === "/image") {
      const started = Date.now();
      const result: any = await env.AI.run(
        "@cf/zai-org/glm-5.3-flash" as keyof AiModels,
        {
          reasoning_effort: "low",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Describe this image in one sentence." },
                {
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${body.b64}` },
                },
              ],
            },
          ],
          max_tokens: 200,
          temperature: 0,
        } as never,
      );
      return Response.json({ ms: Date.now() - started, usage: result.usage });
    }
    if (path === "/file")
      return Response.json(
        await run(env.AI, body as Call, suggestionSchema, [
          { role: "system", content: METADATA_INSTRUCTIONS },
          {
            role: "user",
            content: JSON.stringify({
              vocabulary: { projects: [], tags: [] },
              document: body.prefixBytes
                ? capBody(body.text, body.prefixBytes)
                : promptText(body.text),
            }),
          },
        ]),
      );
    return new Response("not found", { status: 404 });
  },
};

async function run(
  ai: Ai,
  call: Call,
  schema: { parse(value: unknown): unknown },
  messages: { role: string; content: string }[],
) {
  const started = Date.now();
  let result: any;
  try {
    result = await ai.run(
      call.model as keyof AiModels,
      {
        ...call.options,
        messages,
        response_format: { type: "json_object" },
        max_tokens: call.max_tokens,
        temperature: 0,
      } as never,
      { signal: AbortSignal.timeout(120_000) } as never,
    );
  } catch (error) {
    return { ms: Date.now() - started, error: `provider: ${error}` };
  }
  const ms = Date.now() - started;
  const usage = result?.usage ?? null;
  const content =
    result?.choices?.[0]?.message?.content ??
    (typeof result?.response === "string"
      ? result.response
      : JSON.stringify(result?.response));
  const finish = result?.choices?.[0]?.finish_reason ?? null;
  try {
    return { ms, usage, finish, parsed: schema.parse(modelJson(result)) };
  } catch (error) {
    return { ms, usage, finish, content, error: `parse: ${error}` };
  }
}
