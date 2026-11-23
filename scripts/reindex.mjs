#!/usr/bin/env node
/**
 * Rebuild the search projection and the FTS index from the authoritative
 * tables. This is the restore path after a filtered backup and the weekly
 * drift reconciliation, per ADR-0001.
 *
 *   node scripts/reindex.mjs --all
 *   node scripts/reindex.mjs --concept skill --concept memory
 */
import { callDev, printJson } from "./dev-lever.mjs";

const args = process.argv.slice(2);
const concepts = [];
let all = false;
let vectors = false;
let drain = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--all") all = true;
  else if (args[i] === "--concept") concepts.push(args[++i]);
  else if (args[i] === "--vectors") vectors = true;
  else if (args[i] === "--drain") drain = true;
  else {
    process.stderr.write(`unknown argument: ${args[i]}\n`);
    process.exit(2);
  }
}

if (
  (all && concepts.length > 0) ||
  (!all && !concepts.length && !vectors) ||
  (drain && !vectors)
) {
  process.stderr.write(
    "pass --all, --concept <name>, or --vectors [--drain]; do not combine --all and --concept\n",
  );
  process.exit(2);
}

printJson(
  await callDev("/__dev/reindex", {
    concept: all
      ? []
      : vectors
        ? [...new Set([...concepts, "memory"])]
        : concepts,
  }),
);
if (vectors) {
  let after = "";
  for (;;) {
    const page = await callDev("/__dev/vectors", { after }, { method: "POST" });
    printJson(page);
    if (page.done) break;
    after = page.cursor;
  }
  if (drain)
    printJson(
      await callDev("/__dev/vectors", { drain: 1 }, { method: "POST" }),
    );
  else
    process.stderr.write(
      "Vectors enqueued, not delivered. The minute cron drains at most 20 per run; --vectors --drain explicitly attempts one provider batch. Pending=0 means accepted, not ANN-visible.\n",
    );
}
