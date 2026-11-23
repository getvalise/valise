import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { faultGateway, prompts, score } from "./core.mjs";
import { episode, executeCheck, executionTool } from "./harness.mjs";
import { seed } from "./store.mjs";

export const payload = "valise synthetic checksum fixture\n";

/**
 * One closed loop: seed, Agent A, snapshot, fresh Agent B, snapshot, score.
 * The run and the provider-free tests share it, so a scripted pass exercises
 * the same seeding, fault gateway, executor and scorer a model run does.
 */
export async function runCase(
  entry,
  {
    clients: { setup, other, a, b },
    observe,
    completeA,
    completeB,
    tools,
    catalog,
    checkpoint = async () => {},
    ...common
  },
) {
  const { scenario, project } = entry;
  entry.faultEvents ??= [];
  try {
    const directory = await mkdtemp(join(tmpdir(), "valise-j4-execution-"));
    entry.executionDirectory = directory;
    await writeFile(join(directory, "payload.txt"), payload, { mode: 0o600 });
    entry.fixture = await seed({ setup, other, scenario, project, catalog });
    const { protectedIds } = entry.fixture;
    entry.before = await observe.snapshot(setup, protectedIds, project);
    const prompt = prompts(project, scenario);
    entry.a = await episode({
      ...common,
      tools,
      prompt: prompt.a,
      complete: completeA,
      call: faultGateway(a.call, scenario.fault, entry.faultEvents),
      checkpoint: async ({ result }) => {
        entry.a = result;
        await checkpoint();
      },
    });
    entry.afterA = await observe.snapshot(setup, protectedIds, project);
    entry.afterB = entry.afterA;
    if (
      scenario.capture &&
      scenario.fault !== "before" &&
      entry.afterA.todos.length === 1
    ) {
      // B starts from new messages: no A transcript, IDs or expected step.
      entry.b = await episode({
        ...common,
        tools: [...tools, executionTool],
        prompt: prompt.b,
        complete: completeB,
        call: async (name, value) => {
          if (name !== executionTool.name) return b.call(name, value);
          entry.execution = await executeCheck({
            args: value,
            client: b,
            directory,
            allowedTaskId: entry.afterA.todos[0].id,
          });
          return entry.execution;
        },
        checkpoint: async ({ result }) => {
          entry.b = result;
          await checkpoint();
        },
      });
      entry.afterB = await observe.snapshot(setup, protectedIds, project);
    }
    entry.result = score(entry);
    // The injected Stop's reply is kept and scored too, so the report can
    // show what the reminder's extra turn changed.
    if (
      entry.a?.answerBeforeStop != null ||
      entry.b?.answerBeforeStop != null
    ) {
      const last = (e) => e && { ...e, answerBeforeStop: undefined };
      entry.resultOnFinalMessage = score({
        ...entry,
        a: last(entry.a),
        b: last(entry.b),
      });
    }
  } catch (error) {
    entry.error = String(error);
    entry.result = { pass: false, failures: [`harness error: ${error}`] };
  }
  return entry;
}
