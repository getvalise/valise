import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { createTodo } from "~/concepts/todos";
import { TodoCoordinator } from "~/do/todo-coordinator";

type Stub = DurableObjectStub<TodoCoordinator>;
const stubs: Stub[] = [];
const missing = {
  ok: false,
  reason: "todo does not exist",
  holder: null,
  token: null,
};

afterEach(async () => {
  for (const stub of stubs) await stub.resetForDevelopment();
  stubs.length = 0;
  for (const table of ["search_docs", "todo_updates", "todos"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

async function fixture() {
  const userId = `usr_${crypto.randomUUID()}`;
  const stub = env.TODO_COORDINATOR.getByName(`todos:${userId}`);
  stubs.push(stub);
  const todo = await createTodo(
    env,
    { title: "Same title in each tenant", project: "coordination" },
    { userId, agent: "shared-agent", client: "test", session: null },
  );
  return { userId, stub, id: todo.id.slice("todo:".length) };
}

async function snapshot(id: string) {
  return {
    todo: await env.DB.prepare("SELECT * FROM todos WHERE todo_id = ?")
      .bind(id)
      .first(),
    updates: (
      await env.DB.prepare(
        "SELECT * FROM todo_updates WHERE todo_id = ? ORDER BY update_id",
      )
        .bind(id)
        .all()
    ).results,
  };
}

async function seedForeignCache(stub: Stub, id: string, expired = false) {
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO coordinator_todos
        (todo_id, state, lease_holder, lease_expires_at, fencing_token,
         mirror_generation, blocked_on, completed_at)
       VALUES (?, 'claimed', 'shared-agent', ?, 1, 2, NULL, NULL)`,
      id,
      expired ? 0 : Math.floor(Date.now() / 1000) + 600,
    );
  });
}

const operations: [string, (stub: Stub, id: string) => Promise<unknown>][] = [
  ["claim", (stub, id) => stub.claim(id, "shared-agent", 60)],
  ["renew", (stub, id) => stub.renew(id, "shared-agent", 1, 60)],
  ["update", (stub, id) => stub.update(id, "shared-agent", 1, "foreign", 60)],
  ["block", (stub, id) => stub.block(id, "shared-agent", 1, "foreign")],
  ["complete", (stub, id) => stub.complete(id, "shared-agent", 1, "foreign")],
  ["release", (stub, id) => stub.release(id, "shared-agent", 1)],
  [
    "override pending",
    (stub, id) => stub.override(id, "console", "pending", "foreign"),
  ],
  [
    "override blocked",
    (stub, id) => stub.override(id, "console", "blocked", "foreign"),
  ],
  [
    "override done",
    (stub, id) => stub.override(id, "console", "done", "foreign"),
  ],
];

describe("coordinator tenant identity", () => {
  it.each([
    undefined,
    "other:local",
    "todos:",
    "todos: ",
    "todos:local:other",
    "todos:local\n",
  ])("rejects object identity %s before adopting a to-do", async (name) => {
    const owner = await fixture();
    const before = await snapshot(owner.id);
    const stub =
      name === undefined
        ? env.TODO_COORDINATOR.get(env.TODO_COORDINATOR.newUniqueId())
        : env.TODO_COORDINATOR.getByName(name);
    // Catch inside the object: the pool's RPC wrapper reports a rejected
    // method as an unhandled rejection even when the caller awaits it.
    await runInDurableObject(stub, async (instance, state) => {
      if (!(instance instanceof TodoCoordinator)) {
        throw new Error("expected TodoCoordinator");
      }
      const error = "TodoCoordinator requires a todos:<user_id> identity";
      await expect(
        instance.claim(owner.id, "shared-agent", 60),
      ).rejects.toThrow(error);
      await expect(instance.alarm()).rejects.toThrow(error);
      await expect(instance.resetForDevelopment()).rejects.toThrow(error);
      expect(
        state.storage.sql
          .exec(
            "SELECT name FROM sqlite_master WHERE name = 'coordinator_todos'",
          )
          .toArray(),
      ).toEqual([]);
    });
    expect(await snapshot(owner.id)).toEqual(before);
  });

  describe.each([false, true])("foreign ID with cached state: %s", (cached) => {
    it.each(operations)(
      "refuses %s without exposing the lease or writing",
      async (_name, operate) => {
        const owner = await fixture();
        const other = await fixture();
        expect(
          await owner.stub.claim(owner.id, "shared-agent", 600),
        ).toMatchObject({ ok: true, token: 1 });
        await runDurableObjectAlarm(owner.stub);
        if (cached) await seedForeignCache(other.stub, owner.id);
        const before = await snapshot(owner.id);

        expect(await operate(other.stub, owner.id)).toEqual(missing);
        expect(await snapshot(owner.id)).toEqual(before);
        const adopted = await runInDurableObject(
          other.stub,
          async (_instance, state) =>
            state.storage.sql
              .exec(
                "SELECT todo_id FROM coordinator_todos WHERE todo_id = ?",
                owner.id,
              )
              .toArray(),
        );
        expect(adopted).toEqual([]);
        expect(
          await owner.stub.renew(owner.id, "shared-agent", 1, 600),
        ).toMatchObject({ ok: true });
      },
    );
  });

  it.each([false, true])(
    "does not expire or mirror a restored foreign row (queued: %s)",
    async (queued) => {
      const owner = await fixture();
      const other = await fixture();
      await owner.stub.claim(owner.id, "shared-agent", 600);
      await runDurableObjectAlarm(owner.stub);
      await seedForeignCache(other.stub, owner.id, true);
      await runInDurableObject(other.stub, async (_instance, state) => {
        if (queued) {
          state.storage.sql.exec(
            "INSERT INTO mirror_queue VALUES (?, 2)",
            owner.id,
          );
        }
        await state.storage.setAlarm(Date.now() + 60_000);
      });
      const before = await snapshot(owner.id);
      expect(await runDurableObjectAlarm(other.stub)).toBe(true);
      expect(await snapshot(owner.id)).toEqual(before);
      const remaining = await runInDurableObject(
        other.stub,
        async (_instance, state) => ({
          todos: state.storage.sql
            .exec("SELECT * FROM coordinator_todos")
            .toArray(),
          queue: state.storage.sql.exec("SELECT * FROM mirror_queue").toArray(),
          alarm: await state.storage.getAlarm(),
        }),
      );
      expect(remaining).toEqual({ todos: [], queue: [], alarm: null });
    },
  );

  it("keeps independent same-title leases, expiry, restore fencing and console overrides", async () => {
    const alice = await fixture();
    const bob = await fixture();
    const first = await alice.stub.claim(alice.id, "shared-agent", 60);
    expect(first).toMatchObject({ ok: true, token: 1 });
    expect(await bob.stub.claim(bob.id, "shared-agent", 60)).toMatchObject({
      ok: true,
      token: 1,
    });
    await runDurableObjectAlarm(bob.stub);
    const bobBefore = await snapshot(bob.id);

    expect(
      await alice.stub.renew(alice.id, "shared-agent", 1, 600),
    ).toMatchObject({ ok: true });
    expect(
      await alice.stub.update(alice.id, "shared-agent", 1, "progress", null),
    ).toMatchObject({ ok: true });
    expect(
      await alice.stub.block(alice.id, "shared-agent", 1, "dependency"),
    ).toMatchObject({ ok: true });
    expect(await alice.stub.claim(alice.id, "next-agent", 60)).toMatchObject({
      ok: true,
      token: 2,
    });
    expect(await alice.stub.release(alice.id, "next-agent", 2)).toMatchObject({
      ok: true,
    });
    expect(await alice.stub.claim(alice.id, "next-agent", 60)).toMatchObject({
      ok: true,
      token: 3,
    });
    await runInDurableObject(alice.stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE coordinator_todos SET lease_expires_at = 0 WHERE todo_id = ?",
        alice.id,
      );
    });
    expect(await runDurableObjectAlarm(alice.stub)).toBe(true);
    await alice.stub.resetForDevelopment();
    expect(
      await alice.stub.claim(alice.id, "restored-agent", 60),
    ).toMatchObject({ ok: true, token: 4 });
    expect(
      await alice.stub.complete(alice.id, "next-agent", 3, "stale"),
    ).toMatchObject({ ok: false, reason: "stale fencing token" });
    expect(
      await alice.stub.complete(alice.id, "restored-agent", 4, "done"),
    ).toMatchObject({ ok: true });
    await runDurableObjectAlarm(alice.stub);
    expect((await snapshot(alice.id)).todo).toMatchObject({
      state: "done",
      fencing_token: 4,
    });
    expect(
      await alice.stub.override(alice.id, "console", "pending", "reopen"),
    ).toMatchObject({ ok: true, token: 5 });
    expect(
      await alice.stub.claim(alice.id, "restored-agent", 60),
    ).toMatchObject({ ok: true, token: 6 });
    expect(
      await alice.stub.override(alice.id, "console", "done", "override"),
    ).toMatchObject({ ok: true, token: 7 });
    expect(
      await alice.stub.update(alice.id, "restored-agent", 6, "stale", null),
    ).toMatchObject({ ok: false, reason: "stale fencing token" });
    expect((await snapshot(alice.id)).updates.map((row) => row.kind)).toEqual([
      "claim",
      "progress",
      "blocked",
      "claim",
      "release",
      "claim",
      "release",
      "claim",
      "complete",
      "release",
      "claim",
      "complete",
    ]);
    expect(await snapshot(bob.id)).toEqual(bobBefore);
  });
});
