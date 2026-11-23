import { env } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { filtersFromRequest, listHref, withTag } from "~/concepts/list-filters";
import { countMemories, listMemories, saveMemory } from "~/concepts/memories";
import { infiniteWindow, pageNumber, pagination } from "~/concepts/pagination";
import {
  changeSkills,
  countSkills,
  listSkills,
  publishSkill,
} from "~/concepts/skills";
import {
  countTodos,
  createTodo,
  listTodos,
  overrideTodoState,
} from "~/concepts/todos";

const provenance = {
  userId: "local",
  agent: "vitest",
  client: "test",
  session: null,
};

afterEach(async () => {
  for (const table of [
    "search_docs",
    "todo_updates",
    "todos",
    "memory_revisions",
    "memories",
    "skill_versions",
    "skills",
    "mcp_calls",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

it("validates and clamps page numbers and keeps pages on item links, not new tag filters", () => {
  for (const value of [
    null,
    "",
    "-1",
    "0",
    "1",
    "1.5",
    "NaN",
    "Infinity",
    "9007199254740992",
  ]) {
    expect(pageNumber(value)).toBeUndefined();
  }
  expect(pageNumber("3")).toBe(3);
  expect(pagination(65, 99)).toMatchObject({
    page: 3,
    pages: 3,
    limit: 30,
    offset: 60,
  });
  expect(pagination(0, 99)).toMatchObject({ page: 1, pages: 1, offset: 0 });
  expect(infiniteWindow(65, 2)).toMatchObject({
    page: 2,
    limit: 60,
    offset: 0,
  });
  expect(infiniteWindow(65, 999)).toMatchObject({
    page: 3,
    limit: 90,
    offset: 0,
  });
  expect(infiniteWindow(0, 999)).toMatchObject({
    page: 1,
    total: 0,
    offset: 0,
  });
  const filters = filtersFromRequest(
    new Request("https://valise.test/todos?project=p&tag=a&tag=b&page=2"),
  );
  expect(listHref("/todos", filters, { open: "todo:x" })).toBe(
    "/todos?project=p&tag=a&tag=b&page=2&open=todo%3Ax",
  );
  expect(withTag(filters, "c").page).toBeUndefined();
});

it("paginates the filtered to-do set without gaps, duplicates or page-local counts", async () => {
  const ids: string[] = [];
  for (let index = 0; index < 65; index += 1) {
    const made = await createTodo(
      env,
      {
        title: `Needle ${index}`,
        project: "page",
        tags: ["a", "b"],
      },
      provenance,
    );
    ids.push(made.id);
    if (index < 4)
      await overrideTodoState(env, made.id, "done", "test", provenance);
    if (index >= 60)
      await overrideTodoState(
        env,
        made.id,
        "blocked",
        "test blocker",
        provenance,
      );
  }
  await createTodo(
    env,
    { title: "Needle decoy", project: "other", tags: ["a"] },
    provenance,
  );
  const filters = {
    query: "needle",
    project: "page",
    tags: ["A", "b"],
    showDone: true,
  };
  expect(await countTodos(env.DB, "local", filters)).toEqual({
    total: 65,
    done: 4,
    blocked: 5,
  });
  const seen: string[] = [];
  for (let page = 1; page <= 3; page += 1) {
    const rows = await listTodos(
      env.DB,
      "local",
      filters,
      pagination(65, page),
    );
    expect(rows).toHaveLength(page === 3 ? 5 : 30);
    seen.push(...rows.map((row) => row.id));
  }
  // Blocked rows lead every window, so the first page holds them all.
  const expected = [...ids.slice(60).reverse(), ...ids.slice(0, 60).reverse()];
  expect(seen).toEqual(expected);
  expect(new Set(seen).size).toBe(65);
  const prefix = await listTodos(
    env.DB,
    "local",
    filters,
    infiniteWindow(65, 2),
  );
  expect(prefix.map((row) => row.id)).toEqual(expected.slice(0, 60));
  // Absent `showDone`, the list leaves done rows out: the console's default.
  const hidden = { ...filters, showDone: undefined };
  expect(await countTodos(env.DB, "local", hidden)).toEqual({
    total: 61,
    done: 4,
    blocked: 5,
  });
  expect(
    await listTodos(env.DB, "local", hidden, pagination(61, 3)),
  ).toHaveLength(1);
  const blocked = { ...filters, blocked: true };
  expect(await countTodos(env.DB, "local", blocked)).toEqual({
    total: 5,
    done: 4,
    blocked: 5,
  });
  expect(
    (await listTodos(env.DB, "local", blocked, pagination(5))).every(
      (row) => row.state === "blocked",
    ),
  ).toBe(true);
});

it("paginates memories after all filters and the global fetched sort", async () => {
  for (let index = 0; index < 35; index += 1) {
    const memory = await saveMemory(
      env,
      {
        title: `Memory ${index}`,
        body: "needle",
        type: "fact",
        project: "page",
        tags: ["a", "b"],
      },
      provenance,
    );
    // A call row carries its user, as every transport writes it; a fetch
    // nobody owns counts for nobody. ADR-0016.
    await env.DB.prepare(`INSERT INTO mcp_calls (call_id, at, user_id, agent, client, tool, args_json, duration_ms, outcome, result_bytes, transport, method, status)
      VALUES (?, ?, 'local', 'test', 'test', 'fetch', ?, 1, 'ok', 1, 'loopback', 'tools/call', 200)`)
      .bind(`call-${index}`, index, JSON.stringify({ id: memory.id }))
      .run();
    if (index === 34) {
      await env.DB.prepare(
        "UPDATE mcp_calls SET args_json = '{', target_id = ? WHERE call_id = ?",
      )
        .bind(memory.id, `call-${index}`)
        .run();
    }
  }
  await saveMemory(
    env,
    {
      title: "Decoy",
      body: "needle",
      type: "decision",
      tags: ["a"],
      project: "page",
    },
    provenance,
  );
  const filters = {
    query: "needle",
    type: "FACT",
    project: "page",
    tags: ["a", "B"],
    sort: "fetched",
  };
  expect(await countMemories(env.DB, "local", filters)).toBe(35);
  const first = await listMemories(env.DB, "local", filters, pagination(35));
  const last = await listMemories(env.DB, "local", filters, pagination(35, 2));
  expect(first).toHaveLength(30);
  expect(last).toHaveLength(5);
  expect([...first, ...last].map((row) => row.title)).toEqual(
    Array.from({ length: 35 }, (_, index) => `Memory ${34 - index}`),
  );
});

it("orders memories by last fetch, fetch count and search appearances", async () => {
  const ids: Record<string, string> = {};
  for (const title of ["old", "busy", "seen", "quiet"]) {
    ids[title] = (
      await saveMemory(
        env,
        { title, body: "orders", type: "fact", tags: [] },
        provenance,
      )
    ).id;
  }
  const call = (id: string, at: number, tool: string, json: string) =>
    env.DB.prepare(`INSERT INTO mcp_calls (call_id, at, user_id, agent, client, tool, args_json, duration_ms, outcome, result_bytes, transport, method, status, search_result_ids_json)
      VALUES (?, ?, 'local', 'test', 'test', ?, ?, 1, 'ok', 1, 'loopback', 'tools/call', 200, ?)`).bind(
      id,
      at,
      tool,
      tool === "fetch" ? json : JSON.stringify({ query: "orders" }),
      tool === "search" ? json : null,
    );
  await env.DB.batch([
    // "old" is fetched once, most recently; "busy" three times, earlier.
    call("f1", 900, "fetch", JSON.stringify({ id: ids.old })),
    call("f2", 100, "fetch", JSON.stringify({ id: ids.busy })),
    call("f3", 200, "fetch", JSON.stringify({ id: ids.busy })),
    call("f4", 300, "fetch", JSON.stringify({ id: ids.busy })),
    // "seen" is never fetched but turns up in two searches; "busy" in one.
    call("s1", 400, "search", JSON.stringify([ids.seen, ids.busy])),
    call("s2", 500, "search", JSON.stringify([ids.seen])),
  ]);
  const order = async (sort?: string) =>
    (await listMemories(env.DB, "local", { query: "orders", sort })).map(
      (row) => row.title,
    );
  // The never-fetched tail keeps the default order, newest update first.
  const tail = (await order()).filter((t) => t === "seen" || t === "quiet");
  expect(await order("last-fetched")).toEqual(["old", "busy", ...tail]);
  expect(await order("fetched")).toEqual(["busy", "old", ...tail]);
  expect((await order("in-results")).slice(0, 2)).toEqual(["seen", "busy"]);
  // An unknown order is the default one, not SQL.
  expect(await order("x; DROP TABLE memories")).toEqual(await order());
});

it("counts deleted skills across pages and limits the filtered visible set", async () => {
  for (let index = 0; index < 35; index += 1) {
    await publishSkill(
      env,
      {
        body: `---\nname: page-${String(index).padStart(2, "0")}\ndescription: needle\n---\nBody`,
        project: "page",
        tags: ["a", "b"],
        files: [],
      },
      provenance,
    );
  }
  await changeSkills(env, "local", ["page-00"], "delete");
  const filters = { project: "page", query: "needle", tags: ["a", "b"] };
  expect(await countSkills(env.DB, "local", filters)).toEqual({
    total: 34,
    deleted: 1,
  });
  const first = await listSkills(
    env.DB,
    "local",
    filters,
    "disabled",
    pagination(34),
  );
  const last = await listSkills(
    env.DB,
    "local",
    filters,
    "disabled",
    pagination(34, 2),
  );
  expect(first).toHaveLength(30);
  expect(last).toHaveLength(4);
  expect([...first, ...last].map((row) => row.name)).toEqual(
    Array.from(
      { length: 34 },
      (_, index) => `page-${String(index + 1).padStart(2, "0")}`,
    ),
  );
  expect(
    await countSkills(env.DB, "local", { ...filters, showDeleted: true }),
  ).toEqual({
    total: 35,
    deleted: 1,
  });
});

it("lists same-second to-dos in reverse insertion order, including after an edit", async () => {
  const ids: string[] = [];
  for (const title of ["First", "Second", "Third"]) {
    const made = await createTodo(env, { title, project: "order" }, provenance);
    ids.push(made.id);
  }
  for (const [index, id] of ids.entries()) {
    await env.DB.prepare(
      "UPDATE todos SET todo_id = ?, created_at = 100, updated_at = ? WHERE todo_id = ?",
    )
      .bind(["tdo_a", "tdo_z", "tdo_m"][index], 100 + index, id.slice(5))
      .run();
  }
  const titles = async () =>
    (await listTodos(env.DB, "local")).map((row) => row.title);
  expect(await titles()).toEqual(["Third", "Second", "First"]);
  await env.DB.prepare(
    "UPDATE todos SET body = 'Edited', updated_at = 999 WHERE todo_id = 'tdo_a'",
  ).run();
  expect(await titles()).toEqual(["Third", "Second", "First"]);
});
