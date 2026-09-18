/**
 * Token accounting.
 *
 * Every sandbox call records how many bytes it kept out of the conversation so
 * that "does this actually pay for itself?" is a measurement rather than an
 * argument.
 */
import { openDatabase } from "./sqlite-util.mjs";
import { statsPath, projectKey, storageRoot } from "./config.mjs";
import { estimateTokens } from "./text.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  session     TEXT    NOT NULL,
  project     TEXT    NOT NULL,
  tool        TEXT    NOT NULL,
  source      TEXT    NOT NULL DEFAULT '',
  in_bytes    INTEGER NOT NULL DEFAULT 0,
  out_bytes   INTEGER NOT NULL DEFAULT 0,
  saved_bytes INTEGER NOT NULL DEFAULT 0,
  saved_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  ok          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_calls_session ON calls(session);
CREATE INDEX IF NOT EXISTS idx_calls_project ON calls(project);
`;

const SESSION_ID = process.env.CONTEXT_BUDGET_SESSION || `${Date.now().toString(36)}-${process.pid}`;

let db = null;
let dbWarnings = [];

function open() {
  if (db) return db;
  const opened = openDatabase(statsPath());
  db = opened.db;
  dbWarnings = opened.warnings;
  db.exec(SCHEMA);
  return db;
}

/** Non-fatal storage problems, surfaced by the doctor command. */
export function warnings() {
  return [...dbWarnings];
}

/**
 * Never throws. `doctor` calls this to report on the ledger, and a diagnostic
 * command that dies on a broken ledger is useless exactly when it is needed.
 */
export function health() {
  try {
    open().prepare("SELECT COUNT(*) AS n FROM calls").get();
    return { ok: true, file: statsPath(), warnings: dbWarnings };
  } catch (error) {
    return { ok: false, file: statsPath(), error: error.message, warnings: dbWarnings };
  }
}

export function sessionId() {
  return SESSION_ID;
}

/**
 * @param {object} entry
 * @param {string} entry.tool
 * @param {number} entry.rawBytes  bytes that would have entered context without the sandbox
 * @param {number} entry.outBytes  bytes actually returned to the model
 */
export function record(entry) {
  const raw = Math.max(0, Number(entry.rawBytes) || 0);
  const out = Math.max(0, Number(entry.outBytes) || 0);
  const savedBytes = Math.max(0, raw - out);
  try {
    open()
      .prepare(
        "INSERT INTO calls (ts, session, project, tool, source, in_bytes, out_bytes, saved_bytes, saved_tokens, duration_ms, ok) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        Date.now(),
        SESSION_ID,
        projectKey(),
        String(entry.tool ?? "unknown"),
        String(entry.source ?? "").slice(0, 200),
        raw,
        out,
        savedBytes,
        estimateTokens("x".repeat(savedBytes)), // byte-equivalent token estimate
        Number(entry.durationMs) || 0,
        entry.ok === false ? 0 : 1
      );
  } catch {
    // Accounting must never break a tool call.
  }
}

function aggregate(where, args = []) {
  const row = open()
    .prepare(
      "SELECT COUNT(*) AS calls, " +
        "COALESCE(SUM(in_bytes),0) AS in_bytes, " +
        "COALESCE(SUM(out_bytes),0) AS out_bytes, " +
        "COALESCE(SUM(saved_bytes),0) AS saved_bytes, " +
        "COALESCE(SUM(duration_ms),0) AS duration_ms " +
        "FROM calls " +
        where
    )
    .get(...args);
  const savedBytes = Number(row.saved_bytes);
  // Recompute tokens from the byte delta using the same heuristic as the text
  // module so the headline number is consistent with per-call reporting.
  const savedTokens = estimateTokens("x".repeat(savedBytes));
  return {
    calls: Number(row.calls),
    inBytes: Number(row.in_bytes),
    outBytes: Number(row.out_bytes),
    savedBytes,
    savedTokens,
    durationMs: Number(row.duration_ms),
    ratio: Number(row.in_bytes) > 0 ? 1 - Number(row.out_bytes) / Number(row.in_bytes) : 0,
  };
}

export function summary({ session = false } = {}) {
  const where = session ? "WHERE session = ? AND project = ?" : "WHERE project = ?";
  const args = session ? [SESSION_ID, projectKey()] : [projectKey()];
  return {
    session: aggregate(where, args),
    lifetime: aggregate("WHERE project = ?", [projectKey()]),
    allProjects: aggregate("WHERE 1=1"),
    byTool: open()
      .prepare(
        "SELECT tool, COUNT(*) AS calls, COALESCE(SUM(saved_bytes),0) AS saved_bytes " +
          "FROM calls WHERE project = ? GROUP BY tool ORDER BY saved_bytes DESC"
      )
      .all(projectKey())
      .map((r) => ({
        tool: r.tool,
        calls: Number(r.calls),
        savedBytes: Number(r.saved_bytes),
        savedTokens: estimateTokens("x".repeat(Number(r.saved_bytes))),
      })),
    sessionId: SESSION_ID,
    storageRoot: storageRoot(),
    statsFile: statsPath(),
  };
}

export function reset({ all = false } = {}) {
  const handle = open();
  if (all) handle.exec("DELETE FROM calls;");
  else handle.prepare("DELETE FROM calls WHERE session = ?").run(SESSION_ID);
}

export function close() {
  if (db) { try { db.close(); } catch { /* ignore */ } db = null; }
}
