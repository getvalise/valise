import { prepareRun, runRoot, sweepStaleRuns } from "./fixtures/server";

/** Builds once and migrates a template store that every worker copies. */
export default async function globalSetup() {
  await sweepStaleRuns();
  process.env.VALISE_UI_RUN = runRoot();
  await prepareRun(process.env.VALISE_UI_RUN);
  return async () => {
    const { rm } = await import("node:fs/promises");
    await rm(runRoot(), { recursive: true, force: true });
  };
}
