import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUILTIN_SKILLS,
  BUILTIN_SWEEP_LIMIT,
  builtinRelease,
  ensureBuiltinSkills,
  provisionBuiltinSkills,
  sweepBuiltinSkills,
  syncBuiltinSkills,
} from "~/concepts/builtin-skills";
import {
  changeSkills,
  editSkill,
  getSkill,
  listSkillVersions,
  publishSkill,
  setSkillLabels,
} from "~/concepts/skills";
import { capBody, MAX_BODY_BYTES } from "~/search/project";

// Valise bundles one skill; a second, test-only entry keeps the multi-skill
// paths (partial failure, per-skill holds) covered.
BUILTIN_SKILLS.push({
  name: "fixture-builtin",
  body: "---\nname: fixture-builtin\ndescription: A second bundled skill, for tests that need two.\n---\n\nFixture instructions.\n",
});
const originalBodies = BUILTIN_SKILLS.map((skill) => skill.body);
const author = {
  userId: "local",
  agent: "test",
  client: "test",
  session: null,
};

afterEach(async () => {
  vi.restoreAllMocks();
  BUILTIN_SKILLS.forEach((skill, i) => {
    skill.body = originalBodies[i];
  });
  for (const table of [
    "builtin_skill_sync",
    "builtin_skill_sweep",
    "search_docs",
    "skill_versions",
    "skills",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "DELETE FROM users WHERE user_id LIKE 'builtin-test-%'",
  ).run();
});

async function state(userId = "local") {
  return env.DB.prepare("SELECT * FROM builtin_skill_sync WHERE user_id = ?")
    .bind(userId)
    .first<{
      completed_version: string | null;
      target_version: string;
      lease_token: string | null;
      retry_after: number;
      last_error: string | null;
    }>();
}

async function retry(userId = "local") {
  await env.DB.prepare(
    "UPDATE builtin_skill_sync SET retry_after = 0 WHERE user_id = ?",
  )
    .bind(userId)
    .run();
}

async function member(id: string, verified = true) {
  await env.DB.prepare(
    "INSERT INTO users (user_id, role, email_verified, created_at) VALUES (?, 'member', ?, unixepoch())",
  )
    .bind(id, Number(verified))
    .run();
}

describe("durable builtin provisioning", () => {
  it("versions the bundled release and skips completed tenant work across calls", async () => {
    const release = await builtinRelease();
    expect((await ensureBuiltinSkills(env, "local")).status).toBe("complete");
    expect((await state())?.completed_version).toBe(release);
    const batch = vi.spyOn(env.DB, "batch");
    expect(await ensureBuiltinSkills(env, "local")).toEqual({
      status: "current",
      report: [],
    });
    expect(batch).not.toHaveBeenCalled();

    BUILTIN_SKILLS[0].body += "\nRelease two searchmarker.\n";
    expect(await builtinRelease()).not.toBe(release);
    expect((await ensureBuiltinSkills(env, "local")).status).toBe("complete");
    expect((await state())?.completed_version).toBe(await builtinRelease());
    expect(await getSkill(env.DB, "local", "capture-this")).toMatchObject({
      version: 2,
      body: BUILTIN_SKILLS[0].body,
    });
    expect(
      await listSkillVersions(env.DB, "local", "fixture-builtin"),
    ).toHaveLength(1);
    const projection = await env.DB.prepare(
      "SELECT body, tags FROM search_docs WHERE user_id = 'local' AND title = 'capture-this'",
    ).first();
    expect(projection).toMatchObject({
      body: expect.stringContaining("searchmarker"),
      tags: "meta memories",
    });
  });

  it("clears old completion on failed upgrade, defers retries, and resumes without duplicate versions", async () => {
    await ensureBuiltinSkills(env, "local");
    BUILTIN_SKILLS[0].body += "\nUpgrade.\n";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(env.DB, "batch").mockRejectedValueOnce(
      new Error("transient D1 failure"),
    );
    expect((await ensureBuiltinSkills(env, "local")).status).toBe("failed");
    expect(await state()).toMatchObject({
      completed_version: null,
      lease_token: null,
      last_error: '["capture-this"]',
    });
    expect((await state())?.retry_after).toBeGreaterThan(
      Math.floor(Date.now() / 1000),
    );
    expect((await ensureBuiltinSkills(env, "local")).status).toBe("deferred");
    await retry();
    expect((await ensureBuiltinSkills(env, "local")).status).toBe("complete");
    expect((await state())?.completed_version).toBe(await builtinRelease());
    expect(
      await listSkillVersions(env.DB, "local", "capture-this"),
    ).toHaveLength(2);
    expect(
      await listSkillVersions(env.DB, "local", "fixture-builtin"),
    ).toHaveLength(1);
  });

  it("does not complete an invalid bundled release and recovers on a corrected release", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    BUILTIN_SKILLS[0].body = "Not a SKILL.md";
    expect((await ensureBuiltinSkills(env, "local")).status).toBe("failed");
    expect((await state())?.completed_version).toBeNull();
    expect(await getSkill(env.DB, "local", "capture-this")).toBeNull();
    BUILTIN_SKILLS[0].body = originalBodies[0];
    // A corrected release does not wait for the failed release's backoff.
    expect((await ensureBuiltinSkills(env, "local")).status).toBe("complete");
  });

  it("retains successful partial provisioning when the other skill fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch")
      .mockImplementationOnce(batch)
      .mockRejectedValueOnce(new Error("retry second skill"));
    expect((await ensureBuiltinSkills(env, "local")).status).toBe("failed");
    expect((await state())?.completed_version).toBeNull();
    expect(await getSkill(env.DB, "local", "capture-this")).toMatchObject({
      version: 1,
    });
    expect(await getSkill(env.DB, "local", "fixture-builtin")).toBeNull();
    await retry();
    expect((await ensureBuiltinSkills(env, "local")).status).toBe("complete");
    expect(
      await listSkillVersions(env.DB, "local", "capture-this"),
    ).toHaveLength(1);
  });

  it("recovers a crash after publishing but before recording completion", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const prepare = env.DB.prepare.bind(env.DB);
    const failure = vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (sql.startsWith("UPDATE builtin_skill_sync SET completed_version")) {
        throw new Error("completion storage unavailable");
      }
      return prepare(sql);
    });
    await provisionBuiltinSkills(env, "local");
    failure.mockRestore();
    expect(log).toHaveBeenCalledWith({
      event: "builtin_provision_failed",
      userId: "local",
      reason: "sync_failed",
    });
    expect((await state())?.completed_version).toBeNull();
    expect((await ensureBuiltinSkills(env, "local")).status).toBe("deferred");
    await env.DB.prepare(
      "UPDATE builtin_skill_sync SET lease_expires_at = 0 WHERE user_id = 'local'",
    ).run();
    expect((await ensureBuiltinSkills(env, "local")).status).toBe("complete");
    for (const skill of BUILTIN_SKILLS) {
      expect(await listSkillVersions(env.DB, "local", skill.name)).toHaveLength(
        1,
      );
    }
  });

  it("holds local edits on release upgrades and preserves off switches", async () => {
    await ensureBuiltinSkills(env, "local");
    const edited = `${originalBodies[0]}\nMy own instructions.\n`;
    await editSkill(env, "capture-this", edited, author);
    await changeSkills(env, "local", ["fixture-builtin"], "disable");
    BUILTIN_SKILLS.forEach((skill) => {
      skill.body += "\nUpstream changes.\n";
    });
    const result = await ensureBuiltinSkills(env, "local");
    expect(result.status).toBe("complete");
    expect(result.report[0].outcome).toBe("held");
    expect(await getSkill(env.DB, "local", "capture-this")).toMatchObject({
      body: edited,
      version: 2,
    });
    expect(
      await getSkill(env.DB, "local", "fixture-builtin", undefined, "disabled"),
    ).toMatchObject({ disabled: true, version: 2 });
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM search_docs WHERE title = 'fixture-builtin'",
      ).first(),
    ).toBeNull();
  });

  it("does not clobber an edit committed between reading the head and the upgrade batch", async () => {
    await ensureBuiltinSkills(env, "local");
    BUILTIN_SKILLS[0].body += "\nUpgrade.\n";
    const edited = `${originalBodies[0]}\nConcurrent user edit.\n`;
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      await editSkill(env, "capture-this", edited, author);
      return batch(statements);
    });
    expect((await ensureBuiltinSkills(env, "local")).status).toBe("failed");
    expect((await state())?.completed_version).toBeNull();
    expect(await getSkill(env.DB, "local", "capture-this")).toMatchObject({
      version: 2,
      body: edited,
    });
    expect(
      await listSkillVersions(env.DB, "local", "capture-this"),
    ).toHaveLength(2);
    const projection = await env.DB.prepare(
      "SELECT body FROM search_docs WHERE title = 'capture-this'",
    ).first();
    expect(projection?.body).toBe(edited);
    await retry();
    expect((await ensureBuiltinSkills(env, "local")).report[0].outcome).toBe(
      "held",
    );
    expect((await state())?.completed_version).toBe(await builtinRelease());
  });

  it("does not overwrite a user skill created after a missing-name lookup", async () => {
    const edited = `${originalBodies[0]}\nCreated concurrently by the user.\n`;
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      await publishSkill(env, { body: edited, files: [] }, author);
      return batch(statements);
    });
    expect((await ensureBuiltinSkills(env, "local")).status).toBe("failed");
    expect((await state())?.completed_version).toBeNull();
    expect(await getSkill(env.DB, "local", "capture-this")).toMatchObject({
      version: 1,
      body: edited,
      source: null,
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM skills WHERE head_version_id IS NULL",
      ).first(),
    ).toEqual({ count: 0 });
    await retry();
    expect((await ensureBuiltinSkills(env, "local")).report[0].outcome).toBe(
      "held",
    );
  });

  it("keeps concurrent metadata edits and disabling authoritative in the upgrade projection", async () => {
    await ensureBuiltinSkills(env, "local");
    BUILTIN_SKILLS[0].body += "\nUpgrade.\n";
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      await changeSkills(env, "local", ["capture-this"], "disable");
      await env.DB.prepare(
        "UPDATE skills SET project = 'mine', tags_json = '[\"my-tag\"]' WHERE user_id = 'local' AND name = 'capture-this'",
      ).run();
      return batch(statements);
    });
    expect((await ensureBuiltinSkills(env, "local")).status).toBe("complete");
    expect(
      await getSkill(env.DB, "local", "capture-this", undefined, "disabled"),
    ).toMatchObject({
      version: 2,
      project: "mine",
      tags: ["my-tag"],
      disabled: true,
    });
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM search_docs WHERE title = 'capture-this'",
      ).first(),
    ).toBeNull();
    await changeSkills(env, "local", ["capture-this"], "enable");
    expect(
      await env.DB.prepare(
        "SELECT body, project, tags FROM search_docs WHERE title = 'capture-this'",
      ).first(),
    ).toMatchObject({
      body: BUILTIN_SKILLS[0].body,
      project: "mine",
      tags: "my-tag",
    });
  });

  it("enables the current head when a completed builtin upgrade overtakes the toggle batch", async () => {
    await ensureBuiltinSkills(env, "local");
    await changeSkills(env, "local", ["capture-this"], "disable");
    BUILTIN_SKILLS[0].body += "\nUpgraded while enabling.\n";
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      expect((await ensureBuiltinSkills(env, "local")).status).toBe("complete");
      return batch(statements);
    });
    await changeSkills(env, "local", ["capture-this"], "enable");
    expect(await getSkill(env.DB, "local", "capture-this")).toMatchObject({
      version: 2,
      disabled: false,
    });
    expect(
      await env.DB.prepare(
        "SELECT body FROM search_docs WHERE title = 'capture-this'",
      ).first(),
    ).toEqual({ body: BUILTIN_SKILLS[0].body });
    expect((await ensureBuiltinSkills(env, "local")).status).toBe("current");
  });

  it("applies labels to the current head and preserves a concurrent project change", async () => {
    await ensureBuiltinSkills(env, "local");
    BUILTIN_SKILLS[0].body += "\nUpgraded while labeling.\n";
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      expect((await ensureBuiltinSkills(env, "local")).status).toBe("complete");
      await setSkillLabels(env, "local", "capture-this", {
        project: "concurrent-project",
      });
      return batch(statements);
    });
    await setSkillLabels(env, "local", "capture-this", { tags: ["new-label"] });
    expect(await getSkill(env.DB, "local", "capture-this")).toMatchObject({
      version: 2,
      project: "concurrent-project",
      tags: ["new-label"],
    });
    expect(
      await env.DB.prepare(
        "SELECT body, project, tags FROM search_docs WHERE title = 'capture-this'",
      ).first(),
    ).toEqual({
      body: BUILTIN_SKILLS[0].body,
      project: "concurrent-project",
      tags: "new-label",
    });
  });

  it("does not republish a skill disabled while its label batch was waiting", async () => {
    await ensureBuiltinSkills(env, "local");
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      await changeSkills(env, "local", ["capture-this"], "disable");
      return batch(statements);
    });
    await setSkillLabels(env, "local", "capture-this", {
      project: "still-hidden",
    });
    expect(
      await getSkill(env.DB, "local", "capture-this", undefined, "disabled"),
    ).toMatchObject({ disabled: true, project: "still-hidden" });
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM search_docs WHERE title = 'capture-this'",
      ).first(),
    ).toBeNull();
  });

  it("does not clear a concurrent deletion while enabling a skill", async () => {
    await publishSkill(env, { body: originalBodies[0], files: [] }, author);
    await changeSkills(env, "local", ["capture-this"], "disable");
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      await changeSkills(env, "local", ["capture-this"], "delete");
      return batch(statements);
    });
    await changeSkills(env, "local", ["capture-this"], "enable");
    expect(
      await getSkill(env.DB, "local", "capture-this", undefined, "deleted"),
    ).toMatchObject({ disabled: false, deleted: true });
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM search_docs WHERE title = 'capture-this'",
      ).first(),
    ).toBeNull();
  });

  it.each([
    { character: "é", remaining: 1 },
    { character: "€", remaining: 1 },
    { character: "€", remaining: 2 },
    { character: "🚀", remaining: 1 },
    { character: "🚀", remaining: 2 },
    { character: "🚀", remaining: 3 },
  ])(
    "keeps UTF-8 projection boundaries for $character with $remaining bytes remaining",
    async ({ character, remaining }) => {
      const header =
        "---\nname: unicode-proof\ndescription: UTF-8 boundary test.\n---\n";
      const body =
        header +
        "a".repeat(MAX_BODY_BYTES - header.length - remaining) +
        character +
        "tail";
      await publishSkill(env, { body, files: [] }, author);
      await setSkillLabels(env, "local", "unicode-proof", {
        tags: ["one", "two"],
      });
      const expected = { body: capBody(body), tags: "one two" };
      expect(
        await env.DB.prepare(
          "SELECT body, tags FROM search_docs WHERE title = 'unicode-proof'",
        ).first(),
      ).toEqual(expected);
      await changeSkills(env, "local", ["unicode-proof"], "disable");
      await changeSkills(env, "local", ["unicode-proof"], "enable");
      expect(
        await env.DB.prepare(
          "SELECT body, tags FROM search_docs WHERE title = 'unicode-proof'",
        ).first(),
      ).toEqual(expected);
    },
  );

  it("adopts an identical unmanaged body without appending a duplicate version", async () => {
    await publishSkill(env, { body: originalBodies[0], files: [] }, author);
    const result = await ensureBuiltinSkills(env, "local");
    expect(result.status).toBe("complete");
    expect(result.report[0].outcome).toBe("adopted");
    expect(await getSkill(env.DB, "local", "capture-this")).toMatchObject({
      version: 1,
      source: "builtin:capture-this",
    });
    expect(
      await listSkillVersions(env.DB, "local", "capture-this"),
    ).toHaveLength(1);
  });

  it("fences expired work from publishing or recording completion and retries abandoned leases", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      await env.DB.prepare(
        "UPDATE builtin_skill_sync SET lease_expires_at = 0 WHERE user_id = 'local'",
      ).run();
      return batch(statements);
    });
    expect((await ensureBuiltinSkills(env, "local")).status).toBe("failed");
    expect((await state())?.completed_version).toBeNull();
    expect(await getSkill(env.DB, "local", "capture-this")).toBeNull();
    expect((await ensureBuiltinSkills(env, "local")).status).toBe("complete");
  });

  it("allows only one active tenant lease and provisions only the newly admitted account", async () => {
    const id = "builtin-test-new";
    await member(id);
    await member("builtin-test-pending", false);
    const results = await Promise.all([
      ensureBuiltinSkills(env, id),
      ensureBuiltinSkills(env, id),
    ]);
    expect(results.map((r) => r.status)).toContain("complete");
    expect(
      results.map((r) => r.status).filter((s) => s === "complete"),
    ).toHaveLength(1);
    expect(await listSkillVersions(env.DB, id, "capture-this")).toHaveLength(1);
    expect(await getSkill(env.DB, "local", "capture-this")).toBeNull();
    expect(await state()).toBeNull();
    expect(
      (await ensureBuiltinSkills(env, "builtin-test-pending")).status,
    ).toBe("deferred");
    expect(await state("builtin-test-pending")).toBeNull();
  });

  it("retains authored, deleted, registry-owned and file-edited skills", async () => {
    await publishSkill(env, { body: originalBodies[0], files: [] }, author, {
      source: "registry:custom",
      sourceHash: "custom",
    });
    await publishSkill(
      env,
      {
        body: originalBodies[1],
        files: [{ path: "user.txt", content: "keep" }],
      },
      author,
    );
    expect(
      (await syncBuiltinSkills(env, "local")).map((r) => r.outcome),
    ).toEqual(["held", "held"]);
    await changeSkills(env, "local", ["capture-this"], "delete");
    expect((await syncBuiltinSkills(env, "local"))[0].outcome).toBe("held");
    expect(
      await getSkill(env.DB, "local", "capture-this", undefined, "deleted"),
    ).toMatchObject({ deleted: true, source: "registry:custom" });
  });

  it("keeps a bounded cursor moving past failures and resumes across sweep invocations", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    // Fail publication for every account regardless of current uniqueness schema.
    vi.spyOn(env.DB, "batch").mockRejectedValue(new Error("unavailable"));
    for (let i = 0; i < BUILTIN_SWEEP_LIMIT * 2 + 1; i++)
      await member(`builtin-test-${String(i).padStart(2, "0")}`);
    const first = await sweepBuiltinSkills(env);
    const second = await sweepBuiltinSkills(env);
    const third = await sweepBuiltinSkills(env);
    expect(first).toHaveLength(BUILTIN_SWEEP_LIMIT);
    expect(second).toHaveLength(BUILTIN_SWEEP_LIMIT);
    expect(third).toHaveLength(2); // includes local
    const ids = [...first, ...second, ...third].map((r) => r.userId);
    expect(new Set(ids).size).toBe(BUILTIN_SWEEP_LIMIT * 2 + 2);
    expect(first.every((r) => r.status === "failed")).toBe(true);
    expect(await sweepBuiltinSkills(env)).toEqual([]); // cursor wraps
    expect((await sweepBuiltinSkills(env)).map((r) => r.userId)).toEqual(
      first.map((r) => r.userId),
    );
    expect(log).toHaveBeenCalled();
    expect((await state(ids.at(-1)))?.completed_version).toBeNull();
  });

  it("logs unexpected provisioning failures without aborting account admission", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(env.DB, "prepare").mockImplementationOnce(() => {
      throw new Error("private DB details");
    });
    await expect(provisionBuiltinSkills(env, "local")).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith({
      event: "builtin_provision_failed",
      userId: "local",
      reason: "sync_failed",
    });
  });
});

describe("a built-in Valise stops bundling", () => {
  it("stays with the person as an ordinary skill they can delete", async () => {
    const body =
      "---\nname: retired-builtin\ndescription: Once bundled, now not.\n---\n\nOld instructions.\n";
    await publishSkill(env, { body, files: [] }, author);
    await env.DB.prepare(
      "UPDATE skills SET source = 'builtin:retired-builtin', source_hash = 'x' WHERE user_id = 'local' AND name = 'retired-builtin'",
    ).run();
    expect(
      await changeSkills(env, "local", ["retired-builtin"], "delete"),
    ).toMatchObject({
      skipped: [{ name: "retired-builtin", reason: "builtin" }],
    });

    await syncBuiltinSkills(env, "local");

    expect(await getSkill(env.DB, "local", "retired-builtin")).toMatchObject({
      body,
      version: 1,
      source: null,
    });
    expect(await getSkill(env.DB, "local", "capture-this")).toMatchObject({
      source: "builtin:capture-this",
    });
    expect(
      await changeSkills(env, "local", ["retired-builtin"], "delete"),
    ).toMatchObject({ changed: ["retired-builtin"] });
  });
});
