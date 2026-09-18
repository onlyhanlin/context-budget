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

/* ------------------------------------------------- additional edge cases */

test("user importing readFileSync does not collide with the preamble", async () => {
  // Regression test: the preamble aliases its own readFileSync import so a
  // user script that imports readFileSync from "node:fs" (rewritten to
  // ./__cb_fs.mjs) no longer triggers "Identifier 'readFileSync' has already
  // been declared".
  const file = path.join(dir, "conflict.txt");
  fs.writeFileSync(file, "data".repeat(1000), "utf8");
  const res = await run({
    language: "javascript",
    code: 'import { readFileSync } from "node:fs";\nconst t = readFileSync(process.env.CB_TARGET, "utf8");\nconsole.log("len=" + t.length);',
    env: { CB_TARGET: file },
  });
  assert.equal(res.exitCode, 0, res.stderr);
  assert.equal(res.stdout.trim(), "len=4000");
});

test("user importing createRequire does not collide with the preamble", async () => {
  const res = await run({
    language: "javascript",
    code: 'import { createRequire } from "node:module";\nconst r = createRequire(import.meta.url);\nconsole.log("has-require=" + typeof r);',
  });
  assert.equal(res.exitCode, 0, res.stderr);
  assert.ok(res.stdout.includes("has-require=function"));
});

test("user importing the default fs export still works and is instrumented", async () => {
  const file = path.join(dir, "default-fs.txt");
  fs.writeFileSync(file, "z".repeat(1000), "utf8");
  const res = await run({
    language: "javascript",
    code: 'import fs from "node:fs";\nconst t = fs.readFileSync(process.env.CB_TARGET, "utf8");\nconsole.log("len=" + t.length);',
    env: { CB_TARGET: file },
  });
  assert.equal(res.exitCode, 0, res.stderr);
  assert.equal(res.stdout.trim(), "len=1000");
  assert.ok(res.bytesRead >= 1000, `bytesRead should be >= 1000, got ${res.bytesRead}`);
});

test("stdoutCaptured holds the full output even when truncated", async () => {
  const res = await run({
    language: "javascript",
    code: 'process.stdout.write("x".repeat(50000));',
    maxOutputBytes: 1024,
  });
  assert.equal(res.truncated, true);
  // stdoutCaptured is what gets indexed; it must contain more than the model sees.
  assert.ok(res.stdoutCaptured.length >= 50000, "captured output should retain the full payload");
  assert.ok(res.stdout.length <= 1024 + 64, "model-facing output is capped");
});

test("stderr is capped and never exposes the stats sentinel", async () => {
  const res = await run({
    language: "javascript",
    code: 'for (let i = 0; i < 1000; i++) console.error("line " + i);',
  });
  assert.equal(res.exitCode, 0);
  assert.ok(!res.stderr.includes("__CB_STATS__"), "sentinel must always be stripped");
  // stderr is capped at 256KB; 1000 short lines should fit but the cap is enforced.
  assert.ok(Buffer.byteLength(res.stderr, "utf8") <= 256 * 1024 + 256);
});

test("a thrown error surfaces its stack in stderr and exitCode is non-zero", async () => {
  const res = await run({
    language: "javascript",
    code: 'throw new Error("boom");',
  });
  assert.notEqual(res.exitCode, 0);
  assert.ok(res.stderr.includes("boom"));
  assert.ok(!res.ok);
});

test("runCommand refuses a denied command without spawning", async () => {
  const res = await runCommand("rm -rf /");
  assert.equal(res.refused, true);
  assert.equal(res.command, null);
  assert.ok(res.stderr.includes("refused by context-budget policy"));
});

test("runCommand allows a benign command", async () => {
  const res = await runCommand('node -e "console.log(\'ok\')"', { cwd: dir });
  assert.equal(res.ok, true);
  assert.equal(res.stdout.trim(), "ok");
});

test("normalizeLanguage handles null, undefined and case", () => {
  assert.equal(normalizeLanguage(null), null);
  assert.equal(normalizeLanguage(undefined), null);
  assert.equal(normalizeLanguage(""), null);
  assert.equal(normalizeLanguage("  "), null);
  assert.equal(normalizeLanguage("JavaScript"), "javascript");
  assert.equal(normalizeLanguage("PY"), "python");
  assert.equal(normalizeLanguage("PowerShell"), "powershell");
  assert.equal(normalizeLanguage("BAT"), "batch");
  assert.equal(normalizeLanguage("Cmd"), "batch");
});

test("the full stdout count is reported for accounting even on truncation", async () => {
  const res = await run({
    language: "javascript",
    code: 'process.stdout.write("a".repeat(100000));',
    maxOutputBytes: 512,
  });
  assert.ok(res.stdoutBytesTotal >= 100000, "stdoutBytesTotal must reflect what the process actually wrote");
  assert.ok(res.bytesOut <= 512 + 64);
});

test("ctxExecute-style run with empty code still returns a structured result", async () => {
  // The sandbox itself does not reject empty code (the tool layer does); it
  // just runs an empty script. Verify the result shape is well-formed.
  const res = await run({ language: "javascript", code: "" });
  assert.equal(typeof res.ok, "boolean");
  assert.equal(typeof res.stdout, "string");
  assert.equal(typeof res.exitCode, "number");
  assert.equal(typeof res.durationMs, "number");
});

test("powershell runtime is detected on Windows (regression for --version probe)", async () => {
  // Windows PowerShell 5.1 does not understand --version; the runtime spec
  // must use a probe command that both pwsh and powershell.exe accept.
  // Skip gracefully when neither is installed.
  const resolved = resolveRuntime("powershell");
  if (!resolved) {
    assert.ok(true, "no powershell runtime on this platform — skipping");
    return;
  }
  const res = await run({
    language: "powershell",
    code: 'Write-Output "ps-probe-ok"',
  });
  assert.equal(res.exitCode, 0, res.stderr);
  assert.ok(res.stdout.includes("ps-probe-ok"), `stdout was: ${res.stdout}`);
});

test("batch runtime is detected on Windows and exposes filePath for ctx_execute_file", async () => {
  // Skip gracefully on platforms without cmd.exe (macOS, Linux).
  const resolved = resolveRuntime("batch");
  if (!resolved) {
    assert.ok(true, "no batch runtime on this platform — skipping");
    return;
  }
  const res = await run({
    language: "batch",
    code: `@echo off\necho batch-probe-ok`,
  });
  assert.equal(res.exitCode, 0, res.stderr);
  assert.ok(res.stdout.includes("batch-probe-ok"), `stdout was: ${res.stdout}`);
  assert.equal(res.language, "batch");
  assert.equal(res.command, "cmd");

  // ctx_execute_file path: the preamble must expose `filePath`, since batch
  // cannot bind a multiline `content` variable.
  const src = path.join(os.tmpdir(), `cb-batch-src-${Date.now()}.txt`);
  fs.writeFileSync(src, "file-content-here", "utf8");
  const res2 = await run({
    language: "batch",
    code: `type "%filePath%"`,
    filePath: src,
  });
  fs.rmSync(src, { force: true });
  assert.equal(res2.exitCode, 0, res2.stderr);
  assert.ok(res2.stdout.includes("file-content-here"), `stdout was: ${res2.stdout}`);
});

test("batch round-trips non-ASCII (CRLF conversion regression)", async () => {
  // cmd.exe on a double-byte codepage (cp936 etc.) mis-parses LF-only batch
  // files containing non-ASCII: a DBCS lead byte eats the line break and every
  // later line — even pure ASCII — breaks. The sandbox must write CRLF endings.
  const resolved = resolveRuntime("batch");
  if (!resolved) {
    assert.ok(true, "no batch runtime on this platform — skipping");
    return;
  }
  const res = await run({
    language: "batch",
    code: `@echo off\necho hello-world\necho café 你好`,
  });
  assert.equal(res.exitCode, 0, res.stderr);
  assert.ok(res.stdout.includes("hello-world"), `stdout was: ${res.stdout}`);
  assert.ok(res.stdout.includes("café 你好"), `stdout was: ${res.stdout}`);
});

test("batch survives special characters and reports a non-zero exit code", async () => {
  const resolved = resolveRuntime("batch");
  if (!resolved) {
    assert.ok(true, "no batch runtime on this platform — skipping");
    return;
  }
  const res = await run({
    language: "batch",
    code: `@echo off\necho a ^& b\necho 100%% done\necho (paren ^| pipe)\nexit /b 3`,
  });
  assert.equal(res.exitCode, 3);
  assert.equal(res.ok, false);
  assert.ok(res.stdout.includes("a & b"), `stdout was: ${res.stdout}`);
  assert.ok(res.stdout.includes("100% done"), `stdout was: ${res.stdout}`);
});

test("batch infinite loop is killed by the timeout", async () => {
  const resolved = resolveRuntime("batch");
  if (!resolved) {
    assert.ok(true, "no batch runtime on this platform — skipping");
    return;
  }
  const res = await run({
    language: "batch",
    code: `@echo off\n:cb_forever\ngoto cb_forever`,
    timeoutMs: 2000,
  });
  assert.equal(res.timedOut, true);
  assert.equal(res.ok, false);
});

test("batch large output is truncated to the cap but fully counted", async () => {
  const resolved = resolveRuntime("batch");
  if (!resolved) {
    assert.ok(true, "no batch runtime on this platform — skipping");
    return;
  }
  const res = await run({
    language: "batch",
    code: `@echo off\nfor /l %%i in (1,1,20000) do echo line-%%i-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
    maxOutputBytes: 4096,
  });
  assert.equal(res.truncated, true);
  assert.ok(res.bytesOut <= 4096 + 64);
  assert.ok(res.stdoutBytesTotal >= 800000, "the full output volume must be counted for accounting");
});
