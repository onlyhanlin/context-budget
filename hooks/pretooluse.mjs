#!/usr/bin/env node
/**
 * context-budget — Cline PreToolUse hook (file-hook entry point).
 *
 * Reads the tool-call payload from stdin and prints a routing decision.
 * Fails open: any error results in {} which means "do nothing".
 */
import { runHookEvent } from "./run.mjs";

await runHookEvent("pretooluse");
