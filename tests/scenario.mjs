#!/usr/bin/env node
/**
 * Behavioural scenario test.
 *
 * Drives the REAL generated hook files as child processes with realistic Cline
 * payloads, so what you see here is what Cline will see — not what the unit
 * tests believe.
 *
 *   node tests/scenario.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "cb-scenario-"));
const store = path.join(work, "store");
fs.mkdirSync(store, { recursive: true });

// A workspace with one fat file so the "big read" branch has something real.
fs.writeFileSync(path.join(work, "big-module.ts"), "export const x = 1;\n".repeat(3000));

const { workspacePlan, applyPlan } = await import(pathToFileURL(path.join(root, "hooks", "install.mjs")).href);
applyPlan(workspacePlan(work));

const hook = (event) => path.join(work, ".cline", "hooks", `${event}.mjs`);

function run(event, payload, env = {}) {
  const result = spawnSync(process.execPath, [hook(event)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CONTEXT_BUDGET_DIR: store, CONTEXT_BUDGET_PROJECT: work, ...env },
  });
  if (result.status !== 0) return { error: result.stderr.trim() || `exit ${result.status}` };
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { error: `unparseable: ${result.stdout.slice(0, 80)}` };
  }
}

const url = (u) => ({ hookName: "PreToolUse", preToolUse: { toolName: "fetch_web_content", parameters: { url: u } } });
const tool = (name, parameters) => ({ hookName: "PreToolUse", preToolUse: { toolName: name, parameters } });

function verdict(decision) {
  if (decision.error) return `ERROR ${decision.error}`;
  if (decision.cancel === true) return "CANCEL";
  if (decision.contextModification) return "nudge";
  return "silent";
}

function line(label, decision) {
  const v = verdict(decision);
  const mark = v === "CANCEL" ? "■" : v === "nudge" ? "▸" : v === "silent" ? "·" : "!";
  return `  ${mark} ${label.padEnd(46)} ${v}`;
}

const rows = [];
const section = (title) => rows.push(`\n${title}`);

/* ---------------------------------------------------------- default mode */
section("DEFAULT  (CONTEXT_BUDGET_FETCH unset)");
rows.push(line("fetch a page", run("PreToolUse", url("https://example.com/spec"))));
rows.push(line("fetch the same page again", run("PreToolUse", url("https://example.com/spec"))));
rows.push(line("read a 60 KB file", run("PreToolUse", tool("read_files", { path: path.join(work, "big-module.ts") }))));
rows.push(line("run npm test", run("PreToolUse", tool("execute_command", { command: "npm test" }))));
rows.push(line("run pwd", run("PreToolUse", tool("execute_command", { command: "pwd" }))));
rows.push(line("edit a file", run("PreToolUse", tool("editor", { path: path.join(work, "big-module.ts") }))));
rows.push(line("apply a patch", run("PreToolUse", tool("apply_patch", { path: "src/a.ts" }))));

/* ------------------------------------------------------------ nudge mode */
section("NUDGE  (explicit)");
rows.push(line("fetch a page", run("PreToolUse", url("https://example.com/a"), { CONTEXT_BUDGET_FETCH: "nudge" })));

/* ------------------------------------------------------------- off mode */
section("OFF");
rows.push(line("fetch a page", run("PreToolUse", url("https://example.com/b"), { CONTEXT_BUDGET_FETCH: "off" })));

/* ------------------------------------------------ cancel, no MCP target */
section("CANCEL — but context-budget is not registered as an MCP server");
rows.push(line("fetch a page", run("PreToolUse", url("https://example.com/c"), {
  CONTEXT_BUDGET_FETCH: "cancel",
  CONTEXT_BUDGET_MCP_ASSUME: "missing",
})));

/* ------------------------------------------------------- cancel, armed */
section("CANCEL — redirect target available");
const armed = { CONTEXT_BUDGET_FETCH: "cancel", CONTEXT_BUDGET_MCP_ASSUME: "registered" };
rows.push(line("fetch attempt 1", run("PreToolUse", url("https://example.com/d"), armed)));
rows.push(line("fetch attempt 2", run("PreToolUse", url("https://example.com/d"), armed)));
rows.push(line("fetch attempt 3  (retry valve)", run("PreToolUse", url("https://example.com/d"), armed)));

/* ------------------------------------------------------------ allowlist */
section("CANCEL — with an allowlisted domain");
const allowed = { ...armed, CONTEXT_BUDGET_FETCH_ALLOW: "internal.example.com" };
rows.push(line("fetch docs.internal.example.com", run("PreToolUse", url("https://docs.internal.example.com/p"), allowed)));
rows.push(line("fetch public.example.com", run("PreToolUse", url("https://public.example.com/p"), allowed)));

/* -------------------------------------------------------------- editor */
section("CANCEL — editor safety");
rows.push(line("edit a file", run("PreToolUse", tool("editor", { path: "src/a.ts" }), armed)));
rows.push(line("write a file", run("PreToolUse", tool("write_to_file", { path: "src/a.ts" }), armed)));

/* ------------------------------------------------ compaction round trip */
section("COMPACTION ROUND TRIP");
const history = path.join(work, "conversation_history.txt");
fs.writeFileSync(history, [
  '{"type":"ask","ask":"followup","text":"parser breaks on nested generics in src/parser.ts"}',
  '{"type":"say","say":"tool","text":"Error: unexpected token at src/parser.ts:118"}',
].join("\n"));

const compact = run("PreCompact", {
  hookName: "PreCompact",
  taskId: "task-9",
  preCompact: { taskId: "task-9", contextSize: 88, compactionStrategy: "auto-condense", contextRawPath: history },
});
rows.push(line("PreCompact", compact));
rows.push("     ↳ capture only; injecting at this moment would be compacted away");

const resume1 = run("TaskResume", { hookName: "TaskResume", taskId: "task-9" });
rows.push(line("TaskResume (1st)", resume1));
const resume2 = run("TaskResume", { hookName: "TaskResume", taskId: "task-9" });
rows.push(line("TaskResume (2nd)", resume2));

const card = resume1.contextModification ?? "";
rows.push("");
rows.push("  --- card handed back ---");
for (const cardLine of card.split("\n")) rows.push(`  | ${cardLine}`);

/* ----------------------------------------------------- overhead measure */
section("COST OF THE HOOK LAYER");
const started = Date.now();
for (let i = 0; i < 20; i++) run("PreToolUse", tool("execute_command", { command: "pwd" }));
const each = (Date.now() - started) / 20;
rows.push(`  20 quiet tool calls: ${each.toFixed(0)} ms per call (process spawn included)`);

process.stdout.write(rows.join("\n") + "\n");

const failures = rows.filter((r) => r.includes(" ERROR ") || r.startsWith("  !"));
fs.rmSync(work, { recursive: true, force: true });
if (failures.length) {
  process.stdout.write(`\n${failures.length} problem(s) above\n`);
  process.exitCode = 1;
}
