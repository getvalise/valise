// Fixed UTC window; updated_at deliberately disagrees with completed_at.
export const window = { since: 1792627200, until: 1792713600 }; // Oct 22 [00:00, Oct 23 00:00)
export const project = "handoff-eval";
export const tasks = [
  {
    key: "partial",
    title: "Resume checksum rollout",
    body: "Implement checksum verification. Original plan: implement parser, then integration test, then deploy.",
    progress:
      "Parser already implemented at commit abc1234; unit tests 18/18. Remaining step: integration-check. Do not redo parser. Evidence: fixtures/checksum.spec.ts. Deployment is a separate blocked task.",
    state: "pending",
  },
  {
    key: "blocked",
    title: "Deploy checksum rollout",
    body: "Deployment follows verification.",
    blocker: "vendor-signoff",
    state: "blocked",
  },
  {
    key: "first",
    title: "Checksum boundary-start completed",
    state: "done",
    completed: window.since,
  },
  {
    key: "second",
    title: "Checksum yesterday completed",
    state: "done",
    completed: window.until - 1,
  },
  {
    key: "before",
    title: "Checksum older completion edited yesterday",
    state: "done",
    completed: window.since - 1,
  },
  {
    key: "after",
    title: "Checksum boundary-end completed",
    state: "done",
    completed: window.until,
  },
  {
    key: "active",
    title: "Checksum dashboard work in progress",
    state: "claimed",
  },
];
export const decisions = [
  {
    key: "old",
    title: "Checksum algorithm decision",
    body: "2026-10-20: use sha1. Historical decision; superseded by the 2026-10-22 checksum decision selecting sha256.",
  },
  {
    key: "new",
    title: "Checksum algorithm decision",
    body: "2026-10-22: use sha256. This explicitly supersedes the 2026-10-20 sha1 decision. Rollout remains blocked on vendor-signoff.",
  },
];
export function cases(ids) {
  return [
    {
      id: "resume",
      prompt: `A fresh agent is taking over ${project}. Recover where checksum rollout should resume and its deployment blocker from saved evidence; I should not have to reconstruct the last session.`,
      expected: {
        task_id: ids.partial,
        next_step: "integration-check",
        blockers: ["vendor-signoff"],
      },
      requiredFetch: [ids.partial],
      searchBudget: 1,
    },
    {
      id: "latest-decision",
      prompt: `Which checksum algorithm should ${project} use now? Resolve conflicting saved decisions.`,
      expected: { decision: "sha256" },
      requiredFetch: [ids.new],
      searchBudget: 1,
    },
    {
      id: "completion-window",
      prompt: `Report every completed ${project} task in the UTC interval [2026-10-22T00:00:00Z, 2026-10-23T00:00:00Z). Use completion time, not last edit time.`,
      expected: { completed_ids: [ids.first, ids.second] },
      searchBudget: 1,
    },
    {
      id: "known-id",
      prompt: `Read ${ids.partial} and tell the next agent exactly which step remains.`,
      expected: { task_id: ids.partial, next_step: "integration-check" },
      requiredFetch: [ids.partial],
      searchBudget: 0,
    },
    {
      id: "no-recall",
      prompt: "What is 17 + 25? Nothing needs saving.",
      expected: { answer: 42 },
      searchBudget: 0,
      callBudget: 0,
    },
  ];
}

export const answerContract = `Return only one JSON object when finished. Include applicable fields: task_id (string), next_step (short action identifier), blockers (array of blocker identifiers), decision (algorithm name), completed_ids (array of exact task IDs), answer (number). Also include needs_user_context (boolean). Use evidence from tools, not guesses; if unavailable report needs_user_context:true. This is a read-only handoff assessment: do not claim, complete or change saved records.`;

export function score(testCase, episode) {
  let answer;
  try {
    if (typeof episode.answer !== "string")
      throw new Error("Answer is not text");
    answer = JSON.parse(
      episode.answer.replace(/^```(?:json)?\s*|\s*```$/g, ""),
    );
  } catch {
    answer = null;
  }
  const equal = (actual, expected) =>
    JSON.stringify(Array.isArray(actual) ? [...actual].sort() : actual) ===
    JSON.stringify(Array.isArray(expected) ? [...expected].sort() : expected);
  const wrong = Object.entries(testCase.expected)
    .filter(([key, value]) => !equal(answer?.[key], value))
    .map(([key]) => key);
  const missingEvidence = (testCase.requiredFetch ?? []).filter(
    (id) =>
      !episode.route.some(
        (call) => call.name === "fetch" && call.args.id === id && !call.error,
      ),
  );
  const searches = episode.route.filter(
    (call) => call.name === "search",
  ).length;
  const needlessWrites = episode.route.filter(
    (call) => call.writeAttempt,
  ).length;
  const missedBlockers = (testCase.expected.blockers ?? []).filter(
    (blocker) =>
      !Array.isArray(answer?.blockers) || !answer.blockers.includes(blocker),
  );
  const needsUserContext = answer?.needs_user_context !== false;
  return {
    pass:
      !episode.error &&
      !episode.capped &&
      !wrong.length &&
      !needsUserContext &&
      !needlessWrites &&
      (testCase.callBudget === undefined ||
        episode.route.length <= testCase.callBudget),
    answerCorrect: !wrong.length && !needsUserContext,
    authoritativeFetch: !missingEvidence.length,
    wrong,
    missingEvidence,
    missedBlockers,
    needsUserContext,
    needlessWrites,
    needlessSearches: Math.max(0, searches - testCase.searchBudget),
    calls: episode.route.length,
  };
}
