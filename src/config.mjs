/**
 * Configuration and on-disk layout.
 *
 * Everything lives under a single storage root (default ~/.context-budget)
 * so that a user can inspect, back up, or delete the whole thing at once.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

export const VERSION = "0.1.0";

export function storageRoot() {
  const raw = process.env.CONTEXT_BUDGET_DIR || path.join(os.homedir(), ".context-budget");
  return path.resolve(raw);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The workspace the agent is operating in. All sandbox paths are bounded by this. */
export function projectRoot() {
  return path.resolve(process.env.CONTEXT_BUDGET_PROJECT || process.cwd());
}

/** Stable per-project key so two projects never share a knowledge base. */
export function projectKey(root = projectRoot()) {
  const normalized = process.platform === "win32" ? root.toLowerCase() : root;
  const hash = crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 12);
  const base = (path.basename(root) || "project").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 32);
  return `${base}-${hash}`;
}

export function kbPath() {
  return path.join(ensureDir(path.join(storageRoot(), "kb")), `${projectKey()}.db`);
}

export function statsPath() {
  return path.join(ensureDir(storageRoot()), "stats.db");
}

export function tmpDir() {
  return ensureDir(path.join(storageRoot(), "tmp"));
}

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const limits = {
  /** Hard cap on bytes returned to the model from a single sandbox call. */
  get maxOutputBytes() { return num("CB_MAX_OUTPUT_BYTES", 8192); },
  /** Subprocess wall-clock timeout. */
  get timeoutMs() { return num("CB_TIMEOUT_MS", 30_000); },
  /** How long an indexed source stays fresh before a re-fetch is expected. */
  get indexTtlMs() { return num("CB_INDEX_TTL_MS", 24 * 60 * 60 * 1000); },
  /** Knowledge-base garbage collection age. */
  get kbTtlMs() { return num("CB_KB_TTL_MS", 14 * 24 * 60 * 60 * 1000); },
  /** Largest file ctx_execute_file will inject into the sandbox. */
  get maxReadBytes() { return num("CB_MAX_READ_BYTES", 4 * 1024 * 1024); },
  /** Chunk size when a document has no usable heading structure. */
  get chunkChars() { return num("CB_CHUNK_CHARS", 1800); },
  get chunkOverlap() { return num("CB_CHUNK_OVERLAP", 200); },
};
