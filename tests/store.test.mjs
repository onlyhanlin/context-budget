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

/* ------------------------------------------------- additional edge cases */

test("chunkDocument returns empty for whitespace-only input", () => {
  assert.deepEqual(store.chunkDocument(""), []);
  assert.deepEqual(store.chunkDocument("   \n\n  \t  "), []);
  assert.deepEqual(store.chunkDocument(null), []);
});

test("chunkDocument normalises Windows line endings", () => {
  const doc = "# Title\r\n\r\nbody line\r\n## Sub\r\n\r\nsub body";
  const chunks = store.chunkDocument(doc);
  assert.ok(chunks.some((c) => c.title === "Title"));
  assert.ok(chunks.some((c) => c.title === "Sub"));
});

test("chunkDocument keeps nested code fences intact", () => {
  const doc = [
    "# Code",
    "```js",
    "const a = 1;",
    "```",
    "",
    "```js",
    "const b = 2;",
    "```",
  ].join("\n");
  const chunks = store.chunkDocument(doc);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].body.includes("const a = 1;"));
  assert.ok(chunks[0].body.includes("const b = 2;"));
});

test("chunkDocument handles a heading with no body text", () => {
  const doc = "# Only Heading\n\n## Another\n\nactual body";
  const chunks = store.chunkDocument(doc);
  // The first heading has no body and should be dropped; "Another" carries text.
  assert.ok(chunks.some((c) => c.title === "Another" && c.body.includes("actual body")));
});

test("isFresh reports null for an unknown source", () => {
  assert.equal(store.isFresh("does-not-exist"), null);
});

test("isFresh reports a freshly indexed source as fresh", () => {
  store.index({ source: "fresh-check", content: "# H\n\nbody" });
  const info = store.isFresh("fresh-check");
  assert.ok(info !== null);
  assert.equal(info.fresh, true);
  assert.ok(info.ageMs >= 0);
});

test("isFresh reports stale when the timestamp is old", () => {
  store.index({ source: "stale-check", content: "# H\n\nbody" });
  const handle = store.open();
  handle.prepare("UPDATE sources SET ts = ? WHERE source = ?").run(Date.now() - 10 * 24 * 60 * 60 * 1000, "stale-check");
  const info = store.isFresh("stale-check");
  assert.equal(info.fresh, false);
});

test("forget returns 0 for a non-existent source", () => {
  assert.equal(store.forget("never-existed"), 0);
});

test("index with empty content produces zero chunks but still records the source", () => {
  const info = store.index({ source: "empty-content", content: "   " });
  assert.equal(info.chunks, 0);
  // The source row should still exist so a caller can detect it was indexed.
  assert.ok(store.listSources().some((s) => s.source === "empty-content"));
});

test("index truncates overly long source names", () => {
  const longName = "s".repeat(500);
  const info = store.index({ source: longName, content: "# H\n\nbody" });
  assert.equal(info.source.length, 200);
});

test("search with multiple queries answers each independently", () => {
  store.index({ source: "multi-q", content: "## Alpha\n\nalpha content here\n\n## Beta\n\nbeta content here" });
  const found = store.search(["alpha", "beta"]);
  assert.equal(found.results.length, 2);
  assert.equal(found.results[0].query, "alpha");
  assert.equal(found.results[1].query, "beta");
  assert.ok(found.results[0].matches.length >= 1);
  assert.ok(found.results[1].matches.length >= 1);
});

test("search OR mode matches when only one term appears", () => {
  store.index({ source: "or-mode", content: "## Only\n\nunicorn exists here" });
  const and = store.search(["unicorn nonexistent"], { mode: "and" });
  const or = store.search(["unicorn nonexistent"], { mode: "or" });
  // AND with the substring fallback might still match; OR should definitely match.
  assert.ok(or.results[0].matches.length >= 1);
  assert.ok(or.results[0].matches.length >= and.results[0].matches.length);
});

test("search returns the vocabulary of all query terms", () => {
  store.index({ source: "vocab", content: "hello world foo bar" });
  const found = store.search(["hello", "world foo"]);
  assert.ok(found.vocabulary.includes("hello"));
  assert.ok(found.vocabulary.includes("world"));
  assert.ok(found.vocabulary.includes("foo"));
});

test("gc removes chunks older than the retention window", () => {
  store.index({ source: "gc-old", content: "# H\n\nold body" });
  const handle = store.open();
  const oldTs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  handle.prepare("UPDATE chunks SET ts = ? WHERE source = ?").run(oldTs, "gc-old");
  handle.prepare("UPDATE sources SET ts = ? WHERE source = ?").run(oldTs, "gc-old");
  store.gc();
  assert.equal(store.forget("gc-old"), 0, "old chunks should already be gone after gc");
});

test("search across sources with perQuery limit distributes hits", () => {
  store.index({ source: "src-a", content: "## S\n\nneedle in a1\nneedle in a2" });
  store.index({ source: "src-b", content: "## S\n\nneedle in b1" });
  const found = store.search(["needle"], { limit: 10, perQuery: 1 });
  const sources = new Set(found.results[0].matches.map((m) => m.source));
  assert.ok(sources.has("src-a"));
  assert.ok(sources.has("src-b"));
});
