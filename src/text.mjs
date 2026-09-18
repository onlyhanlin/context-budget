/**
 * Text utilities: indexing tokenization, query building, snippet extraction,
 * and token estimation.
 *
 * CJK note: SQLite's unicode61 tokenizer treats a run of Han characters as a
 * single token, which makes Chinese search useless. We therefore store a
 * shadow token stream in which every CJK codepoint is space separated, so
 * "记忆系统" indexes as "记 忆 系 统" and a 2-character query still matches.
 */

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;

export function isCJK(codepoint) {
  return (
    (codepoint >= 0x3400 && codepoint <= 0x4dbf) ||
    (codepoint >= 0x4e00 && codepoint <= 0x9fff) ||
    (codepoint >= 0xf900 && codepoint <= 0xfaff) ||
    (codepoint >= 0x3040 && codepoint <= 0x30ff) ||
    (codepoint >= 0xac00 && codepoint <= 0xd7af)
  );
}

/**
 * Produce the string that actually gets fed to FTS5.
 * Latin runs stay whole; CJK runs are exploded to one token per character.
 */
export function tokenizeForIndex(input) {
  if (!input) return "";
  const out = [];
  let latin = [];
  const flush = () => {
    if (latin.length) {
      out.push(latin.join("").toLowerCase());
      latin = [];
    }
  };
  for (const ch of String(input)) {
    const cp = ch.codePointAt(0);
    if (isCJK(cp)) {
      flush();
      out.push(ch);
    } else if (/[A-Za-z0-9_]/.test(ch)) {
      latin.push(ch);
    } else {
      flush();
    }
  }
  flush();
  return out.join(" ");
}

/** Distinct search terms, used for snippet extraction and result reporting. */
export function termsOf(input) {
  return [...new Set(tokenizeForIndex(input).split(" ").filter(Boolean))];
}

/**
 * Build an FTS5 MATCH expression. Every term is quoted so that user input can
 * never be parsed as FTS5 syntax.
 */
export function buildMatchQuery(input, mode = "and") {
  const terms = termsOf(input);
  if (!terms.length) return null;
  const quoted = terms.map((t) => `"${t.replace(/"/g, '""')}"`);
  return quoted.join(mode === "or" ? " OR " : " AND ");
}

/**
 * Return a window of text centered on the densest cluster of query terms
 * rather than blindly truncating the head of the document.
 */
export function extractSnippet(body, terms, maxChars = 700) {
  const text = String(body ?? "");
  if (text.length <= maxChars) return text;
  const lower = text.toLowerCase();
  const needles = terms.filter((t) => t.length >= 1).map((t) => t.toLowerCase());
  if (!needles.length) return text.slice(0, maxChars) + "…";

  const hits = [];
  for (const needle of needles) {
    let from = 0;
    for (let guard = 0; guard < 400; guard++) {
      const at = lower.indexOf(needle, from);
      if (at === -1) break;
      hits.push(at);
      from = at + needle.length;
    }
  }
  if (!hits.length) return text.slice(0, maxChars) + "…";
  hits.sort((a, b) => a - b);

  // Densest cluster: the window containing the most hits.
  const half = Math.floor(maxChars / 2);
  let bestStart = hits[0];
  let bestCount = -1;
  for (const hit of hits) {
    const start = Math.max(0, hit - half);
    const end = start + maxChars;
    const count = hits.filter((h) => h >= start && h < end).length;
    if (count > bestCount) {
      bestCount = count;
      bestStart = start;
    }
  }
  const start = Math.max(0, Math.min(bestStart, text.length - maxChars));
  const end = Math.min(text.length, start + maxChars);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

/**
 * Rough token estimate. Deliberately conservative and dependency-free:
 * ASCII ≈ 4 chars/token, CJK ≈ 1.25 chars/token, other scripts in between.
 * Used for reporting only — never for correctness decisions.
 */
export function estimateTokens(input) {
  const s = String(input ?? "");
  if (!s) return 0;
  let ascii = 0;
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp < 128) ascii++;
    else if (isCJK(cp)) cjk++;
    else other++;
  }
  return Math.ceil(ascii / 4 + cjk * 0.8 + other * 0.6);
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
