#!/usr/bin/env node
/**
 * Adversarial audit #3 — data-loss and coherency edges:
 * silent truncation, key collisions, retrieval quality, TTL/GC, hook payload abuse.
 *
 *   node tests/audit3.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-audit3-"));
const results = [];
function check(section, name, ok, detail = "") {
  results.push({ section, name, ok: Boolean(ok), detail });
  process.stdout.write(`  ${ok ? "✔" : "✖"} ${name}${ok || !detail ? "" : "\n      → " + String(detail).slice(0, 320).replace(/\n/g, "\n      ")}\n`);
}
const head = (t) => process.stdout.write(`\n${t}\n`);

function startServer(workdir, storeDir, env = {}) {
  const child = spawn(process.execPath, ["bin/cli.mjs", "mcp"], {
    cwd: root,
    env: { ...process.env, CONTEXT_BUDGET_DIR: storeDir, CONTEXT_BUDGET_PROJECT: workdir, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let id = 1;
  const pending = new Map();
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    }
  });
  const rpc = (method, params, ms = 90_000) => {
    const reqId = id++;
    return new Promise((resolve, reject) => {
      pending.set(reqId, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: reqId, method, params }) + "\n");
      setTimeout(() => { if (pending.delete(reqId)) reject(new Error(`timeout ${method}`)); }, ms);
    });
  };
  return {
    child,
    call: (name, args) => rpc("tools/call", { name, arguments: args }),
    init: async () => {
      await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "a3", version: "1" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    },
  };
}
const txt = (r) => (r?.content ?? []).map((c) => c.text ?? "").join("\n");

/* ===================== 1. ctx_batch silent truncation & collisions ===================== */
head("ctx_batch · data loss");
{
  const work = fs.mkdtempSync(path.join(base, "batch-"));
  const s = startServer(work, path.join(work, "store"));
  await s.init();
  try {
    const many = Array.from({ length: 30 }, (_, i) => ({ label: `t${i}`, command: `node -e "console.log('marker-${i}')"` }));
    const r = await s.call("ctx_batch", { tasks: many });
    const out = txt(r);
    const ran = [...out.matchAll(/marker-(\d+)/g)].map((m) => Number(m[1]));
    check("batch", "30 tasks: the user is told 6 were dropped", /DROPPED/.test(out) && /were NOT run/.test(out), out.split("\n").slice(0, 3).join(" | "));
    check("batch", "30 tasks: markers 0..23 present", ran.filter((n) => n < 24).length === 24, `saw ${ran.length} markers: ${ran.join(",")}`);

    const dup = await s.call("ctx_batch", {
      tasks: [
        { label: "same", command: "node -e \"console.log('first-output-alpha')\"" },
        { label: "same", command: "node -e \"console.log('second-output-beta')\"" },
      ],
    });
    void dup;
    // Search WITHOUT a source filter: the label collision used to make the second
    // task overwrite the first, and the loose LIKE fallback then "found" the first
    // task's query inside the second task's body.
    const a = await s.call("ctx_search", { queries: ["first-output-alpha"] });
    const b = await s.call("ctx_search", { queries: ["second-output-beta"] });
    check("batch", "duplicate labels keep BOTH outputs", /first-output-alpha/.test(txt(a)) && /second-output-beta/.test(txt(b)), `a=${txt(a).slice(0, 110)} | b=${txt(b).slice(0, 110)}`);
    check("batch", "a query does not match an unrelated body via one common word", !/second-output-beta/.test(txt(a)), txt(a).slice(0, 200));

    const weirdLabel = await s.call("ctx_batch", {
      tasks: [{ label: "line1\nline2: with colon", command: "node -e \"console.log('weird-label-marker')\"" }],
    });
    void weirdLabel;
    const w = await s.call("ctx_search", { queries: ["weird-label-marker"] });
    check("batch", "a label containing newline+colon is still searchable", /weird-label-marker/.test(txt(w)), txt(w).slice(0, 150));

    const emptyOut = await s.call("ctx_batch", { tasks: [{ label: "silent", command: "node -e \"\"" }] });
    check("batch", "a command with no output is reported, not crashed", /silent: exit 0/.test(txt(emptyOut)), txt(emptyOut).slice(0, 200));
  } catch (e) {
    check("batch", "batch section completed", false, e?.stack ?? String(e));
  }
  s.child.kill();
}

/* ===================== 2. retrieval quality ===================== */
head("Search · retrieval quality");
{
  const work = fs.mkdtempSync(path.join(base, "rank-"));
  const s = startServer(work, path.join(work, "store"));
  await s.init();
  try {
    // One section that genuinely answers, buried among near-miss sections.
    const body = [];
    for (let i = 0; i < 25; i++) {
      body.push(`## Filler ${i}\n\nThis section mentions caching in passing but says nothing useful.`);
    }
    body.push("## Retry policy\n\nThe cache is invalidated by the TTL, and retries use exponential backoff capped at 30 seconds.");
    for (let i = 0; i < 25; i++) {
      body.push(`## More filler ${i}\n\nCaching again, without the specifics.`);
    }
    await s.call("ctx_index", { source: "rankdoc", content: body.join("\n\n") });

    const r = await s.call("ctx_search", { queries: ["cache invalidated ttl exponential backoff"] });
    const out = txt(r);
    const first = out.split("\n").find((l) => l.startsWith("[rankdoc"));
    check("rank", "the answering section ranks first", /Retry policy/.test(first ?? ""), `first hit: ${first}`);

    const cap = await s.call("ctx_search", { queries: ["caching"] });
    check("rank", "results are capped per source (<=2 per query by default)", (txt(cap).match(/\[rankdoc/g) ?? []).length <= 2, txt(cap).slice(0, 200));

    const wide = await s.call("ctx_search", { queries: ["caching"], per_query: 5 });
    check("rank", "per_query raises the cap", (txt(wide).match(/\[rankdoc/g) ?? []).length <= 5, txt(wide).slice(0, 120));
    check("rank", "per_query is bounded (999 does not explode)", (txt(await s.call("ctx_search", { queries: ["caching"], per_query: 999 })).match(/\[rankdoc/g) ?? []).length <= 6, "");
    check("rank", "limit=0 falls back to a sane default", /rankdoc|no match/.test(txt(await s.call("ctx_search", { queries: ["caching"], limit: 0 }))), "");
    check("rank", "negative numbers do not crash", !/failed/i.test(txt(await s.call("ctx_search", { queries: ["caching"], limit: -1, per_query: -1 }))), "");
  } catch (e) {
    check("rank", "ranking section completed", false, e?.stack ?? String(e));
  }
  s.child.kill();
}

/* ===================== 3. file edges ===================== */
head("ctx_execute_file · file edges");
{
  const work = fs.mkdtempSync(path.join(base, "files-"));
  fs.writeFileSync(path.join(work, "empty.txt"), "");
  fs.writeFileSync(path.join(work, "binary.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255, 254, 0, 65]));
  fs.writeFileSync(path.join(work, "with space.ts"), "export const spaced = 1;\n");
  fs.writeFileSync(path.join(work, "big-ish.txt"), "hello world\n".repeat(2000));
  const s = startServer(work, path.join(work, "store"));
  await s.init();
  try {
    const empty = await s.call("ctx_execute_file", { path: "empty.txt", language: "javascript", code: 'console.log("len=" + (content ?? "").length);' });
    check("files", "an empty file yields an empty string, not an error", /len=0/.test(txt(empty)), txt(empty).slice(0, 200));

    const bin = await s.call("ctx_execute_file", { path: "binary.bin", language: "javascript", code: 'console.log("bytes=" + Buffer.byteLength(content, "utf8"));' });
    check("files", "a binary file is read without crashing", /bytes=\d+/.test(txt(bin)), txt(bin).slice(0, 200));

    const spaced = await s.call("ctx_execute_file", { path: "with space.ts", language: "javascript", code: 'console.log("ok=" + /spaced/.test(content));' });
    check("files", "a path containing a space works", /ok=true/.test(txt(spaced)), txt(spaced).slice(0, 200));

    const dash = await s.call("ctx_execute_file", { path: "./big-ish.txt", language: "javascript", code: 'console.log("lines=" + content.trim().split("\\n").length);' });
    check("files", "a ./-prefixed path works", /lines=2000/.test(txt(dash)), txt(dash).slice(0, 200));

    const abs = await s.call("ctx_execute_file", { path: path.join(work, "big-ish.txt"), language: "javascript", code: 'console.log("abs-ok");' });
    check("files", "an absolute in-workspace path works", /abs-ok/.test(txt(abs)), txt(abs).slice(0, 200));

    const pythonFile = await s.call("ctx_execute_file", { path: "big-ish.txt", language: "python", code: 'print("py-len=" + str(len(content)))' });
    check("files", "the python preamble binds content too", /py-len=\d+/.test(txt(pythonFile)), txt(pythonFile).slice(0, 200));
  } catch (e) {
    check("files", "file section completed", false, e?.stack ?? String(e));
  }
  s.child.kill();
}

/* ===================== 4. TTL and GC ===================== */
head("Storage · TTL and garbage collection");
{
  const work = fs.mkdtempSync(path.join(base, "ttl-"));
  const store = path.join(work, "store");
  // A 1 ms retention window: everything written becomes stale immediately.
  const sFast = startServer(work, store, { CB_KB_TTL_MS: "1" });
  await sFast.init();
  await sFast.call("ctx_index", { source: "ephemeral", content: "# X\n\nsome content" });
  sFast.child.kill();
  await new Promise((r) => setTimeout(r, 400));

  const sAgain = startServer(work, store, { CB_KB_TTL_MS: "1" });
  await sAgain.init();
  try {
    const after = await sAgain.call("ctx_search", { queries: ["some content"] });
    check("ttl", "expired chunks are collected on open", /no match|0 chunk/.test(txt(after)), txt(after).slice(0, 200));

    const fresh = startServer(work, path.join(work, "store2"));
    await fresh.init();
    await fresh.call("ctx_index", { source: "keeper", content: "# Y\n\nretained content here" });
    const kept = await fresh.call("ctx_search", { queries: ["retained content"] });
    check("ttl", "a fresh chunk survives a reopen", /keeper/.test(txt(kept)), txt(kept).slice(0, 150));

    const cli = spawnSync(process.execPath, ["bin/cli.mjs", "purge", "--yes"], {
      cwd: root, encoding: "utf8",
      env: { ...process.env, CONTEXT_BUDGET_DIR: path.join(work, "store2"), CONTEXT_BUDGET_PROJECT: work },
    });
    check("ttl", "purge via CLI succeeds", cli.status === 0 && /purged/.test(cli.stdout), cli.stdout.slice(0, 150));
    const gone = await fresh.call("ctx_search", { queries: ["retained content"] });
    check("ttl", "the purged content is really gone from this process too", /no match/.test(txt(gone)), txt(gone).slice(0, 200));
    fresh.child.kill();
  } catch (e) {
    check("ttl", "ttl section completed", false, e?.stack ?? String(e));
  }
  sAgain.child.kill();
}

/* ===================== 5. hook payload abuse ===================== */
head("Hooks · payload abuse");
{
  const work = fs.mkdtempSync(path.join(base, "hookabuse-"));
  const store = path.join(work, "store");
  spawnSync(process.execPath, ["bin/cli.mjs", "setup", "--yes", "--hooks-only"], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, CONTEXT_BUDGET_DIR: store, CONTEXT_BUDGET_PROJECT: work },
  });
  const entry = (e) => path.join(root, "hooks", `${e}.mjs`);
  const run = (e, input, env = {}) => {
    const r = spawnSync(process.execPath, [entry(e)], {
      input, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, CONTEXT_BUDGET_DIR: store, CONTEXT_BUDGET_PROJECT: work, ...env },
    });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };

  const cases = [
    ["no preToolUse key", "PreToolUse", JSON.stringify({ hookName: "PreToolUse" })],
    ["null preToolUse", "PreToolUse", JSON.stringify({ hookName: "PreToolUse", preToolUse: null })],
    ["parameters is a string", "PreToolUse", JSON.stringify({ hookName: "PreToolUse", preToolUse: { toolName: "read_files", parameters: "oops" } })],
    ["toolName is a number", "PreToolUse", JSON.stringify({ hookName: "PreToolUse", preToolUse: { toolName: 7, parameters: {} } })],
    ["outer payload is an array", "PreToolUse", JSON.stringify([1, 2, 3])],
    ["outer payload is a string", "PreToolUse", JSON.stringify("hello")],
    ["deeply null", "PostToolUse", JSON.stringify({ hookName: "PostToolUse", postToolUse: { toolName: null, result: null } })],
    ["PreCompact with null fields", "PreCompact", JSON.stringify({ hookName: "PreCompact", preCompact: { taskId: null, contextRawPath: null, contextJsonPath: null, contextSize: "lots" } })],
  ];
  let bad = 0;
  for (const [label, event, input] of cases) {
    const r = run(event, input);
    let parsed = null;
    try { parsed = JSON.parse(r.out); } catch { /* below */ }
    const ok = r.status === 0 && parsed && parsed.cancel === false;
    if (!ok) { bad++; process.stdout.write(`      failed: ${label} -> status=${r.status} out=${String(r.out).slice(0, 80)} err=${String(r.err).slice(0, 80)}\n`); }
  }
  check("hookabuse", "8 malformed payloads all fail open with cancel:false", bad === 0, `${bad} failed`);

  const huge = JSON.stringify({ hookName: "PostToolUse", postToolUse: { toolName: "read_files", result: "z".repeat(4 * 1024 * 1024) } });
  const started = Date.now();
  const hr = run("PostToolUse", huge);
  const elapsed = Date.now() - started;
  check("hookabuse", "a 4 MB tool result is handled within the 30 s budget", hr.status === 0 && elapsed < 25_000, `${elapsed} ms, status ${hr.status}`);

  const nonUtf8 = spawnSync(process.execPath, [entry("PreToolUse")], {
    input: Buffer.from([0xff, 0xfe, 0x7b, 0x7d]), encoding: "utf8",
    env: { ...process.env, CONTEXT_BUDGET_DIR: store, CONTEXT_BUDGET_PROJECT: work },
  });
  check("hookabuse", "non-UTF8 stdin fails open", nonUtf8.status === 0 && JSON.parse(nonUtf8.stdout).cancel === false, nonUtf8.stdout);

  const cliHook = spawnSync(process.execPath, ["bin/cli.mjs", "hook", "precompact"], {
    cwd: root, encoding: "utf8",
    input: JSON.stringify({ hookName: "PreCompact", preCompact: { taskId: "x", contextSize: 1 } }),
    env: { ...process.env, CONTEXT_BUDGET_DIR: store, CONTEXT_BUDGET_PROJECT: work },
  });
  check("hookabuse", "the CLI hook bridge works", cliHook.status === 0 && JSON.parse(cliHook.stdout).cancel === false, cliHook.stdout + cliHook.stderr.slice(0, 120));
}

/* ===================== 6. unicode round trip ===================== */
head("Unicode · round trip through MCP");
{
  const work = fs.mkdtempSync(path.join(base, "uni-"));
  const s = startServer(work, path.join(work, "store"));
  await s.init();
  try {
    const zh = "会话记忆系统：压缩之前必须保存工作状态，否则丢失上下文。";
    const emoji = "状态 ✅ 完成 🎉 失败 ❌";
    await s.call("ctx_index", { source: "uni-zh", content: `# 中文标题\n\n${zh}\n\n# 表情\n\n${emoji}` });
    const f1 = await s.call("ctx_search", { queries: ["会话记忆"] });
    check("unicode", "CJK content round-trips through MCP", /会话记忆/.test(txt(f1)), txt(f1).slice(0, 200));
    const f2 = await s.call("ctx_search", { queries: ["表情"] });
    check("unicode", "an emoji-bearing section is retrievable", /状态/.test(txt(f2)) && /🎉/.test(txt(f2)), txt(f2).slice(0, 200));

    const exec = await s.call("ctx_execute", { language: "javascript", code: 'console.log("中文输出 ✅ " + Buffer.byteLength("🎉"));' });
    check("unicode", "CJK+emoji survive the sandbox boundary", /中文输出 ✅/.test(txt(exec)) && /4\s*$/.test(txt(exec).trim()), txt(exec).slice(0, 200));

    const file = path.join(work, "中文文件.txt");
    fs.writeFileSync(file, "中文文件内容\n", "utf8");
    const ef = await s.call("ctx_execute_file", { path: "中文文件.txt", language: "javascript", code: "console.log(content.trim());" });
    check("unicode", "a non-ASCII filename works", /中文文件内容/.test(txt(ef)), txt(ef).slice(0, 200));
  } catch (e) {
    check("unicode", "unicode section completed", false, e?.stack ?? String(e));
  }
  s.child.kill();
}

/* ===================== report ===================== */
const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${"=".repeat(62)}\n`);
for (const section of [...new Set(results.map((r) => r.section))]) {
  const inSection = results.filter((r) => r.section === section);
  const bad = inSection.filter((r) => !r.ok).length;
  process.stdout.write(`${bad ? "✖" : "✔"} ${section.padEnd(11)} ${inSection.length - bad}/${inSection.length}\n`);
}
process.stdout.write(`${"=".repeat(62)}\n${results.length - failed.length}/${results.length} checks passed\n`);
if (failed.length) {
  process.stdout.write("\nFAILURES:\n");
  for (const f of failed) process.stdout.write(`  [${f.section}] ${f.name}\n      ${String(f.detail).slice(0, 320).replace(/\n/g, "\n      ")}\n`);
}
fs.rmSync(base, { recursive: true, force: true });
if (failed.length) process.exitCode = 1;
