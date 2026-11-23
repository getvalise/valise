#!/usr/bin/env node
/**
 * Insert one skill, one memory, and one to-do sharing a term, so cross-concept
 * ranking is observable. Idempotent: rerunning overwrites the same three rows.
 */
import { callDev, printJson } from "./dev-lever.mjs";

printJson(await callDev("/__dev/seed"));
