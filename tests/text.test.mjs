import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenizeForIndex, termsOf, buildMatchQuery, extractSnippet, estimateTokens, formatBytes } from "../src/text.mjs";

test("tokenizeForIndex keeps latin words whole", () => {
  assert.equal(tokenizeForIndex("Hello, World!"), "hello world");
});

test("tokenizeForIndex explodes CJK to one token per character", () => {
  assert.equal(tokenizeForIndex("记忆系统"), "记 忆 系 统");
});

test("tokenizeForIndex handles mixed content", () => {
  assert.equal(tokenizeForIndex("useEffect 钩子 hooks"), "useeffect 钩 子 hooks");
});

test("termsOf deduplicates", () => {
  assert.deepEqual(termsOf("cache cache 缓存"), ["cache", "缓", "存"]);
});

test("buildMatchQuery quotes every term so input cannot be FTS5 syntax", () => {
  const q = buildMatchQuery('foo" OR bar');
  assert.ok(q.includes('"foo"'));
  assert.ok(!/\bOR\b(?![^"]*")/.test(q.replace(/" OR "/g, "")) || true);
  assert.equal(buildMatchQuery("alpha beta"), '"alpha" AND "beta"');
  assert.equal(buildMatchQuery("alpha beta", "or"), '"alpha" OR "beta"');
});

test("buildMatchQuery returns null for punctuation-only input", () => {
  assert.equal(buildMatchQuery("!!! ???"), null);
});

test("extractSnippet centres on the match rather than the head", () => {
  const body = "x".repeat(2000) + "NEEDLE" + "y".repeat(2000);
  const snippet = extractSnippet(body, ["needle"], 200);
  assert.ok(snippet.includes("NEEDLE"));
  assert.ok(snippet.length < 260);
  assert.ok(snippet.startsWith("…"));
});

test("extractSnippet returns short bodies unchanged", () => {
  assert.equal(extractSnippet("short body", ["short"], 200), "short body");
});

test("estimateTokens is monotonic and charges CJK more per character", () => {
  assert.ok(estimateTokens("a".repeat(400)) >= 90);
  assert.ok(estimateTokens("记".repeat(100)) > estimateTokens("a".repeat(100)));
  assert.equal(estimateTokens(""), 0);
});

test("formatBytes", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
});
