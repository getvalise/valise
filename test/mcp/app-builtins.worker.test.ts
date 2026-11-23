import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { expect, it, vi } from "vitest";
import worker from "../../workers/app";

vi.mock("react-router", async (original) => ({
  ...(await original<typeof import("react-router")>()),
  createRequestHandler: () => () => new Response("console"),
}));

it("serves the first deployed request without touching tenant storage or scheduling builtin scans", async () => {
  const db = vi.spyOn(env.DB, "prepare").mockImplementation(() => {
    throw new Error("a health request must not read tenants");
  });
  try {
    for (let i = 0; i < 2; i++) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request("https://app.valise.run/health"),
        env,
        ctx,
      );
      expect(response.status).toBe(200);
      await waitOnExecutionContext(ctx);
    }
    expect(db).not.toHaveBeenCalled();
  } finally {
    db.mockRestore();
  }
});
