import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";

/**
 * The CLI's state on one machine: where Valise is, the OAuth client and its
 * tokens, the device name sent with every transcript, and the login agent
 * that watches for new sessions. One file, mode 0600, under the user's config
 * directory; `VALISE_HOME` moves it. The OS keychain is not used yet.
 */

export function configDir() {
  if (process.env.VALISE_HOME) return process.env.VALISE_HOME;
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg || path.join(homedir(), ".config"), "valise");
}

export function configPath() {
  return path.join(configDir(), "cli.json");
}

export const DEFAULTS = Object.freeze({
  origin: "https://app.valise.run",
  device: hostname(),
  auth: null,
});

export function readConfig() {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8"));
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeConfig(config) {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const file = configPath();
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}
