import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createStaticHandler,
  createStaticRouter,
  StaticRouterProvider,
} from "react-router";
import { expect, it } from "vitest";
import { AssetProcessing } from "../../app/components/asset-processing";
import type { AssetProcessingView } from "../../app/concepts/asset-processing";

it("renders provisional ghost controls as one-field native forms, marking existing and new vocabulary", async () => {
  const routes = [
    {
      path: "/",
      element: createElement(AssetProcessing, {
        assetId: "ast_test",
        title: "Original title",
        tags: ["already-assigned"],
        vocabulary: { projects: ["orchard"], tags: ["Irrigation"] },
        processing: {
          assetId: "ast_test",
          processingId: "apr_test",
          state: "ready",
          errorCode: null,
          createdAt: 1,
          outputId: "apr_test",
          processorVersion: "valise-extract-1",
          extractor: "bounded-pptx-text-1",
          originalSha256: "a".repeat(64),
          truncated: false,
          passages: 3,
          passageKind: "page",
          semanticPending: 1,
          semanticFailed: 0,
          retryAfter: null,
          decisions: [],
          suggestionError: null,
          suggestions: {
            title: "Suggested title",
            summary: "<script>untrusted</script>",
            project: "orchard",
            tags: ["Irrigation", "new-label", "already-assigned"],
            concepts: ["drip irrigation"],
          },
        },
      }),
    },
  ];
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request("http://localhost/"));
  if (context instanceof Response) throw new Error("unexpected route response");
  const router = createStaticRouter(handler.dataRoutes, context);
  const html = renderToStaticMarkup(
    createElement(StaticRouterProvider, { router, context }),
  );
  expect(html).toContain("Suggested, not saved.");
  expect(html).toContain("Dismiss suggested concept: drip irrigation");
  expect(html).toContain("Searchable in 3 passages, each citing its page.");
  expect(html).toContain("Irrigation (existing)");
  expect(html).toContain("new-label (new suggestion)");
  expect(html).toContain("Suggested project: orchard (existing)");
  expect(html).toContain("Dismiss suggested title");
  expect(html).toContain('name="expected" value="Original title"');
  expect(html).not.toContain("Accept tag: already-assigned");
  expect(html).toContain('class="ghost small"');
  expect(html).toContain('method="post"');
  expect(html).toContain('action="/library/ast_test/process"');
  expect(html).toContain('name="output" value="apr_test"');
  expect(html).toContain('name="field" value="summary"');
  expect(html).toContain("&lt;script&gt;untrusted&lt;/script&gt;");
  expect(html).not.toContain("<script>untrusted</script>");
});

it.each([
  ["queued", null, "Queued for processing"],
  ["running", null, "Extracting content"],
  ["failed", "no_text", "No readable text was found"],
] as const)(
  "does not hide a persisted %s state behind current format preflight",
  async (state, errorCode, message) => {
    const routes = [
      {
        path: "/",
        element: createElement(AssetProcessing, {
          assetId: "ast_legacy",
          fileName: "legacy.ppt",
          contentType: "application/vnd.ms-powerpoint",
          compact: true,
          processing: { state, errorCode } as AssetProcessingView,
        }),
      },
    ];
    const handler = createStaticHandler(routes);
    const context = await handler.query(new Request("http://localhost/"));
    if (context instanceof Response)
      throw new Error("unexpected route response");
    const html = renderToStaticMarkup(
      createElement(StaticRouterProvider, {
        router: createStaticRouter(handler.dataRoutes, context),
        context,
      }),
    );
    expect(html).toContain(message);
    expect(html).not.toContain("Text extraction is not available");
  },
);
