import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);

async function run(args: string[]) {
  const calls: { path: string; method: string; after: string | null }[] = [];
  const rebuildConcepts: string[][] = [];
  let page = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    calls.push({
      path: url.pathname,
      method: request.method ?? "",
      after: url.searchParams.get("after"),
    });
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/__dev/reindex") {
      rebuildConcepts.push(url.searchParams.getAll("concept"));
      response.end(JSON.stringify({ rebuilt: true }));
    } else if (url.searchParams.has("drain"))
      response.end(JSON.stringify({ delivered: 20, pending: 31 }));
    else
      response.end(
        JSON.stringify({
          cursor: '["memory",50]',
          done: ++page > 1,
          pending: 51,
        }),
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing local test address");
  try {
    const result = await exec(
      process.execPath,
      ["scripts/reindex.mjs", ...args],
      {
        env: {
          ...process.env,
          VALISE_DEV_ORIGIN: `http://127.0.0.1:${address.port}`,
        },
      },
    );
    return { ...result, calls, rebuildConcepts };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("vector rebuild CLI", () => {
  it("rebuilds memory publication when another concept and vectors are requested", async () => {
    const result = await run(["--concept", "skill", "--vectors"]);
    expect(result.rebuildConcepts).toEqual([["skill", "memory"]]);
  });

  it("enqueues paginated history with POST and never requests inference by default", async () => {
    const { calls, stdout, stderr } = await run(["--all", "--vectors"]);
    expect(calls).toEqual([
      { path: "/__dev/reindex", method: "GET", after: null },
      { path: "/__dev/vectors", method: "POST", after: "" },
      { path: "/__dev/vectors", method: "POST", after: '["memory",50]' },
    ]);
    expect(stdout).toContain('"pending": 51');
    expect(stderr).toContain("not ANN-visible");
  });

  it("requests exactly one explicitly authorized drain batch", async () => {
    const { calls, stdout } = await run(["--vectors", "--drain"]);
    expect(calls).toHaveLength(4);
    expect(calls.at(-1)).toEqual({
      path: "/__dev/vectors",
      method: "POST",
      after: null,
    });
    expect(stdout).toContain('"delivered": 20');
    expect(stdout).toContain('"pending": 31');
  });
});
