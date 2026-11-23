import { Resend } from "resend";
import { emailSender } from "~/lib/email.server";
import { allowedEmails } from "~/lib/google.server";

/**
 * Backup status for the workbench, and the alert that emails the admin
 * addresses once per incident. An incident is everything since the last
 * complete snapshot: a failed run, or no complete snapshot for 36 hours.
 * ADR-0019.
 */

export const STALE_HOURS = 36;

export type MonitorEnv = {
  DB: D1Database;
  BACKUPS?: R2Bucket;
  APP_ORIGIN: string;
  EMAIL_API_KEY?: string;
  EMAIL_FROM?: string;
  VALISE_ADMIN_EMAILS?: string;
};

type Run = {
  snapshot: string;
  state: "running" | "complete" | "failed";
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
};

export type BackupStatus = {
  configured: boolean;
  latest: Run | null;
  lastComplete: Run | null;
};

const RUN_COLUMNS =
  "snapshot, state, started_at AS startedAt, finished_at AS finishedAt, error";

export async function backupStatus(env: MonitorEnv): Promise<BackupStatus> {
  if (!env.BACKUPS)
    return { configured: false, latest: null, lastComplete: null };
  const [latest, lastComplete] = await env.DB.batch<Run>([
    env.DB.prepare(
      `SELECT ${RUN_COLUMNS} FROM backup_runs ORDER BY started_at DESC LIMIT 1`,
    ),
    env.DB.prepare(
      `SELECT ${RUN_COLUMNS} FROM backup_runs WHERE state='complete' ORDER BY finished_at DESC LIMIT 1`,
    ),
  ]);
  return {
    configured: true,
    latest: latest.results[0] ?? null,
    lastComplete: lastComplete.results[0] ?? null,
  };
}

export type Alert = { subject: string; text: string };

/** The problem, if there is one, and the incident it belongs to. */
export function diagnose(
  status: BackupStatus,
  firstCheckedAt: number,
  now: number,
): (Alert & { incident: string }) | null {
  if (!status.configured) return null;
  const last = status.lastComplete;
  const incident = `since:${last?.snapshot ?? "none"}`;
  const lastLine = last?.finishedAt
    ? `The last complete snapshot finished ${new Date(last.finishedAt).toISOString()}.`
    : "There is no complete snapshot yet.";
  const latest = status.latest;
  if (latest?.state === "failed")
    return {
      incident,
      subject: "Valise backup failed",
      text: `The scheduled backup ${latest.snapshot} failed${latest.finishedAt ? ` at ${new Date(latest.finishedAt).toISOString()}` : ""}: ${latest.error ?? "no error recorded"}.\n\n${lastLine}`,
    };
  const since = last?.finishedAt ?? firstCheckedAt;
  if (now - since > STALE_HOURS * 3_600_000)
    return {
      incident,
      subject: `Valise has no complete backup in ${STALE_HOURS} hours`,
      text: `${lastLine} The daily backup has not completed since. Check that the backup cron and Workflow are deployed.`,
    };
  return null;
}

export async function sendBackupAlert(env: MonitorEnv, alert: Alert) {
  const to = [...allowedEmails(env)];
  if (!env.EMAIL_API_KEY || !to.length)
    throw new Error("Backup alerts need EMAIL_API_KEY and VALISE_ADMIN_EMAILS");
  const { error } = await new Resend(env.EMAIL_API_KEY).emails.send({
    from: emailSender(env),
    to,
    subject: alert.subject,
    text: `${alert.text}\n\nStatus: ${new URL("/workbench", env.APP_ORIGIN)}\n\nThis is the only email for this incident. The next complete snapshot ends it.`,
  });
  if (error) throw new Error("Backup alert email failed");
}

/**
 * Claim the incident before sending, so two checks racing send one email,
 * and release it if the send fails so the next check tries again.
 */
export async function checkBackups(
  env: MonitorEnv,
  now: number,
  send: (env: MonitorEnv, alert: Alert) => Promise<void> = sendBackupAlert,
): Promise<{ incident: string | null; alerted: boolean }> {
  if (!env.BACKUPS) return { incident: null, alerted: false };
  await env.DB.prepare(
    "INSERT OR IGNORE INTO backup_alerts (id, first_checked_at) VALUES (1, ?)",
  )
    .bind(now)
    .run();
  const state = await env.DB.prepare(
    "SELECT first_checked_at AS firstCheckedAt, incident FROM backup_alerts WHERE id=1",
  ).first<{ firstCheckedAt: number; incident: string | null }>();
  const problem = diagnose(
    await backupStatus(env),
    state?.firstCheckedAt ?? now,
    now,
  );
  if (!problem) return { incident: null, alerted: false };
  const claimed = await env.DB.prepare(
    "UPDATE backup_alerts SET incident=?, alerted_at=? WHERE id=1 AND incident IS NOT ?",
  )
    .bind(problem.incident, now, problem.incident)
    .run();
  if (!claimed.meta.changes)
    return { incident: problem.incident, alerted: false };
  try {
    await send(env, problem);
  } catch (error) {
    await env.DB.prepare(
      "UPDATE backup_alerts SET incident=?, alerted_at=NULL WHERE id=1 AND incident=?",
    )
      .bind(state?.incident ?? null, problem.incident)
      .run();
    console.log(
      JSON.stringify({
        event: "backup_alert_unsent",
        incident: problem.incident,
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
    return { incident: problem.incident, alerted: false };
  }
  console.log(
    JSON.stringify({ event: "backup_alert", incident: problem.incident }),
  );
  return { incident: problem.incident, alerted: true };
}
