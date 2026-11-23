// Node --import preload for the existing eval runner. Freeze only fixture setup;
// all MCP tools, searches, fetches and model calls still reach their real services.
// Loopback seed routes are not revisioned writes and must not touch indexed heads.
import assert from "node:assert/strict";

const origin = new URL(
  process.env.VALISE_MCP_URL ?? "http://localhost:4475/mcp",
).origin;
assert(
  ["localhost", "127.0.0.1"].includes(new URL(origin).hostname),
  "frozen vector eval is loopback-only",
);
const liveFetch = globalThis.fetch;
const statusResponse = await liveFetch(`${origin}/__dev/vector-status`);
assert(statusResponse.ok, "vector status unavailable");
const status = await statusResponse.json();
assert(
  status.namespace?.startsWith("rollout-eval-"),
  "isolated eval namespace required",
);
assert(
  status.total > 0 &&
    status.total <= 5001 &&
    status.pending === 0 &&
    status.failed === 0,
  "finish the bounded vector backfill before model evals",
);
const storeResponse = await liveFetch(`${origin}/__dev/store`);
assert(storeResponse.ok, "eval store unavailable");
const store = await storeResponse.json();
const docs = new Map(store.docs.map((doc) => [doc.doc_key, doc]));
assert(docs.has("memory:mem_seed_duckdb_default"), "seed before backfill");
assert(
  store.docs.some(
    (doc) => doc.doc_key.startsWith("skill:") && doc.title === "capture-this",
  ),
  "capture-this seed missing",
);
assert(
  store.todos.some((todo) => todo.todo_id === "tdo_seed_rank_calibration"),
  "to-do seed missing",
);

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === origin && url.pathname === "/__dev/seed")
    return Response.json({ frozen: true, namespace: status.namespace });
  if (url.origin === origin && url.pathname === "/__dev/memories") {
    assert(typeof init?.body === "string", "expected runner fixture JSON");
    const memories = JSON.parse(init.body);
    assert(
      Array.isArray(memories) && memories.length > 0 && memories.length <= 5000,
    );
    assert(
      new Set(memories.map((memory) => memory.id)).size === memories.length,
    );
    assert.equal(
      store.docs.filter((doc) => doc.doc_key.startsWith("memory:")).length,
      memories.length + 1,
      "frozen store is not the requested corpus size",
    );
    for (const memory of memories) {
      const doc = docs.get(`memory:${memory.id}`);
      assert(doc, `missing frozen fixture ${memory.id}`);
      assert(
        Buffer.byteLength(memory.body) <= 16384,
        "oversized fixture requires explicit projection comparison",
      );
      assert.equal(doc.project, memory.project);
      assert.equal(doc.title, memory.title);
      assert.equal(doc.body, memory.body);
      assert.equal(
        doc.tags,
        [...memory.tags, memory.type].filter(Boolean).join(" "),
      );
    }
    return Response.json({ seeded: memories.length, frozen: true });
  }
  return liveFetch(input, init);
};
