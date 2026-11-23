import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { expect, it } from "vitest";
import { readTodoRelations } from "~/concepts/todo-relations";
import { getTodo, listReady } from "~/concepts/todos";

it("adopts a fresh recovery snapshot without replaying its old lease and keeps tenant fences independent", async () => {
  const owner = `recovery_${crypto.randomUUID()}`;
  const member = `recovery_${crypto.randomUUID()}`;
  const ownerStub = env.TODO_COORDINATOR.getByName(`todos:${owner}`);
  const memberStub = env.TODO_COORDINATOR.getByName(`todos:${member}`);
  const id = `tdo_${crypto.randomUUID()}`;
  const otherId = `tdo_${crypto.randomUUID()}`;
  // These are the restore serializer's outputs for a token-41 live claim:
  // owner unchanged, floor bumped, holder cleared, claim expired. Only the
  // coordinator can transition that state after first adoption.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO todos(todo_id,user_id,title,state,lease_holder,lease_expires_at,
         fencing_token,mirror_generation,source_agent,created_at,updated_at)
       VALUES(?,?,'Restored claim','claimed',NULL,0,42,9,'drill',1,2)`,
    ).bind(id, owner),
    env.DB.prepare(
      `INSERT INTO todos(todo_id,user_id,title,state,fencing_token,
         source_agent,created_at,updated_at)
       VALUES(?,?,'Restored other tenant','pending',1,'drill',1,2)`,
    ).bind(otherId, member),
  ]);
  try {
    expect(await ownerStub.renew(id, "old-agent", 41, 600)).toMatchObject({
      ok: false,
      reason: "stale fencing token",
    });
    expect(await ownerStub.claim(id, "recovered-agent", 600)).toMatchObject({
      ok: true,
      token: 43,
    });
    expect(await memberStub.claim(id, "recovered-agent", 600)).toEqual({
      ok: false,
      reason: "todo does not exist",
      holder: null,
      token: null,
    });
    expect(
      await ownerStub.complete(id, "old-agent", 41, "stale pre-recovery write"),
    ).toMatchObject({ ok: false, reason: "stale fencing token" });
    expect(
      await memberStub.claim(otherId, "recovered-agent", 600),
    ).toMatchObject({
      ok: true,
      token: 2,
    });
    await runDurableObjectAlarm(ownerStub);
    expect(
      await env.DB.prepare(
        "SELECT user_id,state,fencing_token,lease_holder FROM todos WHERE todo_id=?",
      )
        .bind(id)
        .first(),
    ).toEqual({
      user_id: owner,
      state: "claimed",
      fencing_token: 43,
      lease_holder: "recovered-agent",
    });
    expect(
      await ownerStub.complete(id, "recovered-agent", 43, "recovery verified"),
    ).toMatchObject({ ok: true });
  } finally {
    await ownerStub.resetForDevelopment();
    await memberStub.resetForDevelopment();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM todo_updates WHERE todo_id IN (?,?)").bind(
        id,
        otherId,
      ),
      env.DB.prepare("DELETE FROM todos WHERE todo_id IN (?,?)").bind(
        id,
        otherId,
      ),
    ]);
  }
});

it("adopts a restored parent/dependency graph in fresh coordinators without erasing manual blockers or replaying graph-operation fences", async () => {
  // New object identities model a fresh, unpublished destination installation.
  // No reset/deleteAll is used to turn an existing coordinator into recovery.
  const owner = `recovery_${crypto.randomUUID()}`;
  const member = `recovery_${crypto.randomUUID()}`;
  const ownerStub = env.TODO_COORDINATOR.getByName(`todos:${owner}`);
  const memberStub = env.TODO_COORDINATOR.getByName(`todos:${member}`);
  const parent = `tdo_${crypto.randomUUID()}`;
  const child = `tdo_${crypto.randomUUID()}`;
  const blocked = `tdo_${crypto.randomUUID()}`;
  const other = `tdo_${crypto.randomUUID()}`;
  const oldGraphToken = "00000000-0000-4000-8000-000000000101";
  const restoredGraphToken = `recovery:${"a".repeat(64)}`;
  const memberGraphToken = `recovery:${"b".repeat(64)}`;
  const history = `tdu_${crypto.randomUUID()}`;
  // Same transformed states/floors as the executable Node/Wrangler restore
  // fixture: parent stays done; child keeps its state but has no live lease;
  // manual reason and all authoritative edge timestamps are unchanged.
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO todos(todo_id,user_id,title,project,state,fencing_token,source_agent,created_at,updated_at)
      VALUES(?,?,'Recovered parent','platform','done',9,'drill',1,2)`).bind(
      parent,
      owner,
    ),
    env.DB.prepare(`INSERT INTO todos(todo_id,user_id,title,body,state,lease_holder,lease_expires_at,fencing_token,source_agent,created_at,updated_at)
      VALUES(?,?,'Recovered child','- [ ] Checklist stays separate','claimed',NULL,0,42,'drill',1,2)`).bind(
      child,
      owner,
    ),
    env.DB.prepare(`INSERT INTO todos(todo_id,user_id,title,project,state,blocked_on,fencing_token,source_agent,created_at,updated_at)
      VALUES(?,?,'Recovered dependent','integration','blocked','Owner approval remains outstanding',5,'drill',1,2)`).bind(
      blocked,
      owner,
    ),
    env.DB.prepare(`INSERT INTO todos(todo_id,user_id,title,state,fencing_token,source_agent,created_at,updated_at)
      VALUES(?,?,'Other owner','pending',1,'drill',1,2)`).bind(other, member),
    ...[
      [child, parent, "parent", 11],
      [blocked, parent, "parent", 12],
      [child, parent, "depends-on", 13],
      [blocked, child, "depends-on", 14],
      [blocked, parent, "depends-on", 15],
    ].map(([from, to, kind, created]) =>
      env.DB.prepare(
        "INSERT INTO todo_relations(user_id,from_todo_id,to_todo_id,kind,created_at) VALUES(?,?,?,?,?)",
      ).bind(owner, from, to, kind, created),
    ),
    env.DB.prepare(
      "INSERT INTO todo_relation_fences(user_id,token) VALUES(?,?),(?,?)",
    ).bind(owner, restoredGraphToken, member, memberGraphToken),
    env.DB.prepare(
      "INSERT INTO todo_updates(update_id,todo_id,kind,author,token,body,created_at) VALUES(?,?,'claim','old-agent',41,'Pre-recovery audit remains',2)",
    ).bind(history, child),
  ]);
  try {
    expect(await ownerStub.renew(child, "old-agent", 41, 600)).toMatchObject({
      ok: false,
      reason: "stale fencing token",
    });
    expect(await ownerStub.claim(blocked, "recovered", 600)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("unfinished"),
    });
    expect(await ownerStub.claim(child, "recovered", 600)).toMatchObject({
      ok: true,
      token: 43,
    });
    expect(
      await ownerStub.complete(child, "old-agent", 41, "stale snapshot write"),
    ).toMatchObject({ ok: false });
    expect(
      await ownerStub.complete(
        child,
        "recovered",
        43,
        "child finished after recovery",
      ),
    ).toMatchObject({ ok: true });
    await runDurableObjectAlarm(ownerStub);
    expect((await getTodo(env.DB, owner, blocked))?.blockedOn).toBe(
      "Owner approval remains outstanding",
    );
    expect((await getTodo(env.DB, owner, blocked))?.state).toBe("blocked");
    expect(
      (await listReady(env.DB, owner)).map((todo) => todo.id),
    ).not.toContain(`todo:${blocked}`);
    expect(
      (await readTodoRelations(env.DB, owner, parent)).child_progress,
    ).toEqual({ done: 1, total: 2 });
    expect((await getTodo(env.DB, owner, parent))?.state).toBe("done");
    expect((await getTodo(env.DB, owner, child))?.body).toBe(
      "- [ ] Checklist stays separate",
    );
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM todo_relations WHERE user_id=?",
      )
        .bind(owner)
        .first("n"),
    ).toBe(5);
    expect(
      await env.DB.prepare("SELECT body FROM todo_updates WHERE update_id=?")
        .bind(history)
        .first("body"),
    ).toBe("Pre-recovery audit remains");
    // The existing graph is immediately authoritative. The first new graph
    // operation admits its own UUID; no captured operation token is reused.
    expect(
      await ownerStub.editRelations(blocked, { addDependsOn: [parent] }),
    ).toMatchObject({ ok: true });
    expect(
      (
        await env.DB.prepare(
          "SELECT created_at FROM todo_relations WHERE user_id=? ORDER BY created_at",
        )
          .bind(owner)
          .all<{ created_at: number }>()
      ).results.map((row) => row.created_at),
    ).toEqual([11, 12, 13, 14, 15]);
    const newFence = await env.DB.prepare(
      "SELECT token FROM todo_relation_fences WHERE user_id=?",
    )
      .bind(owner)
      .first<string>("token");
    expect(newFence).not.toBe(restoredGraphToken);
    expect(newFence).toMatch(/^[a-f0-9-]{36}$/);
    expect(
      await env.DB.prepare(
        "SELECT user_id FROM todo_relation_fences WHERE user_id=? AND token IN (?,?)",
      )
        .bind(owner, oldGraphToken, restoredGraphToken)
        .all(),
    ).toMatchObject({ results: [] });
    expect(
      await env.DB.prepare(
        "SELECT token FROM todo_relation_fences WHERE user_id=?",
      )
        .bind(member)
        .first("token"),
    ).toBe(memberGraphToken);
    expect(await memberStub.editRelations(blocked, { parent: other })).toEqual({
      ok: false,
      reason: "todo does not exist",
      holder: null,
      token: null,
    });
    expect(await readTodoRelations(env.DB, member, parent)).toMatchObject({
      parent: null,
      children: [],
      depends_on: [],
      blocks: [],
    });
    // Only this explicit claim judges the manual blocker resolved. Completion
    // of the structured prerequisites above did not clear its free-text reason.
    expect(await ownerStub.claim(blocked, "recovered", 600)).toMatchObject({
      ok: true,
      token: 6,
    });
    expect(
      await ownerStub.override(parent, "console", "pending", "unsafe reopen"),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("active dependent"),
    });
    await runInDurableObject(ownerStub, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) n FROM uncertain_graph_write")
          .one().n,
      ).toBe(0);
      expect(
        state.storage.sql.exec("SELECT COUNT(*) n FROM uncertain_reopens").one()
          .n,
      ).toBe(0);
    });
  } finally {
    // Test teardown only, after every admitted RPC has settled; never a restore
    // recipe for a live namespace with unknown in-flight D1 operations.
    await ownerStub.resetForDevelopment();
    await memberStub.resetForDevelopment();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM todo_relations WHERE user_id IN (?,?)").bind(
        owner,
        member,
      ),
      env.DB.prepare(
        "DELETE FROM todo_relation_fences WHERE user_id IN (?,?)",
      ).bind(owner, member),
      env.DB.prepare(
        "DELETE FROM todo_updates WHERE todo_id IN (?,?,?,?)",
      ).bind(parent, child, blocked, other),
      env.DB.prepare("DELETE FROM todos WHERE todo_id IN (?,?,?,?)").bind(
        parent,
        child,
        blocked,
        other,
      ),
    ]);
  }
});
