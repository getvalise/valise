import { assetRef } from "~/concepts/assets";
import {
  ImportRefused,
  type ManifestAsset,
  type ManifestSource,
} from "~/concepts/library";
import { fileResponse } from "~/r2/objects";
import { authorizeBearerStore } from "./config";

/**
 * The library's export and import over plain HTTP, for `scripts/library.mjs`
 * holding a console-issued bearer token. ADR-0015; the manifest is
 * documented in docs/operations/library-export.md.
 *
 *   GET  /library/export                   assets:read + sources:read
 *   GET  /library/export/files/{assetId}   assets:read
 *   PUT  /library/import/assets/{assetId}  assets:write
 *   POST /library/import/sources           sources:write + assets:read
 */

export const LIBRARY_PREFIX = "/library/";

type LibraryEnv = Parameters<typeof authorizeBearerStore>[1];

const EXPORT_FILE = /^\/library\/export\/files\/(ast_[0-9a-f-]{36})$/;
const IMPORT_ASSET = /^\/library\/import\/assets\/(ast_[0-9a-f-]{36})$/;

/** Null when the path is not one of these; the console takes it. */
export async function handleLibrary(
  request: Request,
  env: LibraryEnv,
  url: URL,
): Promise<Response | null> {
  if (url.pathname === "/library/export") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const who = await authorizeBearerStore(request, env, [
      "assets:read",
      "sources:read",
    ]);
    if (who instanceof Response) return who;
    return Response.json(await who.store.library.exportManifest(), {
      headers: { "cache-control": "no-store" },
    });
  }

  const file = EXPORT_FILE.exec(url.pathname);
  if (file) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const who = await authorizeBearerStore(request, env, ["assets:read"]);
    if (who instanceof Response) return who;
    const asset = await who.store.library.asset(file[1]);
    const stored = asset ? await who.store.library.readObject(asset) : null;
    if (stored === null)
      return Response.json({ error: "not_found" }, { status: 404 });
    return fileResponse(stored.metadata, stored.object);
  }

  const imported = IMPORT_ASSET.exec(url.pathname);
  if (imported) {
    if (request.method !== "PUT") return methodNotAllowed("PUT");
    const who = await authorizeBearerStore(request, env, ["assets:write"]);
    if (who instanceof Response) return who;
    let entry: ManifestAsset;
    try {
      entry = JSON.parse(
        new TextDecoder().decode(
          base64UrlBytes(request.headers.get("x-valise-asset") ?? ""),
        ),
      );
    } catch {
      return refused(
        "x-valise-asset must be the manifest entry, base64url JSON.",
      );
    }
    if (entry.id !== assetRef(imported[1])) {
      return refused("The manifest entry names a different asset.");
    }
    try {
      const outcome = await who.store.library.importAsset(
        entry,
        await request.arrayBuffer(),
      );
      return Response.json({ id: entry.id, outcome });
    } catch (error) {
      if (error instanceof ImportRefused) return refused(error.message);
      throw error;
    }
  }

  if (url.pathname === "/library/import/sources") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    const who = await authorizeBearerStore(request, env, [
      "sources:write",
      "assets:read",
    ]);
    if (who instanceof Response) return who;
    let sources: ManifestSource[];
    try {
      ({ sources } = (await request.json()) as { sources: ManifestSource[] });
      if (!Array.isArray(sources)) throw new Error("sources");
    } catch {
      return refused("The body must be { sources: [...] } from the manifest.");
    }
    try {
      return Response.json(await who.store.library.importSources(sources));
    } catch (error) {
      if (error instanceof ImportRefused) return refused(error.message);
      throw error;
    }
  }
  return null;
}

function refused(message: string): Response {
  return Response.json({ error: "refused", message }, { status: 400 });
}

function methodNotAllowed(allow: string): Response {
  return new Response(null, { status: 405, headers: { allow } });
}

function base64UrlBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}
