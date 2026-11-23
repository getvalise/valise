#!/usr/bin/env node
/**
 * Export a Valise library to a directory, or import one back. ADR-0015.
 *
 *   node scripts/library.mjs export <origin> <dir>
 *   node scripts/library.mjs import <origin> <dir>
 *
 * The token is a console-issued bearer token, from $VALISE_LIBRARY_TOKEN,
 * $VALISE_TOKEN, or ~/.valise/token. Export needs assets:read and
 * sources:read; import needs assets:write, assets:read and sources:write.
 *
 * <dir>/manifest.json holds every stable id, the metadata, every source
 * revision, its links and provenance; <dir>/files/<asset id>/<file name>
 * holds each original, checked against the manifest's SHA-256 on the way
 * out and again by the server on the way in. Import keeps every id and is
 * safe to rerun: an id the library already holds is skipped. The search
 * projection is written by the import itself. The format is documented in
 * docs/operations/library-export.md.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const [command, origin, dir] = process.argv.slice(2);
if (!["export", "import"].includes(command) || !origin || !dir) {
  process.stderr.write(
    "usage: node scripts/library.mjs export|import <origin> <dir>\n",
  );
  process.exit(2);
}

const token = await readToken();
const auth = { authorization: `Bearer ${token}` };

if (command === "export") await exportLibrary();
else await importLibrary();

async function exportLibrary() {
  const manifest = await json(await call("GET", "/library/export"));
  for (const asset of manifest.assets) {
    const response = await call(
      "GET",
      `/library/export/files/${asset.id.slice("asset:".length)}`,
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== asset.sha256 || bytes.length !== asset.size) {
      throw new Error(
        `${asset.id}: downloaded bytes do not match the manifest`,
      );
    }
    const path = join(dir, asset.file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  process.stdout.write(
    `exported ${manifest.assets.length} assets and ${manifest.sources.length} sources to ${dir}\n`,
  );
}

async function importLibrary() {
  const manifest = JSON.parse(
    await readFile(join(dir, "manifest.json"), "utf8"),
  );
  if (manifest.format !== "valise-library" || manifest.version !== 1) {
    throw new Error("manifest.json is not a valise-library version 1 export");
  }
  const outcomes = { imported: 0, exists: 0 };
  for (const asset of manifest.assets) {
    const bytes = await readFile(join(dir, asset.file));
    const response = await call(
      "PUT",
      `/library/import/assets/${asset.id.slice("asset:".length)}`,
      bytes,
      {
        "x-valise-asset": Buffer.from(JSON.stringify(asset)).toString(
          "base64url",
        ),
      },
    );
    outcomes[(await json(response)).outcome]++;
  }
  // Each source restores in its own D1 batch. Bound request work rather than
  // trying to fit an entire bookmark archive into one Worker's subrequests.
  const sources = { imported: 0, existing: 0 };
  for (let at = 0; at < manifest.sources.length; at += 10) {
    const batch = await json(
      await call(
        "POST",
        "/library/import/sources",
        JSON.stringify({ sources: manifest.sources.slice(at, at + 10) }),
        { "content-type": "application/json" },
      ),
    );
    sources.imported += batch.imported;
    sources.existing += batch.existing;
  }
  process.stdout.write(
    `assets: ${outcomes.imported} imported, ${outcomes.exists} already present; sources: ${sources.imported} imported, ${sources.existing} already present\n`,
  );
}

async function call(method, path, body, headers = {}) {
  const response = await fetch(new URL(path, origin), {
    method,
    headers: { ...auth, ...headers },
    body,
  });
  if (!response.ok) {
    throw new Error(
      `${method} ${path}: ${response.status} ${await response.text()}`,
    );
  }
  return response;
}

async function json(response) {
  return response.json();
}

async function readToken() {
  const fromEnv =
    process.env.VALISE_LIBRARY_TOKEN?.trim() ||
    process.env.VALISE_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    return (await readFile(join(homedir(), ".valise", "token"), "utf8")).trim();
  } catch {
    process.stderr.write(
      "Set VALISE_LIBRARY_TOKEN to a bearer token from the console's Connections page.\n",
    );
    process.exit(2);
  }
}
