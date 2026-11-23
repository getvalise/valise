import { createHash } from "node:crypto";
import { test } from "@playwright/test";
import {
  credentials,
  Evidence,
  expect,
  type Mcp,
  mcpClient,
  memberContext,
  mintToken,
  origin,
  revokeTokens,
  runId,
  text,
  visit,
} from "./harness";

/*
 * J6, docs/testing/user-journeys.md#j6-share-safely-under-load, for two
 * member tenants. Needs JOURNEY_B_*: a second tenant is the whole point, and
 * the owner's tenant is never a stand-in. The load step is bounded and runs
 * against a local build only unless JOURNEY_LOAD=1 is set for an approved
 * disposable deployment.
 */

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[
      Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
    ] ?? 0
  );
};

async function upload(
  client: Mcp,
  name: string,
  body: string,
  project: string,
) {
  const bytes = Buffer.from(body);
  const pending = await client.ok("upload_asset", {
    file_name: name,
    content_type: "text/plain",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    project,
  });
  const put = await fetch(pending.upload.url, {
    method: "PUT",
    headers: pending.upload.headers,
    body: bytes,
  });
  expect(put.status).toBe(200);
  return pending.id as string;
}

test("J6: two tenants stay private to each other, also under mixed load", async ({
  browser,
}) => {
  test.skip(
    !credentials("B"),
    "J6 needs a second synthetic tenant (JOURNEY_B_*)",
  );
  const evidence = new Evidence("j6");
  const project = `journey-j6-${runId}`;
  const tokenPrefix = `journey j6 ${runId}`;
  const marker = `zebrafinch${runId.replaceAll("-", "")}`;
  const A = await memberContext(browser, "A");
  const B = await memberContext(browser, "B");
  const clients: Mcp[] = [];
  try {
    const a = await mcpClient(
      await mintToken(A.page, `${tokenPrefix} a`),
      "journey-tenant-a",
    );
    const bToken = await mintToken(B.page, `${tokenPrefix} b`);
    const b = await mcpClient(bToken, "journey-tenant-b");
    clients.push(a, b);

    // 2. Same names on both sides; each tenant writes every concept.
    const skillName = `journey-shared-${runId.slice(-6)}`;
    const write = async (client: Mcp, who: string) => {
      const todo = await client.ok("create_todo", {
        title: `Shared title ${who}`,
        project,
      });
      const memory = await client.ok("save_memory", {
        title: `Shared memory ${who} ${marker}`,
        body: `Synthetic ${who} memory ${marker}.`,
        type: "fact",
        project,
        tags: ["journey"],
      });
      await client.ok("publish_skill", {
        body: `---\nname: ${skillName}\ndescription: Synthetic shared-name skill for J6. Use only in J6.\n---\n\n${who} body ${marker}.\n`,
        project,
      });
      const source = await client.ok("save_source", {
        kind: "bookmark",
        title: `Shared source ${who} ${marker}`,
        url: `https://example.com/${who}/${runId}`,
        project,
      });
      const asset = await upload(
        client,
        `shared-${who}.txt`,
        `${who} bytes ${marker}`,
        project,
      );
      return { todo: todo.id, memory: memory.id, source: source.id, asset };
    };
    const ids = { a: await write(a, "a"), b: await write(b, "b") };
    for (const side of Object.values(ids))
      for (const id of Object.values(side)) evidence.fixture(id);
    const ownSkill = await b.ok("get_skill", { name: skillName });
    expect(JSON.stringify(ownSkill)).toContain("b body");
    expect(JSON.stringify(ownSkill)).not.toContain("a body");
    evidence.step(
      "2. both tenants write same-named items in every concept",
      true,
    );

    // Guessed IDs: every door refuses B on A's ids, as if missing.
    const refusals: Record<string, string> = {};
    const refuse = async (
      label: string,
      call: Promise<{ isError?: boolean; content?: { text?: string }[] }>,
    ) => {
      const result = await call;
      expect(result.isError, `${label} must be refused`).toBe(true);
      refusals[label] = text(result as never).slice(0, 120);
    };
    await refuse("fetch todo", b.call("fetch", { id: ids.a.todo }));
    await refuse("fetch memory", b.call("fetch", { id: ids.a.memory }));
    await refuse("fetch source", b.call("fetch", { id: ids.a.source }));
    await refuse("fetch asset", b.call("fetch", { id: ids.a.asset }));
    await refuse(
      "asset download",
      b.call("get_asset_download", { id: ids.a.asset }),
    );
    await refuse("claim todo", b.call("claim_todo", { id: ids.a.todo }));
    await refuse(
      "comment todo",
      b.call("comment_todo", { id: ids.a.todo, body: "Cross-tenant" }),
    );
    await refuse(
      "edit memory",
      b.call("edit_memory", { id: ids.a.memory, body: "Cross-tenant" }),
    );
    await refuse(
      "tag todo",
      b.call("edit_todo_tags", { id: ids.a.todo, add_tags: ["x"] }),
    );
    const search = await b.ok("search", { query: `${marker} a` });
    expect(JSON.stringify(search)).not.toContain("a memory");
    expect(JSON.stringify(search)).not.toContain(ids.a.memory);
    const resource = await b.client.readResource({
      uri: `skill://${skillName}/SKILL.md`,
    });
    expect(JSON.stringify(resource)).toContain("b body");
    expect(JSON.stringify(resource)).not.toContain("a body");
    evidence.step(
      "guessed ids refused through MCP; search and skill:// stay per tenant",
      true,
      refusals,
    );

    // Console direct routes.
    await visit(B.page, `/todos?open=${encodeURIComponent(ids.a.todo)}`);
    await expect(B.page.getByText("Shared title a")).toHaveCount(0);
    await visit(B.page, `/memories?open=${encodeURIComponent(ids.a.memory)}`);
    await expect(B.page.getByText(`Shared memory a ${marker}`)).toHaveCount(0);
    await visit(B.page, `/skills?open=${skillName}`);
    await expect(B.page.getByText("a body")).toHaveCount(0);
    const download = await a.ok("get_asset_download", { id: ids.a.asset });
    const foreignBytes = await B.page.request.get(
      download.url.replace(/^https?:\/\/[^/]+/, origin()),
    );
    // A signed URL is a credential for one file; it is the holder's, not the session's.
    evidence.step("console routes show nothing of tenant A", true, {
      signedUrlFromBrowserB: foreignBytes.status(),
    });
    await evidence.shot(B.page, "01-tenant-b-skills");

    // Revoking B's token leaves A working.
    await revokeTokens(B.page, `${tokenPrefix} b`);
    const revoked = await b.call("list_todos", { project });
    expect(revoked.isError).toBe(true);
    expect((await a.ok("list_todos", { project })).todos.length).toBe(1);
    evidence.step("revoking B's token stops B and not A", true, {
      afterRevoke: text(revoked).slice(0, 120),
    });

    // 3-4. Bounded mixed load: A noisy, a fresh B client quiet.
    const local = new URL(origin()).hostname === "localhost";
    if (local || process.env.JOURNEY_LOAD === "1") {
      const quiet = await mcpClient(
        await mintToken(B.page, `${tokenPrefix} b quiet`),
        "journey-quiet",
      );
      clients.push(quiet);
      const timings: Record<"noisy" | "quiet", number[]> = {
        noisy: [],
        quiet: [],
      };
      const errors: Record<"noisy" | "quiet", string[]> = {
        noisy: [],
        quiet: [],
      };
      const timed = async (
        who: "noisy" | "quiet",
        client: Mcp,
        tool: string,
        args: Record<string, unknown>,
      ) => {
        const started = performance.now();
        const result = await client.call(tool, args);
        timings[who].push(performance.now() - started);
        if (result.isError)
          errors[who].push(`${tool}: ${text(result).slice(0, 400)}`);
        return result;
      };
      const NOISY = 160;
      const noisyWork = Array.from({ length: NOISY }, (_, i) => async () => {
        switch (i % 4) {
          case 0:
            return timed("noisy", a, "search", {
              query: `${marker} load ${i}`,
            });
          case 1:
            return timed("noisy", a, "save_memory", {
              title: `Load memory ${i} ${marker}`,
              body: `Noisy synthetic load ${i}.`,
              type: "fact",
              project,
              tags: ["journey-load"],
            });
          case 2:
            return timed("noisy", a, "create_todo", {
              title: `Load task ${i}`,
              project,
            });
          default:
            return timed("noisy", a, "list_todos", { project });
        }
      });
      const quietIds: string[] = [];
      const quietWork = Array.from({ length: 20 }, (_, i) => async () => {
        const made = await timed("quiet", quiet, "create_todo", {
          title: `Quiet task ${i}`,
          project,
        });
        if (!made.isError) quietIds.push(made.structuredContent.id);
      });
      const pool = async (jobs: (() => Promise<unknown>)[], width: number) => {
        const queue = [...jobs];
        await Promise.all(
          Array.from({ length: width }, async () => {
            for (let job = queue.shift(); job; job = queue.shift()) await job();
          }),
        );
      };
      const started = Date.now();
      await Promise.all([pool(noisyWork, 8), pool(quietWork, 1)]);
      const seconds = (Date.now() - started) / 1000;
      const listed = await quiet.ok("list_todos", { project, limit: 100 });
      const quietLanded = quietIds.filter((id) =>
        listed.todos.some((todo: { id: string }) => todo.id === id),
      ).length;
      expect(quietLanded).toBe(20);
      expect(errors.quiet).toEqual([]);
      // The noisy tenant is refused only by its own limiter, as a JSON-RPC
      // error that keeps its request id and says when to retry.
      for (const error of errors.noisy) {
        expect(error).toContain("rate_limited");
        expect(error).toContain("retryAfterSeconds");
      }
      const leaked = JSON.stringify(listed).includes("Load task");
      expect(leaked).toBe(false);
      const stats = (who: "noisy" | "quiet") => ({
        calls: timings[who].length,
        errors: errors[who].length,
        errorSamples: [
          ...new Set(errors[who].map((e) => e.replace(/"id":\d+/, '"id":n'))),
        ].slice(0, 3),
        p50: Math.round(percentile(timings[who], 50)),
        p95: Math.round(percentile(timings[who], 95)),
        p99: Math.round(percentile(timings[who], 99)),
      });
      evidence.step(
        "mixed load: quiet tenant's work lands and stays private",
        true,
        {
          seconds,
          noisyConcurrency: 8,
          quietConcurrency: 1,
          noisy: stats("noisy"),
          quiet: stats("quiet"),
          quietLanded,
        },
      );
    } else {
      evidence.step(
        "mixed load",
        false,
        "not run: deployed load needs an approved disposable installation (JOURNEY_LOAD=1)",
      );
    }

    const phone = await memberContext(browser, "B", { width: 320 });
    try {
      await visit(phone.page, `/todos?project=${project}`);
      await evidence.shot(phone.page, "02-tenant-b-phone");
    } finally {
      await phone.context.close();
    }
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    await revokeTokens(A.page, tokenPrefix).catch(() => {});
    await revokeTokens(B.page, tokenPrefix).catch(() => {});
    evidence.record.cleanup.push(
      `bearer tokens labelled "${tokenPrefix}" revoked in both tenants`,
      `synthetic rows remain in project ${project} in both tenants`,
    );
    evidence.flush();
    await A.context.close();
    await B.context.close();
  }
});

/*
 * The part of J6 one tenant can show on a deployed origin, where no second
 * synthetic tenant exists: member routes are enforced on the server, ids
 * that are not the member's answer as missing, and revoking one connection
 * leaves the member's other connection working.
 */
test("J6, one tenant: owner routes, unknown ids and per-connection revocation", async ({
  browser,
}) => {
  const evidence = new Evidence("j6");
  const tokenPrefix = `journey j6 solo ${runId}`;
  const project = `journey-j6-${runId}`;
  const { context, page } = await memberContext(browser, "A");
  const clients: Mcp[] = [];
  try {
    for (const path of ["/people", "/workbench", "/workbench?tab=logs"]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBeGreaterThanOrEqual(400);
      expect(new URL(page.url()).pathname).toBe(path.split("?")[0]);
    }
    await visit(page, "/todos");
    for (const name of ["People", "Workbench"])
      await expect(page.getByRole("link", { name, exact: true })).toHaveCount(
        0,
      );
    evidence.step(
      "owner routes refuse a member on the server, not only in the nav",
      true,
    );

    const scopes = ["todos:read", "todos:write", "search:read"];
    const one = await mcpClient(
      await mintToken(page, `${tokenPrefix} one`, scopes),
      "journey-solo-one",
    );
    const two = await mcpClient(
      await mintToken(page, `${tokenPrefix} two`, scopes),
      "journey-solo-two",
    );
    clients.push(one, two);
    const todo = await one.ok("create_todo", {
      title: "Synthetic J6 journey to-do",
      project,
      tags: ["journey"],
    });
    evidence.fixture(todo.id);
    const unknown: Record<string, string> = {};
    for (const id of [
      `todo:tdo_${crypto.randomUUID()}`,
      `memory:mem_${crypto.randomUUID()}`,
      `source:src_${crypto.randomUUID()}`,
      `asset:ast_${crypto.randomUUID()}`,
    ]) {
      const result = await one.call("fetch", { id });
      expect(result.isError, id).toBe(true);
      unknown[id.split(":")[0]] = text(result).replace(
        /[0-9a-f-]{36}/,
        "<uuid>",
      );
    }
    const claim = await one.call("claim_todo", {
      id: `todo:tdo_${crypto.randomUUID()}`,
    });
    expect(claim.isError).toBe(true);
    evidence.step(
      "ids that are not the member's answer as missing",
      true,
      unknown,
    );

    await revokeTokens(page, `${tokenPrefix} one`);
    const revoked = await one.call("list_todos", { project });
    expect(revoked.isError).toBe(true);
    expect(text(revoked)).toContain("invalid_token");
    const still = await two.ok("fetch", { id: todo.id });
    expect(still.title).toBe("Synthetic J6 journey to-do");
    const lease = await two.ok("claim_todo", { id: todo.id });
    await two.ok("complete_todo", {
      id: todo.id,
      token: lease.token,
      summary: "Synthetic J6 journey check finished.",
    });
    evidence.step(
      "revoking one token stops it and leaves the other working",
      true,
    );
    await evidence.shot(page, "03-solo-connections");
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    await revokeTokens(page, tokenPrefix).catch(() => {});
    evidence.record.cleanup.push(
      `bearer tokens labelled "${tokenPrefix}" revoked`,
      `one synthetic to-do left completed in project ${project}`,
    );
    evidence.flush();
    await context.close();
  }
});
