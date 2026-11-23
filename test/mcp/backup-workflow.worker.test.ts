import { env, introspectWorkflowInstance } from "cloudflare:test";
import { expect, it } from "vitest";
import {
  type Alert,
  backupStatus,
  checkBackups,
  diagnose,
  STALE_HOURS,
} from "~/backup/monitor";
import {
  type Manifest,
  originalKey,
  sha256,
  snapshotKey,
} from "~/backup/snapshot";

/**
 * The scheduled backup on the real Workflows engine: a run publishes a
 * verified snapshot, a changed original fails it, and the failure alert goes
 * out once per incident. The restore of a Worker-made snapshot is the Node
 * drill in test/backup.test.mjs. ADR-0019.
 */

const bytes = new TextEncoder().encode("original bytes for the backup test\n");

async function seedObject(objectId: string, contents: Uint8Array) {
  const key = `u/local/objects/${objectId}`;
  await env.BUNDLES.put(key, contents);
  await env.DB.prepare(
    `INSERT INTO objects (object_id,user_id,r2_key,name,content_type,size,sha256,created_at)
     VALUES (?,'local',?,'note.txt','text/plain',?,?,1)`,
  )
    .bind(objectId, key, bytes.byteLength, sha256(bytes))
    .run();
  return key;
}

function request(day: string) {
  const startedAt = `${day}T03:23:00.000Z`;
  return {
    id: `backup-${day}`,
    params: {
      snapshot: `snapshot-${startedAt.replaceAll(":", "-")}-${crypto.randomUUID()}`,
      startedAt,
    },
  };
}

it("publishes a verified snapshot, then fails and alerts once when an original changed", async () => {
  const key = await seedObject(`obj_${crypto.randomUUID()}`, bytes);
  const first = request("2026-10-25");
  {
    await using instance = await introspectWorkflowInstance(
      env.BACKUP_WORKFLOW,
      first.id,
    );
    await instance.modify(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    await env.BACKUP_WORKFLOW.create(first);
    await instance.waitForStatus("complete");
  }
  const manifest = (await (
    await env.BACKUPS.get(snapshotKey(first.params.snapshot, "manifest.json"))
  )?.json()) as Manifest;
  expect(manifest).toMatchObject({
    format: "valise-recovery",
    version: 1,
    target: "worker",
    source: { worker: "valise", bucket: "valise-bundles" },
  });
  const original = manifest.originals.find((o) => o.key === key);
  expect(original).toMatchObject({
    size: bytes.byteLength,
    sha256: sha256(bytes),
    file: `files/${sha256(key)}`,
  });
  const stored = await env.BACKUPS.get(originalKey(sha256(bytes)));
  expect(new Uint8Array((await stored?.arrayBuffer()) ?? [])).toEqual(bytes);
  const sql = await env.BACKUPS.get(
    snapshotKey(first.params.snapshot, "database.sql"),
  );
  const text = (await sql?.text()) ?? "";
  expect(sha256(text)).toBe(manifest.checksums["database.sql"]);
  expect(text).toContain(`'${key}'`);
  expect(
    (await env.BACKUPS.list({ prefix: `staging/${first.params.snapshot}/` }))
      .objects,
  ).toEqual([]);
  const status = await backupStatus(env);
  expect(status.lastComplete?.snapshot).toBe(first.params.snapshot);
  expect(status.latest?.state).toBe("complete");

  // An original whose bytes no longer match D1 must fail the run, never
  // publish it, and leave the earlier complete snapshot in place.
  await env.BUNDLES.put(key, new TextEncoder().encode("changed underneath\n"));
  await env.DB.prepare("DELETE FROM backup_alerts").run();
  const second = request("2026-10-26");
  {
    await using instance = await introspectWorkflowInstance(
      env.BACKUP_WORKFLOW,
      second.id,
    );
    await instance.modify(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    await env.BACKUP_WORKFLOW.create(second);
    await instance.waitForStatus("errored");
  }
  expect(
    await env.BACKUPS.head(
      snapshotKey(second.params.snapshot, "manifest.json"),
    ),
  ).toBeNull();
  const failed = await backupStatus(env);
  expect(failed.latest).toMatchObject({
    snapshot: second.params.snapshot,
    state: "failed",
  });
  expect(failed.lastComplete?.snapshot).toBe(first.params.snapshot);
  expect(
    await env.BACKUPS.head(snapshotKey(first.params.snapshot, "manifest.json")),
  ).not.toBeNull();

  // The Workflow's own check could not send (no email key in tests) and so
  // released the incident. The next check sends exactly one email.
  const sent: Alert[] = [];
  const send = async (_env: unknown, alert: Alert) => {
    sent.push(alert);
  };
  const now = Date.now();
  expect(await checkBackups(env, now, send)).toMatchObject({ alerted: true });
  expect(await checkBackups(env, now + 3_600_000, send)).toMatchObject({
    alerted: false,
  });
  expect(sent).toHaveLength(1);
  expect(sent[0].subject).toBe("Valise backup failed");
  expect(sent[0].text).toContain("Original missing or changed");

  // A send that fails releases the claim so the next check retries.
  await env.DB.prepare("UPDATE backup_alerts SET incident=NULL").run();
  await expect(
    checkBackups(env, now, async () => {
      throw new Error("provider down");
    }),
  ).resolves.toMatchObject({ alerted: false });
  expect(await checkBackups(env, now, send)).toMatchObject({ alerted: true });
  expect(sent).toHaveLength(2);
});

it("calls a backup stale after 36 hours, counting from the first check when none has completed", () => {
  const hour = 3_600_000;
  const empty = { configured: true, latest: null, lastComplete: null };
  expect(diagnose(empty, 0, STALE_HOURS * hour)).toBeNull();
  expect(diagnose(empty, 0, STALE_HOURS * hour + 1)).toMatchObject({
    incident: "since:none",
    subject: `Valise has no complete backup in ${STALE_HOURS} hours`,
  });
  const done = {
    snapshot: "snapshot-a",
    state: "complete" as const,
    startedAt: 0,
    finishedAt: 10 * hour,
    error: null,
  };
  const healthy = { configured: true, latest: done, lastComplete: done };
  expect(diagnose(healthy, 0, 40 * hour)).toBeNull();
  expect(diagnose(healthy, 0, 47 * hour)).toMatchObject({
    incident: "since:snapshot-a",
  });
  expect(
    diagnose({ configured: false, latest: null, lastComplete: null }, 0, 1e12),
  ).toBeNull();
});
