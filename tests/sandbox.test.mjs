import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-sandbox-"));
process.env.CONTEXT_BUDGET_DIR = dir;

const { run, runCommand, normalizeLanguage, supportedLanguages, resolveRuntime, rewriteInstrumentedSpecifiers } = await import("../src/sandbox.mjs");
const { resolveInsideWorkspace, checkCommand } = await import("../src/security.mjs");

test("javascript runs and only stdout is captured", async () => {
  const res = await run({
    language: "javascript",
    code: 'console.error("this is noise"); console.log("ANSWER=42");',
  });
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout.trim(), "ANSWER=42");
  assert.ok(res.stderr.includes("noise"));
  assert.equal(res.language, "javascript");
});

test("output is capped and flagged as truncated", async () => {
  const res = await run({
    language: "javascript",
    code: 'process.stdout.write("x".repeat(200000));',
    maxOutputBytes: 1024,
  });
  assert.equal(res.truncated, true);
  assert.ok(res.bytesOut <= 1024);
  assert.ok(res.stdoutBytesTotal >= 200000, "total produced must be reported for accounting");
});

test("timeout kills the process", async () => {
  const res = await run({
    language: "javascript",
    code: "await new Promise(r => setTimeout(r, 10000));",
    timeoutMs: 700,
  });
  assert.equal(res.timedOut, true);
  assert.equal(res.ok, false);
});

test("file content is bound to the variable 'content'", async () => {
  const file = path.join(dir, "sample.txt");
  fs.writeFileSync(file, "alpha\nbeta\ngamma\n", "utf8");
  const res = await run({
    language: "javascript",
    code: 'console.log(content.split("\\n").filter(Boolean).length);',
    filePath: file,
  });
  assert.equal(res.stdout.trim(), "3");
});

test("unknown language fails with a helpful message", async () => {
  const res = await run({ language: "cobol", code: "DISPLAY 'HI'." });
  assert.equal(res.ok, false);
  assert.ok(res.stderr.includes("no runtime available"));
});

test("language aliases normalise", () => {
  assert.equal(normalizeLanguage("js"), "javascript");
  assert.equal(normalizeLanguage("py"), "python");
  assert.equal(normalizeLanguage("Bash"), "shell");
  assert.equal(normalizeLanguage("nope"), null);
  assert.ok(supportedLanguages().includes("javascript"));
  assert.ok(resolveRuntime("javascript"));
});

test("deny-list refuses destructive commands", async () => {
  const res = await runCommand("rm -rf /");
  assert.equal(res.refused, true);
  assert.ok(res.stderr.includes("refused by context-budget policy"));
  assert.equal(checkCommand("git status").allowed, true);
  assert.equal(checkCommand("git push --force origin main").allowed, false);
  assert.equal(checkCommand("git push --force-with-lease origin main").allowed, true);
});

test("path containment rejects escapes", () => {
  const root = path.resolve("/tmp/workspace");
  assert.equal(resolveInsideWorkspace(root, "src/a.js").ok, true);
  assert.equal(resolveInsideWorkspace(root, "../../etc/passwd").ok, false);
  assert.equal(resolveInsideWorkspace(root, "/etc/passwd").ok, false);
});

test("fs imports are rewritten so named imports stay instrumented", () => {
  const src = [
    'import { readFileSync } from "node:fs";',
    "import fsp from 'fs/promises';",
    'const cp = await import("node:child_process");',
    'const also = require("fs");',
    'const unrelated = "fs";',
  ].join("\n");
  const out = rewriteInstrumentedSpecifiers(src);
  assert.ok(out.includes('from "./__cb_fs.mjs"'));
  assert.ok(out.includes("from './__cb_fsp.mjs'"));
  assert.ok(out.includes('import("./__cb_cp.mjs")'));
  assert.ok(out.includes('require("./__cb_fs.mjs")'));
  assert.ok(out.includes('const unrelated = "fs";'), "unrelated strings must be untouched");
});

test("instrumentation measures how much data the script pulled in", async () => {
  const file = path.join(dir, "bulk.txt");
  fs.writeFileSync(file, "z".repeat(50000), "utf8");
  const res = await run({
    language: "javascript",
    code: 'import { readFileSync } from "node:fs";\nconst t = readFileSync(process.env.CB_TARGET, "utf8");\nconsole.log("len=" + t.length);',
    env: { CB_TARGET: file },
  });
  assert.equal(res.stdout.trim(), "len=50000");
  assert.ok(res.bytesRead >= 50000, `bytesRead should be >= 50000, got ${res.bytesRead}`);
  assert.ok(!res.stderr.includes("__CB_STATS__"), "the sentinel must be stripped from stderr");
});

test("runs an actual shell command and captures its output", async () => {
  const res = await runCommand('node -e "console.log(1+1)"', { cwd: dir });
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout.trim(), "2");
});
