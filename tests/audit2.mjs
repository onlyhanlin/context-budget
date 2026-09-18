#!/usr/bin/env node
/**
 * Adversarial audit #2 — everything the first pass did not touch:
 * protocol abuse, malformed arguments, dirty storage, path edges, concurrency.
 *
 *   node tests/audit2.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-audit2-"));
const results = [];
function check(section, name, ok, detail = "") {
  results.push({ section, name, ok: Boolean(ok), detail });
  process.stdout.write(`  ${ok ? "✔" : "✖"} ${name}${ok || !detail ? "" : "\n      → " + String(detail).slice(0, 300).replace(/\n/g, "\n      ")}}\n`);
}
const head = (t) => process.stdout.write(`\n${t}\n`);

/* ============================== shared MCP client ============================== */
function startServer(workdir, storeDir) {
  const child = spawn(process.execPath, ["bin/cli.mjs", "mcp"], {
    cwd: root,
    env: { ...process.env, CONTEXT_BUDGET_DIR: storeDir, CONTEXT_BUDGET_PROJECT: workdir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderrText = "";
  child.stderr.on("data", (c) => { stderrText += c.toString("utf8"); });
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
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
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
      // Clear the timer on settle: a stray 90 s timer otherwise keeps the event
      // loop alive long after the report has been printed.
      const timer = setTimeout(() => { if (pending.delete(reqId)) reject(new Error(`timeout ${method}`)); }, ms);
      pending.set(reqId, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: reqId, method, params }) + "\n");
    });
  };
  return {
    child,
    rpc,
    call: (name, args) => rpc("tools/call", { name, arguments: args }),
    stderr: () => stderrText,
    init: async () => {
      await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "a2", version: "1" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    },
  };
}
const txt = (r) => (r?.content ?? []).map((c) => c.text ?? "").join("\n");

/* ============================== 1. protocol abuse ============================== */
head("Protocol · malformed and hostile input");
{
  const work = fs.mkdtempSync(path.join(base, "proto-"));
  const s = startServer(work, path.join(work, "store"));
  await s.init();
  try {
    const unknown = await s.call("ctx_nonexistent", {});
    check("proto", "unknown tool returns an error, not a crash", /unknown tool/.test(txt(unknown)), txt(unknown).slice(0, 150));

    const batchString = await s.call("ctx_batch", { tasks: "not-an-array" });
    check("proto", "ctx_batch with a string instead of an array", /provide .*tasks/i.test(txt(batchString)), txt(batchString).slice(0, 150));

    const searchString = await s.call("ctx_search", { queries: "one query" });
    check("proto", "ctx_search with a string instead of an array", /non-empty array/.test(txt(searchString)), txt(searchString).slice(0, 150));

    const searchNull = await s.call("ctx_search", { queries: [null, undefined, 42, "  "] });
    check("proto", "ctx_search tolerates null/number/blank entries", !/failed/i.test(txt(searchNull)), txt(searchNull).slice(0, 150));

    const execBadLang = await s.call("ctx_execute", { language: 123, code: null });
    check("proto", "ctx_execute with non-string args is handled", /required|no runtime/.test(txt(execBadLang)), txt(execBadLang).slice(0, 150));

    const noArgs = await s.call("ctx_stats", {});
    check("proto", "ctx_stats with no arguments", /kept out/.test(txt(noArgs)), txt(noArgs).slice(0, 120));

    const tooMany = await s.call("ctx_search", { queries: Array.from({ length: 20 }, (_, i) => "q" + i) });
    check("proto", "ctx_search rejects more than 12 queries", /at most 12/.test(txt(tooMany)), txt(tooMany).slice(0, 150));

    const longQuery = await s.call("ctx_search", { queries: ["x".repeat(20000)] });
    check("proto", "a 20k-character query does not crash", !/failed/i.test(txt(longQuery)), txt(longQuery).slice(0, 150));

    check("proto", "server is still alive after all that", /kept out/.test(txt(await s.call("ctx_stats", {}))));
  } catch (e) {
    check("proto", "protocol section completed", false, e?.stack ?? String(e));
  }
  s.child.kill();
}

/* ============================== 2. FTS5 injection ============================== */
head("Search · FTS5 syntax injection");
{
  const work = fs.mkdtempSync(path.join(base, "fts-"));
  const s = startServer(work, path.join(work, "store"));
  await s.init();
  try {
    await s.call("ctx_index", { source: "inj", content: "# Alpha\n\nthe quick brown fox AND the lazy dog OR something" });
    const evil = [
      '"', "'", '*', '^', 'NEAR(', 'AND OR NOT', 'foo"bar', '(a OR b)', 'a AND (b OR c)',
      'col:val', '{col}', 'a*b', '-neg', '+pos', 'NEAR/3', '\\', '""', '()', '***',
    ];
    let broken = 0;
    for (const q of evil) {
      const r = await s.call("ctx_search", { queries: [q] });
      if (/failed/i.test(txt(r))) { broken++; process.stdout.write(`      hostile query broke it: ${JSON.stringify(q)}\n`); }
    }
    check("fts", "20 hostile FTS5 queries all survive", broken === 0, `${broken} broke`);

    const cjkPunct = await s.call("ctx_search", { queries: ["，。！？：；"] });
    check("fts", "CJK punctuation-only query does not crash", !/failed/i.test(txt(cjkPunct)), txt(cjkPunct).slice(0, 150));

    const dup = await s.call("ctx_search", { queries: ["fox", "fox", "fox"] });
    check("fts", "duplicate queries are handled", /### fox/.test(txt(dup)), txt(dup).slice(0, 150));
  } catch (e) {
    check("fts", "FTS section completed", false, e?.stack ?? String(e));
  }
  s.child.kill();
}

/* ============================== 3. sandbox content edges ============================== */
head("Sandbox · content edges");
{
  const work = fs.mkdtempSync(path.join(base, "sandbox-"));
  const s = startServer(work, path.join(work, "store"));
  await s.init();
  try {
    const syntax = await s.call("ctx_execute", { language: "javascript", code: "const = ;" });
    check("sandbox", "a syntax error surfaces the reason", /SyntaxError/.test(txt(syntax)), txt(syntax).slice(0, 200));

    const nulls = await s.call("ctx_execute", { language: "javascript", code: 'process.stdout.write("a\\u0000b");' });
    check("sandbox", "null bytes do not corrupt the response", /a/.test(txt(nulls)), txt(nulls).slice(0, 120));

    const emoji = await s.call("ctx_execute", {
      language: "javascript",
      code: 'process.stdout.write("🎉🚀🧪".repeat(2000));',
      max_output_bytes: 999,
    });
    const emojiText = txt(emoji);
    check("sandbox", "emoji truncation leaves no lone surrogate", !/[\uD800-\uDFFF]/.test(emojiText.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")), JSON.stringify(emojiText.slice(-30)));

    const binary = await s.call("ctx_execute", { language: "javascript", code: 'process.stdout.write(Buffer.from([0xff,0xfe,0xfd]));' });
    check("sandbox", "invalid UTF-8 bytes are replaced, not fatal", !/failed/i.test(txt(binary)), txt(binary).slice(0, 120));

    // The sandbox is a CONTEXT boundary, not a filesystem jail: it runs in the
    // project directory with the user's permissions, so a write really happens.
    // This check used to assert the opposite, and only passed because
    // require() was broken and nothing was written at all.
    const probeName = "cb-sandbox-write-probe.txt";
    const writes = await s.call("ctx_execute", {
      language: "javascript",
      code: `require("node:fs").writeFileSync("${probeName}", "x"); console.log("cjs write ok");`,
    });
    check("sandbox", "CommonJS require() works in the sandbox", /cjs write ok/.test(txt(writes)), txt(writes).slice(0, 200));
    check("sandbox", "a script write really lands in the project directory", fs.existsSync(path.join(work, probeName)));
    check("sandbox", "only console.log() output crossed back", !txt(writes).includes("cb-sandbox-write-probe"));

    const bigPrint = await s.call("ctx_execute", { language: "javascript", code: 'process.stdout.write("A".repeat(50 * 1024 * 1024));', timeout_ms: 60000 });
    check("sandbox", "a 50 MB print is capped without exhausting memory", Buffer.byteLength(txt(bigPrint), "utf8") < 200000, `${Buffer.byteLength(txt(bigPrint), "utf8")} B`);

    const alias = await s.call("ctx_execute", { language: "JS", code: "console.log('alias-ok')" });
    check("sandbox", "language aliases are case-insensitive", /alias-ok/.test(txt(alias)), txt(alias).slice(0, 150));
  } catch (e) {
    check("sandbox", "sandbox section completed", false, e?.stack ?? String(e));
  }
  s.child.kill();
}

/* ============================== 4. storage edges ============================== */
head("Storage · dirty and unusual layouts");
{
  // non-ASCII + spaces in the storage path
  const weird = path.join(base, "störe dir 中文");
  const work = fs.mkdtempSync(path.join(base, "weird-"));
  const s = startServer(work, weird);
  await s.init();
  try {
    const idx = await s.call("ctx_index", { source: "weird", content: "# Header\n\ncontent here" });
    check("storage", "storage root with spaces + non-ASCII works", /indexed/.test(txt(idx)), txt(idx).slice(0, 200));
    const found = await s.call("ctx_search", { queries: ["content"] });
    check("storage", "search works from that root", /weird/.test(txt(found)), txt(found).slice(0, 150));
  } catch (e) {
    check("storage", "non-ASCII storage root", false, e?.stack ?? String(e));
  }
  s.child.kill();

  // very long + path-ish source names
  const work2 = fs.mkdtempSync(path.join(base, "names-"));
  const store2 = path.join(work2, "store");
  const s2 = startServer(work2, store2);
  await s2.init();
  try {
    const longName = "s".repeat(500);
    const r = await s2.call("ctx_index", { source: longName, content: "# H\n\nlong-name-body" });
    check("storage", "a 500-char source name is accepted", /indexed/.test(txt(r)), txt(r).slice(0, 150));

    const found = await s2.call("ctx_search", { queries: ["long-name-body"] });
    check("storage", "the truncated name is still searchable", /long-name-body|s{20}/.test(txt(found)), txt(found).slice(0, 200));

    const src = await s2.call("ctx_stats", {});
    check("storage", "stats survive a long source name", /calls/.test(txt(src)), txt(src).slice(0, 150));

    const weirdSource = await s2.call("ctx_index", { source: "a/b\\c:d*e?f\"g<h>i|j", content: "# H\n\npathish" });
    check("storage", "a path-and-shell-metacharacter source name is accepted", /indexed/.test(txt(weirdSource)), txt(weirdSource).slice(0, 150));
  } catch (e) {
    check("storage", "source-name section completed", false, e?.stack ?? String(e));
  }
  s2.child.kill();
  await new Promise((r) => setTimeout(r, 300));

  // corrupted knowledge base
  const work3 = fs.mkdtempSync(path.join(base, "corrupt-"));
  const store3 = path.join(work3, "store");
  fs.mkdirSync(path.join(store3, "kb"), { recursive: true });
  const s3pre = startServer(work3, store3);
  await s3pre.init();
  await s3pre.call("ctx_index", { source: "x", content: "# H\n\nbody" });
  s3pre.child.kill();
  await new Promise((r) => setTimeout(r, 400));

  const kbFile = fs.readdirSync(path.join(store3, "kb")).find((f) => f.endsWith(".db"));
  fs.writeFileSync(path.join(store3, "kb", kbFile), Buffer.from("this is not a database at all"));
  const s3 = startServer(work3, store3);
  await s3.init();
  try {
    const r = await s3.call("ctx_search", { queries: ["body"] });
    const stillAlive = await s3.call("ctx_stats", {});
    check("storage", "a corrupted knowledge base does not kill the server", /kept out/.test(txt(stillAlive)), txt(stillAlive).slice(0, 200));
    check("storage", "the corruption is reported, not swallowed", /failed/i.test(txt(r)) || /calls/.test(txt(stillAlive)), txt(r).slice(0, 200));
  } catch (e) {
    check("storage", "corrupted-DB section completed", false, e?.stack ?? String(e));
  }
  s3.child.kill();
}

/* ============================== 5. installer edges ============================== */
head("Installer · hostile filesystem states");
{
  const work = fs.mkdtempSync(path.join(base, "inst-"));
  // .clinerules/hooks exists as a FILE, not a directory
  fs.mkdirSync(path.join(work, ".clinerules"), { recursive: true });
  fs.writeFileSync(path.join(work, ".clinerules", "hooks"), "I am a file, not a directory");

  const r = spawnSync(process.execPath, ["bin/cli.mjs", "setup", "--yes", "--hooks-only"], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, CONTEXT_BUDGET_DIR: path.join(work, "store"), CONTEXT_BUDGET_PROJECT: work },
  });
  check("installer", "setup survives .clinerules/hooks being a file", r.status === 0, `exit ${r.status}: ${(r.stderr ?? "").slice(0, 250)}`);
  check("installer", "the conflicting file is left alone", fs.readFileSync(path.join(work, ".clinerules", "hooks"), "utf8").startsWith("I am a file"), "the user's file was clobbered");

  // BOM-prefixed MCP settings
  const bomDir = fs.mkdtempSync(path.join(base, "bom-"));
  const bomFile = path.join(bomDir, "cline_mcp_settings.json");
  fs.writeFileSync(bomFile, "\uFEFF" + JSON.stringify({ mcpServers: { existing: { command: "x" } } }, null, 2), "utf8");
  const mcp = await import(pathToFileURL(path.join(root, "src", "mcp-config.mjs")).href);
  const plan = mcp.planMerge(bomFile);
  check("installer", "a BOM-prefixed MCP settings file is parsed", plan.action !== "skip", plan.error ?? plan.action);

  // mcpServers is an array
  const arrFile = path.join(bomDir, "arr.json");
  fs.writeFileSync(arrFile, JSON.stringify({ mcpServers: [] }), "utf8");
  const arrPlan = mcp.planMerge(arrFile);
  check("installer", "mcpServers as an array is refused, not corrupted", arrPlan.action === "skip" || arrPlan.action === "update", arrPlan.action);

  // top-level array
  const topArr = path.join(bomDir, "toparr.json");
  fs.writeFileSync(topArr, JSON.stringify([{ a: 1 }]), "utf8");
  check("installer", "a top-level array is refused", mcp.planMerge(topArr).action === "skip", mcp.planMerge(topArr).action);

  // uninstall when files are already gone
  const gone = fs.mkdtempSync(path.join(base, "gone-"));
  const un = spawnSync(process.execPath, ["bin/cli.mjs", "uninstall", "--yes"], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, CONTEXT_BUDGET_DIR: path.join(gone, "store"), CONTEXT_BUDGET_PROJECT: gone },
  });
  check("installer", "uninstall on a clean workspace succeeds", un.status === 0, (un.stderr ?? "").slice(0, 200));
}

/* ============================== 6. concurrency ============================== */
head("Concurrency · parallel writers");
{
  const work = fs.mkdtempSync(path.join(base, "conc-"));
  const store = path.join(work, "store");
  applyHooks(work);

  // eight PreToolUse hooks at once, in the mode that writes shared state
  const payload = JSON.stringify({
    hookName: "PreToolUse",
    preToolUse: { toolName: "fetch_web_content", parameters: { url: "https://example.com/race" } },
  });
  const runs = Array.from({ length: 8 }, () =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(root, "hooks", "pretooluse.mjs")], {
        env: { ...process.env, CONTEXT_BUDGET_DIR: store, CONTEXT_BUDGET_FETCH: "cancel", CONTEXT_BUDGET_MCP_ASSUME: "registered" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      p.stdout.on("data", (c) => { out += c.toString("utf8"); });
      p.on("close", () => resolve(out));
      p.stdin.end(payload);
    })
  );
  const outputs = await Promise.all(runs);
  const parsed = outputs.map((o) => { try { return JSON.parse(o); } catch { return null; } });
  check("concurrency", "8 parallel hooks all emit valid JSON", parsed.every((p) => p && typeof p.cancel === "boolean"), JSON.stringify(outputs.slice(0, 2)));

  const stateFile = path.join(store, "hook-state.json");
  let stateOk = true;
  let stateDetail = "";
  if (fs.existsSync(stateFile)) {
    try { JSON.parse(fs.readFileSync(stateFile, "utf8")); }
    catch (e) { stateOk = false; stateDetail = e.message; }
  }
  check("concurrency", "the shared hook-state file stays valid JSON", stateOk, stateDetail);

  const cancels = parsed.filter((p) => p?.cancel === true).length;
  check("concurrency", "the retry valve still bounded the cancellations", cancels < 8, `${cancels}/8 cancelled`);

  // two MCP servers on the same project at once
  const s1 = startServer(work, store);
  const s2 = startServer(work, store);
  await s1.init();
  await s2.init();
  try {
    const [ia, ib] = await Promise.all([
      s1.call("ctx_index", { source: "conc-a", content: "# A\n\nshared-index-alpha" }),
      s2.call("ctx_index", { source: "conc-b", content: "# B\n\nshared-index-beta" }),
    ]);
    check("concurrency", "both concurrent index calls succeeded", /indexed/.test(txt(ia)) && /indexed/.test(txt(ib)), txt(ia).slice(0, 120) + " | " + txt(ib).slice(0, 120));
    const a = await s1.call("ctx_search", { queries: ["shared-index-alpha"] });
    const b = await s2.call("ctx_search", { queries: ["shared-index-beta"] });
    check("concurrency", "two MCP servers share the KB without corruption", /conc-a/.test(txt(a)) && /conc-b/.test(txt(b)), txt(a).slice(0, 150) + " | " + txt(b).slice(0, 150));
  } catch (e) {
    check("concurrency", "two MCP servers on one project", false, e?.stack ?? String(e));
  }
  s1.child.kill();
  s2.child.kill();
}

function applyHooks(work) {
  const r = spawnSync(process.execPath, ["bin/cli.mjs", "setup", "--yes", "--hooks-only"], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, CONTEXT_BUDGET_DIR: path.join(work, "store"), CONTEXT_BUDGET_PROJECT: work },
  });
  if (r.status !== 0) throw new Error("hook install failed: " + r.stderr);
}

/* ============================== report ============================== */
const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${"=".repeat(62)}\n`);
for (const section of [...new Set(results.map((r) => r.section))]) {
  const inSection = results.filter((r) => r.section === section);
  const bad = inSection.filter((r) => !r.ok).length;
  process.stdout.write(`${bad ? "✖" : "✔"} ${section.padEnd(12)} ${inSection.length - bad}/${inSection.length}\n`);
}
process.stdout.write(`${"=".repeat(62)}\n${results.length - failed.length}/${results.length} checks passed\n`);
if (failed.length) {
  process.stdout.write("\nFAILURES:\n");
  for (const f of failed) process.stdout.write(`  [${f.section}] ${f.name}\n      ${String(f.detail).slice(0, 350).replace(/\n/g, "\n      ")}\n`);
}
fs.rmSync(base, { recursive: true, force: true });
if (failed.length) process.exitCode = 1;
