/**
 * Terminal output for the steps a command takes, so a person sees what is
 * being changed on their machine as it happens. Colour only on a terminal
 * and never under NO_COLOR; everything goes to stderr, leaving stdout for
 * output a script reads.
 */

const color =
  process.stderr.isTTY && !process.env.NO_COLOR
    ? (code) => (text) => `\x1b[${code}m${text}\x1b[0m`
    : () => (text) => text;

export const green = color(32);
export const red = color(31);
export const yellow = color(33);
export const dim = color(2);
export const bold = color(1);

const write = (line = "") => process.stderr.write(`${line}\n`);

/** One completed step: a mark, what was done, and where, dimmed. */
export function done(label, detail) {
  write(`  ${green("✓")} ${label}${detail ? `  ${dim(detail)}` : ""}`);
}

export function todo(label, detail) {
  write(`  ${dim("○")} ${label}${detail ? `  ${dim(detail)}` : ""}`);
}

export function failed(label, detail) {
  write(`  ${red("✗")} ${label}${detail ? `  ${dim(detail)}` : ""}`);
}

export function heading(text) {
  write();
  write(bold(text));
}

/** A notice the person should read before moving on. */
export function notice(lines) {
  write();
  for (const [i, line] of lines.entries()) {
    write(`  ${i === 0 ? yellow("!") : " "} ${line}`);
  }
  write();
}

let lastDraw = 0;
/**
 * A line that redraws in place on a terminal, at most ten times a second;
 * `final` forces a draw. Off a terminal it prints nothing, and the caller's
 * closing `done` line carries the result.
 */
export function progress(text, { final = false } = {}) {
  if (!process.stderr.isTTY) return;
  const now = Date.now();
  if (!final && now - lastDraw < 100) return;
  lastDraw = now;
  const line = fitLine(`  ${yellow("…")} ${text}`, process.stderr.columns);
  process.stderr.write(`\r\x1b[K${line}`);
}

const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * `line` cut to fit `columns` without wrapping. `\r` only returns to the
 * start of the row the cursor is on, so a wrapped line leaves its first row
 * behind on every redraw. A line that does not fit loses its colour and
 * ends in an ellipsis.
 */
export function fitLine(line, columns) {
  if (!columns) return line;
  const plain = line.replace(ANSI, "");
  if (plain.length < columns) return line;
  return `${plain.slice(0, Math.max(columns - 2, 0))}…`;
}

export function clearProgress() {
  if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
}
