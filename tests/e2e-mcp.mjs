#!/usr/bin/env node
/**
 * End-to-end check: speak real MCP to the real server over stdio.
 *
 *   npm run test:e2e
 *
 * Exits non-zero if any assertion fails, so it works as a CI gate.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-e2e-"));
const storageDir = path.join(sandboxDir, "storage");
fs.mkdirSync(storageDir, { recursive: true });

// A workspace with one big file, so the sandbox has something real to chew on.
for (let i = 0; i < 40; i++) {
  fs.writeFileSync(
    path.join(sandboxDir, `module-${i}.js`),
    `export function handler${i}(req) {\n  const value = req.body?.value ?? 0;\n  return { ok: true, value: value * ${i + 1} };\n}\n` + "// padding\n".repeat(400),
    "utf8"
  );
}

const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "bin/cli.mjs", "mcp"], {
  cwd: root,
  env: {
    ...process.env,
    CONTEXT_BUDGET_DIR: storageDir,
    CONTEXT_BUDGET_PROJECT: sandboxDir,
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 1;
const pending = new Map();
const stderrLines = [];
let buffer = "";

child.stderr.on("data", (chunk) => stderrLines.push(chunk.toString("utf8")));
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id != null && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  }
});

function call(method, params) {
  const id = nextId++;
  const payload = { jsonrpc: "2.0", id, method, params };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify(payload) + "\n");
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout waiting for ${method}`)); }
    }, 30_000);
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail });
  process.stdout.write(`${condition ? "✔" : "✖"} ${name}${condition ? "" : " — " + detail}\n`);
}

function textOf(result) {
  return (result?.content ?? []).map((c) => c.text ?? "").join("\n");
}

try {
  const init = await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "context-budget-e2e", version: "1.0.0" },
  });
  check("initialize handshake", init?.serverInfo?.name === "context-budget", JSON.stringify(init?.serverInfo));
  notify("notifications/initialized", {});

  const list = await call("tools/list", {});
  const names = (list?.tools ?? []).map((t) => t.name);
  check("tools/list exposes 7 tools", names.length === 7, names.join(","));
  check("every tool has an inputSchema", (list?.tools ?? []).every((t) => t.inputSchema?.type === "object"));
  check("ctx_execute is described with routing guidance", (list?.tools ?? []).find((t) => t.name === "ctx_execute")?.description?.includes("ONLY stdout"));

  // --- the headline behaviour: a big analysis returns a tiny payload ---
  const exec = await call("tools/call", {
    name: "ctx_execute",
    arguments: {
      language: "javascript",
      code:
        'import { readdirSync, readFileSync } from "node:fs";\n' +
        'const files = readdirSync(".").filter(f => f.endsWith(".js"));\n' +
        'let total = 0;\n' +
        'for (const f of files) total += readFileSync(f, "utf8").split("\\n").length;\n' +
        'console.log(files.length + " files, " + total + " lines total");',
    },
  });
  const execText = textOf(exec);
  check("ctx_execute ran and stayed small", /40 files, \d+ lines total/.test(execText), execText.slice(0, 300));
  check("ctx_execute payload under 700 bytes", Buffer.byteLength(execText, "utf8") < 700, `${Buffer.byteLength(execText, "utf8")} B`);

  // --- index + search round trip ---
  const indexed = await call("tools/call", {
    name: "ctx_index",
    arguments: {
      source: "e2e-doc",
      content: "## Session memory\n\nA compaction snapshot must stay under two kilobytes.\n\n## Sandbox\n\nOnly stdout crosses the boundary.",
    },
  });
  check("ctx_index reports chunks", /indexed "e2e-doc"/.test(textOf(indexed)), textOf(indexed).slice(0, 200));

  const searched = await call("tools/call", {
    name: "ctx_search",
    arguments: { queries: ["compaction snapshot", "stdout boundary"] },
  });
  const searchText = textOf(searched);
  check("ctx_search finds indexed content", /compaction snapshot/.test(searchText) && /stdout/i.test(searchText), searchText.slice(0, 300));

  // --- accounting actually moved ---
  const statResult = await call("tools/call", { name: "ctx_stats", arguments: {} });
  const statsText = textOf(statResult);
  check("ctx_stats reports kept-out bytes", /kept out/.test(statsText) && !/kept out\s+0 B/.test(statsText), statsText.slice(0, 400));

  // --- refusals are enforced ---
  const refused = await call("tools/call", {
    name: "ctx_execute",
    arguments: { language: "shell", code: "rm -rf /" },
  });
  check("destructive command is refused", /refused by context-budget policy/.test(textOf(refused)), textOf(refused).slice(0, 200));

  // --- path containment ---
  const escaped = await call("tools/call", {
    name: "ctx_execute_file",
    arguments: { path: "../../etc/passwd", language: "javascript", code: "console.log(content)" },
  });
  check("path escape is refused", /outside the workspace/.test(textOf(escaped)), textOf(escaped).slice(0, 200));

  const doctor = await call("tools/call", { name: "ctx_doctor", arguments: {} });
  check("ctx_doctor runs", /node:sqlite/.test(textOf(doctor)), textOf(doctor).slice(0, 200));
} catch (error) {
  check("no exception during the suite", false, error?.stack ?? String(error));
} finally {
  child.kill();
  try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
if (failed.length) process.exitCode = 1;
