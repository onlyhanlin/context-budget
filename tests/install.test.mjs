import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-install-"));
process.env.CONTEXT_BUDGET_DIR = dir;

const mcp = await import("../src/mcp-config.mjs");
const install = await import("../hooks/install.mjs");
const paths = await import("../src/cline-paths.mjs");

/* ------------------------------------------------------------- mcp-config */

test("planMerge creates settings from nothing", () => {
  const file = path.join(dir, "nested", "cline_mcp_settings.json");
  const plan = mcp.planMerge(file);
  assert.equal(plan.action, "create");
  assert.equal(plan.before, null);
  const parsed = JSON.parse(plan.after);
  assert.equal(parsed.mcpServers["context-budget"].command, "context-budget");
  assert.deepEqual(parsed.mcpServers["context-budget"].args, ["mcp"]);
});

test("planMerge preserves every other server", () => {
  const file = path.join(dir, "existing.json");
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { "my-fs": { command: "fs.exe", args: [] } } }, null, 2));
  const plan = mcp.planMerge(file);
  assert.equal(plan.action, "update");
  assert.deepEqual(plan.otherServers, ["my-fs"]);
  const parsed = JSON.parse(plan.after);
  assert.equal(parsed.mcpServers["my-fs"].command, "fs.exe", "an unrelated server must survive untouched");
  assert.ok(parsed.mcpServers["context-budget"]);
});

test("planMerge is idempotent", () => {
  const file = path.join(dir, "idempotent.json");
  fs.writeFileSync(file, mcp.planMerge(file).after);
  assert.equal(mcp.planMerge(file).action, "unchanged");
});

test("planMerge refuses to touch a file it cannot parse", () => {
  const file = path.join(dir, "broken.json");
  fs.writeFileSync(file, "{ this is not json");
  const plan = mcp.planMerge(file);
  assert.equal(plan.action, "skip");
  assert.match(plan.error, /invalid JSON/);
  assert.equal(fs.readFileSync(file, "utf8"), "{ this is not json", "a broken file must be left alone");
});

test("applyMerge writes a backup before changing anything", () => {
  const file = path.join(dir, "backup.json");
  const original = JSON.stringify({ mcpServers: { keeper: { command: "keep" } } }, null, 2) + "\n";
  fs.writeFileSync(file, original);
  const outcome = mcp.applyMerge(file, mcp.planMerge(file));
  assert.ok(outcome.written);
  assert.ok(outcome.backup && fs.existsSync(outcome.backup));
  assert.equal(fs.readFileSync(outcome.backup, "utf8"), original);
  assert.ok(mcp.isRegistered(file));
});

test("planRemoval removes only our key", () => {
  const file = path.join(dir, "remove.json");
  fs.writeFileSync(file, mcp.planMerge(file).after);
  const removal = mcp.planRemoval(file);
  assert.equal(removal.action, "update");
  const parsed = JSON.parse(removal.after);
  assert.equal(parsed.mcpServers["context-budget"], undefined);
});

/* ---------------------------------------------------------------- install */

/* The extension discovers hooks by exact file name (hook-factory.ts):
   Windows  -> "<HookName>.ps1" only
   Unix     -> the extensionless "<HookName>" only, and it must be executable
   Nothing else is looked at, ever. */
test("the extension hook file name matches Cline's discovery rule", () => {
  assert.equal(install.extensionHookFile("pretooluse", "win32"), "PreToolUse.ps1");
  assert.equal(install.extensionHookFile("pretooluse", "linux"), "PreToolUse");
  assert.equal(install.extensionHookFile("precompact", "darwin"), "PreCompact");
  assert.equal(install.extensionHookFile("taskresume", "win32"), "TaskResume.ps1");

  // The wrong platform's file is intentionally ignored by Cline, so shipping the
  // other one is the same as shipping nothing.
  const win = install.workspacePlan(path.join(dir, "plat-win"), { platform: "win32" });
  const unix = install.workspacePlan(path.join(dir, "plat-unix"), { platform: "linux" });
  assert.ok(win.every((i) => !i.file.includes(".clinerules") || i.file.endsWith(".ps1") || i.file.endsWith(".md")));
  assert.ok(unix.every((i) => !i.file.includes(".clinerules") || !i.file.endsWith(".ps1")));
});

test("Unix hook files are marked executable", () => {
  const unix = install.workspacePlan(path.join(dir, "exec"), { platform: "linux" });
  const extHook = unix.find((i) => i.file.endsWith(path.join(".clinerules", "hooks", "PreToolUse")));
  assert.ok(extHook, "expected the extensionless unix hook");
  assert.equal(extHook.executable, true, "Cline checks fs.constants.X_OK; a non-executable hook is skipped");
});

test("a global install uses the canonical hook names, not prefixed ones", () => {
  const plan = install.globalPlan({ platform: "linux" });
  const names = plan.filter((i) => i.file.includes("Hooks")).map((i) => path.basename(i.file)).sort();
  assert.deepEqual(names, ["PostToolUse", "PreCompact", "PreToolUse", "TaskResume"], names.join(", "));
  assert.ok(plan.some((i) => i.file.endsWith(path.join("Cline", "Rules", "context-budget.md"))));
});

test("an existing foreign hook in a slot is a conflict, never an overwrite", () => {
  const root = path.join(dir, "conflict");
  const hooksDir = path.join(root, ".clinerules", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  // A hook the user wrote, sitting in the slot we need.
  const theirs = path.join(hooksDir, install.extensionHookFile("pretooluse", "linux"));
  fs.writeFileSync(theirs, "#!/usr/bin/env bash\n# mine, hands off\necho '{}'\n");

  const plan = install.workspacePlan(root, { platform: "linux" });
  assert.equal(plan.find((i) => i.file === theirs)?.action, "conflict");

  const applied = install.applyPlan(plan, { platform: "linux" });
  assert.equal(applied.conflicts.length, 1, JSON.stringify(applied.conflicts));
  assert.equal(fs.readFileSync(theirs, "utf8"), "#!/usr/bin/env bash\n# mine, hands off\necho '{}'\n", "a user hook must survive untouched");
  assert.ok(applied.written.length > 0, "the rest of the install should still proceed");

  // ...and re-running after the user moves it away succeeds.
  fs.rmSync(theirs);
  const second = install.applyPlan(install.workspacePlan(root, { platform: "linux" }), { platform: "linux" });
  assert.equal(second.conflicts.length, 0);
  assert.ok(fs.existsSync(theirs));
});

test("workspacePlan covers both surfaces and every file is marked", () => {
  const root = path.join(dir, "ws");
  fs.mkdirSync(root, { recursive: true });
  const plan = install.workspacePlan(root);
  assert.equal(plan.length, 9, "1 rules file + 4 hook events x (extension hook + CLI hook)");
  assert.ok(plan.every((item) => item.action === "create"));
  assert.ok(plan.every((item) => item.content.includes(install.MARKER)));
  assert.ok(plan.some((item) => item.file.endsWith(path.join(".clinerules", "hooks", install.extensionHookFile("precompact")))));
  assert.ok(plan.some((item) => item.file.endsWith(path.join(".cline", "hooks", "PreToolUse.sh"))));
});

test("applyPlan is idempotent", () => {
  const root = path.join(dir, "ws2");
  fs.mkdirSync(root, { recursive: true });
  assert.equal(install.applyPlan(install.workspacePlan(root)).written.length, 9);
  assert.equal(install.applyPlan(install.workspacePlan(root)).written.length, 0, "a second run must write nothing");
  assert.ok(install.workspacePlan(root).every((item) => item.action === "unchanged"));
});

test("removePlan never deletes a file the user wrote", () => {
  const root = path.join(dir, "ws3");
  fs.mkdirSync(path.join(root, ".clinerules", "hooks"), { recursive: true });
  install.applyPlan(install.workspacePlan(root));

  const userHook = path.join(root, ".clinerules", "hooks", "PreToolUse.user");
  fs.writeFileSync(userHook, "#!/usr/bin/env bash\necho '{}'\n");

  const { removed } = install.removePlan(install.workspacePlan(root));
  assert.equal(removed.length, 9);
  assert.ok(fs.existsSync(userHook), "a user-owned hook must survive uninstall");
});

test("repair rewrites a launcher whose entry path no longer exists", () => {
  const root = path.join(dir, "ws4");
  fs.mkdirSync(root, { recursive: true });
  install.applyPlan(install.workspacePlan(root));

  const target = path.join(root, ".cline", "hooks", "PreToolUse.sh");
  const broken = fs
    .readFileSync(target, "utf8")
    .replace(/context-budget:entry=.*/, "context-budget:entry=" + path.join(dir, "gone", "pretooluse.mjs"));
  fs.writeFileSync(target, broken);
  assert.equal(install.readRecordedEntry(broken), path.join(dir, "gone", "pretooluse.mjs"));

  const repaired = install.repair({ root });
  assert.ok(repaired.includes(target), "the stale launcher should be rewritten");
  assert.ok(fs.readFileSync(target, "utf8").includes(install.ENTRY.pretooluse));
});

test("repair leaves healthy launchers untouched", () => {
  const root = path.join(dir, "ws5");
  fs.mkdirSync(root, { recursive: true });
  install.applyPlan(install.workspacePlan(root));
  assert.deepEqual(install.repair({ root }), []);
});

/* ------------------------------------------------------------ cline-paths */

test("discovery returns a well-formed list", () => {
  const targets = paths.discoverClineTargets();
  assert.ok(Array.isArray(targets));
  for (const t of targets) {
    assert.ok(["extension", "cli"].includes(t.kind));
    assert.equal(typeof t.label, "string");
    assert.ok(t.mcpSettings === null || typeof t.mcpSettings === "string");
  }
  assert.ok(Array.isArray(paths.describeTargets(targets)));
  assert.deepEqual(paths.describeTargets([]), ["  (no Cline installation detected)"]);
});
