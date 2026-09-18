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

test("workspacePlan covers both surfaces and every file is marked", () => {
  const root = path.join(dir, "ws");
  fs.mkdirSync(root, { recursive: true });
  const plan = install.workspacePlan(root);
  assert.equal(plan.length, 17, "4 hook events x 4 launchers + 1 rules file");
  assert.ok(plan.some((item) => item.file.endsWith(path.join(".clinerules", "hooks", "PreCompact"))));
  assert.ok(plan.some((item) => item.file.endsWith(path.join(".clinerules", "hooks", "TaskResume"))));
  assert.ok(plan.every((item) => item.action === "create"));
  assert.ok(plan.every((item) => item.content.includes(install.MARKER)));
  assert.ok(plan.some((item) => item.file.endsWith(path.join(".clinerules", "hooks", "PreToolUse"))));
  assert.ok(plan.some((item) => item.file.endsWith(path.join(".cline", "hooks", "PreToolUse.mjs"))));
});

test("applyPlan is idempotent", () => {
  const root = path.join(dir, "ws2");
  fs.mkdirSync(root, { recursive: true });
  assert.equal(install.applyPlan(install.workspacePlan(root)).written.length, 17);
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
  assert.equal(removed.length, 17);
  assert.ok(fs.existsSync(userHook), "a user-owned hook must survive uninstall");
});

test("repair rewrites a launcher whose entry path no longer exists", () => {
  const root = path.join(dir, "ws4");
  fs.mkdirSync(root, { recursive: true });
  install.applyPlan(install.workspacePlan(root));

  const target = path.join(root, ".cline", "hooks", "PreToolUse.mjs");
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
