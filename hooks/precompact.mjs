#!/usr/bin/env node
/**
 * context-budget — Cline PreCompact hook.
 *
 * Runs immediately before Cline compacts the conversation. Cline deletes the
 * context files it hands us as soon as this returns, so we read, snapshot and
 * index them right here. We deliberately emit no context: anything injected
 * now would be compacted away a moment later.
 */
import { runHookEvent } from "./run.mjs";

await runHookEvent("precompact");
