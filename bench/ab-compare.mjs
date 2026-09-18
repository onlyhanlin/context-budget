#!/usr/bin/env node
/**
 * A/B payload comparison.
 *
 * This measures PAYLOAD bytes only: what the tool would have handed to the
 * model. It does not model prompt caching, tool-schema overhead or the rest of
 * the conversation, so treat the ratio as an upper bound, not a promise.
 *
 *   node bench/ab-compare.mjs <dir> [--pattern=TODO] [--limit=200]
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { run } from "../src/sandbox.mjs";
import { estimateTokens, formatBytes } from "../src/text.mjs";
import { chunkDocument } from "../src/store.mjs";

const args = process.argv.slice(2);
const target = path.resolve(args.find((a) => !a.startsWith("--")) ?? ".");
const pattern = (args.find((a) => a.startsWith("--pattern=")) ?? "--pattern=TODO").split("=")[1];
const limit = Number((args.find((a) => a.startsWith("--limit=")) ?? "--limit=400").split("=")[1]);

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "vendor", "__pycache__"]);
const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".go", ".rs", ".java", ".rb", ".php", ".c", ".h", ".cpp", ".hpp", ".cs", ".md", ".txt", ".json", ".yml", ".yaml", ".toml", ".sh", ".ps1", ".sql", ".css", ".html"]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= limit) return out;
    if (entry.name.startsWith(".") && entry.name !== ".clinerules") continue;
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (TEXT_EXT.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

const files = walk(target);
if (!files.length) {
  console.error(`no text files found under ${target}`);
  process.exit(1);
}

const sizes = files.map((f) => fs.statSync(f).size);
const totalBytes = sizes.reduce((a, b) => a + b, 0);
const line = (n) => "─".repeat(n);

console.log(`context-budget A/B payload comparison`);
console.log(`target   ${target}`);
console.log(`files    ${files.length} text files, ${formatBytes(totalBytes)}`);
console.log(`pattern  ${pattern}`);
console.log(line(64));

/* ---- A: the naive path — read every file into context ---- */
const aTokens = estimateTokens("x".repeat(totalBytes));
console.log(`\nA. naive read (native read_file per file)`);
console.log(`   payload  ${formatBytes(totalBytes).padStart(10)}  ≈ ${aTokens.toLocaleString()} tokens`);
console.log(`   plus one tool round trip per file (${files.length} round trips)`);

/* ---- B: one sandboxed script ---- */
const code = `
import { readFileSync } from "node:fs";
const files = ${JSON.stringify(files)};
const re = new RegExp(${JSON.stringify(pattern)}, "g");
let total = 0, hits = 0, bytes = 0;
for (const f of files) {
  const text = readFileSync(f, "utf8");
  bytes += Buffer.byteLength(text);
  const m = text.match(re);
  if (m) { hits += m.length; console.log(f + ": " + m.length); }
  total++;
}
console.log("---");
console.log("files scanned: " + total + ", matches: " + hits + ", bytes processed: " + bytes);
`;

const started = Date.now();
const res = await run({ language: "javascript", code, cwd: target });
const elapsed = Date.now() - started;
const bBytes = res.bytesOut;
const bTokens = estimateTokens(res.stdout);
console.log(`\nB. ctx_execute (one script, only stdout returns)`);
console.log(`   payload  ${formatBytes(bBytes).padStart(10)}  ≈ ${bTokens.toLocaleString()} tokens`);
console.log(`   one round trip, ${elapsed} ms wall clock`);

console.log("\n" + line(64));
const saved = totalBytes - bBytes;
const pct = totalBytes > 0 ? (saved / totalBytes) * 100 : 0;
console.log(`payload kept out of context: ${formatBytes(saved)} (${pct.toFixed(1)}%)`);
console.log(`≈ ${(aTokens - bTokens).toLocaleString()} tokens not sent`);
console.log(`\nNOTE: payload-only. Tool schemas, routing rules and prompt caching are`);
console.log("not modelled here. Measure your real sessions with `context-budget stats`.");

if (process.argv.includes("--show")) console.log("\n" + res.stdout);
