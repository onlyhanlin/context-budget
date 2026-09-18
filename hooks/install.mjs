/**
 * Install / repair / remove the Cline integration.
 *
 * Design rules, learned the hard way by every tool that got this wrong:
 *   1. Only ever write files we own. Every generated file carries a marker, and
 *      removal refuses to delete anything that lacks it.
 *   2. Never overwrite silently. Anything that already exists is compared first
 *      and reported as create / update / unchanged / conflict.
 *   3. Never edit a user's settings file in place. MCP registration goes through
 *      mcp-config.mjs, which merges one key and takes a backup.
 *   4. Fail open at runtime. A launcher that cannot find its entry point prints
 *      `{}` (meaning "do nothing") rather than blocking the agent.
 *
 * FILE NAMING is not a style choice — it is the discovery contract. Taken from
 * apps/vscode/src/core/hooks/hook-factory.ts on 2026-09:
 *
 *     findHookInHooksDir() -> win32 ? findWindowsHook() : findUnixHook()
 *     findWindowsHook()  : looks ONLY for "<HookName>.ps1"
 *     findUnixHook()     : looks ONLY for the extensionless "<HookName>",
 *                          and requires the executable bit
 *
 * So the extensionless file is *intentionally ignored* on Windows, and a ".ps1"
 * is *intentionally ignored* on Unix. Writing the wrong one produces a hook that
 * never runs and never says why. The CLI/SDK uses a different rule —
 * "<HookName>.sh" inside .cline/hooks/ — and also requires the executable bit.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARKER = "context-budget:generated";
export const HOOK_EVENTS = ["pretooluse", "posttooluse", "precompact", "taskresume"];

const here = path.dirname(fileURLToPath(import.meta.url));
export const packageRoot = path.resolve(here, "..");
export const ENTRY = {
  pretooluse: path.join(here, "pretooluse.mjs"),
  posttooluse: path.join(here, "posttooluse.mjs"),
  precompact: path.join(here, "precompact.mjs"),
  taskresume: path.join(here, "taskresume.mjs"),
};
/** Canonical Cline hook names, as they appear in the extension's `Hooks` type. */
const HOOK_NAME = {
  pretooluse: "PreToolUse",
  posttooluse: "PostToolUse",
  precompact: "PreCompact",
  taskresume: "TaskResume",
};

/** The file Cline's extension will actually look for. */
export function extensionHookFile(hookName, platform = process.platform) {
  return platform === "win32" ? `${HOOK_NAME[hookName] ?? hookName}.ps1` : (HOOK_NAME[hookName] ?? hookName);
}

/** The file the CLI/SDK will actually look for. */
export function cliHookFile(hookName) {
  return `${HOOK_NAME[hookName] ?? hookName}.sh`;
}

export function extensionHooksDir({ root = process.cwd(), global = false } = {}) {
  return global
    ? path.join(os.homedir(), "Documents", "Cline", "Hooks")
    : path.join(path.resolve(root), ".clinerules", "hooks");
}

export function rulesPath({ root = process.cwd(), global = false } = {}) {
  return global
    ? path.join(os.homedir(), "Documents", "Cline", "Rules", "context-budget.md")
    : path.join(path.resolve(root), ".clinerules", "context-budget.md");
}

/* ------------------------------------------------------------------ launchers */

/**
 * Every generated launcher carries a machine-readable entry marker. Repair
 * reads that line to decide whether the recorded path still resolves — far more
 * reliable than trying to parse a path out of shell syntax.
 */
export function entryMarker(entryAbs) {
  return `context-budget:entry=${entryAbs}`;
}

export function readRecordedEntry(content) {
  const match = String(content).match(/context-budget:entry=(.+?)\s*$/m);
  return match ? match[1] : null;
}

/** Unix extension hooks and CLI hooks: bash, extensionless or ".sh". */
function bashLauncher(entryAbs) {
  return [
    "#!/usr/bin/env bash",
    `# ${MARKER} — do not edit. Re-run 'context-budget setup' to refresh.`,
    `# ${entryMarker(entryAbs)}`,
    'ENTRY="${CONTEXT_BUDGET_HOOK_ENTRY:-' + entryAbs + '}"',
    'if [ -f "$ENTRY" ]; then exec node "$ENTRY"; fi',
    "echo '[context-budget] no hook entry found; failing open' >&2",
    "printf '{}'",
    "",
  ].join("\n");
}

/**
 * Windows extension hook. PowerShell 5.1 compatible on purpose — that is what
 * Cline invokes, not necessarily pwsh.
 */
function ps1Launcher(entryAbs) {
  return [
    `# ${MARKER} — do not edit. Re-run 'context-budget setup' to refresh.`,
    `# ${entryMarker(entryAbs)}`,
    "$ErrorActionPreference = 'Stop'",
    "",
    "$entry = $env:CONTEXT_BUDGET_HOOK_ENTRY",
    `if ([string]::IsNullOrWhiteSpace($entry)) { $entry = '${entryAbs.replace(/'/g, "''")}' }`,
    "",
    "if (-not (Test-Path -LiteralPath $entry)) {",
    "  [Console]::Error.WriteLine('[context-budget] no hook entry found; failing open')",
    "  [Console]::Out.Write('{}')",
    "  exit 0",
    "}",
    "",
    "try {",
    "  $payload = [Console]::In.ReadToEnd()",
    "  $result = $payload | & node $entry",
    "  [Console]::Out.Write(($result -join [Environment]::NewLine))",
    "} catch {",
    "  [Console]::Error.WriteLine('[context-budget] hook failed; failing open: ' + $_.Exception.Message)",
    "  [Console]::Out.Write('{}')",
    "}",
    "",
  ].join("\r\n");
}

export function launcherFor(hookName, entryAbs, platform = process.platform) {
  return platform === "win32" ? ps1Launcher(entryAbs) : bashLauncher(entryAbs);
}

function rulesContent() {
  const body = fs.readFileSync(path.join(packageRoot, "rules", "context-budget.md"), "utf8");
  return `<!-- ${MARKER} — edit rules/context-budget.md in the package instead. -->\n\n${body}`;
}

/* ---------------------------------------------------------------------- plan */

function entryFor(file) {
  if (fs.existsSync(file)) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * @param {boolean} exclusive a hook slot holds exactly one file, so an
 *   unrecognised file already sitting there can never coexist with ours. We
 *   report it rather than clobbering somebody's own hook.
 */
function push(plan, file, content, note, { exclusive = false, executable = false } = {}) {
  const existing = entryFor(file);
  if (existing == null) {
    plan.push({ file, content, action: "create", note, executable });
    return plan;
  }
  if (existing === content) {
    plan.push({ file, content, action: "unchanged", note, executable });
    return plan;
  }
  if (exclusive && !existing.includes(MARKER)) {
    plan.push({ file, content, action: "conflict", note, executable });
    return plan;
  }
  plan.push({ file, content, action: "update", note, executable });
  return plan;
}

/**
 * Everything a global install needs: hooks and rules shared by every workspace.
 * The MCP server is registered separately and is already global — it lives in
 * the editor's own settings file, not in the project.
 */
export function globalPlan({ platform = process.platform } = {}) {
  const plan = [];
  push(plan, rulesPath({ global: true }), rulesContent(), "global routing rules");
  for (const event of HOOK_EVENTS) {
    push(
      plan,
      path.join(extensionHooksDir({ global: true }), extensionHookFile(event, platform)),
      launcherFor(event, ENTRY[event], platform),
      `global ${HOOK_NAME[event]} hook`,
      { exclusive: true, executable: platform !== "win32" }
    );
  }
  return plan;
}

/** Workspace-scoped install: the extension reads .clinerules/hooks, the CLI reads .cline/hooks. */
export function workspacePlan(root, { platform = process.platform } = {}) {
  const workspace = path.resolve(root);
  const plan = [];
  push(plan, rulesPath({ root: workspace }), rulesContent(), "routing rules");
  for (const event of HOOK_EVENTS) {
    push(
      plan,
      path.join(extensionHooksDir({ root: workspace }), extensionHookFile(event, platform)),
      launcherFor(event, ENTRY[event], platform),
      `${HOOK_NAME[event]} hook for the extension`,
      { exclusive: true, executable: platform !== "win32" }
    );
    push(
      plan,
      path.join(workspace, ".cline", "hooks", cliHookFile(event)),
      bashLauncher(ENTRY[event]),
      `${HOOK_NAME[event]} hook for the CLI`,
      { executable: platform !== "win32" }
    );
  }
  return plan;
}

/** Hook-only plan, used when only the extension matters. */
export function planFor({ root = process.cwd(), global = false, platform = process.platform } = {}) {
  return global ? globalPlan({ platform }) : workspacePlan(root, { platform });
}

/* --------------------------------------------------------------------- apply */

/**
 * Write the plan one file at a time.
 *
 * A single unwritable path must not abort the whole install, and it must never
 * destroy anything. Conflicting hook slots are skipped, not overwritten.
 *
 * @returns {{written: string[], blocked: string[], conflicts: string[]}}
 */
export function applyPlan(plan, { platform = process.platform } = {}) {
  const written = [];
  const blocked = [];
  const conflicts = [];
  for (const item of plan) {
    if (item.action === "unchanged") continue;
    if (item.action === "conflict") {
      conflicts.push(`${item.file} already exists and was not written by context-budget`);
      continue;
    }
    const dir = path.dirname(item.file);
    try {
      if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) {
        blocked.push(`${dir} exists and is not a directory — move it aside and re-run`);
        continue;
      }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(item.file, item.content, "utf8");
      // Unix discovery requires the executable bit; without it the hook is
      // silently skipped by Cline.
      if (item.executable && platform !== "win32") fs.chmodSync(item.file, 0o755);
      written.push(item.file);
    } catch (error) {
      blocked.push(`${item.file}: ${error.message}`);
    }
  }
  return { written, blocked, conflicts };
}

function isOurs(file) {
  const content = entryFor(file);
  return content != null && content.includes(MARKER);
}

/**
 * Delete only files that carry our marker. A user's own `PreToolUse` hook in
 * the same directory is left exactly where it is.
 */
export function removePlan(plan) {
  const removed = [];
  const skipped = [];
  for (const item of plan) {
    if (!fs.existsSync(item.file)) continue;
    if (!isOurs(item.file)) {
      skipped.push(item.file);
      continue;
    }
    try {
      fs.rmSync(item.file);
      removed.push(item.file);
    } catch (error) {
      skipped.push(`${item.file} (${error.message})`);
    }
  }
  return { removed, skipped };
}

/**
 * Detect generated hook launchers that point at an entry file which no longer
 * exists (package moved, pnpm store rotated, plugin cache renamed) and rewrite
 * them. Returns the files that were repaired.
 */
export function repair({ root = process.cwd(), global = false, platform = process.platform } = {}) {
  const plan = planFor({ root, global, platform });
  const repaired = [];
  for (const item of plan) {
    if (!fs.existsSync(item.file)) continue;
    const existing = entryFor(item.file);
    if (existing == null || !existing.includes(MARKER)) continue;
    if (existing === item.content) continue;
    // Rewrite ONLY when the recorded entry no longer resolves. Never churn a
    // working file just because its bytes differ cosmetically.
    const recorded = readRecordedEntry(existing);
    if (recorded && fs.existsSync(recorded)) continue;
    try {
      fs.writeFileSync(item.file, item.content, "utf8");
      if (item.executable && platform !== "win32") fs.chmodSync(item.file, 0o755);
      repaired.push(item.file);
    } catch {
      /* leave it; doctor will report it again */
    }
  }
  return repaired;
}
