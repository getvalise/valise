/**
 * How the console names whoever wrote something. An OAuth client's `agent` is
 * its registration URL, so without this every agent-written row would be
 * headed `https://claude.ai/oauth/claude-code-client-metadata`. Pure, so the
 * route components and the logs can share it.
 */

/** Registration URLs of clients people know by a product name. */
const KNOWN_CLIENTS: readonly (readonly [RegExp, string])[] = [
  [
    /^https:\/\/claude\.ai\/oauth\/claude-code-client-metadata\/?$/,
    "Claude Code",
  ],
  [/^https:\/\/opencode\.ai\/oauth\/opencode\//, "OpenCode"],
];

/**
 * A short name for a client: its product name when known, else the readable
 * end of a registration URL, else the agent string as written.
 */
export function clientName(agent: string | null): string {
  if (agent === null || agent.trim() === "") return "unknown";
  for (const [pattern, name] of KNOWN_CLIENTS) {
    if (pattern.test(agent)) return name;
  }
  if (!/^https?:\/\//.test(agent)) return agent;
  // `…/acme-client-metadata` names itself in its last segment;
  // `…/acme/client.json` one segment earlier.
  const segments = agent.replace(/\/+$/, "").split("/").slice(3).reverse();
  for (const segment of segments) {
    const name = segment
      .replace(/\.json$/, "")
      .replace(/-?client-metadata$/, "")
      .replace(/-?metadata$/, "")
      .replace(/^(client|oauth)$/, "");
    if (name !== "") return name;
  }
  return agent;
}

/**
 * Who wrote it, as a person reads it: the session's own name when the client
 * sent one, with the client as the secondary label, else the client alone.
 */
export function authorLabel(
  agent: string | null,
  sessionName: string | null | undefined,
): { name: string; client: string | null } {
  const client = clientName(agent);
  return sessionName
    ? { name: sessionName, client }
    : { name: client, client: null };
}

/** `authorLabel` as one line: `work-todos-60 · Claude Code`, or `Claude Code`. */
export function byline(
  agent: string | null,
  sessionName: string | null | undefined,
): string {
  const { name, client } = authorLabel(agent, sessionName);
  return client ? `${name} · ${client}` : name;
}
