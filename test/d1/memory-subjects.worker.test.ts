import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  archiveMemory,
  editMemory,
  getMemory,
  listMemoryRevisions,
  saveMemory,
} from "~/concepts/memories";
import { assertPersonMemoryLink } from "~/concepts/memory-links";
import {
  changeSubjectMember,
  createSubject,
  createSubjectSummary,
  editSubject,
  findSubjectByName,
  getSubject,
  listMemorySubjects,
  listSubjectMembers,
  listSubjects,
  setSubjectDeleted,
  setSubjectSummary,
} from "~/concepts/memory-subjects";
import { search } from "~/search/query";

const db = env.DB;
const owner = {
  userId: "local",
  agent: "console",
  client: "web",
  session: null,
};
const member = { ...owner, userId: "member" };
const raw = (id: string) => id.slice("memory:".length);
const save = (title: string, user = owner) =>
  saveMemory(
    env,
    {
      title,
      body: `evidence ${title}`,
      type: "fact",
      tags: ["topic"],
      project: "valise",
    },
    user,
  );
const create = async (name: string, user = owner) =>
  (
    await createSubject(db, user.userId, {
      name,
      kind: "topic",
      description: "",
    })
  ).id;

afterEach(async () => {
  for (const table of [
    "memory_subject_members",
    "memory_subjects",
    "memory_review_pending",
    "search_docs",
    "memory_links",
    "memory_revisions",
    "memories",
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
});

describe("memory subjects", () => {
  it("keeps multi-subject identity and sources searchable, revisioned and independent", async () => {
    const a = await save("first");
    const b = await save("second");
    const one = await create("Mehdi");
    const two = await create("Conference");
    expect(await changeSubjectMember(db, one, raw(a.id), "add", "local")).toBe(
      true,
    );
    expect(await changeSubjectMember(db, one, raw(b.id), "add", "local")).toBe(
      true,
    );
    expect(await changeSubjectMember(db, two, raw(b.id), "add", "local")).toBe(
      true,
    );
    expect(await listMemorySubjects(db, "local", raw(b.id))).toHaveLength(2);
    expect((await listSubjects(db, "local")).rows.map((s) => s.count)).toEqual([
      1, 2,
    ]);
    const summary = await createSubjectSummary(
      env,
      (await getSubject(db, "local", one))!,
      "Two sources agree.",
      owner,
    );
    expect((await getSubject(db, "local", one))?.summary?.body).toBe(
      "Two sources agree.",
    );
    expect((await getMemory(db, "local", raw(a.id)))?.body).toBe(
      "evidence first",
    );
    expect(await listMemoryRevisions(db, "local", raw(a.id))).toEqual([]);
    expect(
      (
        await search(env, { userId: "local", query: "evidence", limit: 20 })
      ).map((hit) => hit.docKey),
    ).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(await editSubject(db, "local", one, "name", "Mehdi renamed")).toBe(
      true,
    );
    expect((await getSubject(db, "local", one))?.summaryId).toBe(raw(summary));
    const replacement = await save("approved replacement");
    expect(await setSubjectSummary(db, "local", one, raw(replacement.id))).toBe(
      true,
    );
    expect((await getSubject(db, "local", one))?.summaryId).toBe(
      raw(replacement.id),
    );
    expect(await getMemory(db, "local", raw(summary))).not.toBeNull();
    expect(await setSubjectSummary(db, "local", one, raw(summary))).toBe(true);
    expect(
      await changeSubjectMember(db, one, raw(b.id), "remove", "local"),
    ).toBe(true);
    expect((await listSubjectMembers(db, "local", two)).rows).toHaveLength(1);
    expect(await changeSubjectMember(db, one, raw(b.id), "add", "local")).toBe(
      true,
    );
    await archiveMemory(env, "local", raw(summary));
    expect((await getSubject(db, "local", one))?.freshness).toBe("missing");
    expect((await listSubjectMembers(db, "local", one)).rows).toHaveLength(2);
  });

  it("refuses cross-user reads, writes and pointers even when ids are known", async () => {
    const userMemory = await save("other's fact", member);
    const ownerMemory = await save("owner fact");
    const ownerSubject = await create("private owner");
    const memberSubject = await create("private member", member);
    expect(await getSubject(db, "member", ownerSubject)).toBeNull();
    await expect(
      createSubjectSummary(
        env,
        (await getSubject(db, "local", ownerSubject))!,
        "Unauthorized summary",
        member,
      ),
    ).rejects.toThrow("Subject not found");
    expect((await listSubjects(db, "member")).rows.map((s) => s.id)).toEqual([
      memberSubject,
    ]);
    expect((await listSubjectMembers(db, "member", ownerSubject)).rows).toEqual(
      [],
    );
    expect(
      await editSubject(db, "member", ownerSubject, "name", "stolen"),
    ).toBe(false);
    expect(
      await changeSubjectMember(
        db,
        ownerSubject,
        raw(userMemory.id),
        "add",
        "local",
      ),
    ).toBe(false);
    expect(
      await changeSubjectMember(
        db,
        ownerSubject,
        raw(ownerMemory.id),
        "add",
        "member",
      ),
    ).toBe(false);
    expect(
      await setSubjectSummary(db, "local", ownerSubject, raw(userMemory.id)),
    ).toBe(false);
    expect(
      await setSubjectSummary(db, "member", ownerSubject, raw(ownerMemory.id)),
    ).toBe(false);
    expect(
      await changeSubjectMember(
        db,
        ownerSubject,
        raw(ownerMemory.id),
        "add",
        "local",
      ),
    ).toBe(true);
    expect(
      await changeSubjectMember(
        db,
        ownerSubject,
        raw(ownerMemory.id),
        "remove",
        "member",
      ),
    ).toBe(false);
    expect(await listMemorySubjects(db, "member", raw(ownerMemory.id))).toEqual(
      [],
    );
    expect(
      (
        await search(env, { userId: "member", query: "owner fact", limit: 20 })
      ).map((hit) => hit.docKey),
    ).not.toContain(ownerMemory.id);
  });

  it("bounds lists, detects newer evidence and confirmed conflicts without rewriting sources", async () => {
    const id = await create("Area");
    for (let i = 0; i < 35; i++) {
      const memory = await save(`claim-${i}`);
      await changeSubjectMember(db, id, raw(memory.id), "add", "local");
    }
    expect((await listSubjectMembers(db, "local", id)).rows).toHaveLength(30);
    expect((await listSubjectMembers(db, "local", id)).hasMore).toBe(true);
    expect((await listSubjectMembers(db, "local", id, 2)).rows).toHaveLength(5);
    const summary = await createSubjectSummary(
      env,
      (await getSubject(db, "local", id))!,
      "Current synthesis",
      owner,
    );
    expect(
      await changeSubjectMember(db, id, raw(summary), "add", "local"),
    ).toBe(false);
    const [a, b] = (await listSubjectMembers(db, "local", id)).rows;
    expect(await setSubjectSummary(db, "local", id, raw(a.id))).toBe(false);
    await editMemory(env, raw(a.id), { body: "new evidence" }, owner);
    await db
      .prepare(
        "UPDATE memories SET updated_at = updated_at + 2 WHERE memory_id = ?",
      )
      .bind(raw(a.id))
      .run();
    expect((await getSubject(db, "local", id))?.freshness).toBe("needs review");
    await assertPersonMemoryLink(
      env,
      raw(a.id),
      { id: b.id, kind: "contradicts" },
      owner,
    );
    expect((await getSubject(db, "local", id))?.conflicts).toBe(1);
    expect((await getMemory(db, "local", raw(b.id)))?.body).toContain(
      "evidence",
    );
  });

  it("paginates the index and atomically rolls back a rejected summary projection", async () => {
    for (let i = 0; i < 35; i++)
      await create(`Area ${String(i).padStart(2, "0")}`);
    expect((await listSubjects(db, "local")).rows).toHaveLength(30);
    expect((await listSubjects(db, "local", 2)).rows).toHaveLength(5);
    const id = await create("Rollback");
    await db
      .prepare(`CREATE TRIGGER reject_subject_summary BEFORE INSERT ON search_docs
      WHEN NEW.title = 'Rollback — current understanding'
      BEGIN SELECT RAISE(ABORT, 'projection rejected'); END`)
      .run();
    try {
      await expect(
        createSubjectSummary(
          env,
          (await getSubject(db, "local", id))!,
          "Draft",
          owner,
        ),
      ).rejects.toThrow();
      expect((await getSubject(db, "local", id))?.summaryId).toBeNull();
      expect(
        await db
          .prepare(
            "SELECT COUNT(*) AS n FROM memories WHERE title = 'Rollback — current understanding'",
          )
          .first<{ n: number }>(),
      ).toEqual({ n: 0 });
    } finally {
      await db.prepare("DROP TRIGGER reject_subject_summary").run();
    }
  });

  it("returns the live subject instead of creating a second one with the same name", async () => {
    const first = await createSubject(db, "local", {
      name: "vineyard",
      kind: "topic",
      description: "",
    });
    expect(first.created).toBe(true);
    // The 2026-11-03 retry: same name, different case and spacing.
    expect(
      await createSubject(db, "local", {
        name: "  VineYard ",
        kind: "area",
        description: "retry",
      }),
    ).toEqual({ id: first.id, created: false });
    // Another tenant's subject of that name is not a conflict.
    expect(
      (
        await createSubject(db, "member", {
          name: "vineyard",
          kind: "topic",
          description: "",
        })
      ).created,
    ).toBe(true);
    const other = await create("Orchard");
    expect(await editSubject(db, "local", other, "name", "VINEYARD")).toBe(
      false,
    );
    expect(await editSubject(db, "local", first.id, "name", "Vineyard")).toBe(
      true,
    );
    expect((await listSubjects(db, "local")).rows.map((s) => s.name)).toEqual([
      "Orchard",
      "Vineyard",
    ]);
  });

  it("deletes a subject out of every list and restores it with its members", async () => {
    const a = await save("kept");
    const id = await create("Garden");
    expect(await changeSubjectMember(db, id, raw(a.id), "add", "local")).toBe(
      true,
    );
    expect(await setSubjectDeleted(db, "member", id, true)).toBe(false);
    expect(await setSubjectDeleted(db, "local", id, true)).toBe(true);
    expect(await setSubjectDeleted(db, "local", id, true)).toBe(false);

    expect((await listSubjects(db, "local")).rows).toEqual([]);
    expect(await getSubject(db, "local", id)).toBeNull();
    expect(
      (await getSubject(db, "local", id, { includeDeleted: true }))?.deletedAt,
    ).toEqual(expect.any(Number));
    expect(await listMemorySubjects(db, "local", raw(a.id))).toEqual([]);
    expect(await findSubjectByName(db, "local", "garden")).toBeNull();
    // Writes against a deleted subject are refused.
    expect(await editSubject(db, "local", id, "description", "x")).toBe(false);
    expect(
      await changeSubjectMember(db, id, raw(a.id), "remove", "local"),
    ).toBe(false);
    expect(await setSubjectSummary(db, "local", id, null)).toBe(false);
    // The memory itself is untouched.
    expect(await getMemory(db, "local", raw(a.id))).not.toBeNull();

    // While a live subject holds the name, the deleted one cannot come back.
    const twin = await create("garden");
    expect(await setSubjectDeleted(db, "local", id, false)).toBe(false);
    expect(await setSubjectDeleted(db, "local", twin, true)).toBe(true);
    expect(await setSubjectDeleted(db, "local", id, false)).toBe(true);
    expect(await getSubject(db, "local", id)).toMatchObject({
      name: "Garden",
      count: 1,
      deletedAt: null,
    });
    expect(await listMemorySubjects(db, "local", raw(a.id))).toHaveLength(1);
  });
});
