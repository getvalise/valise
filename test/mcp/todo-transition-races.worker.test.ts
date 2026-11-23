import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { createTodo } from "~/concepts/todos";
import { TodoCoordinator } from "~/do/todo-coordinator";

const stubs: DurableObjectStub<TodoCoordinator>[] = [];

afterEach(async () => {
  for (const stub of stubs) await stub.resetForDevelopment();
  stubs.length = 0;
  for (const table of ["search_docs", "todo_updates", "todos"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Run real D1, then hold exactly one successful response at its await boundary. */
function delayedDatabase(db: D1Database, read = false, failResponse = false) {
  const committed = deferred();
  const resume = deferred();
  let armed = true;
  async function delayed<T>(result: Promise<T>): Promise<T> {
    const value = await result;
    if (armed) {
      armed = false;
      committed.resolve();
      await resume.promise;
      if (failResponse) throw new Error("D1 response lost");
    }
    return value;
  }
  function statement(stmt: D1PreparedStatement): D1PreparedStatement {
    return new Proxy(stmt, {
      get(target, key) {
        if (key === "bind")
          return (...args: unknown[]) => statement(target.bind(...args));
        if (key === "run" && !read) return () => delayed(target.run());
        if (key === "first" && read)
          return (...args: Parameters<D1PreparedStatement["first"]>) =>
            delayed(target.first(...args));
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  return {
    committed: committed.promise,
    resume: resume.resolve,
    db: new Proxy(db, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => statement(target.prepare(sql));
        if (key === "batch" && !read)
          return (statements: D1PreparedStatement[]) =>
            delayed(target.batch(statements));
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
}

async function fixture() {
  const userId = `usr_${crypto.randomUUID()}`;
  const stub = env.TODO_COORDINATOR.getByName(`todos:${userId}`);
  stubs.push(stub);
  const ids = await Promise.all(
    ["delayed", "independent"].map(async (title) => {
      const todo = await createTodo(
        env,
        { title, project: "races" },
        {
          userId,
          agent: "agent",
          client: "test",
          session: null,
        },
      );
      return todo.id.slice("todo:".length);
    }),
  );
  return { stub, id: ids[0], otherId: ids[1] };
}

const transitions = [
  {
    name: "complete",
    run: (c: TodoCoordinator, id: string) =>
      c.complete(id, "agent", 1, "first"),
    next: "pending" as const,
  },
  {
    name: "block",
    run: (c: TodoCoordinator, id: string) => c.block(id, "agent", 1, "first"),
    next: "done" as const,
  },
  {
    name: "release",
    run: (c: TodoCoordinator, id: string) => c.release(id, "agent", 1),
    next: "done" as const,
  },
  {
    name: "update",
    run: (c: TodoCoordinator, id: string) =>
      c.update(id, "agent", 1, "first", 600),
    next: "done" as const,
  },
  {
    name: "renew",
    run: (c: TodoCoordinator, id: string) => c.renew(id, "agent", 1, 600),
    next: "done" as const,
  },
  {
    name: "claim",
    run: (c: TodoCoordinator, id: string) => c.claim(id, "agent", 600),
    next: "done" as const,
  },
  {
    name: "override",
    run: (c: TodoCoordinator, id: string) =>
      c.override(id, "console", "blocked", "first"),
    next: "done" as const,
  },
];

describe("same-to-do transitions across delayed D1 responses", () => {
  it("rejects a queued same-token transition after completion commits", async () => {
    const { stub, id } = await fixture();
    await stub.claim(id, "agent", 600);
    await runInDurableObject(stub, async (_instance, state) => {
      const gate = delayedDatabase(env.DB);
      const coordinator = new TodoCoordinator(state, { DB: gate.db });
      const complete = coordinator.complete(id, "agent", 1, "first");
      await gate.committed;
      const block = coordinator.block(id, "agent", 1, "too late");
      gate.resume();
      expect(await complete).toMatchObject({ ok: true });
      expect(await block).toMatchObject({
        ok: false,
        reason: "stale fencing token",
      });
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM todo_updates WHERE todo_id = ? AND kind = 'blocked'",
        )
          .bind(id)
          .first("n"),
      ).toBe(0);
      await coordinator.alarm();
      expect(
        await env.DB.prepare("SELECT state FROM todos WHERE todo_id = ?")
          .bind(id)
          .first("state"),
      ).toBe("done");
    });
  });

  it("releases the per-to-do queue when a D1 response rejects", async () => {
    const { stub, id } = await fixture();
    await stub.claim(id, "agent", 600);
    await runInDurableObject(stub, async (_instance, state) => {
      const gate = delayedDatabase(env.DB, false, true);
      const coordinator = new TodoCoordinator(state, { DB: gate.db });
      const complete = coordinator
        .complete(id, "agent", 1, "first")
        .catch((error: Error) => error.message);
      await gate.committed;
      const override = coordinator.override(
        id,
        "console",
        "pending",
        "recover",
      );
      gate.resume();
      expect(await complete).toBe("D1 response lost");
      expect(await override).toMatchObject({ ok: true, token: 2 });
      expect(await coordinator.claim(id, "next-agent", 600)).toMatchObject({
        ok: true,
        token: 3,
      });
    });
  });

  it.each(transitions)(
    "serializes $name with an override while another to-do progresses",
    async ({ name, run, next }) => {
      const { stub, id, otherId } = await fixture();
      if (name !== "claim")
        expect(await stub.claim(id, "agent", 600)).toMatchObject({
          ok: true,
          token: 1,
        });

      await runInDurableObject(stub, async (_instance, state) => {
        const gate = delayedDatabase(env.DB, name === "renew");
        const coordinator = new TodoCoordinator(state, { DB: gate.db });
        const first = run(coordinator, id);
        await gate.committed;
        const override = coordinator.override(id, "console", next, "second");
        try {
          // A different to-do in this same tenant must not wait for the response.
          expect(await coordinator.claim(otherId, "other", 600)).toMatchObject({
            ok: true,
            token: 1,
          });
          expect(
            await env.DB.prepare(
              "SELECT COUNT(*) AS n FROM todo_updates WHERE todo_id = ? AND body = 'second'",
            )
              .bind(id)
              .first("n"),
          ).toBe(0);
        } finally {
          gate.resume();
          await Promise.allSettled([first, override]);
        }
        expect(await first).toMatchObject({ ok: true });
        const token = name === "override" ? 3 : 2;
        expect(await override).toMatchObject({ ok: true, token });
        expect(
          state.storage.sql
            .exec(
              "SELECT state, fencing_token FROM coordinator_todos WHERE todo_id = ?",
              id,
            )
            .one(),
        ).toEqual({ state: next, fencing_token: token });
        expect(
          await env.DB.prepare(
            "SELECT state, fencing_token FROM todos WHERE todo_id = ?",
          )
            .bind(id)
            .first(),
        ).toEqual({ state: next, fencing_token: token });
        expect(
          await coordinator.override(
            id,
            "console",
            next === "done" ? "pending" : "done",
            "third",
          ),
        ).toMatchObject({ ok: true, token: token + 1 });
        expect(
          await coordinator.update(id, "agent", 1, "stale", null),
        ).toMatchObject({ ok: false, reason: "stale fencing token" });
      });
    },
  );

  it("serializes an expiry release whose successful D1 response is delayed", async () => {
    const { stub, id, otherId } = await fixture();
    await stub.claim(id, "agent", 600);
    await runInDurableObject(stub, async (instance, state) => {
      if (!(instance instanceof TodoCoordinator))
        throw new Error("expected TodoCoordinator");
      await instance.alarm();
      state.storage.sql.exec(
        "UPDATE coordinator_todos SET lease_expires_at = 0 WHERE todo_id = ?",
        id,
      );
      const gate = delayedDatabase(env.DB);
      const coordinator = new TodoCoordinator(state, { DB: gate.db });
      const expiry = coordinator.alarm();
      await gate.committed;
      const override = coordinator.override(id, "console", "done", "second");
      try {
        expect(await coordinator.claim(otherId, "other", 600)).toMatchObject({
          ok: true,
        });
        expect(
          await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM todo_updates WHERE todo_id = ? AND body = 'second'",
          )
            .bind(id)
            .first("n"),
        ).toBe(0);
      } finally {
        gate.resume();
        await Promise.allSettled([expiry, override]);
      }
      expect(await override).toMatchObject({ ok: true, token: 2 });
      expect(
        state.storage.sql
          .exec(
            "SELECT state, fencing_token FROM coordinator_todos WHERE todo_id = ?",
            id,
          )
          .one(),
      ).toEqual({ state: "done", fencing_token: 2 });
      expect(
        await coordinator.override(id, "console", "pending", "third"),
      ).toMatchObject({ ok: true, token: 3 });
    });
  });

  it("rechecks an expired snapshot after waiting behind a re-claim", async () => {
    const { stub, id, otherId } = await fixture();
    await stub.claim(id, "agent", 600);
    await runInDurableObject(stub, async (instance, state) => {
      if (!(instance instanceof TodoCoordinator))
        throw new Error("expected TodoCoordinator");
      await instance.alarm();
      state.storage.sql.exec(
        "UPDATE coordinator_todos SET lease_expires_at = 0 WHERE todo_id = ?",
        id,
      );
      const gate = delayedDatabase(env.DB);
      const coordinator = new TodoCoordinator(state, { DB: gate.db });
      const claim = coordinator.claim(id, "next-agent", 600);
      await gate.committed;
      const alarm = coordinator.alarm();
      try {
        await coordinator.claim(otherId, "other", 600);
      } finally {
        gate.resume();
        await Promise.allSettled([claim, alarm]);
      }
      expect(await claim).toMatchObject({ ok: true, token: 2 });
      expect(
        state.storage.sql
          .exec(
            "SELECT state, lease_holder, fencing_token FROM coordinator_todos WHERE todo_id = ?",
            id,
          )
          .one(),
      ).toEqual({
        state: "claimed",
        lease_holder: "next-agent",
        fencing_token: 2,
      });
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM todo_updates WHERE todo_id = ? AND kind = 'release'",
        )
          .bind(id)
          .first("n"),
      ).toBe(0);
      expect(await coordinator.renew(id, "next-agent", 2, 600)).toMatchObject({
        ok: true,
      });
    });
  });
});
