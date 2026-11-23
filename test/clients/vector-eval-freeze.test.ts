import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
it("freezes identical eval seeds without replacing real MCP calls", async () => {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    calls.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    if (request.url === "/__dev/vector-status")
      response.end(
        JSON.stringify({
          namespace: "rollout-eval-test",
          total: 2,
          pending: 0,
          failed: 0,
        }),
      );
    else if (request.url === "/__dev/store")
      response.end(
        JSON.stringify({
          docs: [
            { doc_key: "memory:mem_seed_duckdb_default" },
            { doc_key: "skill:seed", title: "capture-this" },
            {
              doc_key: "memory:target",
              project: "test",
              title: "Fixture",
              body: "Same body",
              tags: "ops fact",
            },
          ],
          todos: [{ todo_id: "tdo_seed_rank_calibration" }],
        }),
      );
    else if (request.url === "/mcp")
      response.end(JSON.stringify({ real: true }));
    else {
      response.statusCode = 500;
      response.end("seed write must not reach Worker");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing address");
  try {
    const origin = `http://127.0.0.1:${address.port}`;
    const program = `
      const origin = new URL(process.env.VALISE_MCP_URL).origin;
      const seed = await fetch(origin + '/__dev/seed').then(r => r.json());
      const fixtures = await fetch(origin + '/__dev/memories', {method:'POST', body:JSON.stringify([
        {id:'target',project:'test',title:'Fixture',body:'Same body',tags:['ops'],type:'fact'}
      ])}).then(r => r.json());
      const mcp = await fetch(origin + '/mcp').then(r => r.json());
      let rejected = false;
      try { await fetch(origin + '/__dev/memories', {method:'POST',body:JSON.stringify([
        {id:'target',project:'test',title:'Fixture',body:'Changed body',tags:['ops'],type:'fact'}
      ])}); } catch { rejected = true; }
      console.log(JSON.stringify({seed,fixtures,mcp,rejected}));
    `;
    const { stdout } = await exec(
      process.execPath,
      [
        "--import",
        "./scripts/vector-eval-freeze.mjs",
        "--input-type=module",
        "--eval",
        program,
      ],
      {
        env: { ...process.env, VALISE_MCP_URL: `${origin}/mcp` },
      },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      seed: { frozen: true },
      fixtures: { frozen: true, seeded: 1 },
      mcp: { real: true },
      rejected: true,
    });
    expect(calls).toEqual(["/__dev/vector-status", "/__dev/store", "/mcp"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
