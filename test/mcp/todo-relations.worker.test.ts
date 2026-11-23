import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { readProjectBrief } from "~/concepts/startup-brief";
import { queryTodos } from "~/concepts/todo-query";
import { readTodoRelations } from "~/concepts/todo-relations";
import { createTodo, getTodo, listReady } from "~/concepts/todos";
import { TodoCoordinator } from "~/do/todo-coordinator";
import { callMcp } from "./fixture-worker";

const stubs: DurableObjectStub<TodoCoordinator>[] = [];
afterEach(async () => {
  for (const stub of stubs) await stub.resetForDevelopment();
  stubs.length = 0;
  for (const table of [
    "todo_relations",
    "todo_relation_fences",
    "search_docs",
    "todo_comments",
    "todo_updates",
    "todos",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
});

async function fixture() {
  const userId = `usr_${crypto.randomUUID()}`;
  const provenance = { userId, agent: "agent", client: "test", session: null };
  const stub = env.TODO_COORDINATOR.getByName(`todos:${userId}`);
  stubs.push(stub);
  const make = async (title: string, project = "relations") =>
    (
      await createTodo(
        env,
        { title, project, body: "- [ ] Markdown step" },
        provenance,
      )
    ).id.slice(5);
  const [a, b, c] = await Promise.all([
    make("integrate processing"),
    make("tenant boundary", "platform"),
    make("third"),
  ]);
  return { userId, provenance, stub, make, a, b, c };
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Hold a real committed batch or a captured read, not a fake database result. */
function delayedDatabase(
  db: D1Database,
  mode: "batch" | "edges" | "log" | "reservation",
  reject = false,
) {
  const committed = deferred();
  const resume = deferred();
  let armed = true;
  async function hold<T>(operation: Promise<T>) {
    const value = await operation;
    if (armed) {
      armed = false;
      committed.resolve();
      await resume.promise;
      if (reject) throw new Error("D1 response lost");
    }
    return value;
  }
  const statement = (
    stmt: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, key) {
        if (key === "bind")
          return (...args: unknown[]) => statement(target.bind(...args), sql);
        if (
          key === "all" &&
          mode === "edges" &&
          sql.includes("FROM todo_relations WHERE")
        )
          return () => hold(target.all());
        if (
          key === "run" &&
          mode === "log" &&
          sql.includes("INSERT INTO todo_updates")
        )
          return () => hold(target.run());
        if (
          key === "run" &&
          mode === "reservation" &&
          sql.includes("INSERT INTO todo_relation_fences")
        )
          return () => hold(target.run());
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return {
    committed: committed.promise,
    resume: resume.resolve,
    db: new Proxy(db, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => statement(target.prepare(sql), sql);
        if (key === "batch" && mode === "batch")
          return (statements: D1PreparedStatement[]) =>
            hold(target.batch(statements));
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
}

/** Reject before starting the real transaction; it may arrive after unrelated reads and recovery. */
function lateGraphDatabase(db: D1Database) {
  let commit: (() => Promise<D1Result[]>) | undefined;
  let armed = true;
  return {
    commitLater: async () => {
      if (!commit) throw new Error("no delayed graph transaction");
      return commit();
    },
    db: new Proxy(db, {
      get(target, key) {
        if (key === "batch")
          return (statements: D1PreparedStatement[]) => {
            if (!armed) return target.batch(statements);
            armed = false;
            commit = () => target.batch(statements);
            return Promise.reject(
              new Error(
                "request rejected locally; transaction still in flight",
              ),
            );
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
}

describe("first-class to-do relations", () => {
  it("keeps scoped ready queries and brief aligned with list_ready without filtering state enumeration or clearing manual blockers", async () => {
    const { stub, a, b, c, make, userId } = await fixture();
    const manual = await make("Manual and structured blockers coexist");
    const pendingManual = await make("Pending mirror with manual reason");
    await env.DB.prepare("UPDATE todos SET blocked_on = ? WHERE todo_id = ?")
      .bind("Keep pending manual reason", pendingManual)
      .run();
    const foreign = await fixture();
    await stub.editRelations(a, { addDependsOn: [b] });
    await stub.editRelations(manual, { addDependsOn: [b] });
    await stub.editRelations(pendingManual, { addDependsOn: [b] });
    await stub.override(
      manual,
      "console",
      "blocked",
      "Owner approval remains outstanding",
    );
    const ready = async () =>
      (
        await queryTodos(env.DB, userId, {}, undefined, { readyOnly: true })
      ).todos
        .map((todo) => todo.id)
        .sort();
    const listed = async () =>
      (await listReady(env.DB, userId)).map((todo) => todo.id).sort();
    expect(await ready()).toEqual(await listed());
    expect(await ready()).toEqual([`todo:${b}`, `todo:${c}`].sort());
    const before = await readProjectBrief(env.DB, userId);
    expect(before.ready.items.map((todo) => todo.id).sort()).toEqual(
      await ready(),
    );
    expect(
      before.blocked.items
        .map(({ id, state, blocked_on }) => ({ id, state, blocked_on }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    ).toEqual(
      [
        { id: `todo:${a}`, state: "pending", blocked_on: null },
        {
          id: `todo:${manual}`,
          state: "blocked",
          blocked_on: "Owner approval remains outstanding",
        },
        {
          id: `todo:${pendingManual}`,
          state: "pending",
          blocked_on: "Keep pending manual reason",
        },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
    expect(before.ready.items.map((todo) => todo.id)).not.toContain(
      `todo:${a}`,
    );
    expect(
      (await queryTodos(env.DB, userId, { state: "pending" })).todos.map(
        (todo) => todo.id,
      ),
    ).toContain(`todo:${a}`);
    const all = (await queryTodos(env.DB, userId)).todos
      .map((todo) => todo.id)
      .sort();
    expect(all).toEqual(
      [a, b, c, manual, pendingManual].map((id) => `todo:${id}`).sort(),
    );
    expect(all).not.toContain(`todo:${foreign.a}`);
    await stub.override(b, "console", "done", "prerequisite completed");
    expect(await ready()).toEqual(await listed());
    expect(await ready()).toEqual([`todo:${a}`, `todo:${c}`].sort());
    const after = await readProjectBrief(env.DB, userId);
    expect(after.ready.items.map((todo) => todo.id).sort()).toEqual(
      await ready(),
    );
    expect(
      after.blocked.items
        .map(({ id, state, blocked_on }) => ({ id, state, blocked_on }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    ).toEqual(
      [
        {
          id: `todo:${manual}`,
          state: "blocked",
          blocked_on: "Owner approval remains outstanding",
        },
        {
          id: `todo:${pendingManual}`,
          state: "pending",
          blocked_on: "Keep pending manual reason",
        },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
    expect(after.blocked.items.map((todo) => todo.id)).not.toContain(
      `todo:${a}`,
    );
    expect((await getTodo(env.DB, userId, a))?.state).toBe("pending");
    expect(
      (await queryTodos(env.DB, userId, { state: "blocked" })).todos.map(
        (todo) => todo.id,
      ),
    ).toEqual([`todo:${manual}`]);
    expect((await queryTodos(env.DB, userId)).todos).toHaveLength(5);
  });
  it("retains quarantine after a lost reservation acknowledgement without sending a graph mutation", async () => {
    const { stub, a, b } = await fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const gate = delayedDatabase(env.DB, "reservation", true);
      const coordinator = new TodoCoordinator(state, { DB: gate.db });
      const edit = coordinator.editRelations(a, { addDependsOn: [b] });
      await gate.committed;
      gate.resume();
      expect(await edit).toMatchObject({
        ok: false,
        reason: expect.stringContaining("outcome unknown"),
      });
      const recovered = new TodoCoordinator(state, { DB: env.DB });
      expect(await recovered.claim(a, "agent", 600)).toMatchObject({
        ok: false,
      });
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) n FROM todo_relations WHERE from_todo_id = ?",
        )
          .bind(a)
          .first("n"),
      ).toBe(0);
      expect(
        await recovered.editRelations(a, { reconcile: true }),
      ).toMatchObject({ ok: true });
      expect(await recovered.claim(a, "agent", 600)).toMatchObject({
        ok: true,
      });
    });
  });
  it("fences a late reparent and dependency removal so it cannot erase relations written after recovery", async () => {
    const { stub, a, b, c, userId } = await fixture();
    await stub.editRelations(a, { parent: b, addDependsOn: [b] });
    await runInDurableObject(stub, async (_instance, state) => {
      const late = lateGraphDatabase(env.DB);
      const coordinator = new TodoCoordinator(state, { DB: late.db });
      expect(
        await coordinator.editRelations(a, { parent: c, removeDependsOn: [b] }),
      ).toMatchObject({ ok: false });
      const recovered = new TodoCoordinator(state, { DB: env.DB });
      expect(
        await recovered.editRelations(a, { reconcile: true }),
      ).toMatchObject({ ok: true });
      expect(
        await recovered.editRelations(a, { parent: b, addDependsOn: [c] }),
      ).toMatchObject({ ok: true });
      await late.commitLater();
      const relations = await readTodoRelations(env.DB, userId, a);
      expect(relations.parent?.id).toBe(`todo:${b}`);
      expect(relations.depends_on.map((todo) => todo.id).sort()).toEqual(
        [`todo:${b}`, `todo:${c}`].sort(),
      );
    });
  });
  it("quarantines a graph add before its late commit, including across reconstruction; reconciliation fences the original rather than replaying", async () => {
    const { stub, a, b } = await fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const late = lateGraphDatabase(env.DB);
      const coordinator = new TodoCoordinator(state, { DB: late.db });
      expect(
        await coordinator.editRelations(a, { addDependsOn: [b] }),
      ).toMatchObject({
        ok: false,
        reason: expect.stringContaining("outcome unknown"),
      });
      // A primary read still sees the old graph. It is not proof of cancellation.
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) n FROM todo_relations WHERE from_todo_id = ?",
        )
          .bind(a)
          .first("n"),
      ).toBe(0);
      expect(await coordinator.claim(a, "agent", 600)).toMatchObject({
        ok: false,
        reason: expect.stringContaining("outcome unknown"),
      });
      const recovered = new TodoCoordinator(state, { DB: env.DB });
      expect(await recovered.claim(a, "agent", 600)).toMatchObject({
        ok: false,
      });
      expect(
        await recovered.editRelations(a, { addDependsOn: [b] }),
      ).toMatchObject({ ok: false });
      expect(
        await recovered.editRelations(a, { reconcile: true }),
      ).toMatchObject({ ok: true });
      expect(await recovered.claim(a, "agent", 600)).toMatchObject({
        ok: true,
        token: 1,
      });
      // A real retry must recheck the now-active dependent; recovery grants no exception.
      expect(
        await recovered.editRelations(a, { addDependsOn: [b] }),
      ).toMatchObject({
        ok: false,
        reason: expect.stringContaining("release the active claim"),
      });
      await late.commitLater();
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) n FROM todo_relations WHERE from_todo_id = ?",
        )
          .bind(a)
          .first("n"),
      ).toBe(0);
      expect(await recovered.renew(a, "agent", 1, 600)).toMatchObject({
        ok: true,
      });
    });
  });

  it("retains a committed graph add after response loss and blocks claims/reopens until reconciliation", async () => {
    const { stub, a, b, userId } = await fixture();
    await stub.override(b, "console", "done", "prerequisite complete");
    await runInDurableObject(stub, async (_instance, state) => {
      const gate = delayedDatabase(env.DB, "batch", true);
      const coordinator = new TodoCoordinator(state, { DB: gate.db });
      const edit = coordinator.editRelations(a, { addDependsOn: [b] });
      await gate.committed;
      gate.resume();
      expect(await edit).toMatchObject({
        ok: false,
        reason: expect.stringContaining("outcome unknown"),
      });
      const recovered = new TodoCoordinator(state, { DB: env.DB });
      expect(await recovered.claim(a, "agent", 600)).toMatchObject({
        ok: false,
      });
      expect(
        await recovered.override(b, "console", "pending", "unsafe reopen"),
      ).toMatchObject({ ok: false });
      expect(
        await recovered.editRelations(a, { reconcile: true }),
      ).toMatchObject({ ok: true });
      expect(
        (await readTodoRelations(env.DB, userId, a)).depends_on,
      ).toMatchObject([{ id: `todo:${b}` }]);
      expect(await recovered.claim(a, "agent", 600)).toMatchObject({
        ok: true,
        token: 1,
      });
      expect(
        await recovered.override(b, "console", "pending", "still unsafe"),
      ).toMatchObject({
        ok: false,
        reason: expect.stringContaining("active dependent"),
      });
    });
  });

  it("fences every related-creation statement when its failed request commits after recovery", async () => {
    const { stub, b, provenance } = await fixture();
    const id = `tdo_${crypto.randomUUID()}`;
    await runInDurableObject(stub, async (_instance, state) => {
      const late = lateGraphDatabase(env.DB);
      const coordinator = new TodoCoordinator(state, { DB: late.db });
      expect(
        await coordinator.createRelated(
          id,
          {
            title: "must not appear late",
            project: "relations",
            parent: `todo:${b}`,
            depends_on: [`todo:${b}`],
          },
          provenance,
        ),
      ).toMatchObject({
        ok: false,
        reason: expect.stringContaining(`todo:${id}`),
      });
      const recovered = new TodoCoordinator(state, { DB: env.DB });
      expect(await recovered.claim(b, "agent", 600)).toMatchObject({
        ok: false,
      });
      expect(
        await recovered.editRelations(b, { reconcile: true }),
      ).toMatchObject({ ok: true });
      expect(await recovered.claim(b, "agent", 600)).toMatchObject({
        ok: true,
      });
      await late.commitLater();
      expect(
        await env.DB.prepare("SELECT todo_id FROM todos WHERE todo_id = ?")
          .bind(id)
          .first(),
      ).toBeNull();
      expect(
        await env.DB.prepare(
          "SELECT doc_key FROM search_docs WHERE doc_key = ?",
        )
          .bind(`todo:${id}`)
          .first(),
      ).toBeNull();
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) n FROM todo_relations WHERE from_todo_id = ?",
        )
          .bind(id)
          .first("n"),
      ).toBe(0);
    });
  });

  it("preserves all related-creation rows after committed response loss and exposes explicit recovery without replay", async () => {
    const { stub, b, provenance, userId } = await fixture();
    const id = `tdo_${crypto.randomUUID()}`;
    await runInDurableObject(stub, async (_instance, state) => {
      const gate = delayedDatabase(env.DB, "batch", true);
      const coordinator = new TodoCoordinator(state, { DB: gate.db });
      const create = coordinator.createRelated(
        id,
        {
          title: "created once",
          project: "relations",
          parent: `todo:${b}`,
          depends_on: [`todo:${b}`],
        },
        provenance,
      );
      await gate.committed;
      gate.resume();
      expect(await create).toMatchObject({
        ok: false,
        reason: expect.stringContaining("outcome unknown"),
      });
      const recovered = new TodoCoordinator(state, { DB: env.DB });
      expect(await recovered.claim(id, "agent", 600)).toMatchObject({
        ok: false,
        reason: expect.stringContaining("outcome unknown"),
      });
      expect(
        await recovered.editRelations(b, { reconcile: true }),
      ).toMatchObject({ ok: true });
      expect(
        await env.DB.prepare("SELECT COUNT(*) n FROM todos WHERE todo_id = ?")
          .bind(id)
          .first("n"),
      ).toBe(1);
      expect(
        await env.DB.prepare(
          "SELECT doc_key FROM search_docs WHERE doc_key = ?",
        )
          .bind(`todo:${id}`)
          .first("doc_key"),
      ).toBe(`todo:${id}`);
      expect(await readTodoRelations(env.DB, userId, id)).toMatchObject({
        parent: { id: `todo:${b}` },
        depends_on: [{ id: `todo:${b}` }],
      });
      expect(await recovered.claim(id, "agent", 600)).toMatchObject({
        ok: false,
        reason: expect.stringContaining("unfinished"),
      });
    });
  });

  it("keeps quarantine if the recovery fence response is lost; a second explicit recovery can safely retry", async () => {
    const { stub, a, b } = await fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const late = lateGraphDatabase(env.DB);
      const coordinator = new TodoCoordinator(state, { DB: late.db });
      await coordinator.editRelations(a, { addDependsOn: [b] });
      let armed = true;
      const failedRecovery = new Proxy(env.DB, {
        get(target, key) {
          if (key === "prepare")
            return (sql: string) => {
              const statement = target.prepare(sql);
              if (!sql.includes("INSERT INTO todo_relation_fences") || !armed)
                return statement;
              return new Proxy(statement, {
                get(stmt, property) {
                  if (property === "bind")
                    return (...args: unknown[]) => ({
                      run: async () => {
                        armed = false;
                        await stmt.bind(...args).run();
                        throw new Error("recovery fence response lost");
                      },
                    });
                  const value = Reflect.get(stmt, property);
                  return typeof value === "function" ? value.bind(stmt) : value;
                },
              });
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const recovery = new TodoCoordinator(state, { DB: failedRecovery });
      expect(
        await recovery.editRelations(a, { reconcile: true }),
      ).toMatchObject({ ok: false });
      expect(await recovery.claim(a, "agent", 600)).toMatchObject({
        ok: false,
      });
      const recovered = new TodoCoordinator(state, { DB: env.DB });
      expect(
        await recovered.editRelations(a, { reconcile: true }),
      ).toMatchObject({ ok: true });
      await late.commitLater();
      expect(await recovered.claim(a, "agent", 600)).toMatchObject({
        ok: true,
      });
    });
  });

  it("does not advance a claim fence when the relation store is unavailable", async () => {
    const { stub, a } = await fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const db = new Proxy(env.DB, {
        get(target, key) {
          if (key === "prepare")
            return (sql: string) => {
              if (sql.includes("FROM todo_relations WHERE"))
                throw new Error("relations unavailable");
              return target.prepare(sql);
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const coordinator = new TodoCoordinator(state, { DB: db });
      await expect(coordinator.claim(a, "agent", 600)).rejects.toThrow(
        "relations unavailable",
      );
      expect(
        await env.DB.prepare(
          "SELECT fencing_token FROM todos WHERE todo_id = ?",
        )
          .bind(a)
          .first("fencing_token"),
      ).toBe(0);
      expect(
        await coordinator.update(a, "agent", 1, "no lease", null),
      ).toMatchObject({ ok: false });
    });
  });

  it("limits dependency count and retains edges across coordinator storage loss", async () => {
    const { stub, a, b, make, userId } = await fixture();
    const dependencies = [b];
    for (let i = 0; i < 20; i++)
      dependencies.push(await make(`prerequisite ${i}`));
    expect(
      await stub.editRelations(a, { addDependsOn: dependencies }),
    ).toMatchObject({ ok: false });
    expect(
      await stub.editRelations(a, { addDependsOn: dependencies.slice(0, 20) }),
    ).toMatchObject({ ok: true });
    expect(
      await stub.editRelations(a, { addDependsOn: [dependencies[20]] }),
    ).toMatchObject({ ok: false });
    await stub.resetForDevelopment();
    expect(
      (await readTodoRelations(env.DB, userId, a)).depends_on,
    ).toHaveLength(20);
    expect(await stub.claim(a, "agent", 600)).toMatchObject({ ok: false });
  });

  it("organizes independently claimable children across projects without changing Markdown or cascading", async () => {
    const { stub, userId, a, b } = await fixture();
    expect(await stub.editRelations(a, { parent: b })).toMatchObject({
      ok: true,
    });
    const claimed = await stub.claim(a, "agent", 600);
    expect(claimed).toMatchObject({ ok: true });
    await stub.override(a, "console", "done", "child complete");
    const relations = await readTodoRelations(env.DB, userId, b);
    expect(relations.child_progress).toEqual({ done: 1, total: 1 });
    expect(relations.children).toMatchObject([
      { id: `todo:${a}`, state: "done" },
    ]);
    expect((await getTodo(env.DB, userId, b))?.state).toBe("pending");
    expect((await getTodo(env.DB, userId, a))?.body).toBe(
      "- [ ] Markdown step",
    );
    await stub.override(b, "console", "done", "parent complete");
    await stub.override(a, "console", "pending", "child reopen");
    expect((await getTodo(env.DB, userId, b))?.state).toBe("done");
  });

  it("requires every prerequisite's live completion and retains manual reasons when relations resolve", async () => {
    const { stub, userId, a, b, c } = await fixture();
    await stub.editRelations(a, { addDependsOn: [b, c] });
    expect(
      (await listReady(env.DB, userId)).map((todo) => todo.id),
    ).not.toContain(`todo:${a}`);
    expect(await stub.claim(a, "agent", 600)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("unfinished"),
    });
    await stub.claim(b, "agent", 600);
    await stub.complete(
      b,
      "agent",
      1,
      "boundary complete without mirror flush",
    );
    expect(await stub.claim(a, "agent", 600)).toMatchObject({ ok: false });
    await stub.claim(c, "agent", 600);
    await stub.complete(c, "agent", 1, "third complete without mirror flush");
    expect(await stub.claim(a, "agent", 600)).toMatchObject({
      ok: true,
      token: 1,
    });
    await stub.block(a, "agent", 1, "Owner approval still needed");
    await runInDurableObject(stub, async (instance) => {
      if (!(instance instanceof TodoCoordinator))
        throw new Error("expected coordinator");
      await instance.alarm();
    });
    await stub.editRelations(a, { removeDependsOn: [b, c] });
    expect((await getTodo(env.DB, userId, a))?.blockedOn).toBe(
      "Owner approval still needed",
    );
    expect(
      (await listReady(env.DB, userId)).map((todo) => todo.id),
    ).not.toContain(`todo:${a}`);
    // The existing explicit manual resolution-by-claim remains available.
    expect(await stub.claim(a, "next", 600)).toMatchObject({
      ok: true,
      token: 2,
    });
  });

  it("rejects self, missing and foreign endpoints without disclosing them, and rejects both cycle types", async () => {
    const { stub, a, b, c, userId } = await fixture();
    const foreign = await fixture();
    expect(await stub.editRelations(a, { parent: a })).toMatchObject({
      ok: false,
    });
    const absent = await stub.editRelations(a, { parent: "tdo_missing" });
    expect(await stub.editRelations(a, { parent: foreign.a })).toEqual(absent);
    await stub.editRelations(a, { parent: b, addDependsOn: [c] });
    await stub.editRelations(b, { parent: c });
    expect(await stub.editRelations(c, { parent: a })).toMatchObject({
      ok: false,
      reason: "parent cycle refused",
    });
    expect(await stub.editRelations(c, { addDependsOn: [a] })).toMatchObject({
      ok: false,
      reason: "depends-on cycle refused",
    });
    expect(await readTodoRelations(env.DB, foreign.userId, a)).toMatchObject({
      parent: null,
      children: [],
      depends_on: [],
      blocks: [],
    });
    expect(await readTodoRelations(env.DB, userId, foreign.a)).toMatchObject({
      parent: null,
      children: [],
      depends_on: [],
      blocks: [],
    });
    expect(await stub.editRelations(foreign.a, { parent: b })).toMatchObject({
      ok: false,
      holder: null,
      token: null,
    });
  });

  it("serializes opposing graph edits and keeps exactly one parent", async () => {
    const { stub, userId, a, b, c } = await fixture();
    const attempts = await Promise.all([
      stub.editRelations(a, { addDependsOn: [b] }),
      stub.editRelations(b, { addDependsOn: [a] }),
    ]);
    expect(attempts.filter((result) => result.ok)).toHaveLength(1);
    await Promise.all([
      stub.editRelations(a, { parent: b }),
      stub.editRelations(a, { parent: c }),
    ]);
    expect((await readTodoRelations(env.DB, userId, a)).parent?.id).toBe(
      `todo:${c}`,
    );
  });

  it("refuses bounded traversal overflow rather than assuming no cycle", async () => {
    const { stub, provenance, a } = await fixture();
    const ids = Array.from({ length: 257 }, () => `tdo_${crypto.randomUUID()}`);
    for (const id of ids)
      await env.DB.prepare(`INSERT INTO todos (todo_id,user_id,title,source_agent,created_at,updated_at)
      VALUES (?,?,'chain','test',1,1)`)
        .bind(id, provenance.userId)
        .run();
    for (let i = 0; i < ids.length - 1; i++)
      await env.DB.prepare(
        `INSERT INTO todo_relations VALUES (?, ?, ?, 'parent', 1)`,
      )
        .bind(provenance.userId, ids[i], ids[i + 1])
        .run();
    expect(await stub.editRelations(a, { parent: ids[0] })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("exceeds 256"),
    });
  });

  it("fences reopening against active dependents and permits it only after release", async () => {
    const { stub, a, b } = await fixture();
    await stub.editRelations(a, { addDependsOn: [b] });
    await stub.override(b, "console", "done", "done");
    expect(await stub.claim(a, "agent", 600)).toMatchObject({
      ok: true,
      token: 1,
    });
    expect(
      await stub.override(b, "console", "pending", "reopen"),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("active dependent"),
    });
    await stub.release(a, "agent", 1);
    expect(
      await stub.override(b, "console", "pending", "reopen"),
    ).toMatchObject({ ok: true, token: 2 });
    expect(await stub.claim(a, "agent", 600)).toMatchObject({ ok: false });
    expect(await stub.update(a, "agent", 1, "stale", null)).toMatchObject({
      ok: false,
      reason: "stale fencing token",
    });
  });

  it("fences a claim that reopens a done prerequisite against active dependents", async () => {
    const { stub, a, b } = await fixture();
    await stub.editRelations(a, { addDependsOn: [b] });
    await stub.override(b, "console", "done", "done");
    expect(await stub.claim(a, "agent", 600)).toMatchObject({
      ok: true,
      token: 1,
    });
    expect(await stub.claim(b, "other", 600)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("active dependent"),
    });
    await stub.release(a, "agent", 1);
    expect(await stub.claim(b, "other", 600)).toMatchObject({
      ok: true,
      token: 2,
    });
    expect(await stub.claim(a, "agent", 600)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("unfinished"),
    });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec("SELECT todo_id FROM uncertain_reopens")
          .toArray(),
      ).toEqual([]);
    });
  });

  it("does not grant across a dependency addition that commits before its D1 response returns", async () => {
    const { stub, a, b } = await fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const gate = delayedDatabase(env.DB, "batch");
      const coordinator = new TodoCoordinator(state, { DB: gate.db });
      const edit = coordinator.editRelations(a, { addDependsOn: [b] });
      await gate.committed;
      const claim = coordinator.claim(a, "agent", 600);
      gate.resume();
      expect(await edit).toMatchObject({ ok: true });
      expect(await claim).toMatchObject({
        ok: false,
        reason: expect.stringContaining("unfinished"),
      });
    });
  });

  it("refuses an unfinished dependency added after a claim has captured readiness", async () => {
    const { stub, a, b } = await fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const gate = delayedDatabase(env.DB, "edges");
      const coordinator = new TodoCoordinator(state, { DB: gate.db });
      const claim = coordinator.claim(a, "agent", 600);
      await gate.committed;
      const edit = coordinator.editRelations(a, { addDependsOn: [b] });
      gate.resume();
      expect(await claim).toMatchObject({ ok: true, token: 1 });
      expect(await edit).toMatchObject({
        ok: false,
        reason: expect.stringContaining("release the active claim"),
      });
    });
  });

  it("allows a conservative claim refusal during completion, then reads completion without waiting for its mirror", async () => {
    const { stub, a, b } = await fixture();
    await stub.editRelations(a, { addDependsOn: [b] });
    await stub.claim(b, "agent", 600);
    await runInDurableObject(stub, async (_instance, state) => {
      const gate = delayedDatabase(env.DB, "log");
      const coordinator = new TodoCoordinator(state, { DB: gate.db });
      const complete = coordinator.complete(b, "agent", 1, "done");
      await gate.committed;
      expect(await coordinator.claim(a, "agent", 600)).toMatchObject({
        ok: false,
      });
      gate.resume();
      expect(await complete).toMatchObject({ ok: true });
      expect(await coordinator.claim(a, "agent", 600)).toMatchObject({
        ok: true,
      });
    });
  });

  it("makes reopen wait for an admitted claim, then refuses rather than revoking its lease", async () => {
    const { stub, a, b } = await fixture();
    await stub.editRelations(a, { addDependsOn: [b] });
    await stub.override(b, "console", "done", "done");
    await runInDurableObject(stub, async (_instance, state) => {
      const gate = delayedDatabase(env.DB, "batch");
      const coordinator = new TodoCoordinator(state, { DB: gate.db });
      const claim = coordinator.claim(a, "agent", 600);
      await gate.committed;
      const reopen = coordinator.override(b, "console", "pending", "reopen");
      gate.resume();
      expect(await claim).toMatchObject({ ok: true, token: 1 });
      expect(await reopen).toMatchObject({
        ok: false,
        reason: expect.stringContaining("active dependent"),
      });
    });
  });

  it("blocks claims during a delayed reopen and quarantines an unknown reopen outcome across reconstruction", async () => {
    const { stub, a, b } = await fixture();
    await stub.editRelations(a, { addDependsOn: [b] });
    await stub.override(b, "console", "done", "done");
    await runInDurableObject(stub, async (_instance, state) => {
      const gate = delayedDatabase(env.DB, "batch", true);
      const coordinator = new TodoCoordinator(state, { DB: gate.db });
      const reopen = coordinator
        .override(b, "console", "pending", "reopen")
        .catch((error: Error) => error.message);
      await gate.committed;
      const claim = coordinator.claim(a, "agent", 600);
      gate.resume();
      expect(await reopen).toBe("D1 response lost");
      expect(await claim).toMatchObject({
        ok: false,
        reason: "dependency readiness unavailable",
      });
      const recovered = new TodoCoordinator(state, { DB: env.DB });
      expect(await recovered.claim(a, "agent", 600)).toMatchObject({
        ok: false,
      });
      expect(
        await recovered.override(b, "console", "pending", "explicit retry"),
      ).toMatchObject({ ok: true, token: 3 });
      expect(await recovered.claim(a, "agent", 600)).toMatchObject({
        ok: false,
        reason: expect.stringContaining("unfinished"),
      });
    });
    await stub.resetForDevelopment();
    expect(await stub.claim(a, "agent", 600)).toMatchObject({ ok: false });
  });

  it("fails closed on a corrupted foreign dependency without including its title or token", async () => {
    const { stub, userId, a } = await fixture();
    const foreign = await fixture();
    await env.DB.prepare(
      "INSERT INTO todo_relations VALUES (?, ?, ?, 'depends-on', 1)",
    )
      .bind(userId, a, foreign.b)
      .run();
    expect((await readTodoRelations(env.DB, userId, a)).depends_on).toEqual([]);
    expect(await stub.claim(a, "agent", 600)).toMatchObject({
      ok: false,
      reason: "dependency readiness unavailable",
    });
  });

  it("exposes creation and relation-only edits through existing tools without changing the closed lease receipt", async () => {
    const call = async (name: string, args: Record<string, unknown>) =>
      (await callMcp("tools/call", { name, arguments: args })).value.result;
    const parent = (
      await call("create_todo", { title: "parent", project: "relations" })
    ).structuredContent?.id as string;
    const prerequisite = (
      await call("create_todo", { title: "prerequisite", project: "platform" })
    ).structuredContent?.id as string;
    const created = await call("create_todo", {
      title: "child",
      project: "relations",
      parent,
      depends_on: [prerequisite],
    });
    const id = created.structuredContent?.id as string;
    expect(created.isError).not.toBe(true);
    const fetched = await call("fetch", { id });
    expect(fetched.structuredContent?.metadata).toMatchObject({
      relations: { parent: { id: parent }, depends_on: [{ id: prerequisite }] },
    });
    expect((await call("claim_todo", { id })).isError).toBe(true);
    const edited = await call("update_todo", {
      id,
      relations: { parent: null, remove_depends_on: [prerequisite] },
    });
    expect(edited.isError).not.toBe(true);
    expect(Object.keys(edited.structuredContent ?? {}).sort()).toEqual([
      "expires_at",
      "id",
      "token",
    ]);
    expect((await call("claim_todo", { id })).isError).not.toBe(true);
    expect(
      (await call("update_todo", { id, relations: { reconcile: true } }))
        .isError,
    ).not.toBe(true);
    expect(
      (
        await call("update_todo", {
          id,
          relations: { reconcile: true, parent },
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await call("update_todo", {
          id,
          relations: { add_depends_on: [prerequisite] },
        })
      ).isError,
    ).toBe(true);
    expect((await call("update_todo", { id, body: "no token" })).isError).toBe(
      true,
    );
    const before = await env.DB.prepare(
      "SELECT COUNT(*) n FROM todos",
    ).first<number>("n");
    expect(
      (
        await call("create_todo", {
          title: "must not exist",
          project: "relations",
          parent: "todo:tdo_missing",
        })
      ).isError,
    ).toBe(true);
    expect(
      await env.DB.prepare("SELECT COUNT(*) n FROM todos").first("n"),
    ).toBe(before);
  });
});
