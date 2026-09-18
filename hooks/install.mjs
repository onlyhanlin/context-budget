/**
 * Install / repair / remove the Cline integration.
 *
 * Design rules, learned the hard way by every tool that got this wrong:
 *   1. Only ever write files we own. Every generated file carries a marker, and
 *      removal refuses to delete anything that lacks it.
 *   2. Never overwrite silently. Anything that already exists is compared first
 *      and reported as create / update / unchanged.
 *   3. Never edit a user's settings file in place. MCP registration goes through
 *      mcp-config.mjs, which merges one key and takes a backup.
 *   4. Fail open at runtime. A launcher that cannot find its entry point prints
 *      `{}` (meaning "do nothing") rather than blocking the agent.
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
const EVENT_FILE = {
  pretooluse: "PreToolUse",
  posttooluse: "PostToolUse",
  precompact: "PreCompact",
  taskresume: "TaskResume",
};

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

function bashLauncher(entryAbs) {
  return [
    "#!/usr/bin/env bash",
    `# ${MARKER} — do not edit. Re-run 'context-budget setup' to refresh.`,
    `# ${entryMarker(entryAbs)}`,
    `ENTRY="\${CONTEXT_BUDGET_HOOK_ENTRY:-${entryAbs}}"`,
    'if [ -f "$ENTRY" ]; then exec node "$ENTRY"; fi',
    "echo '{}'",
    "",
  ].join("\n");
}

function cmdLauncher(entryAbs) {
  return [
    "@echo off",
    `rem ${MARKER} — do not edit.`,
    `rem ${entryMarker(entryAbs)}`,
    'set "ENTRY=%CONTEXT_BUDGET_HOOK_ENTRY%"',
    `if "%ENTRY%"=="" set "ENTRY=${entryAbs}"`,
    'if exist "%ENTRY%" (node "%ENTRY%") else (echo {})',
    "",
  ].join("\r\n");
}

/**
 * Node launcher. Resolution order matters: an explicit override first, then the
 * path recorded at install time — which survives an npm upgrade of a globally
 * installed package because the directory name is stable.
 */
function mjsLauncher(entryAbs) {
  return [
    "#!/usr/bin/env node",
    `// ${MARKER} — do not edit.`,
    `// ${entryMarker(entryAbs)}`,
    'import fs from "node:fs";',
    'import { pathToFileURL } from "node:url";',
    "",
    "const candidates = [process.env.CONTEXT_BUDGET_HOOK_ENTRY, " + JSON.stringify(entryAbs) + "].filter(Boolean);",
    "let loaded = false;",
    "for (const candidate of candidates) {",
    "  try {",
    "    if (!fs.existsSync(candidate)) continue;",
    "    await import(pathToFileURL(candidate).href);",
    "    loaded = true;",
    "    break;",
    "  } catch (error) {",
    "    process.stderr.write(\`[context-budget] hook entry failed: \${error?.message ?? error}\\n\`);",
    "  }",
    "}",
    "if (!loaded) {",
    '  process.stderr.write("[context-budget] no hook entry found; failing open\\n");',
    '  process.stdout.write("{}");',
    "}",
    "",
  ].join("\n");
}

function shLauncher(entryAbs) {
  return bashLauncher(entryAbs);
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

function push(plan, file, content, note) {
  const existing = entryFor(file);
  const action = existing == null ? "create" : existing === content ? "unchanged" : "update";
  plan.push({ file, content, action, note });
  return plan;
}

/** Files for a workspace-scoped install (the VS Code extension path). */
export function workspacePlan(root) {
  const workspace = path.resolve(root);
  const plan = [];
  push(plan, path.join(workspace, ".clinerules", "context-budget.md"), rulesContent(), "routing rules");
  for (const event of HOOK_EVENTS) {
    const name = EVENT_FILE[event];
    push(plan, path.join(workspace, ".clinerules", "hooks", name), bashLauncher(ENTRY[event]), "extension hook");
    push(plan, path.join(workspace, ".clinerules", "hooks", `${name}.cmd`), cmdLauncher(ENTRY[event]), "extension hook (Windows)");
    push(plan, path.join(workspace, ".cline", "hooks", `${name}.sh`), shLauncher(ENTRY[event]), "CLI hook");
    push(plan, path.join(workspace, ".cline", "hooks", `${name}.mjs`), mjsLauncher(ENTRY[event]), "CLI hook (node)");
  }
  return plan;
}

/** Files for a global install (`~/Documents/Cline`), shared by all workspaces. */
export function globalPlan() {
  const rulesDir = path.join(os.homedir(), "Documents", "Cline", "Rules");
  const hooksDir = path.join(os.homedir(), "Documents", "Cline", "Hooks");
  const plan = [];
  push(plan, path.join(rulesDir, "context-budget.md"), rulesContent(), "global routing rules");
  for (const event of HOOK_EVENTS) {
    push(plan, path.join(hooksDir, `context-budget-${event}`), bashLauncher(ENTRY[event]), "global hook");
    push(plan, path.join(hooksDir, `context-budget-${event}.cmd`), cmdLauncher(ENTRY[event]), "global hook (Windows)");
    push(plan, path.join(hooksDir, `context-budget-${event}.mjs`), mjsLauncher(ENTRY[event]), "global hook (node)");
  }
  return plan;
}

/* --------------------------------------------------------------------- apply */

/**
 * Write the plan one file at a time.
 *
 * A single unwritable path must not abort the whole install, and it must never
 * destroy anything: if `.clinerules/hooks` already exists as a regular FILE we
 * report the collision and carry on with the rest.
 *
 * @returns {{written: string[], blocked: string[]}}
 */
export function applyPlan(plan) {
  const written = [];
  const blocked = [];
  for (const item of plan) {
    if (item.action === "unchanged") continue;
    const dir = path.dirname(item.file);
    try {
      if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) {
        blocked.push(`${dir} exists and is not a directory — move it aside and re-run`);
        continue;
      }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(item.file, item.content, "utf8");
      written.push(item.file);
    } catch (error) {
      blocked.push(`${item.file}: ${error.message}`);
    }
  }
  return { written, blocked };
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
export function repair({ root = process.cwd(), global = false } = {}) {
  const plan = global ? globalPlan() : workspacePlan(root);
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
    fs.writeFileSync(item.file, item.content, "utf8");
    repaired.push(item.file);
  }
  return repaired;
}