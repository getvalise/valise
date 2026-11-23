import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { checkBackups } from "./monitor";
import {
  type BackupRequest,
  type BackupSource,
  type BackupStep,
  keepCount,
  type Migration,
  recordFailure,
  runBackup,
  sha256,
} from "./snapshot";

/**
 * The daily backup as a Cloudflare Workflow: cron starts it, steps retry and
 * resume, and a run that fails records itself and alerts. ADR-0019.
 */

declare const __VALISE_BACKUP_SOURCE__: BackupSource | null | undefined;

const MIGRATIONS: Migration[] = Object.entries(
  import.meta.glob<string>("../../drizzle/*.sql", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
)
  .map(([path, sql]) => ({
    name: path.slice(path.lastIndexOf("/") + 1),
    sha256: sha256(sql),
  }))
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const STEP = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
  timeout: "10 minutes",
} as const;

export type BackupWorkflowEnv = Env & { BACKUPS: R2Bucket };

export class BackupWorkflow extends WorkflowEntrypoint<
  BackupWorkflowEnv,
  BackupRequest
> {
  async run(event: WorkflowEvent<BackupRequest>, step: WorkflowStep) {
    const steps: BackupStep = {
      do: (name, work) =>
        step.do(name, STEP, work as () => Promise<never>) as never,
      sleep: (name, ms) => step.sleep(name, ms),
    };
    try {
      const source =
        typeof __VALISE_BACKUP_SOURCE__ === "undefined"
          ? null
          : __VALISE_BACKUP_SOURCE__;
      if (!source)
        throw new Error("This build has no backup source; rebuild from main");
      return await runBackup(this.env, steps, event.payload, {
        source,
        migrations: MIGRATIONS,
        keep: keepCount(this.env.VALISE_BACKUP_KEEP),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await step.do("record failure", async () => {
        await recordFailure(this.env.DB, event.payload, message, Date.now());
        return checkBackups(this.env, Date.now());
      });
      throw error;
    }
  }
}

/** Start today's run. The instance id is the date, so a double fire is one run. */
export async function startBackup(
  env: Env,
  scheduledTime: number,
): Promise<{ started: boolean; id: string | null }> {
  const workflow = (env as Partial<Env>).BACKUP_WORKFLOW;
  if (!workflow || !(env as { BACKUPS?: R2Bucket }).BACKUPS)
    return { started: false, id: null };
  const startedAt = new Date(scheduledTime).toISOString();
  const id = `backup-${startedAt.slice(0, 10)}`;
  const params: BackupRequest = {
    snapshot: `snapshot-${startedAt.replaceAll(":", "-")}-${crypto.randomUUID()}`,
    startedAt,
  };
  try {
    await workflow.create({ id, params });
    return { started: true, id };
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "backup_not_started",
        id,
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
    return { started: false, id };
  }
}
