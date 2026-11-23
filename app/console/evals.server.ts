/**
 * The evals tab's data, read on the server so only the condition and the case
 * being looked at cross the wire. The index holds every run on disk; bundling
 * it into the route module would grow the client bundle with every eval.
 * ADR-0006.
 *
 * Recorded runs stay local, so `evals/runs/index.json` exists only where
 * someone ran the evals. The build uses it when it is on disk and otherwise
 * falls back to `evals/fixtures/runs-index.sample.json`, a committed,
 * trimmed index of earlier runs, so a fresh checkout still renders the tab.
 *
 * Rebuild the local index with `npm run evals:index`; `npm run evals` and
 * `npm run evals:verdict` do it too.
 */
const indexes = import.meta.glob<EvalIndex>(
  [
    "../../evals/runs/index.json",
    "../../evals/fixtures/runs-index.sample.json",
  ],
  { eager: true, import: "default" },
);
const index =
  indexes["../../evals/runs/index.json"] ??
  indexes["../../evals/fixtures/runs-index.sample.json"];

type EvalIndex = {
  generatedAt: string;
  conditions: unknown[];
  cases: unknown[];
  runs: unknown[];
  history: Record<string, unknown>;
};

export type EvalCell = {
  /**
   * Rows that passed, out of the rows the cell ran. The rest of the cell is
   * one of those rows: the first miss when there was one.
   */
  passes: number;
  n: number;
  /**
   * Rows that passed within the case's turn budget. Null on a run from before
   * the budget, and on a harness run.
   */
  withinBudget: number | null;
  /** The turns each passing row took. Empty on a run before V1-13. */
  turnsToPass: number[];
  /** Rows that ran out of rounds on reads rather than ending on a tool. */
  capped: number;
  /** The shown row ran out of rounds; `chose` is then its last read. */
  routeCapped: boolean;
  chose: string | null;
  /** Every row passed. */
  pass: boolean;
  toolMatch: boolean;
  missingArgs: string[];
  /** The skill the case requires and the route did not read. */
  viaMissing: string | null;
  /** Present but not the value the case's `expectArgs` names. */
  wrongArgs: string[];
  /** A prose ending that named none of the case's `expectAnswer` strings. */
  answerMissing: boolean;
  route: string[];
  /** Model calls, not tool calls. Null on a run written before V1-13. */
  turns: number | null;
  /** Prompt plus completion. Null on a run written before V1-13. */
  tokens: number | null;
  costUsd: number | null;
  error: string | null;
  /** The run this result came from. */
  stamp: string;
  /** The result it replaced, which a delta compares with. */
  was: { stamp: string; passes: number; n: number } | null;
};

/** The case as the newest run that sent it recorded it. */
export type EvalCase = {
  id: string;
  expected: string | null;
  /** The turn as sent. Null on a case no run has sent. */
  prompt: string | null;
  why: string | null;
  via: string | null;
  alsoAccept: string[];
  requiredArgs: string[];
  /** The model calls a good route needs. Null on a run before the budget. */
  turnBudget: number | null;
  system: string | null;
  /** The newest run that sent it, or null when none has. */
  scoredIn: string | null;
};

export type Verdict = "kept" | "dropped" | "baseline";

export type EvalSummaryRow = {
  model: string;
  total: number;
  exact: number;
  accepted: number;
  argsValid: number;
  /** Passed within the turn budget. Null before the budget and on a harness run. */
  withinBudget: number | null;
  capped: number;
  viaSkill: number;
  turns: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  /** Calls landing on a tool that offers `why`, and how many said. ADR-0007. */
  whyOffered: number;
  whyFilled: number;
  errors: number;
};

/** Plain surface, rival tools, a seeded corpus, or a harness lane. */
export type EvalCondition = {
  key: string;
  label: string;
  runs: number;
  newest: string | null;
  models: string[];
  /** Over each case's newest result, and over the results those replaced. */
  summary: EvalSummaryRow[];
  before: EvalSummaryRow[];
  divergence: { divergent: number; cases: number };
  cells: Record<string, Record<string, EvalCell>>;
};

export type EvalRunNote = {
  stamp: string;
  at: string;
  condition: string;
  cases: number;
  models: number;
  repeat: number;
  rows: number;
  passes: number;
  toolsHash: string | null;
  /** What the run tested, from `--note`. */
  note: string | null;
  verdict: Verdict | null;
  why: string | null;
};

export type EvalHistoryEntry = {
  run: EvalRunNote;
  /** `[passes, n]` per model, in the order of the history's `models`. */
  marks: ([number, number] | null)[];
  /** The case's own text changed since the run before that sent it. */
  edited: boolean;
  /** Tools the case expects, accepts or routes through whose text changed. */
  changedTools: string[];
  /** Other tools whose text changed. */
  otherTools: number;
  /** Something on the surface changed. All an older pair of runs can say. */
  surfaceChanged: boolean;
};

export type EvalCaseRow = Pick<EvalCase, "id" | "expected" | "turnBudget">;

export type Evals = {
  generatedAt: string;
  conditions: Pick<EvalCondition, "key" | "label" | "runs" | "newest">[];
  condition: EvalCondition | null;
  cases: EvalCaseRow[];
  runs: EvalRunNote[];
  /** The case open in the pane, with every run that sent it. */
  opened: {
    testCase: EvalCase;
    models: string[];
    history: EvalHistoryEntry[];
  } | null;
  /** A `?case=` the suite does not hold. */
  missing: string | null;
};

type IndexHistory = Record<
  string,
  {
    models: string[];
    entries: (Omit<EvalHistoryEntry, "run"> & { stamp: string })[];
  }
>;

const conditions = index.conditions as unknown as EvalCondition[];
const cases = index.cases as unknown as EvalCase[];
const runs = index.runs as unknown as EvalRunNote[];
const history = index.history as unknown as IndexHistory;
const runsByStamp = new Map(runs.map((run) => [run.stamp, run]));

export function readEvals(
  conditionKey: string | null,
  caseId: string | null,
): Evals {
  const condition =
    conditions.find((each) => each.key === (conditionKey ?? "plain")) ??
    conditions[0] ??
    null;
  const testCase = caseId ? cases.find((each) => each.id === caseId) : null;
  const trail = testCase ? history[testCase.id] : undefined;
  return {
    generatedAt: index.generatedAt,
    conditions: conditions.map(({ key, label, runs, newest }) => ({
      key,
      label,
      runs,
      newest,
    })),
    condition,
    cases: cases.map(({ id, expected, turnBudget }) => ({
      id,
      expected,
      turnBudget,
    })),
    runs,
    opened: testCase
      ? {
          testCase,
          models: trail?.models ?? [],
          history: (trail?.entries ?? []).flatMap(({ stamp, ...entry }) => {
            const run = runsByStamp.get(stamp);
            return run ? [{ ...entry, run }] : [];
          }),
        }
      : null,
    missing: caseId && !testCase ? caseId : null,
  };
}
