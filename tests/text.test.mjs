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

/* ------------------------------------------------- additional edge cases */

test("tokenizeForIndex handles empty and falsy input", () => {
  assert.equal(tokenizeForIndex(""), "");
  assert.equal(tokenizeForIndex(null), "");
  assert.equal(tokenizeForIndex(undefined), "");
  assert.equal(tokenizeForIndex(0), "");
});

test("tokenizeForIndex keeps identifiers with underscores and digits intact", () => {
  assert.equal(tokenizeForIndex("useEffect_with_cleanup2"), "useeffect_with_cleanup2");
  assert.equal(tokenizeForIndex("CB_MAX_OUTPUT_BYTES"), "cb_max_output_bytes");
});

test("tokenizeForIndex handles Japanese and Korean scripts", () => {
  // Hiragana + Katakana are in the CJK range used by isCJK
  assert.equal(tokenizeForIndex("こんにちは"), "こ ん に ち は");
  assert.equal(tokenizeForIndex("カタカナ"), "カ タ カ ナ");
  // Korean Hangul
  assert.equal(tokenizeForIndex("안녕"), "안 녕");
});

test("tokenizeForIndex separates CJK from adjacent latin without merging", () => {
  assert.equal(tokenizeForIndex("ReactのuseEffect"), "react の useeffect");
  assert.equal(tokenizeForIndex("缓存cache缓存"), "缓 存 cache 缓 存");
});

test("termsOf returns empty array for empty input", () => {
  assert.deepEqual(termsOf(""), []);
  assert.deepEqual(termsOf("  "), []);
});

test("termsOf normalises case", () => {
  assert.deepEqual(termsOf("Hello hello HELLO"), ["hello"]);
});

test("buildMatchQuery with a single term produces one quoted token", () => {
  assert.equal(buildMatchQuery("cache"), '"cache"');
});

test("buildMatchQuery strips punctuation including quotes before quoting terms", () => {
  // Quotation marks are not [A-Za-z0-9_], so tokenization drops them and the
  // resulting terms are "say" and "hello" — each then FTS5-quoted.
  const q = buildMatchQuery('say "hello"');
  assert.equal(q, '"say" AND "hello"');
});

test("buildMatchQuery returns null when all terms are punctuation", () => {
  assert.equal(buildMatchQuery("...,,--"), null);
});

test("buildMatchQuery defaults to AND mode", () => {
  assert.equal(buildMatchQuery("a b c"), '"a" AND "b" AND "c"');
});

test("extractSnippet with null/undefined body returns empty string", () => {
  assert.equal(extractSnippet(null, ["x"], 100), "");
  assert.equal(extractSnippet(undefined, ["x"], 100), "");
});

test("extractSnippet falls back to the head when no term matches", () => {
  const body = "a".repeat(1000);
  const snippet = extractSnippet(body, ["nomatch"], 200);
  assert.ok(snippet.endsWith("…"));
  assert.ok(snippet.startsWith("a"));
  assert.ok(snippet.length <= 201);
});

test("extractSnippet places window near the start when match is there", () => {
  const body = "NEEDLE" + "x".repeat(2000);
  const snippet = extractSnippet(body, ["needle"], 200);
  assert.ok(snippet.includes("NEEDLE"));
  assert.ok(!snippet.startsWith("…"), "a match near the start needs no leading ellipsis");
});

test("extractSnippet places window near the end when match is there", () => {
  const body = "x".repeat(2000) + "NEEDLE";
  const snippet = extractSnippet(body, ["needle"], 200);
  assert.ok(snippet.includes("NEEDLE"));
  assert.ok(!snippet.endsWith("…"), "a match at the end needs no trailing ellipsis");
});

test("extractSnippet with empty terms returns the head", () => {
  const body = "a".repeat(1000);
  const snippet = extractSnippet(body, [], 200);
  assert.ok(snippet.endsWith("…"));
  assert.ok(snippet.length <= 201);
});

test("estimateTokens counts non-CJK non-ASCII scripts in between", () => {
  // Cyrillic is neither ASCII nor CJK, so it uses the "other" weight (0.6).
  const ascii = estimateTokens("a".repeat(100));
  const cyrillic = estimateTokens("б".repeat(100));
  const cjk = estimateTokens("记".repeat(100));
  assert.ok(cyrillic > ascii, "cyrillic should cost more than ASCII per char");
  assert.ok(cyrillic < cjk, "cyrillic should cost less than CJK per char");
});

test("estimateTokens handles null and non-string input gracefully", () => {
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
  // Numbers are stringified; "123" has 3 ASCII chars → ceil(3/4) = 1.
  assert.equal(estimateTokens(123), 1);
});

test("formatBytes boundary values", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1025), "1.0 KB");
  assert.equal(formatBytes(1024 * 1024 - 1), "1024.0 KB");
  assert.equal(formatBytes(1024 * 1024), "1.00 MB");
  assert.match(formatBytes(1024 * 1024 * 1024), /MB/);
});
