#!/usr/bin/env node
/**
 * context-budget — Cline PostToolUse hook (file-hook entry point).
 *
 * Watches for oversized tool results and nudges the model toward the sandbox
 * for the next bulk read. Fails open.
 */
import { runHookEvent } from "./run.mjs";

await runHookEvent("posttooluse");
