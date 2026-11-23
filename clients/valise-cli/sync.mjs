import { createHash } from "node:crypto";

/**
 * Sending a session's turns to Valise so that a resend adds nothing and a
 * diverged history is resent from the longest common prefix. The server
 * hashes each turn from its kind, tool and text; this computes the same, so
 * the writer can find the prefix from the state the server returns.
 */

export const TRANSCRIPTS_PATH = "/mcp/transcripts";

/** Valise holds a different history for this session than the writer has. */
export class DivergedHistory extends Error {}
/** Turns per request, the server's cap. */
export const TURNS_PER_WRITE = 500;

export function turnHash(turn) {
  return createHash("sha256")
    .update(JSON.stringify([turn.kind, turn.tool_name ?? "", turn.text]))
    .digest("hex");
}

/** How many leading turns agree with the server's hash list. */
export function commonPrefix(turns, hashes) {
  let n = 0;
  while (
    n < turns.length &&
    n < hashes.length &&
    turnHash(turns[n]) === hashes[n]
  )
    n++;
  return n;
}

/**
 * Push `turns` for `session` through `api` (`{ get, post }`), starting from
 * `from` when known. When Valise's history differs from this one partway
 * (a newer distiller keeps turns an older one dropped), the first request
 * replaces what Valise holds from the common prefix on; appending alone
 * could never get past the difference. A 409 is answered once by resending
 * from the prefix the server's hashes give. Returns the server's answer, or
 * `{ skipped: true }` when nothing was new.
 *
 * `onlyNew` is for archives: a copy taken before the session ended may be
 * older than what Valise holds, so a session Valise holds at all is left
 * alone rather than replaced.
 */
export async function pushTurns(
  api,
  session,
  turns,
  { from = null, onlyNew = false } = {},
) {
  if (turns.length === 0) return { skipped: true, reason: "no turns" };
  let start = from;
  let replace = false;
  if (start === null) {
    const state = await api.get(session);
    if (onlyNew && state !== null)
      return {
        skipped: true,
        reason: "held already",
        turn_count: state.turn_count,
      };
    start = state === null ? 0 : commonPrefix(turns, state.hashes);
    if (
      state !== null &&
      start === state.turn_count &&
      start === turns.length
    ) {
      return { skipped: true, reason: "held already", turn_count: start };
    }
    replace = state !== null && start < state.turn_count;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await postFrom(api, session, turns, start, replace);
    if (result.status !== 409) return result;
    const hashes = result.body.hashes ?? [];
    start = commonPrefix(turns, hashes);
    if (start === turns.length && start === hashes.length) {
      return { skipped: true, reason: "held already", turn_count: start };
    }
    replace = start < hashes.length;
  }
  throw new DivergedHistory(
    `Valise refused the session twice at ${TRANSCRIPTS_PATH}; its history differs from this machine's.`,
  );
}

async function postFrom(api, session, turns, start, replace = false) {
  let result = null;
  for (let at = start; at < turns.length; at += TURNS_PER_WRITE) {
    const slice = turns.slice(at, at + TURNS_PER_WRITE);
    const body = { ...session, from: at, turns: slice };
    // Only the first request replaces; the rest append after it.
    if (replace && at === start) body.replace = true;
    result = await api.post(body);
    if (result.status === 409) return result;
    if (result.status !== 200) {
      throw new Error(
        `${TRANSCRIPTS_PATH} answered ${result.status}: ${JSON.stringify(result.body)}`,
      );
    }
  }
  return result ?? { status: 200, body: { appended: 0 } };
}

/** An `api` over fetch with a bearer, the shape `pushTurns` expects. */
export function transcriptsApi(origin, token) {
  const base = origin.replace(/\/+$/, "");
  // `token` may be a function, sync or async, so a long import can refresh.
  const headers = async () => ({
    authorization: `Bearer ${typeof token === "function" ? await token() : token}`,
    "content-type": "application/json",
  });
  return {
    async get(session) {
      const url = new URL(`${base}${TRANSCRIPTS_PATH}`);
      url.search = new URLSearchParams({
        client: session.client,
        device: session.device,
        session: session.session_id,
      }).toString();
      const response = await fetch(url, { headers: await headers() });
      if (response.status === 404) return null;
      if (!response.ok)
        throw new Error(
          `${TRANSCRIPTS_PATH} answered ${response.status}: ${await response.text()}`,
        );
      return response.json();
    },
    async post(body) {
      const response = await fetch(`${base}${TRANSCRIPTS_PATH}`, {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify(body),
      });
      return {
        status: response.status,
        body: await response.json().catch(() => ({})),
      };
    },
  };
}
