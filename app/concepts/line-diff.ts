/** One line of a diff: kept, removed from the old text, or added in the new. */
export type DiffLine = { op: "same" | "del" | "add"; text: string };

/** A run of unchanged lines long enough to fold, and how many it hid. */
export type DiffHunk = DiffLine | { op: "fold"; count: number };

/*
 * Past this many cells the LCS table costs more than the answer is worth. A
 * SKILL.md is a few hundred lines, so only a pasted file of thousands ever
 * reaches it, and that gets the changed middle as one removal and one
 * addition rather than a request that times out.
 */
const MAX_CELLS = 4_000_000;

/**
 * A line diff by longest common subsequence, after trimming the shared head
 * and tail. Good enough for a person reviewing one file before publishing it;
 * not a patch format.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = a.slice(0, start).map(same);
  const tail = a.slice(endA).map(same);
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  return [...head, ...diffMiddle(midA, midB), ...tail];
}

/** Folds every unchanged run longer than twice `context` down to its edges. */
export function foldDiff(lines: DiffLine[], context = 3): DiffHunk[] {
  const out: DiffHunk[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].op !== "same") {
      out.push(lines[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].op === "same") j++;
    const run = lines.slice(i, j);
    const keepBefore = i === 0 ? 0 : context;
    const keepAfter = j === lines.length ? 0 : context;
    // Folding fewer than three lines hides less than the fold line costs.
    if (run.length >= keepBefore + keepAfter + 3) {
      out.push(...run.slice(0, keepBefore));
      out.push({ op: "fold", count: run.length - keepBefore - keepAfter });
      out.push(...run.slice(run.length - keepAfter));
    } else {
      out.push(...run);
    }
    i = j;
  }
  return out;
}

function diffMiddle(a: string[], b: string[]): DiffLine[] {
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map(del), ...b.map(add)];
  }
  // lengths[i][j] is the LCS of a[i..] and b[j..], one flat row-major array.
  const width = b.length + 1;
  const lengths = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i * width + j] =
        a[i] === b[j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(same(a[i]));
      i++;
      j++;
    } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
      out.push(del(a[i]));
      i++;
    } else {
      out.push(add(b[j]));
      j++;
    }
  }
  while (i < a.length) out.push(del(a[i++]));
  while (j < b.length) out.push(add(b[j++]));
  return out;
}

function same(text: string): DiffLine {
  return { op: "same", text };
}
function del(text: string): DiffLine {
  return { op: "del", text };
}
function add(text: string): DiffLine {
  return { op: "add", text };
}
