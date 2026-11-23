import type { Provenance } from "~/concepts/memories";
import type { BundleFile } from "~/r2/bundles";
import { sha256Hex } from "~/r2/bundles";
import { MAX_OBJECT_BYTES } from "~/r2/objects";
import { inChunks, publishSkill, readFrontmatter } from "./skills";
import type { RegistryFailure } from "./skills-registry";

/**
 * Skills from a GitHub URL, read from one tarball per request.
 *
 * Unauthenticated GitHub API calls are limited to 60 an hour per IP, and
 * Workers share outbound IPs, so a call per file would fail for reasons that
 * have nothing to do with the user. `codeload.github.com` serves the whole
 * repository as one tar.gz, and `git archive` writes the commit sha into its
 * pax global header, so one download gives every file and the exact commit.
 */

const DOWNLOAD_TIMEOUT_MS = 20_000;
/** Per skill. skills.sh caps at 2MB because it serves text only; a GitHub
 * bundle can carry images, so it gets the object store's 10 MiB. ADR-0011. */
const MAX_FILES = 50;
const MAX_TOTAL_BYTES = MAX_OBJECT_BYTES;
/** A repository, not a skill: past this the archive is not a skills repo. */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

/**
 * Any Worker env. Only tests set `GITHUB_CODELOAD_URL`, to point the download
 * at a stub, so it is read rather than declared: an all-optional type would
 * refuse the real `Env`, which shares none of its keys.
 */
export type GithubEnv = object;

/** What a pasted URL points at. */
export type SkillUrl =
  | { kind: "skills.sh"; id: string }
  | {
      kind: "github";
      owner: string;
      repo: string;
      ref: string;
      /** The skill's folder, or "" for the repository root. */
      path: string;
      /** A folder names one skill; a bare repository lists them all. */
      scope: "skill" | "repo";
    };

const NAME = /^[\w.-]+$/;

/**
 * Reads the URL shapes a person pastes. A ref is taken as one path segment,
 * so a branch with a slash in its name has to be pasted as a commit sha.
 */
export function parseSkillUrl(input: string): SkillUrl | RegistryFailure {
  const trimmed = input.trim().replace(/\/+$/, "");
  const fail = {
    errors: [
      `${trimmed || "That"} is not a GitHub file, folder or repository, or a skills.sh link.`,
    ],
  };
  if (trimmed === "") return fail;

  // `owner/repo/skill` is how skills.sh names a skill, so a bare three-part
  // id goes there, and a bare two-part one is a GitHub repository.
  if (/^[\w.-]+\/[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    return { kind: "skills.sh", id: trimmed };
  }
  const bare = /^([\w.-]+)\/([\w.-]+)$/.exec(trimmed);
  if (bare) return github(bare[1], bare[2], "HEAD", "", "repo") ?? fail;

  let url: URL;
  try {
    url = new URL(
      /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`,
    );
  } catch {
    return fail;
  }
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const host = url.hostname.replace(/^www\./, "");

  if (host === "skills.sh" && parts.length === 3) {
    return { kind: "skills.sh", id: parts.join("/") };
  }
  if (host === "raw.githubusercontent.com" && parts.length >= 4) {
    const [owner, repo, ref, ...rest] = parts;
    return fromFile(owner, repo, ref, rest) ?? fail;
  }
  if (host !== "github.com" || parts.length < 2) return fail;
  const [owner, repo, verb, ref, ...rest] = parts;
  const name = repo.replace(/\.git$/, "");
  if (verb === undefined)
    return github(owner, name, "HEAD", "", "repo") ?? fail;
  if (verb === "blob" && ref) return fromFile(owner, name, ref, rest) ?? fail;
  if (verb === "tree" && ref) {
    return rest.length === 0
      ? (github(owner, name, ref, "", "repo") ?? fail)
      : (github(owner, name, ref, rest.join("/"), "skill") ?? fail);
  }
  return fail;
}

function fromFile(owner: string, repo: string, ref: string, rest: string[]) {
  if (rest.at(-1) !== "SKILL.md") return null;
  return github(owner, repo, ref, rest.slice(0, -1).join("/"), "skill");
}

function github(
  owner: string,
  repo: string,
  ref: string,
  path: string,
  scope: "skill" | "repo",
): SkillUrl | null {
  if (!NAME.test(owner) || !NAME.test(repo) || !NAME.test(ref)) return null;
  if (path.split("/").some((part) => part === "..")) return null;
  return { kind: "github", owner, repo, ref, path, scope };
}

/** `github:owner/repo@<sha>:<path>`, with `.` for a skill at the root. */
export function githubSource(
  owner: string,
  repo: string,
  sha: string,
  path: string,
): string {
  return `github:${owner}/${repo}@${sha}:${path || "."}`;
}

export function parseGithubSource(
  source: string,
): { owner: string; repo: string; sha: string; path: string } | null {
  const match = /^github:([\w.-]+)\/([\w.-]+)@([0-9a-f]{40}):(.+)$/.exec(
    source,
  );
  if (match === null || match[4].split("/").includes("..")) return null;
  return {
    owner: match[1],
    repo: match[2],
    sha: match[3],
    path: match[4] === "." ? "" : match[4],
  };
}

/**
 * The digest an update check compares: every file's path and sha256, sorted,
 * SKILL.md included. A rename, an added script and an edit all change it.
 */
export async function bundleDigest(
  body: string,
  files: BundleFile[],
): Promise<string> {
  const lines = await Promise.all(
    [{ path: "SKILL.md", content: body }, ...files].map(
      async (file) => `${file.path}\0${await sha256Hex(file.content)}`,
    ),
  );
  return sha256Hex(lines.sort().join("\n"));
}

export type GithubSkill = {
  source: string;
  hash: string;
  body: string;
  files: BundleFile[];
  /** Where a person can read it on GitHub. */
  url: string;
};

export type GithubListing = {
  owner: string;
  repo: string;
  sha: string;
  groups: {
    /** The plugin from `.claude-plugin/marketplace.json`, or null. */
    plugin: string | null;
    skills: { name: string; description: string; path: string; url: string }[];
  }[];
};

/** One skill: the SKILL.md in `path` and every other file beside it. */
export async function downloadGithubSkill(
  env: GithubEnv,
  owner: string,
  repo: string,
  ref: string,
  path: string,
): Promise<GithubSkill | RegistryFailure> {
  const read = await downloadGithubSkills(env, owner, repo, ref, [path]);
  return "errors" in read ? read : (read.get(path) ?? { errors: [] });
}

/**
 * Several skills from one repository, from one tarball. An update check
 * groups its skills by repository and calls this once per repository.
 */
export async function downloadGithubSkills(
  env: GithubEnv,
  owner: string,
  repo: string,
  ref: string,
  paths: string[],
): Promise<Map<string, GithubSkill | RegistryFailure> | RegistryFailure> {
  const prefixes = paths.map((path) => (path === "" ? "" : `${path}/`));
  const archive = await readArchive(env, owner, repo, ref, (entry) =>
    prefixes.some((prefix) => entry.startsWith(prefix)),
  );
  if ("errors" in archive) return archive;
  const out = new Map<string, GithubSkill | RegistryFailure>();
  for (const path of paths) {
    out.set(path, await skillAt(archive, owner, repo, path));
  }
  return out;
}

async function skillAt(
  archive: Archive,
  owner: string,
  repo: string,
  path: string,
): Promise<GithubSkill | RegistryFailure> {
  const prefix = path === "" ? "" : `${path}/`;
  const body = archive.files.get(`${prefix}SKILL.md`);
  if (body === undefined) {
    return {
      errors: [`There is no SKILL.md in ${path || "the repository root"}.`],
    };
  }
  if (typeof body !== "string") {
    return { errors: [`${prefix}SKILL.md is not UTF-8 text.`] };
  }
  const files: BundleFile[] = [];
  let total = body.length;
  for (const [file, content] of archive.files) {
    if (!file.startsWith(prefix) || file === `${prefix}SKILL.md`) continue;
    files.push({ path: file.slice(prefix.length), content });
    total += content.length;
  }
  if (files.length > MAX_FILES) {
    return { errors: [`That skill carries more than ${MAX_FILES} files.`] };
  }
  if (total > MAX_TOTAL_BYTES) {
    return { errors: ["That skill is larger than 10MB."] };
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    source: githubSource(owner, repo, archive.sha, path),
    hash: await bundleDigest(body, files),
    body,
    files,
    url: `https://github.com/${owner}/${repo}/tree/${archive.sha}/${path}`,
  };
}

/**
 * Every skill in a repository, once each. A repository that publishes for
 * two hosts carries copies, and symlinks in the tarball are entries, not
 * folders, so they are skipped rather than followed. Copies with the same
 * name and body collapse to the path a marketplace plugin points at, or else
 * the shortest one.
 */
export async function listGithubSkills(
  env: GithubEnv,
  owner: string,
  repo: string,
  ref: string,
): Promise<GithubListing | RegistryFailure> {
  const marketplace = ".claude-plugin/marketplace.json";
  const archive = await readArchive(
    env,
    owner,
    repo,
    ref,
    (entry) => entry === marketplace || /(^|\/)SKILL\.md$/.test(entry),
  );
  if ("errors" in archive) return archive;

  // A plugin's skills live under `<source>/skills`, which may be a symlink.
  const manifest = archive.files.get(marketplace);
  const plugins = pluginRoots(
    typeof manifest === "string" ? manifest : undefined,
  ).map(({ name, root }) => ({
    name,
    root: resolveLink(`${root}/skills`, archive.links),
  }));
  const pluginOf = (folder: string) =>
    plugins.find(
      (plugin) =>
        folder === plugin.root || folder.startsWith(`${plugin.root}/`),
    )?.name ?? null;

  const chosen = new Map<
    string,
    { name: string; description: string; path: string; plugin: string | null }
  >();
  for (const [file, body] of archive.files) {
    if (!file.endsWith("SKILL.md") || typeof body !== "string") continue;
    const frontmatter = readFrontmatter(body);
    const name = frontmatter.name;
    if (!name) continue;
    const path = file.slice(0, -"SKILL.md".length).replace(/\/$/, "");
    const key = `${name}\0${await sha256Hex(body)}`;
    const candidate = {
      name,
      description: frontmatter.description ?? "",
      path,
      plugin: pluginOf(path),
    };
    const held = chosen.get(key);
    if (
      held === undefined ||
      (held.plugin === null && candidate.plugin !== null) ||
      ((held.plugin === null) === (candidate.plugin === null) &&
        candidate.path.length < held.path.length)
    ) {
      chosen.set(key, candidate);
    }
  }

  const groups = new Map<string | null, GithubListing["groups"][number]>();
  for (const skill of [...chosen.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const group = groups.get(skill.plugin) ?? {
      plugin: skill.plugin,
      skills: [],
    };
    group.skills.push({
      name: skill.name,
      description: skill.description,
      path: skill.path,
      url: `https://github.com/${owner}/${repo}/tree/${archive.sha}/${skill.path}`,
    });
    groups.set(skill.plugin, group);
  }
  return {
    owner,
    repo,
    sha: archive.sha,
    // Plugins in marketplace order, then whatever no plugin claims.
    groups: [
      ...plugins.flatMap((plugin) => groups.get(plugin.name) ?? []),
      ...[groups.get(null)].filter((group) => group !== undefined),
    ],
  };
}

function pluginRoots(
  json: string | undefined,
): { name: string; root: string }[] {
  if (json === undefined) return [];
  try {
    const parsed = JSON.parse(json) as { plugins?: unknown };
    if (!Array.isArray(parsed.plugins)) return [];
    return parsed.plugins.flatMap((entry) => {
      const plugin = entry as { name?: unknown; source?: unknown };
      return typeof plugin.name === "string" &&
        typeof plugin.source === "string"
        ? [{ name: plugin.name, root: normalise(plugin.source) }]
        : [];
    });
  } catch {
    return [];
  }
}

function resolveLink(path: string, links: Map<string, string>): string {
  const target = links.get(path);
  if (target === undefined) return path;
  const parent = path.split("/").slice(0, -1).join("/");
  return normalise(`${parent}/${target}`);
}

/** Collapses `.` and `..` segments; a path that climbs out stays as written. */
function normalise(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

type Archive = {
  sha: string;
  /** Kept files, by path from the repository root: text, or bytes if not UTF-8. */
  files: Map<string, string | Uint8Array>;
  /** Symlinks anywhere in the archive: path to target. */
  links: Map<string, string>;
};

async function readArchive(
  env: GithubEnv,
  owner: string,
  repo: string,
  ref: string,
  keep: (path: string) => boolean,
): Promise<Archive | RegistryFailure> {
  const override = (env as { GITHUB_CODELOAD_URL?: string })
    .GITHUB_CODELOAD_URL;
  const base = override?.trim() || "https://codeload.github.com";
  let response: Response;
  try {
    response = await fetch(`${base}/${owner}/${repo}/tar.gz/${ref}`, {
      headers: { "user-agent": "valise" },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    return { errors: [`Could not reach GitHub: ${message(error)}`] };
  }
  if (response.status === 404) {
    return {
      errors: [
        `GitHub has no public ${owner}/${repo} at ${ref}. Private repositories are not supported.`,
      ],
    };
  }
  if (!response.ok || response.body === null) {
    return { errors: [`GitHub answered ${response.status}.`] };
  }
  try {
    return await untar(
      response.body.pipeThrough(new DecompressionStream("gzip")),
      keep,
    );
  } catch (error) {
    return { errors: [`Could not read the archive: ${message(error)}`] };
  }
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/**
 * A ustar reader for what `git archive` writes: regular files, folders,
 * symlinks, pax headers. Streams, and holds only the files `keep` names.
 */
export async function untar(
  stream: ReadableStream<Uint8Array>,
  keep: (path: string) => boolean,
): Promise<Archive> {
  const reader = stream.getReader();
  let buffer = new Uint8Array(0);
  let done = false;
  let read = 0;

  async function fill(size: number): Promise<boolean> {
    while (buffer.length < size && !done) {
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
        break;
      }
      read += chunk.value.length;
      if (read > MAX_ARCHIVE_BYTES) {
        await reader.cancel();
        throw new Error("the repository is larger than 64MB unpacked");
      }
      const next = new Uint8Array(buffer.length + chunk.value.length);
      next.set(buffer);
      next.set(chunk.value, buffer.length);
      buffer = next;
    }
    return buffer.length >= size;
  }
  function take(size: number): Uint8Array {
    const out = buffer.slice(0, size);
    buffer = buffer.slice(size);
    return out;
  }

  const archive: Archive = {
    sha: "",
    files: new Map(),
    links: new Map(),
  };
  let longName: string | null = null;
  let top: string | null = null;

  while (await fill(512)) {
    const header = take(512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const padded = Math.ceil(size / 512) * 512;
    if (!(await fill(padded))) throw new Error("the archive ends early");
    const data = take(padded).subarray(0, size);

    if (type === "g" || type === "x") {
      const pax = paxRecords(data);
      if (type === "g" && /^[0-9a-f]{40}$/.test(pax.comment ?? "")) {
        archive.sha = pax.comment;
      }
      if (type === "x" && pax.path) longName = pax.path;
      continue;
    }
    if (type === "L") {
      longName = new TextDecoder().decode(data).replace(/\0+$/, "");
      continue;
    }

    const prefix = field(header, 345, 155);
    const name =
      longName ??
      (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    longName = null;
    // Every path sits under one `<repo>-<ref>/` folder; strip it.
    const slash = name.indexOf("/");
    top ??= slash < 0 ? name : name.slice(0, slash);
    const path = name.slice(top.length + 1).replace(/\/$/, "");
    if (path === "") continue;

    if (type === "2") {
      archive.links.set(path, field(header, 157, 100));
    } else if ((type === "0" || type === "\0") && keep(path)) {
      try {
        archive.files.set(path, decoder.decode(data));
      } catch {
        archive.files.set(path, data);
      }
    }
  }
  await reader.cancel().catch(() => {});
  if (archive.sha === "") throw new Error("it names no commit");
  return archive;
}

function field(header: Uint8Array, start: number, length: number): string {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
}

/** `<len> <key>=<value>\n` records. */
function paxRecords(data: Uint8Array): Record<string, string> {
  const records: Record<string, string> = {};
  for (const line of new TextDecoder().decode(data).split("\n")) {
    const match = /^\d+ ([^=]+)=(.*)$/.exec(line);
    if (match) records[match[1]] = match[2];
  }
  return records;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Where a listed skill stands against the store. `added`: imported from this
 * same folder of this repository, at any commit. `taken`: the name belongs
 * to a skill from somewhere else, or written here, and a batch import must
 * not publish over it. Deleted skills do not count, so re-importing one
 * restores it.
 */
export type GithubImportState = "new" | "added" | "taken";

export async function classifyGithubSkills(
  db: D1Database,
  userId: string,
  owner: string,
  repo: string,
  skills: { name: string; path: string }[],
): Promise<Map<string, GithubImportState>> {
  const sources = await inChunks(
    skills.map((skill) => skill.name),
    async (chunk) => {
      const { results } = await db
        .prepare(
          `SELECT name, source FROM skills
            WHERE user_id = ? AND deleted_at IS NULL
              AND name IN (${chunk.map(() => "?").join(", ")})`,
        )
        .bind(userId, ...chunk)
        .all<{ name: string; source: string | null }>();
      return new Map(results.map((row) => [row.name, row.source]));
    },
  );
  const states = new Map<string, GithubImportState>();
  for (const skill of skills) {
    if (!sources.has(skill.name)) {
      states.set(skill.path, "new");
      continue;
    }
    const pinned = parseGithubSource(sources.get(skill.name) ?? "");
    const same =
      pinned !== null &&
      pinned.owner.toLowerCase() === owner.toLowerCase() &&
      pinned.repo.toLowerCase() === repo.toLowerCase() &&
      pinned.path === skill.path;
    states.set(skill.path, same ? "added" : "taken");
  }
  return states;
}

export type GithubImportReport = {
  imported: { name: string; version: number }[];
  /** The name is another skill's; nothing was written for it. */
  taken: { name: string; path: string }[];
  failed: { path: string; errors: string[] }[];
};

/**
 * Several skills from one commit, one tarball, each published the way a
 * single import is. A skill whose name is taken by another source is
 * skipped rather than published over, and one that fails to read or
 * validate is reported without stopping the rest.
 */
export async function importGithubSkills(
  env: GithubEnv & { DB: D1Database; BUNDLES: R2Bucket },
  pinned: { owner: string; repo: string; sha: string; paths: string[] },
  labels: { project?: string; tags?: string[] },
  provenance: Provenance,
): Promise<GithubImportReport | RegistryFailure> {
  const read = await downloadGithubSkills(
    env,
    pinned.owner,
    pinned.repo,
    pinned.sha,
    pinned.paths,
  );
  if ("errors" in read) return read;
  const report: GithubImportReport = { imported: [], taken: [], failed: [] };
  const named = [...read].flatMap(([path, got]) => {
    if ("errors" in got) {
      report.failed.push({ path, errors: got.errors });
      return [];
    }
    // A SKILL.md without a name still goes to publish, which says why.
    return [{ name: readFrontmatter(got.body).name ?? "", path, got }];
  });
  const states = await classifyGithubSkills(
    env.DB,
    provenance.userId,
    pinned.owner,
    pinned.repo,
    named.filter((skill) => skill.name !== ""),
  );
  for (const { name, path, got } of named) {
    if (states.get(path) === "taken") {
      report.taken.push({ name, path });
      continue;
    }
    const published = await publishSkill(
      env,
      { body: got.body, files: got.files, ...labels },
      provenance,
      { source: got.source, sourceHash: got.hash },
    );
    if ("errors" in published) {
      report.failed.push({ path, errors: published.errors });
    } else {
      report.imported.push({
        name: published.name,
        version: published.version,
      });
    }
  }
  return report;
}
