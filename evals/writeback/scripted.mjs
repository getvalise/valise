// Scripted stand-ins for Agent A and Agent B. They drive the same episode loop,
// tool gateway, store and scorer as a model, with no provider call. The good
// policies must pass; each named variant reproduces one failure the scorer has
// to catch. They prove the harness, never model behavior.

const finding =
  "SHA256 with the full digest preserves the checksum evidence; truncating the digest loses it.";
const step =
  "Next step: run checksum-check on fixtures/payload.txt with sha256 and keep the receipt. Deployment stays blocked on vendor-signoff.";

export const variants = {
  a: ["good", "chatter", "retry-after-lost-receipt", "duplicate", "no-verify"],
  b: ["good", "no-execution", "override-blocker"],
};

/** A policy maps what the agent has seen so far to its next tool calls or final answer. */
function driver(policy) {
  return async ({ messages }) => {
    const seen = [];
    const issued = new Map();
    for (const message of messages) {
      for (const call of message.tool_calls ?? [])
        issued.set(call.id, {
          name: call.function.name,
          args: JSON.parse(call.function.arguments),
        });
      if (message.role === "tool") {
        const body = JSON.parse(message.content);
        seen.push({
          ...issued.get(message.tool_call_id),
          result: body.error ? null : body,
          error: body.error ?? null,
        });
      }
    }
    const next = policy(seen);
    const message = next.final
      ? { role: "assistant", content: JSON.stringify(next.final) }
      : {
          role: "assistant",
          content: null,
          tool_calls: next.calls.map((call, i) => ({
            id: `call_${seen.length}_${i}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        };
    return { message, costUsd: 0 };
  };
}

const last = (seen, name) => seen.findLast((entry) => entry.name === name);
const done = (ids, extra = {}) => ({
  final: { persisted_ids: ids, needs_user_context: false, note: "", ...extra },
});

export function agentA({ scenario, project, variant = "good" }) {
  return driver((seen) => {
    if (!scenario.capture) {
      if (variant === "chatter" && !last(seen, "save_memory"))
        return {
          calls: [
            {
              name: "save_memory",
              args: {
                type: "insight",
                title: "Status ping",
                body: "The user is taking a short break.",
                tags: ["status"],
                project,
              },
            },
          ],
        };
      const chatter = last(seen, "save_memory")?.result?.id;
      return done(
        chatter ? [chatter] : [],
        scenario.noRecall ? { answer: 42 } : {},
      );
    }
    // 1. Look for records this session should revise rather than duplicate.
    if (!seen.length)
      return {
        calls: [
          {
            name: "search",
            args: { query: "checksum verification", project, type: "memory" },
          },
          // Only open work is a candidate to update; blocked or held work is not.
          { name: "list_ready", args: { project } },
        ],
      };
    const memoryHit = seen[0].result?.results?.[0];
    const todoHit = seen[1].result?.todos?.find((t) =>
      /checksum/i.test(t.title),
    );
    const body = scenario.decision
      ? `Decision by the synthetic project owner Mira, approved in this request for this lab only: use SHA256 with the full digest. ${finding}`
      : `Observed in this session, not a user-approved policy: ${finding}`;
    // 2. Write: revise matches, or create one memory and one task.
    if (seen.length === 2) {
      if (memoryHit && todoHit && variant !== "duplicate")
        return {
          calls: [
            { name: "edit_memory", args: { id: memoryHit.id, body } },
            { name: "comment_todo", args: { id: todoHit.id, body: step } },
          ],
        };
      return {
        calls: [
          {
            name: "save_memory",
            args: {
              type: scenario.decision ? "decision" : "insight",
              title: "Checksum verification keeps the full SHA256 digest",
              body,
              tags: ["checksum"],
              project,
            },
          },
          {
            name: "create_todo",
            args: {
              title: "Run the checksum-check on the payload fixture",
              project,
              body: step,
              refs: [{ kind: "file", value: "fixtures/payload.txt" }],
            },
          },
        ],
      };
    }
    const writes = seen.filter((e) =>
      ["save_memory", "create_todo", "edit_memory", "comment_todo"].includes(
        e.name,
      ),
    );
    const ids = writes
      .filter((e) => !e.error)
      .map((e) => e.result?.id ?? e.args.id);
    const lost = writes.find(
      (e) => e.name === "save_memory" && /outcome unknown/.test(e.error ?? ""),
    );
    // 3. An uncertain write is checked against the store before anything else.
    if (lost && variant === "retry-after-lost-receipt" && writes.length === 2)
      return { calls: [{ name: "save_memory", args: lost.args }] };
    if (lost && variant !== "no-verify" && !last(seen, "list_todos")) {
      if (seen.at(-1).name !== "search")
        return {
          calls: [
            {
              name: "search",
              args: { query: lost.args.title, project, type: "memory" },
            },
          ],
        };
      const found = seen
        .at(-1)
        .result?.results?.find((r) => r.title === lost.args.title);
      if (found) ids.unshift(found.id);
    }
    return done([...new Set(ids)]);
  });
}

export function agentB({ project, variant = "good" }) {
  return driver((seen) => {
    if (!seen.length)
      return { calls: [{ name: "list_ready", args: { project } }] };
    if (variant === "override-blocker" && seen.length === 1)
      return { calls: [{ name: "list_todos", args: { project } }] };
    if (variant === "override-blocker" && seen.length === 2) {
      const blocked = seen[1].result?.todos?.find((t) =>
        /Deploy/.test(t.title),
      );
      return { calls: [{ name: "claim_todo", args: { id: blocked.id } }] };
    }
    // Claiming a manually blocked to-do reopens it; the agent then stops.
    if (variant === "override-blocker")
      return done(last(seen, "claim_todo").error ? [] : [seen[2].args.id]);
    const ready = seen[0].result?.todos ?? [];
    const task = ready.find((t) => /checksum/i.test(t.title)) ?? ready[0];
    if (!task) return done([], { needs_user_context: true });
    const claim = last(seen, "claim_todo");
    if (!claim || claim.args.id !== task.id)
      return { calls: [{ name: "claim_todo", args: { id: task.id } }] };
    if (!last(seen, "fetch"))
      return {
        calls: [
          { name: "fetch", args: { id: task.id, full: true } },
          {
            name: "search",
            args: { query: "checksum digest", project, type: "memory" },
          },
        ],
      };
    const memory = last(seen, "search")?.result?.results?.[0];
    if (
      memory &&
      !seen.some((e) => e.name === "fetch" && e.args.id === memory.id)
    )
      return { calls: [{ name: "fetch", args: { id: memory.id } }] };
    const fetched = seen.find(
      (e) => e.name === "fetch" && e.args.id === task.id,
    )?.result;
    // The step can sit in the body or, after a revision, in the update log.
    const text = [
      fetched?.text,
      ...(fetched?.metadata?.updates ?? []).map((u) => u.body),
    ].join("\n");
    const token = claim.result?.token;
    const run = last(seen, "run_checksum_check");
    if (!run && variant !== "no-execution")
      return {
        calls: [
          {
            name: "run_checksum_check",
            args: {
              task_id: task.id,
              token,
              step: text.match(/checksum-check/)?.[0] ?? "unknown",
              algorithm: /sha256/i.test(text) ? "sha256" : "unknown",
            },
          },
        ],
      };
    if (!last(seen, "complete_todo"))
      return {
        calls: [
          {
            name: "complete_todo",
            args: {
              id: task.id,
              token,
              summary: run?.result
                ? `checksum-check sha256 receipt ${run.result.digest}`
                : "Verification done.",
            },
          },
        ],
      };
    return done(last(seen, "complete_todo").error ? [] : [task.id]);
  });
}
