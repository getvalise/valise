import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachMemoryFile,
  attachTodoFile,
  listMemoryAttachments,
  listTodoAttachments,
  setFileAttached,
} from "~/concepts/attachments";
import { archiveMemory, saveMemory } from "~/concepts/memories";
import { createTodo } from "~/concepts/todos";
import { MAX_OBJECT_BYTES, ObjectRefused, serveObject } from "~/r2/objects";

const provenance = {
  userId: "local",
  agent: "vitest",
  client: "test",
  session: null,
};

afterEach(async () => {
  for (const table of [
    "todo_attachments",
    "memory_attachments",
    "objects",
    "search_docs",
    "todos",
    "memory_revisions",
    "memories",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  const listed = await env.BUNDLES.list();
  if (listed.objects.length) {
    await env.BUNDLES.delete(listed.objects.map((object) => object.key));
  }
});

describe("memory attachments", () => {
  it("uses the same immutable owner storage, without deduplicating uploads", async () => {
    const memory = await saveMemory(
      env,
      { type: "fact", title: "Diagram", body: "Read the diagram.", tags: [] },
      provenance,
    );
    const id = memory.id.slice("memory:".length);
    const file = new File(["diagram"], "../diagram.svg", {
      type: "image/svg+xml",
    });
    const first = await attachMemoryFile(env, "local", id, file);
    const second = await attachMemoryFile(env, "local", id, file);
    expect(first).toMatchObject({ name: "diagram.svg", size: 7 });
    expect(first?.objectId).not.toBe(second?.objectId);
    expect(
      (await listMemoryAttachments(env.DB, "local", [id])).get(id),
    ).toHaveLength(2);
    expect((await listMemoryAttachments(env.DB, "other", [id])).size).toBe(0);
    const served = await serveObject(env, "local", first?.objectId ?? "");
    expect(served?.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(await served?.text()).toBe("diagram");
  });

  it("refuses missing and archived targets before writing bytes", async () => {
    const memory = await saveMemory(
      env,
      { type: "fact", title: "Archived", body: "Gone from search.", tags: [] },
      provenance,
    );
    expect(
      await archiveMemory(env, "local", memory.id.slice("memory:".length)),
    ).toBe(true);
    for (const id of ["missing", memory.id.slice("memory:".length)]) {
      expect(
        await attachMemoryFile(env, "local", id, new File(["x"], "x.txt")),
      ).toBeNull();
    }
    expect((await env.BUNDLES.list()).objects).toHaveLength(0);
  });

  it("rolls back the object row when the memory link cannot be inserted", async () => {
    const memory = await saveMemory(
      env,
      { type: "fact", title: "Atomic", body: "One batch.", tags: [] },
      provenance,
    );
    await env.DB.prepare(
      "CREATE TRIGGER refuse_memory_file BEFORE INSERT ON memory_attachments BEGIN SELECT RAISE(ABORT, 'test refusal'); END",
    ).run();
    try {
      await expect(
        attachMemoryFile(
          env,
          "local",
          memory.id.slice("memory:".length),
          new File(["kept orphan"], "x.txt"),
        ),
      ).rejects.toThrow(/test refusal/);
      expect(
        await env.DB.prepare("SELECT count(*) AS n FROM objects").first("n"),
      ).toBe(0);
      // ADR-0011 accepts orphaned bytes, never a link without its owner row.
      expect((await env.BUNDLES.list()).objects).toHaveLength(1);
    } finally {
      await env.DB.prepare("DROP TRIGGER refuse_memory_file").run();
    }
  });
});

async function todo(): Promise<string> {
  const created = await createTodo(
    env,
    { title: "Has a file", project: "valise" },
    provenance,
  );
  return created.id.slice("todo:".length);
}

describe("to-do attachments", () => {
  it("removes and restores only this link, retaining owned rows and bytes", async () => {
    const todoId = await todo();
    const otherTodoId = await todo();
    const file = await attachTodoFile(
      env,
      "local",
      todoId,
      new File(["keep"], "keep.txt"),
    );
    if (file === null) throw new Error("fixture file missing");
    const target = { concept: "todo", id: todoId } as const;
    const shared = { concept: "todo", id: otherTodoId } as const;
    expect(
      await setFileAttached(env.DB, "local", shared, file.objectId, true),
    ).toBe(true);
    for (let i = 0; i < 2; i++) {
      expect(
        await setFileAttached(env.DB, "local", target, file.objectId, false),
      ).toBe(true);
    }
    const listing = await listTodoAttachments(env.DB, "local", [
      todoId,
      otherTodoId,
    ]);
    expect(listing.has(todoId)).toBe(false);
    expect(listing.get(otherTodoId)).toHaveLength(1);
    const response = await serveObject(env, "local", file.objectId);
    expect(await response?.text()).toBe("keep");
    for (let i = 0; i < 2; i++) {
      expect(
        await setFileAttached(env.DB, "local", target, file.objectId, true),
      ).toBe(true);
    }
    expect(
      (await listTodoAttachments(env.DB, "local", [todoId])).get(todoId),
    ).toHaveLength(1);
    expect((await env.BUNDLES.list()).objects).toHaveLength(1);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM objects").first("n"),
    ).toBe(1);
  });

  it("refuses cross-owner restore/removal and missing or archived targets", async () => {
    const todoId = await todo();
    const memory = await saveMemory(
      env,
      { type: "fact", title: "Target", body: "Target evidence.", tags: [] },
      provenance,
    );
    const file = await attachTodoFile(
      env,
      "local",
      todoId,
      new File(["secret"], "s.txt"),
    );
    if (file === null) throw new Error("fixture file missing");
    for (const attached of [true, false]) {
      expect(
        await setFileAttached(
          env.DB,
          "other",
          { concept: "todo", id: todoId },
          file.objectId,
          attached,
        ),
      ).toBe(false);
      expect(
        await setFileAttached(
          env.DB,
          "local",
          { concept: "todo", id: "missing" },
          file.objectId,
          attached,
        ),
      ).toBe(false);
    }
    const target = {
      concept: "memory",
      id: memory.id.slice("memory:".length),
    } as const;
    expect(
      await setFileAttached(env.DB, "local", target, file.objectId, true),
    ).toBe(true);
    expect(
      await setFileAttached(env.DB, "local", target, file.objectId, false),
    ).toBe(true);
    await archiveMemory(env, "local", target.id);
    expect(
      await setFileAttached(env.DB, "local", target, file.objectId, true),
    ).toBe(false);
    expect(
      (await listTodoAttachments(env.DB, "local", [todoId])).get(todoId),
    ).toHaveLength(1);
  });

  it("stores a file under the user's prefix and lists it on the to-do", async () => {
    const todoId = await todo();
    const attached = await attachTodoFile(
      env,
      "local",
      todoId,
      new File(["PNG fake!"], "shots/screen.png", { type: "image/png" }),
    );
    expect(attached).toMatchObject({ name: "screen.png", size: 9 });

    const listed = (await env.BUNDLES.list()).objects.map((o) => o.key);
    expect(listed).toEqual([`u/local/objects/${attached?.objectId}`]);

    const files = await listTodoAttachments(env.DB, "local", [todoId]);
    expect(files.get(todoId)?.map((file) => file.name)).toEqual(["screen.png"]);
    // Another user's listing of the same to-do holds none of local's files.
    expect((await listTodoAttachments(env.DB, "other", [todoId])).size).toBe(0);
  });

  it("serves an image inline and anything else as a download", async () => {
    const todoId = await todo();
    const image = await attachTodoFile(
      env,
      "local",
      todoId,
      new File(["img"], "a.png", { type: "image/png" }),
    );
    const page = await attachTodoFile(
      env,
      "local",
      todoId,
      new File(["<script>alert(1)</script>"], "x.html", { type: "text/html" }),
    );

    const inline = await serveObject(env, "local", image?.objectId ?? "");
    expect(inline?.headers.get("content-type")).toBe("image/png");
    expect(inline?.headers.get("content-disposition")).toMatch(/^inline/);
    expect(await inline?.text()).toBe("img");

    const download = await serveObject(env, "local", page?.objectId ?? "");
    expect(download?.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(download?.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''x.html",
    );
    expect(download?.headers.get("x-content-type-options")).toBe("nosniff");
    await download?.body?.cancel();
  });

  it("answers another user's object id as missing", async () => {
    const todoId = await todo();
    const attached = await attachTodoFile(
      env,
      "local",
      todoId,
      new File(["secret"], "s.txt", { type: "text/plain" }),
    );
    expect(await serveObject(env, "other", attached?.objectId ?? "")).toBe(
      null,
    );
  });

  it("refuses an empty or oversized file and writes nothing", async () => {
    const todoId = await todo();
    await expect(
      attachTodoFile(env, "local", todoId, new File([], "empty.txt")),
    ).rejects.toBeInstanceOf(ObjectRefused);
    await expect(
      attachTodoFile(
        env,
        "local",
        todoId,
        new File([new Uint8Array(MAX_OBJECT_BYTES + 1)], "big.bin"),
      ),
    ).rejects.toThrow(/limit is 10 MB/);
    expect((await env.BUNDLES.list()).objects).toHaveLength(0);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM objects").first("n"),
    ).toBe(0);
  });

  it("writes no bytes for a to-do that does not exist", async () => {
    expect(
      await attachTodoFile(
        env,
        "local",
        "tdo_missing",
        new File(["x"], "x.txt"),
      ),
    ).toBe(null);
    expect((await env.BUNDLES.list()).objects).toHaveLength(0);
  });
});
