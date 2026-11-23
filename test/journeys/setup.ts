import { execFile } from "node:child_process";
import { randomBytes, webcrypto } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { prepareRun, startServer, sweepStaleRuns } from "../ui/fixtures/server";

const execute = promisify(execFile);

/**
 * With JOURNEY_ORIGIN set, the run targets that origin and needs member
 * credentials in the environment. Without it, this builds the Worker, starts
 * one local server on a free port and seeds two verified members, each its
 * own tenant, with a password generated for this run only.
 */
export default async function setup() {
  if (process.env.JOURNEY_ORIGIN) {
    for (const name of ["JOURNEY_A_EMAIL", "JOURNEY_A_PASSWORD"])
      if (!process.env[name]) throw new Error(`${name} is required`);
    process.env.JOURNEY_LABEL ??= new URL(process.env.JOURNEY_ORIGIN).host;
    return;
  }
  await sweepStaleRuns();
  const root = resolve(".wrangler", "ui-test", `run-${process.pid}`);
  await prepareRun(root);
  const members = {
    A: { email: "journey-a@example.test", name: "Journey A" },
    B: { email: "journey-b@example.test", name: "Journey B" },
  };
  const password = `journey-${randomBytes(9).toString("base64url")}`;
  const now = Math.floor(Date.now() / 1000);
  const rows = await Promise.all(
    Object.entries(members).map(
      async ([key, member]) =>
        `INSERT INTO users (user_id, email, display_name, role, plan, created_at, last_seen_at, password_hash, email_verified)
         VALUES ('usr_journey_${key.toLowerCase()}', '${member.email}', '${member.name}', 'member', 'free', ${now}, ${now}, '${await hashPassword(password)}', 1);`,
    ),
  );
  const sql = join(root, "journey-members.sql");
  await writeFile(sql, rows.join("\n"), { mode: 0o600 });
  await execute(
    process.execPath,
    [
      resolve("node_modules/wrangler/bin/wrangler.js"),
      "d1",
      "execute",
      "DB",
      "--local",
      "--persist-to",
      join(root, "template"),
      "--file",
      sql,
    ],
    { env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" } },
  );
  const server = await startServer({ root, worker: 0, slot: 0 });
  Object.assign(process.env, {
    JOURNEY_ORIGIN: server.baseURL,
    JOURNEY_LABEL: "local",
    JOURNEY_A_EMAIL: members.A.email,
    JOURNEY_A_PASSWORD: password,
    JOURNEY_B_EMAIL: members.B.email,
    JOURNEY_B_PASSWORD: password,
  });
  return async () => {
    await server.stop();
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  };
}

/** The same format as app/lib/password.server.ts. */
async function hashPassword(password: string): Promise<string> {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const key = await webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const bits = await webcrypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    key,
    256,
  );
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
  return `pbkdf2$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}
