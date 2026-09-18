/**
 * The installer's brain: plan first, show the plan, then apply on request.
 *
 * `context-budget setup` with no flags is a DRY RUN. Nothing is written until
 * `--yes` is passed, because the two things it can touch outside the workspace
 * (MCP settings and global rules) belong to the user, not to us.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverClineTargets, describeTargets } from "./cline-paths.mjs";
import { planMerge, planRemoval, applyMerge, SERVER_NAME } from "./mcp-config.mjs";
import { workspacePlan, globalPlan, applyPlan, removePlan, repair, readRecordedEntry, ENTRY } from "../hooks/install.mjs";

export function buildPlan({ root = process.cwd(), global = false, hooksOnly = false, mcpOnly = false } = {}) {
  const targets = discoverClineTargets();
  const files = mcpOnly ? [] : (global ? globalPlan() : workspacePlan(root));
  const merges = [];

  if (!hooksOnly) {
    for (const target of targets) {
      if (!target.mcpSettings) continue;
      merges.push({ target, plan: planMerge(target.mcpSettings) });
    }
  }

  return { root: path.resolve(root), global, hooksOnly, mcpOnly, targets, files, merges };
}

function countByAction(files) {
  return files.reduce((acc, f) => ({ ...acc, [f.action]: (acc[f.action] ?? 0) + 1 }), {});
}

export function formatPlan(plan) {
  const lines = [];
  lines.push(`context-budget setup — ${plan.global ? "global" : "workspace"} install`);
  lines.push(`workspace: ${plan.root}`);
  lines.push("");
  lines.push("Cline installs detected");
  lines.push(...describeTargets(plan.targets));
  lines.push("");

  if (!plan.mcpOnly) {
    const counts = countByAction(plan.files);
    lines.push(
      `Hook + rules files: ${counts.create ?? 0} to create, ${counts.update ?? 0} to update, ${counts.unchanged ?? 0} already current`
    );
    for (const item of plan.files) {
      const rel = plan.global ? path.relative(os.homedir(), item.file) : path.relative(plan.root, item.file);
      lines.push(`  ${item.action.padEnd(9)} ${rel || item.file}   (${item.note})`);
    }
    lines.push("");
  }

  if (!plan.hooksOnly) {
    lines.push("MCP server registration");
    if (!plan.merges.length) {
      lines.push("  (no Cline MCP settings file found — paste the JSON below by hand)");
    }
    for (const { target, plan: merge } of plan.merges) {
      if (merge.action === "skip") {
        lines.push(`  SKIP      ${target.label}: ${merge.error}`);
        continue;
      }
      const keep = merge.otherServers.length
        ? `${merge.otherServers.length} other server(s) preserved: ${merge.otherServers.join(", ")}`
        : "no other servers configured";
      lines.push(`  ${merge.action.padEnd(9)} ${target.label} → ${target.mcpSettings}`);
      lines.push(`            ${keep}`);
    }
    lines.push("");
  }

  lines.push("Manual step you must do yourself:");
  lines.push('  Enable hooks in Cline: Settings → Features → "Enable Hooks".');
  lines.push("  Without it the hook files exist but never fire, and routing drops back");
  lines.push("  from enforced to advisory.");
  return lines.join("\n");
}

export function applySetup(plan) {
  const result = { files: [], blocked: [], merges: [], backups: [] };
  if (!plan.mcpOnly) {
    const applied = applyPlan(plan.files);
    result.files = applied.written;
    result.blocked = applied.blocked;
  }
  if (!plan.hooksOnly) {
    for (const { target, plan: merge } of plan.merges) {
      if (merge.action === "skip" || merge.action === "unchanged") {
        result.merges.push({ file: target.mcpSettings, written: false, action: merge.action });
        continue;
      }
      const outcome = applyMerge(target.mcpSettings, merge);
      if (outcome.backup) result.backups.push(outcome.backup);
      result.merges.push({ file: target.mcpSettings, written: outcome.written, action: merge.action });
    }
  }
  return result;
}

/**
 * Confirm the routing logic actually produces a decision, and that every
 * generated launcher points at an entry that exists. This is a logic check,
 * not a live Cline check — the manual echo command in the report is the real
 * end-to-end confirmation.
 */
export async function verify(plan) {
  const checks = [];
  const { decidePreToolUse, decidePostToolUse } = await import("../hooks/run.mjs");

  const redirect = await decidePreToolUse({
    hookName: "tool_call",
    tool_call: { name: "fetch_web_content", input: { url: "https://example.com" } },
  });
  checks.push({ name: "PreToolUse redirects page fetches", ok: redirect.cancel === true, detail: JSON.stringify(redirect).slice(0, 120) });

  const untouched = await decidePreToolUse({ tool_call: { name: "editor", input: { path: "a.ts" } } });
  checks.push({ name: "PreToolUse leaves the editor alone", ok: Object.keys(untouched).length === 0, detail: JSON.stringify(untouched) });

  const big = await decidePostToolUse({ tool_result: { name: "read_files", output: "x".repeat(50_000) } });
  checks.push({ name: "PostToolUse nudges oversized results", ok: typeof big.context === "string" });

  for (const [event, file] of Object.entries(ENTRY)) {
    checks.push({ name: `hook entry exists: ${event}`, ok: fs.existsSync(file), detail: file });
  }

  for (const item of plan.files) {
    if (!fs.existsSync(item.file)) continue;
    const recorded = readRecordedEntry(fs.readFileSync(item.file, "utf8"));
    if (recorded && !fs.existsSync(recorded)) {
      checks.push({ name: `stale entry in ${path.basename(item.file)}`, ok: false, detail: recorded });
    }
  }

  return checks;
}

export function uninstall({ root = process.cwd(), global = false } = {}) {
  const targets = discoverClineTargets();
  const plan = global ? globalPlan() : workspacePlan(root);
  const { removed, skipped } = removePlan(plan);

  const mcp = [];
  for (const target of targets) {
    if (!target.mcpSettings || !fs.existsSync(target.mcpSettings)) continue;
    const removal = planRemoval(target.mcpSettings);
    if (removal.action !== "update") {
      mcp.push({ target, action: removal.action });
      continue;
    }
    const outcome = applyMerge(target.mcpSettings, removal);
    mcp.push({ target, action: "removed", backup: outcome.backup });
  }

  return { removed, skipped, mcp, targets };
}

export { repair, SERVER_NAME };
