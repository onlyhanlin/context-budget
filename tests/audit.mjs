#!/usr/bin/env node
/**
 * Full audit: every tool, every CLI command, every hook, plus the edge cases
 * most likely to be broken. Designed to FAIL loudly rather than confirm.
 *
 *   node tests/audit.mjs [--section=mcp,cli,hooks]
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const install = await import(pathToFileURL(path.join(root, "hooks", "install.mjs")).href);
const extHookFile = (name) => install.extensionHookFile(name, process.platform);
const work = fs.mkdtempSync(path.join(os.tmpdir(), "cb-audit-"));
const store = path.join(work, "store");

/* --------------------------------------------------------------- fixture */
fs.mkdirSync(path.join(work, "src", "nested"), { recursive: true });
fs.writeFileSync(path.join(work, "src", "a.ts"), "export const a = 1;\n// TODO one\n");
fs.writeFileSync(path.join(work, "src", "b.ts"), "export const b = 2;\n// TODO two\n// TODO three\n");
fs.writeFileSync(path.join(work, "src", "nested", "c.ts"), "export const c = 3;\n");
fs.writeFileSync(path.join(work, "big.txt"), "line\n".repeat(40000));
fs.writeFileSync(path.join(work, "unicode.txt"), "中文内容：会话记忆与上下文预算。\n".repeat(400));
fs.writeFileSync(path.join(work, "python-sample.py"), "print('ok')\n");
fs.writeFileSync(path.join(work, "ts-sample.ts"), "const n: number = 41;\nconsole.log('ts says ' + (n + 1));\n");
fs.mkdirSync(path.join(work, "adir"), { recursive: true });

const results = [];
function check(section, name, ok, detail = "") {
  results.push({ section, name, ok: Boolean(ok), detail });
  process.stdout.write(`  ${ok ? "✔" : "✖"} ${name}${ok || !detail ? "" : "\n      → " + String(detail).slice(0, 400).replace(/\n/g, "\n      ")}}\n`);
}
const head = (t) => process.stdout.write(`\n${t}\n`);

/* ------------------------------------------------------------ MCP client */
const server = spawn(process.execPath, ["bin/cli.mjs", "mcp"], {
  cwd: root,
  env: { ...process.env, CONTEXT_BUDGET_DIR: store, CONTEXT_BUDGET_PROJECT: work },
  stdio: ["pipe", "pipe", "pipe"],
});
let serverErr = "";
server.stderr.on("data", (c) => { serverErr += c.toString("utf8"); });

let nextId = 1;
const pending = new Map();
let buf = "";
server.stdout.on("data", (chunk) => {
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
function rpc(method, params, timeoutMs = 60_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`timeout ${method}`)); }, timeoutMs);
  });
}
const call = (name, args) => rpc("tools/call", { name, arguments: args });
const txt = (r) => (r?.content ?? []).map((c) => c.text ?? "").join("\n");
const isError = (r) => r?.isError === true;

function cli(args, opts = {}) {
  return spawnSync(process.execPath, ["bin/cli.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    input: opts.input,
    env: { ...process.env, CONTEXT_BUDGET_DIR: store, CONTEXT_BUDGET_PROJECT: opts.project ?? work, ...(opts.env ?? {}) },
  });
}

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "audit", version: "1" } });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");

  /* ============================================================== MCP ==== */
  head("MCP · tool surface");
  const list = await rpc("tools/list", {});
  const names = (list?.tools ?? []).map((t) => t.name);
  check("mcp", "7 tools listed", names.length === 7, names.join(", "));
  check("mcp", "every tool has object inputSchema", (list?.tools ?? []).every((t) => t.inputSchema?.type === "object"));
  check("mcp", "every tool has a non-trivial description", (list?.tools ?? []).every((t) => (t.description ?? "").length > 80));

  head("MCP · ctx_execute");
  const js = await call("ctx_execute", { language: "javascript", code: "console.log(1 + 1)" });
  check("mcp", "javascript runs", txt(js).trim().endsWith("2"), txt(js).slice(0, 200));

  const ts = await call("ctx_execute", { language: "typescript", code: "const n: number = 41; console.log('ts=' + (n + 1));" });
  check("mcp", "typescript runs", /ts=42/.test(txt(ts)), txt(ts).slice(0, 300));

  const py = await call("ctx_execute", { language: "python", code: "print('py=' + str(6*7))" });
  check("mcp", "python runs", /py=42/.test(txt(py)), txt(py).slice(0, 300));

  const sh = await call("ctx_execute", { language: "shell", code: "echo sh=$((6*7))" });
  check("mcp", "shell runs", /sh=42/.test(txt(sh)), txt(sh).slice(0, 300));

  const badLang = await call("ctx_execute", { language: "cobol", code: "DISPLAY 'HI'." });
  check("mcp", "unknown language explains itself", /no runtime available/.test(txt(badLang)), txt(badLang).slice(0, 200));

  const thrown = await call("ctx_execute", { language: "javascript", code: "throw new Error('boom-marker');" });
  check("mcp", "a throwing script surfaces stderr", /boom-marker/.test(txt(thrown)), txt(thrown).slice(0, 300));
  check("mcp", "a throwing script includes the stack", /at .*script\.mjs/.test(txt(thrown)), txt(thrown).slice(0, 300));

  const noCode = await call("ctx_execute", { language: "javascript", code: "   " });
  check("mcp", "empty code is rejected politely", /code.*is required/i.test(txt(noCode)), txt(noCode).slice(0, 200));

  const denied = await call("ctx_execute", { language: "shell", code: "rm -rf /" });
  check("mcp", "deny-list refuses rm -rf /", /refused by context-budget policy/.test(txt(denied)), txt(denied).slice(0, 200));

  const timedOut = await call("ctx_execute", { language: "javascript", code: "await new Promise(r => setTimeout(r, 20000));", timeout_ms: 800 });
  check("mcp", "timeout is enforced and reported", /TIMED OUT/.test(txt(timedOut)), txt(timedOut).slice(0, 200));

  const capped = await call("ctx_execute", {
    language: "javascript",
    code: 'process.stdout.write("z".repeat(300000));',
    max_output_bytes: 1200,
  });
  const cappedText = txt(capped);
  check("mcp", "max_output_bytes caps the payload", Buffer.byteLength(cappedText, "utf8") < 2000, `${Buffer.byteLength(cappedText, "utf8")} B`);
  check("mcp", "truncation is announced", /truncated/.test(cappedText), cappedText.slice(0, 160));

  const cjk = await call("ctx_execute", {
    language: "javascript",
    code: 'process.stdout.write("会话记忆".repeat(4000));',
    max_output_bytes: 900,
  });
  const cjkText = txt(cjk);
  check("mcp", "CJK truncation does not produce mojibake", !cjkText.includes("\uFFFD") && /会话记忆/.test(cjkText), cjkText.slice(0, 120));

  head("MCP · ctx_execute with intent");
  const intent = await call("ctx_execute", {
    language: "javascript",
    code: [
      'const parts = [];',
      'for (let i = 0; i < 4000; i++) parts.push("## Section " + i + "\\n" + "filler ".repeat(20));',
      'parts.push("## NEEDLE\\nThe answer is 42 and it lives here.");',
      'console.log(parts.join("\\n\\n"));',
    ].join("\n"),
    intent: "the answer",
  });
  const intentText = txt(intent);
  check("mcp", "intent filtering searches the WHOLE output, not just the prefix", /answer is 42/.test(intentText), intentText.slice(0, 400));
  check("mcp", "intent filtering reports what is searchable", /searchable/.test(intentText), intentText.slice(0, 400));

  head("MCP · ctx_execute_file");
  const ef = await call("ctx_execute_file", { path: "src/b.ts", language: "javascript", code: 'console.log("todos=" + (content.match(/TODO/g)||[]).length);' });
  check("mcp", "reads a workspace file into `content`", /todos=2/.test(txt(ef)), txt(ef).slice(0, 200));

  const efMissing = await call("ctx_execute_file", { path: "nope.ts", language: "javascript", code: "console.log(1)" });
  check("mcp", "missing file is reported", /cannot read/.test(txt(efMissing)), txt(efMissing).slice(0, 200));

  const efEscape = await call("ctx_execute_file", { path: "../../../etc/passwd", language: "javascript", code: "console.log(1)" });
  check("mcp", "path escape is refused", /outside the workspace/.test(txt(efEscape)), txt(efEscape).slice(0, 200));

  const efDir = await call("ctx_execute_file", { path: "adir", language: "javascript", code: "console.log(1)" });
  check("mcp", "a directory is rejected", /not a regular file/.test(txt(efDir)), txt(efDir).slice(0, 200));

  const efCjk = await call("ctx_execute_file", { path: "unicode.txt", language: "javascript", code: "console.log(content.length + '|' + content.slice(0,8));" });
  check("mcp", "reads UTF-8 content correctly", /中文内容/.test(txt(efCjk)) && /6800/.test(txt(efCjk)), txt(efCjk).slice(0, 200));

  head("MCP · ctx_batch");
  const batch = await call("ctx_batch", {
    tasks: [
      { label: "todos", command: "git grep -n TODO -- src || true" },
      { label: "listing", command: "ls src" },
    ],
    queries: ["how many TODO comments"],
  });
  const batchText = txt(batch);
  check("mcp", "batch runs commands and answers a query", /todos/.test(batchText) && /TODO/.test(batchText), batchText.slice(0, 300));
  check("mcp", "batch reports per-task status", /- todos: exit 0/.test(batchText), batchText.slice(0, 200));

  const batchNoQuery = await call("ctx_batch", { tasks: [{ label: "echo", command: "echo hello-batch" }] });
  check("mcp", "batch without queries returns a digest", /hello-batch/.test(txt(batchNoQuery)), txt(batchNoQuery).slice(0, 200));

  const batchEmpty = await call("ctx_batch", { tasks: [] });
  check("mcp", "batch with no tasks is rejected", /provide .*tasks/i.test(txt(batchEmpty)), txt(batchEmpty).slice(0, 200));

  const batchBadTask = await call("ctx_batch", { tasks: [{ label: "oops", command: "   " }] });
  check("mcp", "batch flags an empty command", /empty command/.test(txt(batchBadTask)), txt(batchBadTask).slice(0, 200));

  const batchDenied = await call("ctx_batch", { tasks: [{ label: "danger", command: "rm -rf /" }] });
  check("mcp", "batch honours the deny-list per task", /REFUSED/.test(txt(batchDenied)), txt(batchDenied).slice(0, 250));

  const batchCwd = await call("ctx_batch", { tasks: [{ label: "escape", command: "pwd", cwd: "../../.." }] });
  check("mcp", "batch refuses a cwd outside the workspace", /outside the workspace/.test(txt(batchCwd)), txt(batchCwd).slice(0, 250));

  const batchConc = await call("ctx_batch", {
    tasks: [1, 2, 3, 4].map((n) => ({ label: `job${n}`, command: `node -e "console.log('job${n}')"` })),
    concurrency: 4,
  });
  const concText = txt(batchConc);
  check("mcp", "concurrency > 1 preserves every result", [1, 2, 3, 4].every((n) => concText.includes(`job${n}`)), concText.slice(0, 300));

  head("MCP · ctx_index / ctx_search");
  const idx = await call("ctx_index", { source: "audit-doc", content: "# Alpha\n\nThe cache is invalidated by TTL.\n\n# Beta\n\nRetries use exponential backoff." });
  check("mcp", "index reports chunks", /indexed "audit-doc"/.test(txt(idx)), txt(idx).slice(0, 200));

  const emptyIdx = await call("ctx_index", { source: "empty", content: "   " });
  check("mcp", "indexing empty content is rejected", /nothing to index/.test(txt(emptyIdx)), txt(emptyIdx).slice(0, 200));

  const noSource = await call("ctx_index", { content: "hello" });
  check("mcp", "index without a source is rejected", /source.*is required/i.test(txt(noSource)), txt(noSource).slice(0, 200));

  const s1 = await call("ctx_search", { queries: ["cache ttl", "retries"] });
  check("mcp", "search answers multiple queries in one call", /### cache ttl/.test(txt(s1)) && /### retries/.test(txt(s1)), txt(s1).slice(0, 300));

  const s2 = await call("ctx_search", { queries: ["zzz-nonexistent-zzz"] });
  check("mcp", "a miss says so instead of inventing", /no match/.test(txt(s2)), txt(s2).slice(0, 200));

  const s3 = await call("ctx_search", { queries: [] });
  check("mcp", "empty query list is rejected", /non-empty array/.test(txt(s3)), txt(s3).slice(0, 200));

  const s4 = await call("ctx_search", { queries: ["cache"], source: "somewhere-else" });
  check("mcp", "source filter excludes other sources", /no match/.test(txt(s4)), txt(s4).slice(0, 200));

  const s5 = await call("ctx_search", { queries: ["cache ttl backoff"], mode: "or" });
  check("mcp", "mode=or broadens the match", /Alpha|Beta/.test(txt(s5)), txt(s5).slice(0, 200));

  await call("ctx_index", { source: "audit-zh", content: "# 会话记忆\n\n压缩之前必须保存工作状态。\n\n# 沙箱\n\n只有 stdout 越过边界。" });
  const s6 = await call("ctx_search", { queries: ["会话记忆"] });
  check("mcp", "2-character CJK query matches", /audit-zh/.test(txt(s6)), txt(s6).slice(0, 250));

  head("MCP · ctx_stats / ctx_doctor");
  const stats = await call("ctx_stats", {});
  const statsText = txt(stats);
  check("mcp", "stats reports calls and kept-out bytes", /calls\s+\d+/.test(statsText) && /kept out/.test(statsText), statsText.slice(0, 300));
  const toBytes = (match) =>
    match ? Number(match[1]) * (match[2] === "KB" ? 1024 : match[2] === "MB" ? 1048576 : 1) : null;
  const processed = toBytes(/bytes processed\s+([\d.]+) (B|KB|MB)/.exec(statsText));
  const returned = toBytes(/bytes returned\s+([\d.]+) (B|KB|MB)/.exec(statsText));
  check(
    "mcp",
    "returned bytes never exceed processed bytes",
    processed === null || returned === null || returned <= processed,
    `processed=${processed} returned=${returned}`
  );
  check("mcp", "accounting is not trivially zero", (processed ?? 0) > 0, statsText.slice(0, 200));

  const statsSession = await call("ctx_stats", { session: true });
  check("mcp", "stats --session scope works", /THIS SESSION/.test(txt(statsSession)), txt(statsSession).slice(0, 200));

  const doc = await call("ctx_doctor", {});
  check("mcp", "doctor reports runtimes and cline installs", /node:sqlite/.test(txt(doc)) && /cline/.test(txt(doc)), txt(doc).slice(0, 300));
} catch (error) {
  check("mcp", "no unhandled exception in the MCP section", false, error?.stack ?? String(error));
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 200));
}

/* ================================================================ CLI ==== */
head("CLI");
const ver = cli(["version"]);
check("cli", "version", ver.stdout.trim() === "0.1.0", ver.stdout.trim());
check("cli", "help is printed with no args", /Usage|context-budget setup/.test(cli([]).stdout));

const doc = cli(["doctor"]);
check("cli", "doctor runs", /node:sqlite/.test(doc.stdout), doc.stdout.slice(0, 200));
check("cli", "doctor does not print the SQLite warning", !/ExperimentalWarning/.test(doc.stderr ?? ""), (doc.stderr ?? "").slice(0, 200));

const st = cli(["stats", "--json"]);
let parsed = null;
try { parsed = JSON.parse(st.stdout); } catch { /* ignore */ }
check("cli", "stats --json is valid JSON", parsed !== null && typeof parsed.lifetime?.calls === "number", st.stdout.slice(0, 200));

const idxFile = cli(["index", "cli-doc", path.join(work, "src", "a.ts")]);
check("cli", "index from a file", /indexed "cli-doc"/.test(idxFile.stdout), idxFile.stdout.slice(0, 200));

const idxStdin = cli(["index", "stdin-doc", "-"], { input: "# Piped\n\ncontent from stdin" });
check("cli", "index from stdin", /indexed "stdin-doc"/.test(idxStdin.stdout), idxStdin.stdout.slice(0, 200));

const src = cli(["sources"]);
check("cli", "sources lists indexed docs", /cli-doc/.test(src.stdout) && /stdin-doc/.test(src.stdout), src.stdout.slice(0, 300));

const srch = cli(["search", "piped content"]);
check("cli", "search finds indexed content", /stdin-doc/.test(srch.stdout), srch.stdout.slice(0, 250));

check("cli", "purge without --yes refuses", /--yes/.test(cli(["purge"]).stderr));
check("cli", "uninstall without --yes refuses", /--yes/.test(cli(["uninstall"]).stderr));
check("cli", "index without args explains usage", /usage/.test(cli(["index"]).stderr));

/* ------------------------------------------------------------- setup */
head("CLI · setup / uninstall");
const demo = fs.mkdtempSync(path.join(os.tmpdir(), "cb-audit-demo-"));
const demoStore = path.join(demo, "store");

const dry = cli(["setup"], { project: demo, env: { CONTEXT_BUDGET_DIR: demoStore } });
check("cli", "setup is a dry run by default", /DRY RUN/.test(dry.stdout), dry.stdout.slice(-200));
check("cli", "dry run writes no hook files", !fs.existsSync(path.join(demo, ".clinerules")), "found .clinerules");

const applied = cli(["setup", "--yes", "--hooks-only"], { project: demo, env: { CONTEXT_BUDGET_DIR: demoStore } });
check("cli", "setup --yes writes the hook files", fs.existsSync(path.join(demo, ".clinerules", "hooks", extHookFile("pretooluse"))));
check("cli", "setup writes all four hook events",
  ["pretooluse", "posttooluse", "precompact", "taskresume"].every((n) => fs.existsSync(path.join(demo, ".clinerules", "hooks", extHookFile(n)))),
  fs.readdirSync(path.join(demo, ".clinerules", "hooks")).join(", "));
check("cli", "setup verification passes", /\[x\] hook entry exists: pretooluse/.test(applied.stdout), applied.stdout.slice(-400));

const second = cli(["setup", "--hooks-only"], { project: demo, env: { CONTEXT_BUDGET_DIR: demoStore } });
check("cli", "a second setup is a no-op", /0 to create, 0 to update/.test(second.stdout), second.stdout.slice(-200));

const userFile = path.join(demo, ".clinerules", "hooks", "MyOwnHook");
fs.writeFileSync(userFile, "#!/usr/bin/env bash\necho '{}'\n");
const un = cli(["uninstall", "--yes"], { project: demo, env: { CONTEXT_BUDGET_DIR: demoStore } });
check("cli", "uninstall removes generated files", !fs.existsSync(path.join(demo, ".clinerules", "hooks", extHookFile("pretooluse"))));
check("cli", "uninstall keeps a user-written hook", fs.existsSync(userFile), "user hook was deleted");
check("cli", "uninstall reports the removal count", /removed 9 generated file/.test(un.stdout), un.stdout.slice(0, 200));

/* ------------------------------------------------------------- repair */
const demo2 = fs.mkdtempSync(path.join(os.tmpdir(), "cb-audit-demo2-"));
cli(["setup", "--yes", "--hooks-only"], { project: demo2, env: { CONTEXT_BUDGET_DIR: path.join(demo2, "store") } });
const target = path.join(demo2, ".cline", "hooks", "PreToolUse.sh");
fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace(/context-budget:entry=.*/, "context-budget:entry=" + path.join(demo2, "gone", "pretooluse.mjs")));
const fixed = cli(["doctor", "--fix"], { project: demo2, env: { CONTEXT_BUDGET_DIR: path.join(demo2, "store") } });
check("cli", "doctor --fix repairs a stale launcher", /repaired 1 stale launcher/.test(fixed.stdout), fixed.stdout.slice(-400));

fs.rmSync(demo, { recursive: true, force: true });
fs.rmSync(demo2, { recursive: true, force: true });

/* ============================================================== HOOKS ==== */
head("Hooks (real launcher processes)");
const hookWork = fs.mkdtempSync(path.join(os.tmpdir(), "cb-audit-hooks-"));
const hookStore = path.join(hookWork, "store");
fs.writeFileSync(path.join(hookWork, "fat.txt"), "x".repeat(80000));
cli(["setup", "--yes", "--hooks-only"], { project: hookWork, env: { CONTEXT_BUDGET_DIR: hookStore } });

function hook(event, payload, env = {}) {
  const res = spawnSync(process.execPath, [path.join(root, "hooks", `${event}.mjs`)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CONTEXT_BUDGET_DIR: hookStore, CONTEXT_BUDGET_PROJECT: hookWork, ...env },
  });
  if (res.status !== 0) return { __error: res.stderr || `exit ${res.status}` };
  try { return JSON.parse(res.stdout); } catch { return { __error: `unparseable: ${res.stdout.slice(0, 100)}` }; }
}

const pre = hook("PreToolUse", { hookName: "PreToolUse", preToolUse: { toolName: "execute_command", parameters: { command: "npm test" } } });
check("hooks", "extension payload shape is understood", pre.contextModification?.includes("ctx_batch"), JSON.stringify(pre).slice(0, 250));
check("hooks", "output carries cancel and contextModification", pre.cancel === false && typeof pre.contextModification === "string");

const mods = hook("PreToolUse", { hookName: "PreToolUse", preToolUse: { toolName: "read_files", parameters: { path: path.join(hookWork, "fat.txt") } } });
check("hooks", "a large read is nudged toward ctx_execute_file", mods.contextModification?.includes("ctx_execute_file"), JSON.stringify(mods).slice(0, 250));

const editor = hook("PreToolUse", { hookName: "PreToolUse", preToolUse: { toolName: "editor", parameters: { path: "a.ts" } } });
check("hooks", "the editor is never touched", editor.cancel === false && editor.contextModification === undefined, JSON.stringify(editor));

const post = hook("PostToolUse", { hookName: "PostToolUse", postToolUse: { toolName: "read_files", result: "y".repeat(60000), success: true } });
check("hooks", "PostToolUse nudges on a huge result", post.contextModification?.includes("ctx_execute"), JSON.stringify(post).slice(0, 250));

const postSmall = hook("PostToolUse", { hookName: "PostToolUse", postToolUse: { toolName: "read_files", result: "tiny", success: true } });
check("hooks", "PostToolUse stays quiet on a small result", postSmall.contextModification === undefined, JSON.stringify(postSmall));

const fetchDefault = hook("PreToolUse", { hookName: "PreToolUse", preToolUse: { toolName: "fetch_web_content", parameters: { url: "https://example.com/a" } } });
check("hooks", "fetch defaults to a nudge, not a block", fetchDefault.cancel === false && fetchDefault.contextModification?.includes("ctx_execute"), JSON.stringify(fetchDefault).slice(0, 200));

const fetchOff = hook("PreToolUse", { hookName: "PreToolUse", preToolUse: { toolName: "fetch_web_content", parameters: { url: "https://example.com/b" } } }, { CONTEXT_BUDGET_FETCH: "off" });
check("hooks", "CONTEXT_BUDGET_FETCH=off is silent", fetchOff.cancel === false && fetchOff.contextModification === undefined);

const hookOff = hook("PreToolUse", { hookName: "PreToolUse", preToolUse: { toolName: "fetch_web_content", parameters: {} } }, { CONTEXT_BUDGET_HOOKS: "off" });
check("hooks", "CONTEXT_BUDGET_HOOKS=off disables routing", hookOff.cancel === false && hookOff.contextModification === undefined);

const garbage = spawnSync(process.execPath, [path.join(root, "hooks", "pretooluse.mjs")], { input: "not json at all", encoding: "utf8", env: { ...process.env, CONTEXT_BUDGET_DIR: hookStore } });
check("hooks", "malformed stdin fails open", garbage.status === 0 && JSON.parse(garbage.stdout).cancel === false, garbage.stdout);

const emptyStdin = spawnSync(process.execPath, [path.join(root, "hooks", "pretooluse.mjs")], { input: "", encoding: "utf8", env: { ...process.env, CONTEXT_BUDGET_DIR: hookStore } });
check("hooks", "empty stdin fails open", emptyStdin.status === 0 && JSON.parse(emptyStdin.stdout).cancel === false, emptyStdin.stdout);

/* compaction */
const hist = path.join(hookWork, "history.txt");
fs.writeFileSync(hist, [
  '{"type":"ask","ask":"followup","text":"rename src/old.ts to src/new.ts"}',
  '{"type":"say","say":"tool","text":"Error: ENOENT src/old.ts"}',
].join("\n"));
const pc = hook("PreCompact", { hookName: "PreCompact", taskId: "t1", preCompact: { taskId: "t1", contextSize: 91, compactionStrategy: "auto-condense", contextRawPath: hist } });
check("hooks", "PreCompact captures without injecting", pc.cancel === false && pc.contextModification === undefined, JSON.stringify(pc).slice(0, 200));

const tr = hook("TaskResume", { hookName: "TaskResume", taskId: "t1" });
check("hooks", "TaskResume restores the card", tr.contextModification?.includes("rename src/old.ts"), JSON.stringify(tr).slice(0, 300));
check("hooks", "the card is wrapped for the model", /<session_knowledge>/.test(tr.contextModification ?? ""));

const tr2 = hook("TaskResume", { hookName: "TaskResume", taskId: "t1" });
check("hooks", "the card is only handed back once", tr2.contextModification === undefined, JSON.stringify(tr2).slice(0, 200));

const pcEmpty = hook("PreCompact", { hookName: "PreCompact", preCompact: { taskId: "t2", contextSize: 50 } });
check("hooks", "PreCompact with no files saves nothing", pcEmpty.cancel === false && pcEmpty.contextModification === undefined);
check("hooks", "PreCompact with no files leaves no pending card", hook("TaskResume", { hookName: "TaskResume" }).contextModification === undefined);

fs.rmSync(hookWork, { recursive: true, force: true });

/* ============================================================= REPORT ==== */
const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${"=".repeat(62)}\n`);
for (const section of [...new Set(results.map((r) => r.section))]) {
  const inSection = results.filter((r) => r.section === section);
  const bad = inSection.filter((r) => !r.ok).length;
  process.stdout.write(`${bad ? "✖" : "✔"} ${section.padEnd(8)} ${inSection.length - bad}/${inSection.length}\n`);
}
process.stdout.write(`${"=".repeat(62)}\n`);
process.stdout.write(`${results.length - failed.length}/${results.length} checks passed\n`);
if (failed.length) {
  process.stdout.write("\nFAILURES:\n");
  for (const f of failed) process.stdout.write(`  [${f.section}] ${f.name}\n      ${String(f.detail).slice(0, 400).replace(/\n/g, "\n      ")}\n`);
}
fs.rmSync(work, { recursive: true, force: true });
if (failed.length) process.exitCode = 1;
