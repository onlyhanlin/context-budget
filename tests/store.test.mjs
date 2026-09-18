import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-store-"));
process.env.CONTEXT_BUDGET_DIR = dir;
process.env.CONTEXT_BUDGET_PROJECT = dir;

const store = await import("../src/store.mjs");

after(() => {
  store.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("chunkDocument splits on headings and keeps code fences intact", () => {
  const doc = [
    "# Title",
    "intro text",
    "## Alpha",
    "alpha body",
    "```js",
    "// ## not-a-heading",
    "const x = 1;",
    "```",
    "## Beta",
    "beta body",
  ].join("\n");
  const chunks = store.chunkDocument(doc);
  const titles = chunks.map((c) => c.title);
  assert.ok(titles.includes("Alpha"));
  assert.ok(titles.includes("Beta"));
  const alpha = chunks.find((c) => c.title === "Alpha");
  assert.ok(alpha.body.includes("const x = 1;"), "code fence must survive chunking");
  assert.ok(!alpha.body.includes("beta body"));
});

test("chunkDocument windows documents with no headings", () => {
  const chunks = store.chunkDocument("z".repeat(5000), { maxChars: 1000, overlap: 100 });
  assert.ok(chunks.length >= 5);
  assert.ok(chunks.every((c) => c.body.length <= 1600));
});

test("index then search finds content and reports the source", () => {
  const info = store.index({
    source: "doc-en",
    content: "# Cache\n\nThe cache is invalidated by TTL.\n\n## Retry\n\nRetries use exponential backoff.",
  });
  assert.ok(info.chunks >= 1);
  const found = store.search(["cache ttl"]);
  const hits = found.results[0].matches;
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].source, "doc-en");
  assert.ok(hits[0].snippet.toLowerCase().includes("cache"));
});

test("chinese content is searchable (CJK tokenisation)", () => {
  store.index({ source: "doc-zh", content: "## 会话记忆\n\n压缩之前必须保存工作状态，否则会丢失上下文。" });
  const found = store.search(["会话记忆"]);
  assert.ok(found.results[0].matches.length >= 1, "2-character CJK query must match");
  assert.equal(found.results[0].matches[0].source, "doc-zh");
});

test("re-indexing the same source replaces its chunks", () => {
  store.index({ source: "doc-swap", content: "## One\n\nalpha" });
  store.index({ source: "doc-swap", content: "## Two\n\nbeta" });
  const found = store.search(["alpha"]);
  assert.equal(found.results[0].matches.length, 0);
  const beta = store.search(["beta"]);
  assert.equal(beta.results[0].matches[0].source, "doc-swap");
});

test("per-source dedup limits results per source", () => {
  store.index({
    source: "doc-dedup",
    content: Array.from({ length: 6 }, (_, i) => `## Section ${i}\n\nneedle appears here ${i}`).join("\n\n"),
  });
  const found = store.search(["needle"], { limit: 10, perQuery: 2 });
  const fromDedup = found.results[0].matches.filter((m) => m.source === "doc-dedup");
  assert.ok(fromDedup.length <= 2, "at most 2 hits per source");
});

test("source filter restricts the search", () => {
  store.index({ source: "only-here", content: "## X\n\nunique-token-xyz" });
  const filtered = store.search(["unique-token-xyz"], { source: "somewhere-else" });
  assert.equal(filtered.results[0].matches.length, 0);
  const hit = store.search(["unique-token-xyz"], { source: "only-here" });
  assert.equal(hit.results[0].matches.length, 1);
});

test("substring fallback finds partial identifiers", () => {
  store.index({ source: "doc-partial", content: "## Hooks\n\nuseEffectWithCleanup is exported." });
  const found = store.search(["useEff"]);
  assert.ok(found.results[0].matches.length >= 1);
});

test("sources listing and forget", () => {
  store.index({ source: "doc-forget", content: "temporary" });
  assert.ok(store.listSources().some((s) => s.source === "doc-forget"));
  assert.ok(store.forget("doc-forget") >= 1);
  assert.ok(!store.listSources().some((s) => s.source === "doc-forget"));
});

test("snapshots round-trip and are consumed once", () => {
  store.saveSnapshot({ summary: "LAST REQUEST: fix the parser", task: "t1", strategy: "auto-condense" });
  const first = store.takeSnapshot();
  assert.ok(first && first.summary.includes("fix the parser"));
  assert.equal(first.strategy, "auto-condense");
  assert.equal(store.takeSnapshot(), null, "a snapshot must only be handed back once");
});

test("snapshots are capped to the most recent 20", () => {
  for (let i = 0; i < 30; i++) store.saveSnapshot({ summary: `snapshot ${i}` });
  const rows = store.open().prepare("SELECT COUNT(*) AS n FROM snapshots").get();
  assert.ok(Number(rows.n) <= 20, `expected <= 20 snapshots, got ${rows.n}`);
});

test("purge empties the knowledge base", () => {
  assert.ok(store.purge() > 0);
  assert.equal(store.listSources().length, 0);
});
