import { createHash } from "node:crypto";

export const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const writeTools = new Set([
  "save_memory",
  "edit_memory",
  "create_todo",
  "comment_todo",
  "claim_todo",
  "update_todo",
  "complete_todo",
]);

// These are measurement controls, not a change to Valise's tool contracts.
export const scenarios = [
  { id: "new", capture: true, seedMatch: false, fault: "none" },
  { id: "matching", capture: true, seedMatch: true, fault: "none" },
  { id: "lost-receipt", capture: true, seedMatch: false, fault: "after" },
  { id: "refused-write", capture: true, seedMatch: false, fault: "before" },
  { id: "ephemeral", capture: false, noRecall: false, fault: "none" },
  { id: "arithmetic", capture: false, noRecall: true, fault: "none" },
  {
    id: "approved-decision",
    capture: true,
    seedMatch: false,
    fault: "none",
    decision: true,
  },
];

// Round 5 (2026-11-01) added "this session does not run it": in round 4 a
// real client's shell drew Haiku's A into hashing the file itself in 11 of 12
// runs. The lane measures writeback, not restraint.
export function prompts(project, scenario) {
  return {
    a: scenario.capture
      ? `We are working on ${project}. Synthetic lab observation: the parser is implemented; its remaining verification step is checksum-check on fixtures/payload.txt. In this lab SHA256 preserves the full digest; truncating it loses evidence. ${scenario.decision ? "I, synthetic project owner Mira, explicitly choose SHA256 with the full digest for this lab. Record my choice as approved in this request, not a universal policy." : "This is your observed finding, not a user-approved algorithm policy."} I authorize the next agent to run that local check and keep its receipt, not deploy; this session does not run it. Deployment still needs vendor-signoff. Wrap up this session by recording what the next agent needs to continue without my reconstructing the work. Reuse matching saved records where appropriate; leave unrelated active work alone.`
      : scenario.noRecall
        ? "What is 17 + 25? Nothing needs saving or recalling."
        : `For ${project}, acknowledge this ephemeral status ping: I am taking a short break. There is no new finding, decision or work to record.`,
    // No IDs, expected digest, concrete step, finding, or A messages leak to B.
    b: `Continue the authorized unfinished work for ${project} from durable context. Respect blockers and other agents' active work. Perform the allowed local step and retain its evidence. Do not ask me to reconstruct available context.`,
  };
}

// "Persisted" is every record this session's writes changed, not only new
// ones: the scorer compares each memory and to-do row, history included.
// Round 4's B completed a to-do and reported [], reading it as new memories.
export const answerContract = `Finish with one JSON object: persisted_ids (array of the exact memory and to-do IDs your tool calls created or changed this session; saving or editing a memory, and creating, claiming, commenting on, updating or completing a to-do, each count; reading does not), needs_user_context (boolean), answer (optional number), and note (short string). Do not claim persistence from an uncertain write acknowledgement. Execution receipts belong in durable task progress. Tools, not this output, perform writes.`;

/** A fault at the transport boundary, not a fabricated server validation error. */
export function faultGateway(call, mode, events) {
  let injected = false;
  return async (name, args) => {
    if (mode === "before" && writeTools.has(name)) {
      events.push({ name, args, fault: "before", persisted: false });
      throw new Error("Injected transport refusal: request was not dispatched");
    }
    const value = await call(name, args);
    if (mode === "after" && !injected && name === "save_memory") {
      injected = true;
      // Receipt retained only in evaluator evidence, never delivered to the model.
      events.push({ name, args, fault: "after", persisted: true, value });
      throw new Error(
        "Injected lost response: write outcome unknown; inspect persistence before retrying",
      );
    }
    return value;
  };
}

/**
 * The final answer is bare JSON, or prose ending in a fenced JSON block: the
 * contract says "finish with one JSON object" and Haiku fences it. Only the
 * last fence counts, so an earlier example in the prose cannot stand in.
 */
export function parseAnswer(text) {
  if (typeof text !== "string") return null;
  const object = (raw) => {
    try {
      const value = JSON.parse(raw);
      return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
    } catch {
      return null;
    }
  };
  const bare = object(text.trim());
  if (bare) return bare;
  const fences = [...text.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)\n?```/g)];
  return fences.length ? object(fences.at(-1)[1].trim()) : null;
}

/**
 * With an injected Stop, the user saw the answer before the reminder; the
 * reply to the reminder is a second message, not a correction. The answer
 * scores from the first, and persisted IDs are the union of both, because a
 * write made after the reminder is still this session's write.
 */
export function scoredAnswer(episode) {
  if (!episode || episode.answerBeforeStop == null) return episode?.answer;
  const before = parseAnswer(episode.answerBeforeStop);
  const after = parseAnswer(episode.answer);
  if (!before) return episode.answer;
  const ids = [before.persisted_ids, after?.persisted_ids].filter(
    Array.isArray,
  );
  return JSON.stringify({
    ...before,
    persisted_ids: ids.length ? [...new Set(ids.flat())] : before.persisted_ids,
  });
}

/** Old runs kept no answerBeforeStop; recover it from the transcript. */
export function withAnswerBeforeStop(episode, stopText) {
  if (!episode || !stopText || episode.answerBeforeStop != null) return episode;
  const at = episode.messages?.findIndex(
    (m) => m.role === "user" && m.content === stopText,
  );
  if (!(at > 0) || episode.messages[at - 1].role !== "assistant")
    return episode;
  return {
    ...episode,
    answerBeforeStop: episode.messages[at - 1].content ?? "",
  };
}

/** Snapshot records are observed independently of the agent's reported IDs. */
export function score({
  scenario,
  project,
  before,
  afterA,
  afterB,
  a,
  b,
  execution,
  faultEvents = [],
}) {
  const failures = [];
  const require = (ok, reason) => {
    if (!ok) failures.push(reason);
  };
  const same = (x, y) => hash(x) === hash(y);
  const allRecords = (s) => [...s.memories, ...s.todos];
  const protectedIds = before.protected.map((r) => r.id);
  const protectedOK = (snapshot) => same(before.protected, snapshot.protected);
  require(protectedOK(afterA), "A changed protected claim/blocker/history");
  require(protectedOK(afterB), "B changed protected claim/blocker/history");
  require(same(
    before.outside ?? [],
    afterA.outside ?? [],
  ), "A wrote outside its project");
  require(same(
    afterA.outside ?? [],
    afterB.outside ?? [],
  ), "B wrote outside its project");
  for (const [stage, episode, initial, final] of [
    ["A", a, before, afterA],
    ["B", b, afterA, afterB],
  ]) {
    if (!episode) continue;
    const answer = parseAnswer(scoredAnswer(episode));
    require(!episode.error && !episode.capped, `${stage} episode error/cap`);
    require(answer?.needs_user_context ===
      false, `${stage} missing context/final answer`);
    const ids = answer?.persisted_ids;
    require(Array.isArray(ids) &&
      ids.every((id) => typeof id === "string") &&
      new Set(ids).size === ids.length, `${stage} invalid persisted IDs`);
    const changed = allRecords(final)
      .filter((r) => {
        const old = allRecords(initial).find((x) => x.id === r.id);
        return !old || !same(old, r);
      })
      .map((r) => r.id);
    require(Array.isArray(ids) &&
      same(
        [...ids].sort(),
        [...changed].sort(),
      ), `${stage} reported IDs differ from actual changes`);
    require(!episode.calls.some(
      (c) => writeTools.has(c.name) && protectedIds.includes(c.args?.id),
    ), `${stage} attempted write to protected work`);
  }
  const attemptedWrites = a.calls.filter((c) => writeTools.has(c.name));
  if (!scenario.capture || scenario.fault === "before") {
    require(same(before, afterA), "unexpected durable write");
    if (!scenario.capture)
      require(attemptedWrites.length === 0, "unnecessary write attempt");
    if (scenario.noRecall) {
      require(a.calls.length === 0, "unnecessary recall");
      require(parseAnswer(scoredAnswer(a))?.answer === 42, "wrong arithmetic");
    }
    if (scenario.fault === "before")
      require(attemptedWrites.length > 0, "refusal fault not exercised");
    return { pass: failures.length === 0, failures, executionAccepted: false };
  }
  require(afterA.memories.length === 1, "missing or duplicate scoped finding");
  require(afterA.todos.length === 1, "missing or duplicate scoped next work");
  const memory = afterA.memories[0];
  const task = afterA.todos[0];
  require(typeof project === "string" &&
    memory?.project === project &&
    task?.project === project, "capture escaped project scope");
  require(scenario.decision
    ? memory?.type === "decision" && /Mira/.test(memory?.text ?? "")
    : memory?.type === "insight" ||
        memory?.type === "fact", "incorrect memory authority/type");
  require(/sha256/i.test(memory?.text ?? "") &&
    /truncat/i.test(
      memory?.text ?? "",
    ), "finding lost actionable qualification");
  require(/checksum-check/.test(task?.text ?? "") &&
    /vendor-signoff/.test(task?.text ?? ""), "missing concrete step/blocker");
  require(task?.refs?.some(
    (ref) => ref.kind === "file" && ref.value === "fixtures/payload.txt",
  ), "missing work reference");
  require(task?.state === "pending", "A did not leave ready work");
  for (const record of [memory, task]) {
    require(Boolean(record?.projectionVisible) &&
      Boolean(
        record?.searchVisible,
      ), "durable content not visible through projection and MCP search");
  }
  if (scenario.seedMatch) {
    require(memory?.id === before.memories[0]?.id &&
      task?.id ===
        before.todos[0]?.id, "matching record replaced or duplicated");
    require(memory?.revision >
      before.memories[0]?.revision, "memory revision did not advance");
  }
  if (scenario.fault === "after")
    require(faultEvents.some(
      (event) => event.fault === "after" && event.persisted,
    ), "lost-receipt fault not exercised");
  require(Boolean(b), "fresh B not run");
  require(afterB.memories.length === 1 &&
    afterB.todos.length === 1, "B created duplicate or unrelated records");
  require(same(
    afterA.memories,
    afterB.memories,
  ), "B changed the saved finding during execution");
  for (const record of [memory, task]) {
    require(Boolean(record) &&
      b?.calls.some(
        (c) =>
          c.name === "fetch" &&
          c.args?.id === record.id &&
          !c.error &&
          c.result?.id === record.id,
      ), "B did not retrieve authoritative saved context");
  }
  require(execution?.verified === true &&
    execution?.taskId ===
      task?.id, "no independently verified execution artifact");
  require(execution?.algorithm === "sha256" &&
    execution?.step === "checksum-check", "wrong executed step");
  const finished = afterB.todos.find((r) => r.id === task?.id);
  require(finished?.projectionVisible &&
    finished?.searchVisible, "completed work not visible through projection and MCP search");
  require(finished?.state === "done", "B did not complete allowed work");
  require(Boolean(execution?.digest) &&
    finished?.text.includes(
      execution.digest,
    ), "execution receipt not in durable task history");
  require(b?.calls.some(
    (c) => c.name === "claim_todo" && c.args?.id === task?.id && !c.error,
  ), "B did not acquire ready task claim");
  return {
    pass: failures.length === 0,
    failures,
    executionAccepted: failures.length === 0,
  };
}

/** Reserve before dispatch. Unknown billing never frees a reservation. */
export class Budget {
  constructor({ usd = 1, episodes = 24, rounds = 8 } = {}) {
    if (
      !(Number.isFinite(usd) && usd > 0) ||
      !Number.isInteger(episodes) ||
      episodes < 1 ||
      !Number.isInteger(rounds) ||
      rounds < 1
    )
      throw new Error("Invalid bounded budget");
    this.cap = usd;
    this.episodeLimit = episodes;
    this.roundLimit = rounds;
    this.episodes = 0;
    this.spent = 0;
    this.requests = [];
    this.stopped = false;
  }
  startEpisode() {
    if (this.stopped || this.episodes >= this.episodeLimit)
      throw new Error("Episode budget exhausted");
    this.episodes++;
  }
  reserve(usd) {
    if (
      this.stopped ||
      !Number.isFinite(usd) ||
      usd <= 0 ||
      this.spent + usd > this.cap
    )
      throw new Error("Cost budget exhausted or unknown bound");
    const receipt = { reserved: usd, billed: null };
    this.spent += usd;
    this.requests.push(receipt);
    return receipt;
  }
  settle(receipt, billed) {
    if (!this.requests.includes(receipt) || receipt.settled)
      throw new Error("Unknown or settled reservation");
    receipt.settled = true;
    if (!Number.isFinite(billed) || billed < 0) return;
    receipt.billed = billed;
    this.spent += billed - receipt.reserved;
    if (billed > receipt.reserved || this.spent > this.cap) this.stopped = true;
  }
}
