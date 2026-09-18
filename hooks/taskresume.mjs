#!/usr/bin/env node
/**
 * context-budget — Cline TaskResume hook.
 *
 * Hands the pre-compaction working-state card back to the model, so a resumed
 * task does not start by asking the user what they were doing.
 */
import { runHookEvent } from "./run.mjs";

await runHookEvent("taskresume");
