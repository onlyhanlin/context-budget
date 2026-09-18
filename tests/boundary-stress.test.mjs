/**
 * Boundary & stress tests for context-budget.
 *
 * Conventional tests cover the happy path; this file pushes every boundary the
 * codebase exposes: chunking loops, LIKE wildcards, byte-level truncation of
 * multi-byte UTF-8, megabyte-scale output caps, timeout races, concurrency,
 * deny-list false-positives/negatives and config-limit edge cases.
 *
 * Storage is isolated in a mkdtemp directory via CONTEXT_BUDGET_DIR /
 * CONTEXT_BUDGET_PROJECT so nothing touches a real user home. Network-free,
 * and every stress case is kept to the 1~2 second class.
 *
 * Known-defect cases are named with a [BUG-n] marker and assert the EXPECTED
 * correct behaviour, so they fail (and thereby prove the defect) until fixed.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";


const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-bnd-"));
process.env.CONTEXT_BUDGET_DIR = dir;
process.env.CONTEXT_BUDGET_PROJECT = dir;

const store = await import("../src/store.mjs");
const { run } = await import("../src/sandbox.mjs");
const { checkCommand, resolveInsideWorkspace } = await import("../src/security.mjs");
const tools = await import("../src/tools.mjs");
const { limits } = await import("../src/config.mjs"); // getters re-read env on every access
const {
  tokenizeForIndex,
  termsOf,
  buildMatchQuery,
  extractSnippet,
  estimateTokens,
} = await import("../src/text.mjs");

after(() => {
  store.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/* ============================================================ helpers */

/** Run chunkDocument inside a subprocess so a hang can be detected, not caught. */
function probeChunk({ maxChars, overlap, envPatch = {} }) {
  const call =
    maxChars === undefined
      ? ""
      : `, { maxChars: ${maxChars}, overlap: ${overlap} }`;
  const script =
    `import { chunkDocument } from ${JSON.stringify(new URL("../src/store.mjs", import.meta.url).href)};\n` +
    `const out = chunkDocument("a".repeat(1000)${call});\n` +
    `process.stdout.write("LEN=" + JSON.stringify(out.length));\n`;
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script], {
    timeout: 1500,
    encoding: "utf8",
    env: { ...process.env, ...envPatch },
  });
}

function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = had ? process.env[name] : undefined;
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try { return fn(); } finally {
    if (had) process.env[name] = prev;
    else delete process.env[name];
  }
}

/* ============================================================ A. chunkDocument */

test("chunkDocument: normal stepping produces contiguous non-overlapping coverage", () => {
  const body = "x".repeat(10000);
  const chunks = store.chunkDocument(body, { maxChars: 1000, overlap: 200 });
  assert.ok(chunks.length >= 10);
  for (const c of chunks) assert.ok(c.body.length <= 1000, "window must not exceed maxChars");
  // Consecutive windows must overlap by the requested amount.
  const b0 = chunks[0].body;
  const b1 = chunks[1].body;
  const overlapText = b0.slice(b0.length - 200);
  assert.ok(b1.startsWith(overlapText.slice(0, 100)), "windows should share an overlap region");
});

test("chunkDocument with tiny maxChars stays finite and correct", () => {
  const chunks = store.chunkDocument("y".repeat(500), { maxChars: 3, overlap: 1 });
  assert.ok(chunks.length >= 100);
  assert.ok(chunks.every((c) => c.body.length <= 3));
});

test("[BUG-1] chunkDocument must terminate when maxChars <= overlap (100/150)", () => {
  const r = probeChunk({ maxChars: 100, overlap: 150 });
  assert.equal(r.status, 0, `subprocess should finish; got status=${r.status} signal=${r.signal} — chunkDocument loop steps backwards by ${100 - 150} chars (store.mjs:177)`);
  assert.match(r.stdout ?? "", /^LEN=\d+/);
});

test("[BUG-1] chunkDocument must terminate when maxChars === overlap (100/100)", () => {
  const r = probeChunk({ maxChars: 100, overlap: 100 });
  assert.equal(r.status, 0, `subprocess should finish; got status=${r.status} signal=${r.signal} — loop step is 0 when maxChars === overlap (store.mjs:177)`);
  assert.match(r.stdout ?? "", /^LEN=\d+/);
});

test("[BUG-1] chunkDocument must terminate when overlap is configured above maxChars via env", () => {
  // A plain chunkDocument() with no options reads limits.chunkChars /
  // limits.chunkOverlap from the environment — the real-world trigger path.
  const r = probeChunk({ envPatch: { CB_CHUNK_CHARS: "100", CB_CHUNK_OVERLAP: "150" } });
  assert.equal(r.status, 0, `subprocess should finish; got status=${r.status} signal=${r.signal} — env-configured maxChars(100) <= overlap(150) hangs (store.mjs:177)`);
  assert.match(r.stdout ?? "", /^LEN=\d+/);
});

/* ============================================================ B. LIKE wildcards */


test("search treats '_' in a query literally (BUG-2 reproduction)", () => {
  store.index({ source: "like-und", content: "## X\n\nsomeXterm appears here (no underscore)" });
  // FTS5 sees "some_term" as two tokens (unicode61 splits on '_') and finds
  // nothing; the substring fallback then builds '%some_term%' where '_' is a
  // LIKE wildcard, so "someXterm" wrongly matches.
  const found = store.search(["some_term"]);
  assert.equal(
    found.results[0].matches.length,
    0,
    "query 'some_term' must NOT match 'someXterm'; runLikeSearch does not escape '_' (store.mjs:290)"
  );
  assert.ok(!found.results[0].partial);
});

test("search with an actual underscore still hits the literal content", () => {
  store.index({ source: "like-real", content: "## Y\n\nsome_term literally here." });
  const found = store.search(["some_term"]);
  assert.ok(found.results[0].matches.length >= 1);
});

test("search tokenisation strips '%' so a percent query degrades to its numeric part", () => {
  store.index({ source: "like-pct", content: "## Z\n\n100% complete marker" });
  const found = store.search(["100%"]);
  assert.match(found.results[0].query, /100%/);
  assert.deepEqual(found.results[0].terms, ["100"], "tokenizer drops '%'");
  assert.ok(found.results[0].matches.length >= 1);
});

test("source names with special characters are filterable by exact source match", () => {
  const src = "src%with_special/char";
  store.index({ source: src, content: "## S\n\nspecial-name-needle" });
  const hit = store.search(["special-name-needle"], { source: src });
  assert.equal(hit.results[0].matches.length, 1);
  const miss = store.search(["special-name-needle"], { source: src + "2" });
  assert.equal(miss.results[0].matches.length, 0);
});

/* ============================================================ C. UTF-8 truncation */

test("byte-level truncation never leaves a dangling U+FFFD in stdout", async () => {
  const res = await run({
    language: "javascript",
    code: 'process.stdout.write("你好".repeat(3000) + "👋".repeat(500) + "world")',
    maxOutputBytes: 2000,
  });
  assert.equal(res.truncated, true);
  assert.ok(!res.stdout.includes("\uFFFD"), "truncateUtf8 must strip the broken trailing codepoint");
  assert.ok(res.bytesOut <= 2000 + 64, `invariant exceeded: ${res.bytesOut}`);
  assert.ok(res.stdout.length > 0);
});

test("output exactly at maxOutputBytes is not flagged truncated", async () => {
  const res = await run({
    language: "javascript",
    code: 'process.stdout.write("x".repeat(1024))',
    maxOutputBytes: 1024,
  });
  assert.equal(res.truncated, false);
  assert.equal(res.stdoutBytesTotal, 1024);
});

test("[OBS-1] extreme max_output_bytes=1 still honours the cap but discards the notice", async () => {
  const res = await run({
    language: "javascript",
    code: 'console.log("你好👋世界 abc")',
    maxOutputBytes: 1,
  });
  assert.ok(res.bytesOut <= 1, "byte invariant must hold even for max_output_bytes=1");
  assert.equal(res.truncated, true);
  // Observation: the truncation notice itself is longer than 1 byte, so it is
  // cut away and the model receives a single newline / empty output.
  assert.notEqual(res.stdout, "", "model-facing output is a 1-byte remnant, not the notice");
});

test("reasonable truncation includes the notice and stays under the cap", async () => {
  const res = await run({
    language: "javascript",
    code: 'process.stdout.write("z".repeat(100000))',
    maxOutputBytes: 2048,
  });
  assert.equal(res.truncated, true);
  assert.ok(res.stdout.includes("truncated"), "notice should be attached when it fits");
  assert.ok(res.bytesOut <= 2048 + 64);
});

/* ============================================================ D. output pressure */

test("10 MB of output: total count exact, capture bounded, truncated flag set", async () => {
  const res = await run({
    language: "javascript",
    code: 'process.stdout.write("x".repeat(10 * 1024 * 1024))',
    maxOutputBytes: 8192,
  });
  assert.equal(res.stdoutBytesTotal, 10 * 1024 * 1024, "stdoutBytesTotal must be exact");
  assert.equal(res.truncated, true);
  const hardCap = Math.max(8192 * 3, 8192 + 64 * 1024);
  assert.ok(res.stdoutCaptured.length <= hardCap, `capture must be bounded by hardCap ${hardCap}`);
  assert.ok(res.bytesOut <= 8192 + 64);
});

test("30 MB total stays bounded under the 8 MB intent captureLimit", async () => {
  const res = await run({
    language: "javascript",
    code: 'process.stdout.write("y".repeat(30 * 1024 * 1024))',
    maxOutputBytes: 8192,
    captureLimit: 8 * 1024 * 1024,
  });
  assert.equal(res.stdoutBytesTotal, 30 * 1024 * 1024);
  assert.equal(res.truncated, true);
  assert.ok(res.stdoutCaptured.length <= 8 * 1024 * 1024, "capture limited to intent captureLimit");
  assert.ok(res.stdoutCaptured.length >= 8 * 1024 * 1024 - 65536, "capture should reach the hardCap");
});

test("output under the cap is neither truncated nor mislabelled", async () => {
  const res = await run({
    language: "javascript",
    code: 'process.stdout.write("k".repeat(1000))',
    maxOutputBytes: 8192,
  });
  assert.equal(res.truncated, false);
  assert.equal(res.stdoutBytesTotal, 1000);
  assert.equal(res.stdout, "k".repeat(1000));
});

/* ============================================================ E. timeout races */

test("timeoutMs=1 still resolves with a structured result (no hang)", async () => {
  const res = await run({
    language: "javascript",
    code: "await new Promise(r => setTimeout(r, 10000))",
    timeoutMs: 1,
  });
  assert.equal(typeof res.ok, "boolean");
  assert.equal(res.timedOut, true);
  assert.equal(res.ok, false);
  assert.ok(res.durationMs < 5000);
}, { timeout: 8000 });

test("stdout produced before a timeout survives into the result", async () => {
  const res = await run({
    language: "javascript",
    code: 'console.log("PREFIX-DATA"); await new Promise(r => setTimeout(r, 10000))',
    timeoutMs: 300,
  });
  assert.equal(res.timedOut, true);
  assert.ok(res.stdout.includes("PREFIX-DATA"), "flushed output before the kill must be returned");
});

test("a process that beats the timer reports not-timed-out", async () => {
  const res = await run({
    language: "javascript",
    code: 'console.log("fast-finish")',
    timeoutMs: 5000,
  });
  assert.equal(res.timedOut, false);
  assert.equal(res.exitCode, 0);
  assert.ok(res.stdout.includes("fast-finish"));
});

/* ============================================================ F. concurrency */

test("8 concurrent sandbox runs and 8 concurrent indexes are coherent", async () => {
  const runs = await Promise.all(
    Array.from({ length: 8 }, (_, i) => run({ language: "javascript", code: `console.log("job${i}-" + (${i} * ${i}))` }))
  );
  assert.ok(runs.every((r) => r.exitCode === 0), "all concurrent runs must exit 0");
  assert.ok(runs.every((r) => /^job\d-\d+$/.test(r.stdout.trim())));

  await Promise.all(
    Array.from({ length: 8 }, (_, i) => store.index({ source: `conc-${i}`, content: `## S${i}\n\nneedle-${i} content` }))
  );
  const found = store.search(Array.from({ length: 8 }, (_, i) => `needle-${i}`));
  assert.ok(found.results.every((r) => r.matches.length >= 1), "every concurrent index must be searchable");
});

test("concurrent ctx_index and ctx_search interleave without throwing", async () => {
  const ops = [];
  for (let i = 0; i < 6; i++) {
    ops.push(tools.ctxIndex({ source: `cx-${i}`, content: `## I${i}\n\ninterleave-needle-${i}` }));
  }
  for (let i = 0; i < 6; i++) {
    ops.push(tools.ctxSearch({ queries: [`interleave-needle-${i}`] }));
  }
  const results = await Promise.all(ops);
  assert.ok(results.every((r) => typeof r === "string" && r.length > 0));
});

test("ctx_batch runs 8 tasks at concurrency 8 and indexes every output", async () => {
  const text = await tools.ctxBatch({
    tasks: Array.from({ length: 8 }, (_, i) => ({ label: `bt-${i}`, command: `node -e "console.log(\\"batch-out-${i}\\")"` })),
    concurrency: 8,
    queries: ["batch-out-3"],
  });
  for (let i = 0; i < 8; i++) assert.ok(text.includes(`bt-${i}`), `label bt-${i} present`);
  assert.ok(text.includes("batch-out-3"), "query hit is surfaced");
  assert.ok(text.includes("Ask follow-ups with ctx_search"), "queries branch is reported");
});

/* ============================================================ G. security */

test("[BUG-3] plain commands containing power-control keywords must not be refused", () => {
  for (const cmd of ["cat shutdown.md", "ls reboot.cfg", "cat launchd/halt.example", "echo reboot later"]) {
    const v = checkCommand(cmd);
    assert.equal(v.allowed, true, `"${cmd}" is an ordinary command and must be allowed; rule /\\bshutdown\\b|\\breboot\\b|\\bhalt\\b/ fires on keywords in filenames (security.mjs:18)`);
  }
});

test("[BUG-4] the short flag -f on git push is caught as a force push", () => {
  const v = checkCommand("git push -f origin main");
  assert.equal(v.allowed, false, "git push -f is a force push; the deny rule only matches literal --force (security.mjs:21)");
});

test("rm -rf variants: root and home are refused, subdirs are allowed by design", () => {
  assert.equal(checkCommand("rm -rf /").allowed, false);
  assert.equal(checkCommand("rm -rf /").allowed, false); // repeated for clarity of symmetry
  assert.equal(checkCommand("rm -Rf /").allowed, false);
  assert.equal(checkCommand("rm -rf ~").allowed, false);
  assert.equal(checkCommand("rm -rf ~/").allowed, false);
  assert.equal(checkCommand("rm -rf /tmp").allowed, true, "subdir deletion is allowed (documented choice)");
  assert.equal(checkCommand("rm rf /").allowed, true, "malformed invocation is not recognised; not a real command");
});

test("[OBS-2] rm -rf . escapes the guard even though it deletes the workspace root", () => {
  const v = checkCommand("rm -rf .");
  assert.equal(v.allowed, false, "rm -rf . deletes the current (workspace) directory but the regex only matches '/' or '~' (security.mjs:13)");
});

test("resolveInsideWorkspace: relative, dotted, root forms", () => {
  const root = path.resolve("/ws");
  assert.equal(resolveInsideWorkspace(root, ".").ok, true);
  assert.equal(resolveInsideWorkspace(root, "./src/a.js").ok, true);
  assert.equal(resolveInsideWorkspace(root, "").ok, false);
  assert.equal(resolveInsideWorkspace(root, null).ok, false);
  assert.equal(resolveInsideWorkspace(root, "src/../../etc/passwd").ok, false);
});

test("resolveInsideWorkspace on win32 tolerates case and backslashes", () => {
  if (process.platform !== "win32") {
    assert.ok(true, "win32-specific — skipped");
    return;
  }
  const root = path.win32.join("C:\\", "Work", "App");
  assert.equal(resolveInsideWorkspace(root, path.win32.join("src", "a.js")).ok, true);
  assert.equal(resolveInsideWorkspace(root, "src\\..\\..\\out").ok, false);
  assert.equal(resolveInsideWorkspace("c:\\work\\app", "C:\\WORK\\APP\\x\\y").ok, true, "Windows paths compare case-insensitively");
  assert.equal(resolveInsideWorkspace(root, "C:\\Windows\\system32").ok, false);
});

test("git push --force is refused; --force-with-lease and plain push are allowed", () => {
  assert.equal(checkCommand("git push --force origin main").allowed, false);
  assert.equal(checkCommand("git push --force-with-lease origin main").allowed, true);
  assert.equal(checkCommand("git push origin main").allowed, true);
});

/* ============================================================ H. store pressure */

test("a ~1.5 MB document chunks into hundreds of FTS5 rows with sane accounting", () => {
  const big = "z".repeat(1024 * 1024 + 512 * 1024);
  const info = store.index({ source: "big-doc", content: big });
  assert.ok(info.chunks > 500, `expected >500 chunks, got ${info.chunks}`);
  assert.equal(info.bytes, big.length);
  assert.ok(info.indexedTokens > 0);
  const rows = store.open().prepare("SELECT COUNT(*) AS n FROM chunks WHERE source = ?").get("big-doc");
  assert.equal(Number(rows.n), info.chunks, "chunk table count must match the index return");
  assert.ok(store.listSources().some((s) => s.source === "big-doc" && s.bytes === big.length));
  assert.ok(store.purge() >= info.chunks, "purge clears the big index");
});

test("re-indexing a large source fully replaces the previous chunks", () => {
  store.index({ source: "replace-doc", content: "# A\n\n" + "a".repeat(300000) });
  const before = Number(store.open().prepare("SELECT COUNT(*) AS n FROM chunks WHERE source = ?").get("replace-doc").n);
  store.index({ source: "replace-doc", content: "# B\n\nsmall" });
  const after = Number(store.open().prepare("SELECT COUNT(*) AS n FROM chunks WHERE source = ?").get("replace-doc").n);
  assert.ok(before > 10);
  assert.equal(after, 1, "re-index must delete prior chunks, not accumulate");
  const found = store.search(["b"]);
  assert.ok(found.results[0].matches.some((m) => m.source === "replace-doc"));
});

test("title is truncated to 300 chars, source to 200; body is stored whole", () => {
  const longTitle = "T".repeat(900);
  const longSource = "S".repeat(500);
  // No heading in the content, so chunk.title stays empty and the passed-in
  // title is used — the slicing of title/source is what we are testing.
  const info = store.index({ source: longSource, content: "body-needle-" + "b".repeat(5000), title: longTitle });
  assert.equal(info.source.length, 200);
  const row = store.open().prepare("SELECT title, body, length(body) AS blen FROM chunks WHERE source = ?").get(info.source);
  assert.equal(row.title.length, 300, "title must be sliced to 300");
  const total = store.open().prepare("SELECT COALESCE(SUM(length(body)),0) AS blen FROM chunks WHERE source = ?").get(info.source);
  assert.ok(Number(total.blen) >= Buffer.byteLength("body-needle-" + "b".repeat(5000)), "aggregate body bytes must be preserved (body is never truncated)");
});

test("search answers 50 queries in one call", () => {
  for (let i = 0; i < 5; i++) store.index({ source: `many-q-${i}`, content: `## M${i}\n\nqword-${i} unique-token-${i}` });
  const queries = Array.from({ length: 50 }, (_, i) => `qword-${i % 5}`);
  const found = store.search(queries);
  assert.equal(found.results.length, 50);
  assert.ok(found.results.every((r) => typeof r.query === "string"));
  assert.ok(found.results.some((r) => r.matches.length >= 1));
});

/* ============================================================ I. search extremes */

test("single-character ASCII and CJK queries are handled without throwing", () => {
  store.index({ source: "single-char", content: "## 记忆\n\nshe sells sea shells" });
  const ascii = store.search(["s"]);
  assert.equal(typeof ascii.results[0].matches.length, "number");
  const cjk = store.search(["记"]);
  assert.ok(cjk.results[0].matches.length >= 1, "single CJK character must still match");
});

test("punctuation-only queries produce no error and no matches", () => {
  const found = store.search(["?!.,;:()"]);
  assert.equal(found.results[0].query, "?!.,;:()");
  assert.deepEqual(found.results[0].terms, []);
  assert.equal(found.results[0].matches.length, 0);
});

test("[BUG-5] a 1 MB single-term query returns a result instead of throwing", () => {
  store.index({ source: "long-query-base", content: "## H\n\nhello world this is a normal document." });
  const mega = "a".repeat(1024 * 1024);
  assert.doesNotThrow(
    () => store.search([mega]),
    "runLikeSearch is not guarded: a 1 MB LIKE pattern throws 'LIKE or GLOB pattern too complex' (store.mjs:336)"
  );
}, { timeout: 15000 });

test("[BUG-5] a query with 30000 distinct terms returns a result instead of throwing", () => {
  const many = Array.from({ length: 30000 }, (_, i) => "t" + i).join(" ");
  assert.doesNotThrow(
    () => store.search([many]),
    "buildMatchQuery/runLikeSearch build an expression whose size exceeds SQLite limits; the error escapes store.search (store.mjs:319-344)"
  );
}, { timeout: 15000 });

test("extractSnippet over many hits stays within a sane time budget", () => {
  const terms = Array.from({ length: 20 }, (_, i) => `needle${i}`);
  const chunk = terms.join(" ") + " ";
  const body = chunk.repeat(400); // 20 terms × 400 occurrences = 8000 hits
  const t0 = Date.now();
  const snippet = extractSnippet(body, terms, 700);
  const dt = Date.now() - t0;
  assert.ok(dt < 3000, `8000-hit window scan took ${dt}ms (O(hits²) loop) — got ${snippet.length} chars`);
  assert.ok(snippet.length > 0);
});

test("extractSnippet hits the 400-occurrence guard without runaway growth", () => {
  const body = ("x".repeat(498) + "needle").repeat(400); // exactly 400 hits
  const snippet = extractSnippet(body, ["needle"], 700);
  assert.ok(snippet.includes("needle"));
  assert.ok(snippet.length <= 800);
});

/* ============================================================ J. text extremes */

test("tokenizeForIndex / estimateTokens tolerate extreme inputs", () => {
  assert.equal(tokenizeForIndex(12345), "12345");
  assert.equal(tokenizeForIndex("🎉🎉🎉"), "", "emoji are separators, not tokens");
  assert.equal(tokenizeForIndex("   \t  "), "");
  assert.equal(estimateTokens("🎉".repeat(1000)) > 0, true);
  assert.equal(estimateTokens(123), 1);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
  assert.equal(estimateTokens(" "), 1); // ceil(1/4)
});

test("tokenizeForIndex on a 1 MB latin run stays a single token and is fast", () => {
  const t0 = Date.now();
  const out = tokenizeForIndex("w".repeat(1024 * 1024));
  assert.equal(out, "w".repeat(1024 * 1024));
  assert.ok(Date.now() - t0 < 2000);
});

test("termsOf caps nothing but stays correct on 10k distinct terms", () => {
  const many = Array.from({ length: 10000 }, (_, i) => `k${i}`).join(" ");
  const terms = termsOf(many);
  assert.equal(terms.length, 10000);
});

test("buildMatchQuery doubles embedded quotes but stays parseable", () => {
  const q = buildMatchQuery('say "hello"');
  assert.equal(q, '"say" AND "hello"');
});

/* ============================================================ L. tool layer */

test("ctx_execute refuses a denied shell command and returns the policy reason", async () => {
  const out = await tools.ctxExecute({ language: "shell", code: "rm -rf /" });
  assert.ok(out.includes("refused by context-budget policy"));
  const ok = await tools.ctxExecute({ language: "javascript", code: "console.log('tool-hi')" });
  assert.ok(ok.includes("exit 0"));
  assert.ok(ok.includes("tool-hi"));
});

test("ctx_execute requires non-blank code", async () => {
  const r1 = await tools.ctxExecute({ code: "" });
  assert.ok(r1.includes('"code" is required'));
  const r2 = await tools.ctxExecute({ code: "   " });
  assert.ok(r2.includes('"code" is required'));
});

test("ctx_execute honours a tiny max_output_bytes end to end", async () => {
  const out = await tools.ctxExecute({
    language: "javascript",
    code: 'console.log("x".repeat(50000))',
    max_output_bytes: 1024,
  });
  assert.ok(out.includes("output truncated"));
});

test("ctx_execute_file refuses paths outside the workspace", async () => {
  const out = await tools.ctxExecuteFile({ path: "../../../etc/passwd", code: "console.log('x')" });
  assert.ok(out.includes("outside the workspace"));
});

test("ctx_execute_file refuses files above the max_read_bytes ceiling", async () => {
  const big = path.join(dir, "too-big.txt");
  fs.writeFileSync(big, "x".repeat(4096), "utf8");
  const saved = process.env.CB_MAX_READ_BYTES;
  process.env.CB_MAX_READ_BYTES = "1024"; // limits.maxReadBytes is read synchronously inside the call
  let out;
  try {
    out = await tools.ctxExecuteFile({ path: "too-big.txt", code: "console.log(1)" });
  } finally {
    if (saved === undefined) delete process.env.CB_MAX_READ_BYTES;
    else process.env.CB_MAX_READ_BYTES = saved;
  }
  assert.ok(out.includes("ceiling"), `expected ceiling refusal, got: ${out}`);
});

test("ctx_execute_file runs a small real file", async () => {
  const small = path.join(dir, "small.txt");
  fs.writeFileSync(small, "alpha beta", "utf8");
  const out = await tools.ctxExecuteFile({
    path: "small.txt",
    language: "javascript",
    code: 'console.log(content.split(" ").length)',
  });
  assert.ok(out.includes("exit 0"));
  assert.ok(out.includes("2"), "file content bound to `content`");
});

test("ctx_index validates source and content", async () => {
  const r1 = await tools.ctxIndex({ source: "", content: "x" });
  assert.ok(r1.includes('"source"'));
  const r2 = await tools.ctxIndex({ source: "s-x", content: "   " });
  assert.ok(r2.includes("empty"));
  const ok = await tools.ctxIndex({ source: "tool-index", content: "## H\n\nhello from tools" });
  assert.ok(ok.includes("tool-index"));
  assert.ok(ok.includes("chunk"));
});

test("ctx_search enforces the 12-query cap and non-empty requirement", async () => {
  const tooMany = await tools.ctxSearch({ queries: Array.from({ length: 13 }, (_, i) => `q${i}`) });
  assert.ok(tooMany.includes("at most 12"));
  const empty = await tools.ctxSearch({ queries: [] });
  assert.ok(empty.includes("non-empty"));
  const ok = await tools.ctxSearch({ queries: ["hello"] });
  assert.ok(ok.includes("knowledge base"));
});

test("ctx_batch caps at 24 tasks, rejects empty commands and empty batches", async () => {
  const none = await tools.ctxBatch({ tasks: [] });
  assert.ok(none.includes('"tasks"'));
  const bad = await tools.ctxBatch({ tasks: [{ label: "a", command: "   " }] });
  assert.ok(bad.includes("empty command"));
  const many = await tools.ctxBatch({
    tasks: Array.from({ length: 26 }, (_, i) => ({ label: `cap-${i}`, command: 'node -e "console.log(1)"' })),
    concurrency: 4,
  });
  assert.ok(many.includes("DROPPED"));
  assert.ok(many.includes("at most 24"));
}, { timeout: 30000 });

test("ctx_stats returns a report string", async () => {
  const s = await tools.ctxStats({});
  assert.ok(typeof s === "string");
  assert.ok(s.includes("context-budget"));
  assert.ok(s.includes("bytes processed"));
});

/* ============================================================ K. config limits */

test("config limits fall back for 0 / negative / NaN / Infinity / empty", () => {
  for (const bad of ["0", "-5", "NaN", "Infinity", "-Infinity", "", "abc"]) {
    withEnv("CB_MAX_OUTPUT_BYTES", bad, () => {
      assert.equal(limits.maxOutputBytes, 8192, `CB_MAX_OUTPUT_BYTES=${JSON.stringify(bad)} must fall back to 8192`);
    });
  }
});

test("config limits accept huge finite values but reject non-finite ones", () => {
  withEnv("CB_CHUNK_CHARS", "1e308", () => {
    assert.equal(limits.chunkChars, 1e308, "finite huge value is accepted");
  });
  withEnv("CB_CHUNK_CHARS", "1e400", () => {
    assert.equal(limits.chunkChars, 1800, "overflowing value is rejected as non-finite");
  });
});

test("config limits trim surrounding whitespace", () => {
  withEnv("CB_TIMEOUT_MS", "  5000  ", () => {
    assert.equal(limits.timeoutMs, 5000);
  });
});

test("chunkOverlap=0 falls back to 200; overlap equal to chunkChars is reachable and handled elsewhere", () => {
  withEnv("CB_CHUNK_OVERLAP", "0", () => {
    assert.equal(limits.chunkOverlap, 200);
  });
  withEnv("CB_CHUNK_OVERLAP", "1800", () => {
    assert.equal(limits.chunkOverlap, 1800);
  });
});
/* ============================================================ M. post-fix regression */

test("regression: BUG-1 fix — hard-window steps are non-zero for every overlap value", () => {
  // maxChars === 1 with overlap === 1 (max step clamp = 1) must terminate
  // and produce at most one char per chunk.
  const r = probeChunk({ maxChars: 1, overlap: 1 });
  assert.equal(r.status, 0, `maxChars=1, overlap=1 must terminate; got status=${r.status} signal=${r.signal}`);
  const len = Number((r.stdout ?? "").match(/^LEN=(\d+)/)?.[1]);
  assert.ok(Number.isInteger(len) && len > 0, `expected a finite chunk count, got ${len}`);
  // overlap === 0 is impossible through the env fallback (falls back to 200),
  // but a default-options call must still terminate when overlap is huge.
  const r2 = probeChunk({ maxChars: 50, overlap: 500 });
  assert.equal(r2.status, 0, `maxChars=50, overlap=500 must terminate; got status=${r2.status} signal=${r2.signal}`);
});

test("regression: BUG-2 fix — LIKE wildcards in terms are matched literally after escaping", () => {
  store.index({ source: "like-esc", content: "## E\n\nvalue_is_100% actual literal" });
  // '_' must be literal: "value_is" must NOT match "valueXis".
  store.index({ source: "like-esc2", content: "## F\n\nvalueXis has no underscore" });
  const exact = store.search(["value_is_100%"]);
  assert.ok(exact.results[0].matches.some((m) => m.source === "like-esc"), "literal underscore+percent must hit its own source");
  assert.ok(!exact.results[0].matches.some((m) => m.source === "like-esc2"), "wildcard-like query must not leak into another source");
  // A bare '%' in the query collapses to its numeric part by the tokenizer.
  const pct = store.search(["100%"]);
  assert.ok(pct.results[0].matches.length >= 1);
});

test("regression: BUG-3 fix — power-control keywords only match as command verbs", () => {
  assert.equal(checkCommand("echo hi && shutdown now").allowed, false);
  assert.equal(checkCommand("cd /tmp || halt").allowed, false);
  assert.equal(checkCommand("echo error 2>&1 | reboot -f").allowed, false);
  assert.equal(checkCommand("sudo reboot now").allowed, false);
  assert.equal(checkCommand("grep -r shutdown docs/").allowed, true);
  assert.equal(checkCommand("node scripts/reboot-check.js").allowed, true);
  assert.equal(checkCommand("cat halt.txt notes").allowed, true);
});

test("regression: BUG-4 fix — force-push matrix covers short, long and lease forms", () => {
  assert.equal(checkCommand("git push -f origin main").allowed, false);
  assert.equal(checkCommand("git push origin main -f").allowed, false);
  assert.equal(checkCommand("git push --force origin main").allowed, false);
  assert.equal(checkCommand("git push --force-with-lease=refs/heads/main origin main").allowed, true);
  assert.equal(checkCommand("git push --force-with-lease origin main").allowed, true);
  assert.equal(checkCommand("git pull -f").allowed, true, "pull is not push");
  assert.equal(checkCommand("git fetch --force origin main").allowed, true, "fetch is not push");
});

test("regression: OBS-2 fix — rm -rf on '.' and '..' is refused, subdirs stay allowed", () => {
  assert.equal(checkCommand("rm -rf .").allowed, false);
  assert.equal(checkCommand("rm -rf ./").allowed, false);
  assert.equal(checkCommand("rm -Rfv ..").allowed, false);
  assert.equal(checkCommand("rm -rf ../src").allowed, true, "a sibling sub-directory is an explicit target, not the workspace root");
  assert.equal(checkCommand("rm -rf src").allowed, true);
  assert.equal(checkCommand("rm -f ./-rf-file").allowed, true, "a filename containing -rf without -r is not a recursive delete");
});