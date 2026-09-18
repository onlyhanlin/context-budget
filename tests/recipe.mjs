#!/usr/bin/env node
/**
 * Execute the README's agent recipe against a synthetic machine.
 *
 * The README tells an AI agent exactly what to run and what it should see. This
 * runs those same steps with HOME and APPDATA pointed at throwaway directories,
 * so the whole install -> verify -> uninstall loop is exercised without touching
 * the real Cline configuration.
 *
 *   node tests/recipe.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-recipe-"));

// ---- a synthetic machine -------------------------------------------------
const fakeHome = path.join(base, "home");
const fakeAppData = path.join(fakeHome, "AppData", "Roaming");
const storage = path.join(fakeAppData, "Code", "User", "globalStorage", "saoudrizwan.claude-dev");
const settingsFile = path.join(storage, "settings", "cline_mcp_settings.json");
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
fs.writeFileSync(
  settingsFile,
  JSON.stringify({ mcpServers: { "some-other-server": { command: "other", args: [] } } }, null, 2) + "\n",
  "utf8"
);
const project = path.join(base, "project");
fs.mkdirSync(project, { recursive: true });

const env = {
  ...process.env,
  USERPROFILE: fakeHome,
  HOMEDRIVE: path.parse(fakeHome).root.replace(/\\$/, ""),
  HOMEPATH: fakeHome.slice(path.parse(fakeHome).root.length - 1),
  APPDATA: fakeAppData,
  CONTEXT_BUDGET_DIR: path.join(base, "store"),
  CONTEXT_BUDGET_PROJECT: project,
};

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  process.stdout.write(`  ${ok ? "✔" : "✖"} ${name}${ok || !detail ? "" : "\n      → " + String(detail).slice(0, 400).replace(/\n/g, "\n      ")}\n`);
}
const step = (t) => process.stdout.write(`\n${t}\n`);

/** The README writes `context-budget ...`; unlinked, that is this. */
function cb(args, opts = {}) {
  return spawnSync(process.execPath, ["bin/cli.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...env, ...(opts.env ?? {}) },
    input: opts.input,
  });
}
/** Step 5 runs a hook through stdin. */
function echoHook(payload) {
  return spawnSync(process.execPath, ["bin/cli.mjs", "hook", "pretooluse"], {
    cwd: root,
    encoding: "utf8",
    env,
    input: JSON.stringify(payload),
  });
}

/* ---- Step 0: prerequisites ---- */
step("Step 0 — prerequisites");
const nodeMajor = Number(process.versions.node.split(".")[0]);
const nodeMinor = Number(process.versions.node.split(".")[1]);
check("node >= 22.5 (README requirement)", nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5), process.versions.node);

/* ---- Step 1: version gate ---- */
step("Step 1 — the CLI answers");
const version = cb(["version"]);
check("context-budget version prints a semver", /^\d+\.\d+\.\d+$/.test(version.stdout.trim()), JSON.stringify(version.stdout.trim()));

/* ---- Step 2: dry run writes nothing ---- */
step("Step 2 — dry run");
const dry = cb(["setup"]);
check("dry run says it is a dry run", /DRY RUN/.test(dry.stdout), dry.stdout.slice(-160));
check("dry run detects the synthetic Cline install", /saoudrizwan\.claude-dev/.test(dry.stdout), dry.stdout.slice(0, 300));
check("dry run prints the MCP config block", /"mcpServers"/.test(dry.stdout) && /"ctx_execute"/.test(dry.stdout));
check("dry run writes no hook files", !fs.existsSync(path.join(project, ".clinerules")), "found .clinerules after a dry run");
const beforeDry = fs.readFileSync(settingsFile, "utf8");

/* ---- Step 3: apply ---- */
step("Step 3 — apply");
const applied = cb(["setup", "--yes"]);
check("setup --yes exits 0", applied.status === 0, applied.stderr.slice(0, 300));
check("verification has no failed line", !/\[ \]/.test(applied.stdout), applied.stdout.slice(applied.stdout.indexOf("Verification"), applied.stdout.indexOf("Verification") + 500));
check("verification reports passing checks", /\[x\] hook entry exists: precompact/.test(applied.stdout));

// The name is not cosmetic: Cline looks for "<HookName>.ps1" on Windows and the
// extensionless "<HookName>" elsewhere, and ignores the other one entirely.
const { extensionHookFile, cliHookFile } = await import(pathToFileURL(path.join(root, "hooks", "install.mjs")).href);
for (const event of ["pretooluse", "posttooluse", "precompact", "taskresume"]) {
  check(`extension hook written: ${extensionHookFile(event)}`, fs.existsSync(path.join(project, ".clinerules", "hooks", extensionHookFile(event))));
  check(`CLI hook written: ${cliHookFile(event)}`, fs.existsSync(path.join(project, ".cline", "hooks", cliHookFile(event))));
}
check("routing rules written", fs.existsSync(path.join(project, ".clinerules", "context-budget.md")));

const afterApply = fs.readFileSync(settingsFile, "utf8");
const parsed = JSON.parse(afterApply);
check("MCP server registered in the settings file", Boolean(parsed.mcpServers["context-budget"]), afterApply.slice(0, 300));
check("the pre-existing MCP server survived", Boolean(parsed.mcpServers["some-other-server"]), afterApply.slice(0, 300));
check("settings file content actually changed", afterApply !== beforeDry);
const backups = fs.readdirSync(path.dirname(settingsFile)).filter((f) => f.includes("backup"));
check("a backup was taken before the merge", backups.length >= 1, fs.readdirSync(path.dirname(settingsFile)).join(", "));
if (backups.length) {
  check("the backup holds the original bytes", fs.readFileSync(path.join(path.dirname(settingsFile), backups[0]), "utf8") === beforeDry);
}

/* ---- Step 5: verify the hook end to end ---- */
step("Step 5 — hook verification");
const hooked = echoHook({ hookName: "PreToolUse", preToolUse: { toolName: "fetch_web_content", parameters: { url: "https://example.com" } } });
check("the hook command exits 0", hooked.status === 0, hooked.stderr.slice(0, 200));
let decision = null;
try { decision = JSON.parse(hooked.stdout); } catch { /* below */ }
check("it returns parseable JSON", decision !== null, hooked.stdout.slice(0, 200));
check("cancel is exactly false", decision?.cancel === false, hooked.stdout.slice(0, 200));
check("contextModification is present and non-empty", typeof decision?.contextModification === "string" && decision.contextModification.length > 0, hooked.stdout.slice(0, 200));

/* ---- Step 6: doctor confirms registration ---- */
step("Step 6 — doctor");
const doctor = cb(["doctor"]);
check("doctor exits 0", doctor.status === 0, doctor.stderr.slice(0, 300));
check("doctor lists the detected Cline install", /saoudrizwan\.claude-dev/.test(doctor.stdout), doctor.stdout.slice(0, 400));
check("doctor reports the server as registered", /mcp: registered/.test(doctor.stdout), doctor.stdout.slice(doctor.stdout.indexOf("cline"), doctor.stdout.indexOf("cline") + 400));
check("doctor hook checks all pass", /hook checks: (\d+)\/\1 passing/.test(doctor.stdout), (doctor.stdout.match(/hook checks:.*/) ?? [""])[0]);
check("doctor does not print a SQLite warning", !/ExperimentalWarning/.test(doctor.stderr ?? ""), (doctor.stderr ?? "").slice(0, 200));

/* ---- also documented: a second run is a no-op ---- */
step("Idempotence (documented)");
const again = cb(["setup", "--yes"]);
check("a second setup changes nothing", /0 to create, 0 to update/.test(again.stdout), again.stdout.slice(-200));
const backupsAfter = fs.readdirSync(path.dirname(settingsFile)).filter((f) => f.includes("backup"));
check("a no-op run does not spray backups", backupsAfter.length === backups.length, `${backups.length} -> ${backupsAfter.length}`);

/* ---- Rollback ---- */
step("Uninstall (documented)");
const removed = cb(["uninstall", "--yes"]);
check("uninstall exits 0", removed.status === 0, removed.stderr.slice(0, 300));
check("generated hooks are gone", !fs.existsSync(path.join(project, ".clinerules", "hooks", extensionHookFile("pretooluse"))));
const afterUninstall = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
check("our key is removed from settings", !afterUninstall.mcpServers["context-budget"], JSON.stringify(afterUninstall).slice(0, 200));
check("the other MCP server is still there", Boolean(afterUninstall.mcpServers["some-other-server"]));

/* ---- a user-owned hook must survive ---- */
const userHook = path.join(project, ".clinerules", "hooks", "MyOwnHook");
fs.writeFileSync(userHook, "#!/usr/bin/env bash\necho '{}'\n");
cb(["setup", "--yes"]);
cb(["uninstall", "--yes"]);
check("a user-written hook is never deleted", fs.existsSync(userHook));

/* ---- global install: once, for every project ---- */
step("Global install (documented)");
const globalHooks = path.join(fakeHome, "Documents", "Cline", "Hooks");
const globalRules = path.join(fakeHome, "Documents", "Cline", "Rules");

const globalRun = cb(["setup", "--global", "--yes", "--hooks-only"]);
check("setup --global exits 0", globalRun.status === 0, globalRun.stderr.slice(0, 300));
check("global rules land in ~/Documents/Cline/Rules", fs.existsSync(path.join(globalRules, "context-budget.md")));
check("global hooks land in ~/Documents/Cline/Hooks", fs.existsSync(globalHooks));

const globalNames = fs.existsSync(globalHooks) ? fs.readdirSync(globalHooks).sort() : [];
for (const event of ["pretooluse", "posttooluse", "precompact", "taskresume"]) {
  const expected = extensionHookFile(event);
  check(`global hook uses the canonical name: ${expected}`, globalNames.includes(expected), globalNames.join(", "));
}
check("no prefixed-looking hook names were written", !globalNames.some((n) => n.startsWith("context-budget")), globalNames.join(", "));

/* The hook slot belongs to whoever got there first. */
const theirs = path.join(globalHooks, extensionHookFile("pretooluse"));
cb(["uninstall", "--global", "--yes"]);
fs.mkdirSync(globalHooks, { recursive: true });
const theirsBody = "#!/usr/bin/env bash\n# mine, hands off\necho \"{\"cancel\": false}\"\n";
fs.writeFileSync(theirs, theirsBody);
const conflicted = cb(["setup", "--global", "--yes", "--hooks-only"]);
check("a foreign global hook is reported as a CONFLICT", /CONFLICT/.test(conflicted.stdout), conflicted.stdout.slice(-500));
check("the foreign global hook is left byte-identical", fs.readFileSync(theirs, "utf8") === theirsBody);
check("the rest of the global install still proceeded", fs.existsSync(path.join(globalHooks, extensionHookFile("precompact"))));

const globalUninstall = cb(["uninstall", "--global", "--yes"]);
check("uninstall --global exits 0", globalUninstall.status === 0, globalUninstall.stderr.slice(0, 200));
check("our global hooks are gone", !fs.existsSync(path.join(globalHooks, extensionHookFile("precompact"))));
check("the foreign global hook survived uninstall", fs.existsSync(theirs));

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${"=".repeat(60)}\n${results.length - failed.length}/${results.length} README steps verified\n`);
if (failed.length) {
  process.stdout.write("\nFAILURES:\n");
  for (const f of failed) process.stdout.write(`  ${f.name}\n      ${String(f.detail).slice(0, 400)}\n`);
}
try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* windows lock */ }
if (failed.length) process.exitCode = 1;
