import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// A test that builds its own copy passes a directory, so parallel workers
// never write into one another's extension.
const destination = process.argv[2]
  ? pathToFileURL(`${resolve(process.argv[2])}/`)
  : new URL("./dist/", import.meta.url);
await mkdir(destination, { recursive: true });
for (const file of [
  "manifest.json",
  "capture.mjs",
  "client.mjs",
  "combobox.mjs",
  "oauth.mjs",
  "settings.mjs",
  "popup.html",
  "popup.mjs",
  "settings.html",
  "settings-page.mjs",
  "theme.js",
]) {
  await copyFile(new URL(file, import.meta.url), new URL(file, destination));
}
// The extension ships the console's exact generated sheet, not a second theme.
await copyFile(
  new URL("../../public/valise.css", import.meta.url),
  new URL("valise.css", destination),
);
// Defuddle and Readability run in the page when the popup opens. One
// self-contained script, injected with chrome.scripting, defines the
// extractor and the on-page preview; a second injection calls it. Nothing is
// loaded from the network.
await build({
  stdin: {
    contents:
      'import { extractArticle } from "./extract.mjs"; import { previewArticle } from "./preview.mjs"; globalThis.valiseExtractArticle = extractArticle; globalThis.valisePreviewArticle = previewArticle;',
    resolveDir: new URL(".", import.meta.url).pathname,
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  minify: true,
  legalComments: "eof",
  outfile: new URL("extract.js", destination).pathname,
  logLevel: "warning",
});
console.log("Load clients/chrome-extension/dist as an unpacked extension.");
