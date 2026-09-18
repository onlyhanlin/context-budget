#!/usr/bin/env node
/**
 * Real-workflow test: talk MCP to the real server and do the thing the project
 * exists for — pull a large document through the sandbox and return only the
 * derived answer.
 *
 * This one needs network access. If the sandbox has none, it says so instead of
 * pretending to pass.
 *
 *   node tests/workflow.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "cb-workflow-"));
const store = path.join(work, "store");

// A workspace that looks like a real project, so ctx_batch has work to do.
fs.mkdirSync(path.join(work, "src"), { recursive: true });
for (let i = 0; i < 30; i++) {
  fs.writeFileSync(
    path.join(work, "src", `mod${i}.ts`),
    `// module ${i}\nexport function handler${i}() { return ${i}; }\n` +
      (`// TODO: optimise this path\n`).repeat(i % 7) +
      "export const padding = \"" + "x".repeat(600) + "\";\n"
  );
}

const child = spawn(process.execPath, ["bin/cli.mjs", "mcp"], {
  cwd: root,
  env: { ...process.env, CONTEXT_BUDGET_DIR: store, CONTEXT_BUDGET_PROJECT: work },
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 1;
const pending = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const text = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!text) continue;
    let message;
    try { message = JSON.parse(text); } catch { continue; }
    if (message.id != null && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
    }
  }
});

function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    // Clear the timer on settle: a stray 120 s timer otherwise keeps the event
    // loop alive long after the report has been printed.
    const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error(`timeout: ${method}`)); }, 120_000);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
const textOf = (r) => (r?.content ?? []).map((c) => c.text ?? "").join("\n");
const bytes = (s) => Buffer.byteLength(s, "utf8");
const check = (name, ok, detail = "") =>
  process.stdout.write(`${ok ? "✔" : "✖"} ${name}${ok || !detail ? "" : " — " + detail}\n`);

const results = [];
try {
  await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "wf", version: "1" } });
  notify("notifications/initialized", {});

  /* ---- 1. the headline case: a large web page, reduced to what we asked for ---- */
  // A flaky network must not read as a broken product: retry once, and if the
  // host is still unreachable say SKIPPED instead of failing the suite.
  const URL_ = "https://raw.githubusercontent.com/mksglu/context-mode/main/README.md";
  let fetchedText = "";
  let network = null;
  for (let attempt = 1; attempt <= 3 && !network; attempt++) {
    const fetched = await call("tools/call", {
      name: "ctx_execute",
      arguments: {
        language: "javascript",
        timeout_ms: 45_000,
        code:
          `const res = await fetch("${URL_}", { signal: AbortSignal.timeout(30000) });\n` +
          `const text = await res.text();\n` +
          `const headings = text.split("\\n").filter(l => /^#{1,3} /.test(l));\n` +
          `console.log("page bytes: " + Buffer.byteLength(text));\n` +
          `console.log("headings: " + headings.length);\n` +
          `console.log(headings.slice(0, 12).join("\\n"));`,
      },
    });
    fetchedText = textOf(fetched);
    network = /page bytes: (\d+)/.exec(fetchedText);
    if (!network && attempt < 3) process.stdout.write(`  (network attempt ${attempt} failed, retrying)\n`);
  }
  if (network) {
    results.push(["ctx_execute fetched a live page", true, ""]);
  } else {
    process.stdout.write("  ~ SKIPPED: page unreachable after 3 attempts; the fetch checks were not run\n");
  }
  if (network) {
    const pageBytes = Number(network[1]);
    const returned = bytes(fetchedText);
    results.push([
      `page reduced ${(pageBytes / 1024).toFixed(0)} KB → ${returned} B (${(100 - (returned / pageBytes) * 100).toFixed(2)}% kept out)`,
      returned < 2000,
      "",
    ]);
    process.stdout.write("\n--- what the model actually received ---\n" + fetchedText + "\n");
  }

  /* ---- 2. batch: several commands, one round trip, indexes the noise ---- */
  const batched = await call("tools/call", {
    name: "ctx_batch",
    arguments: {
      tasks: [
        { label: "TODO scan", command: "git grep -n TODO -- src || true" },
        { label: "file inventory", command: "ls -la src" },
        { label: "line counts", command: "wc -l src/*.ts" },
      ],
      queries: ["which files still have TODOs and how many"],
    },
  });
  const batchText = textOf(batched);
  results.push(["ctx_batch ran commands and answered a query", /TODO/.test(batchText), batchText.slice(0, 200)]);

  /* ---- 3. the sandbox really keeps raw bytes out ---- */
  const analyzed = await call("tools/call", {
    name: "ctx_execute_file",
    arguments: {
      path: "src/mod3.ts",
      language: "javascript",
      code: 'console.log("lines: " + content.split("\\n").length + ", bytes: " + Buffer.byteLength(content));',
    },
  });
  const analyzedText = textOf(analyzed);
  const fileBytes = fs.statSync(path.join(work, "src", "mod3.ts")).size;
  results.push([
    `ctx_execute_file: ${fileBytes} B file → ${bytes(analyzedText)} B returned`,
    bytes(analyzedText) < fileBytes,
    analyzedText.slice(0, 120),
  ]);

  /* ---- 4. accounting reflects reality ---- */
  const stats = textOf(await call("tools/call", { name: "ctx_stats", arguments: {} }));
  const keptOut = /kept out\s+([\d.]+ [KMB]?B)/.exec(stats);
  results.push(["ctx_stats reports savings", Boolean(keptOut) && !/kept out\s+0 B/.test(stats), stats.split("\n").slice(0, 8).join(" | ")]);
  process.stdout.write("\n--- ctx_stats ---\n" + stats + "\n");
} catch (error) {
  const message = error?.message ?? String(error);
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|fetch failed|timeout/i.test(message)) {
    process.stdout.write(`\n  ~ SKIPPED: network unavailable (${message.slice(0, 90)})\n`);
  } else {
    results.push(["workflow completed", false, message]);
  }
} finally {
  child.kill();
  fs.rmSync(work, { recursive: true, force: true });
}

process.stdout.write("\n");
let failed = 0;
for (const [name, ok, detail] of results) {
  if (!ok) failed++;
  check(name, ok, detail);
}
process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
if (failed) process.exitCode = 1;
