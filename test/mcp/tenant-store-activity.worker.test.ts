import { createExecutionContext, env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseActivityFilters } from "~/concepts/activity";
import { trailWindow } from "~/concepts/trail";
import { consoleContext } from "~/console/context.server";
import { createSessionCookie } from "~/lib/auth.server";
import { loader as activityLoader } from "~/routes/activity";
import { loader as fileLoader } from "~/routes/files";
import { loader as hooksLoader } from "~/routes/hooks";
import { requireBrowserStore } from "~/store/tenant.server";

const settings = { ...env, SESSION_SECRET: "tenant-store-activity-secret" };
const OWNER = "local";
const OTHER = "usr_store_activity_other";

beforeEach(async () => {
  await env.DB.prepare(
    `INSERT INTO users (user_id, display_name, created_at, email_verified)
     VALUES (?, ?, unixepoch(), 1)`,
  )
    .bind(OTHER, OTHER)
    .run();
});

afterEach(async () => {
  for (const table of [
    "memory_attachments",
    "objects",
    "memory_revisions",
    "search_docs",
    "vector_pending",
    "memories",
    "hook_configs",
    "mcp_calls",
    "sessions",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("DELETE FROM users WHERE user_id = ?").bind(OTHER).run();
  const objects = await env.BUNDLES.list();
  if (objects.objects.length)
    await env.BUNDLES.delete(objects.objects.map((object) => object.key));
});

async function requestFor(userId: string, path: string) {
  // Routing hints in the URL and headers must not choose the tenant.
  const url = `https://valise.test${path}${path.includes("?") ? "&" : "?"}userId=local&shard=other`;
  const cookie = await createSessionCookie(settings, new Request(url), userId);
  return new Request(url, { headers: { cookie, "x-valise-user": "local" } });
}

async function browser(userId: string) {
  return (await requireBrowserStore(settings, await requestFor(userId, "/")))
    .store;
}

function consoleArgs<P extends Record<string, string>>(
  request: Request,
  params: P = {} as P,
) {
  const context = new RouterContextProvider();
  context.set(consoleContext, { env: settings, ctx: createExecutionContext() });
  return {
    context,
    request,
    url: new URL(request.url),
    params,
    pattern: new URL(request.url).pathname,
  };
}

async function seedCall(userId: string, callId: string, session: string) {
  await env.DB.prepare(
    `INSERT INTO mcp_calls (call_id, at, transport, user_id, principal, agent,
       client, session, session_name, method, tool, outcome, status,
       duration_ms, args_json)
     VALUES (?, ?, 'oauth', ?, ?, 'agent', ?, ?, ?, 'tools/call', 'search',
       'ok', 200, 1, '{"query":"private"}')`,
  )
    .bind(
      callId,
      Date.now(),
      userId,
      `client-${userId}`,
      `client-${userId}`,
      session,
      `name-${session}`,
    )
    .run();
}

const memory = (title: string) => ({
  title,
  type: "insight",
  body: `Evidence for ${title}`,
  project: title,
  tags: [title],
});

describe("tenant-bound activity, hooks and files", () => {
  it("reads only the tenant's own call log, runs, sessions and trail", async () => {
    const owner = await browser(OWNER);
    const other = await browser(OTHER);
    await seedCall(OWNER, "call-owner", "owner-session");
    await seedCall(OTHER, "call-other", "other-session");
    await owner.memories.save(memory("owner-note"));
    await other.memories.save(memory("member-note"));

    const filters = parseActivityFilters(new URL("https://valise.test/"));
    const calls = await owner.activity.calls(filters);
    expect(calls.totals.calls).toBe(1);
    expect(calls.knownClients).toEqual([`client-${OWNER}`]);
    const runs = await owner.activity.runs(filters, "recent");
    expect(runs.flatMap((run) => run.calls.map((call) => call.callId))).toEqual(
      ["call-owner"],
    );
    expect(await owner.activity.call("call-other")).toBeNull();
    expect(await owner.activity.call("call-owner")).toMatchObject({
      callId: "call-owner",
    });
    expect(
      (await owner.activity.clientSessions()).map((row) => row.session),
    ).toEqual(["owner-session"]);
    const trail = await owner.activity.trail(
      trailWindow(new URL("https://valise.test/activity")),
    );
    expect(trail.events.map((event) => event.title)).toEqual(["owner-note"]);
  });

  it("keeps each tenant's hook configuration separate", async () => {
    const owner = await browser(OWNER);
    const other = await browser(OTHER);
    const defaults = await owner.hooks.read();
    await other.hooks.write(`${defaults.document}\n# member edit`);

    expect(await owner.hooks.read()).toEqual(defaults);
    expect((await other.hooks.read()).document).toContain("# member edit");
    const page = await hooksLoader(
      consoleArgs(await requestFor(OWNER, "/hooks")),
    );
    expect(page.document).toBe(defaults.document);
  });

  it("serves a stored file only to its owner, through the store and /files", async () => {
    const owner = await browser(OWNER);
    const other = await browser(OTHER);
    const saved = await owner.memories.save(memory("with-file"));
    const attached = await owner.memories.attach(
      saved.id.slice("memory:".length),
      new File(["owner bytes"], "proof.txt", { type: "text/plain" }),
    );
    if (!attached) throw new Error("fixture upload refused");

    expect(await other.files.serve(attached.objectId)).toBeNull();
    const mine = await owner.files.serve(attached.objectId);
    expect(await mine?.text()).toBe("owner bytes");

    const path = `/files/${attached.objectId}`;
    await expect(
      fileLoader(
        consoleArgs(await requestFor(OTHER, path), {
          objectId: attached.objectId,
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    const served = await fileLoader(
      consoleArgs(await requestFor(OWNER, path), {
        objectId: attached.objectId,
      }),
    );
    expect(await served.text()).toBe("owner bytes");
  });

  it("renders /activity from the session's trail only", async () => {
    const owner = await browser(OWNER);
    await owner.memories.save(memory("owner-trail"));
    const other = await browser(OTHER);
    await other.memories.save(memory("member-trail"));
    const page = await activityLoader(
      consoleArgs(await requestFor(OTHER, "/activity")),
    );
    expect(page.events.map((event) => event.title)).toEqual(["member-trail"]);
  });
});
