/**
 * The knowledge base.
 *
 * Anything that would otherwise be re-read into the conversation gets chunked,
 * indexed into SQLite FTS5, and retrieved on demand instead. This is long-term
 * memory for *facts* (documents, pages, command output) — not for the
 * conversation itself.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { kbPath, limits, storageRoot } from "./config.mjs";
import { tokenizeForIndex, termsOf, buildMatchQuery, extractSnippet, estimateTokens } from "./text.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chunks (
  id        INTEGER PRIMARY KEY,
  source    TEXT    NOT NULL,
  title     TEXT    NOT NULL DEFAULT '',
  body      TEXT    NOT NULL,
  title_tok TEXT    NOT NULL DEFAULT '',
  body_tok  TEXT    NOT NULL DEFAULT '',
  ts        INTEGER NOT NULL,
  tokens    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
CREATE INDEX IF NOT EXISTS idx_chunks_ts ON chunks(ts);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  title_tok, body_tok,
  content='chunks',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, title_tok, body_tok) VALUES (new.id, new.title_tok, new.body_tok);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, title_tok, body_tok) VALUES ('delete', old.id, old.title_tok, old.body_tok);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, title_tok, body_tok) VALUES ('delete', old.id, old.title_tok, old.body_tok);
  INSERT INTO chunks_fts(rowid, title_tok, body_tok) VALUES (new.id, new.title_tok, new.body_tok);
END;

CREATE TABLE IF NOT EXISTS sources (
  source     TEXT PRIMARY KEY,
  ts         INTEGER NOT NULL,
  chunks     INTEGER NOT NULL DEFAULT 0,
  bytes      INTEGER NOT NULL DEFAULT 0
);

-- Working-state cards captured just before Cline compacts the conversation.
CREATE TABLE IF NOT EXISTS snapshots (
  id       INTEGER PRIMARY KEY,
  ts       INTEGER NOT NULL,
  task     TEXT NOT NULL DEFAULT '',
  strategy TEXT NOT NULL DEFAULT '',
  summary  TEXT NOT NULL,
  bytes    INTEGER NOT NULL DEFAULT 0,
  consumed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON snapshots(ts);
`;

const require = createRequire(import.meta.url);

/**
 * node:sqlite is loaded lazily. Importing it eagerly makes every command emit
 * Node's ExperimentalWarning, including ones that never touch the database.
 */
function sqlite() {
  return require("node:sqlite").DatabaseSync;
}

let db = null;
let dbFile = null;

export function open() {
  const DatabaseSync = sqlite();
  const file = kbPath();
  if (db && dbFile === file) return db;
  if (db) { try { db.close(); } catch { /* ignore */ } }
  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  // The same knowledge base is written by the MCP server AND by the PreCompact
  // hook, and a user can have two Cline windows open on one project. Without a
  // busy timeout the losing writer gets SQLITE_BUSY and its write disappears.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  dbFile = file;
  gc(db);
  return db;
}

export function kbFile() {
  return kbPath();
}

/** Drop chunks older than the retention window. */
export function gc(handle = open()) {
  const cutoff = Date.now() - limits.kbTtlMs;
  handle.prepare("DELETE FROM chunks WHERE ts < ?").run(cutoff);
  handle.prepare("DELETE FROM sources WHERE ts < ?").run(cutoff);
}

/* ------------------------------------------------------------------ chunking */

/**
 * Split markdown by heading while keeping fenced code blocks intact, then
 * window any oversized section. Documents without headings become fixed-size
 * overlapping windows.
 */
export function chunkDocument(raw, { maxChars = limits.chunkChars, overlap = limits.chunkOverlap } = {}) {
  const text = String(raw ?? "").replace(/\r\n/g, "\n");
  if (!text.trim()) return [];

  const lines = text.split("\n");
  const sections = [];
  let title = "";
  let buffer = [];
  let inFence = false;

  const flush = () => {
    const body = buffer.join("\n").trim();
    if (body) sections.push({ title, body });
    buffer = [];
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const heading = !inFence && /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (heading) {
      flush();
      title = heading[2].trim();
      continue;
    }
    buffer.push(line);
  }
  flush();

  if (!sections.length) sections.push({ title: "", body: text.trim() });

  const out = [];
  for (const section of sections) {
    if (section.body.length <= maxChars) {
      out.push(section);
      continue;
    }
    // Split oversized sections on blank lines, keeping code fences whole.
    const parts = section.body.split(/\n\s*\n/);
    let acc = "";
    for (const part of parts) {
      if (acc && acc.length + part.length + 2 > maxChars) {
        out.push({ title: section.title, body: acc.trim() });
        acc = acc.slice(-overlap) + "\n\n" + part;
      } else {
        acc = acc ? acc + "\n\n" + part : part;
      }
    }
    if (acc.trim()) out.push({ title: section.title, body: acc.trim() });
  }

  // Hard window anything still oversized (minified files, single huge lines).
  const final = [];
  for (const section of out) {
    if (section.body.length <= maxChars * 1.5) { final.push(section); continue; }
    for (let i = 0; i < section.body.length; i += maxChars - overlap) {
      final.push({ title: section.title, body: section.body.slice(i, i + maxChars) });
    }
  }
  return final.filter((s) => s.body.trim().length > 0);
}

/* -------------------------------------------------------------------- writes */

/**
 * Index a document. Re-indexing the same source replaces its previous chunks,
 * so callers can safely re-run the same fetch.
 */
export function index({ source, content, title = "", ttlMs = limits.indexTtlMs }) {
  const handle = open();
  const name = String(source || "untitled").slice(0, 200);
  const chunks = chunkDocument(content);
  const now = Date.now();

  handle.exec("BEGIN");
  try {
    handle.prepare("DELETE FROM chunks WHERE source = ?").run(name);
    const insert = handle.prepare(
      "INSERT INTO chunks (source, title, body, title_tok, body_tok, ts, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    for (const chunk of chunks) {
      const chunkTitle = chunk.title || title || "";
      insert.run(
        name,
        chunkTitle.slice(0, 300),
        chunk.body,
        tokenizeForIndex(chunkTitle),
        tokenizeForIndex(chunk.body),
        now,
        estimateTokens(chunk.body)
      );
    }
    handle
      .prepare(
        "INSERT INTO sources (source, ts, chunks, bytes) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(source) DO UPDATE SET ts = excluded.ts, chunks = excluded.chunks, bytes = excluded.bytes"
      )
      .run(name, now, chunks.length, Buffer.byteLength(String(content ?? ""), "utf8"));
    handle.exec("COMMIT");
  } catch (error) {
    handle.exec("ROLLBACK");
    throw error;
  }

  return {
    source: name,
    chunks: chunks.length,
    bytes: Buffer.byteLength(String(content ?? ""), "utf8"),
    indexedTokens: chunks.reduce((sum, c) => sum + estimateTokens(c.body), 0),
    expiresAt: now + ttlMs,
  };
}

export function forget(source) {
  const handle = open();
  const info = handle.prepare("DELETE FROM chunks WHERE source = ?").run(String(source));
  handle.prepare("DELETE FROM sources WHERE source = ?").run(String(source));
  return Number(info.changes ?? 0);
}

export function purge() {
  const handle = open();
  const before = handle.prepare("SELECT COUNT(*) AS n FROM chunks").get().n;
  handle.exec("DELETE FROM chunks; DELETE FROM sources;");
  handle.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');");
  return Number(before);
}

export function listSources() {
  return open()
    .prepare("SELECT source, ts, chunks, bytes FROM sources ORDER BY ts DESC")
    .all()
    .map((row) => ({ ...row, ageMs: Date.now() - Number(row.ts) }));
}

export function isFresh(source, ttlMs = limits.indexTtlMs) {
  const row = open().prepare("SELECT ts FROM sources WHERE source = ?").get(String(source));
  if (!row) return null;
  const age = Date.now() - Number(row.ts);
  return { fresh: age < ttlMs, ageMs: age, ts: Number(row.ts) };
}

/* -------------------------------------------------------------------- search */

function runSearch(matchExpr, limit, sourceFilter) {
  const handle = open();
  const sql =
    "SELECT c.id, c.source, c.title, c.body, bm25(chunks_fts, 5.0, 1.0) AS score " +
    "FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid " +
    "WHERE chunks_fts MATCH ?" +
    (sourceFilter ? " AND c.source = ?" : "") +
    " ORDER BY score LIMIT ?";
  const args = sourceFilter ? [matchExpr, sourceFilter, limit] : [matchExpr, limit];
  return handle.prepare(sql).all(...args);
}

/**
 * Substring scan, used only when FTS5 finds nothing.
 *
 * `mode: "and"` is the default on purpose: joining terms with OR means a query
 * like "first-output-alpha" happily matches a document that merely contains the
 * word "output", and the model has no way to tell that apart from a real hit.
 */
function runLikeSearch(terms, limit, sourceFilter, mode = "and") {
  const handle = open();
  const join = mode === "or" ? " OR " : " AND ";
  const clauses = terms.map(() => "(body LIKE ? OR title LIKE ?)").join(join);
  const args = [];
  for (const term of terms) args.push(`%${term}%`, `%${term}%`);
  const sql =
    "SELECT id, source, title, body, 0 AS score FROM chunks WHERE (" +
    clauses +
    ")" +
    (sourceFilter ? " AND source = ?" : "") +
    " LIMIT ?";
  if (sourceFilter) args.push(sourceFilter);
  args.push(limit);
  return handle.prepare(sql).all(...args);
}

/**
 * Search the knowledge base. Multiple queries are answered in one call —
 * the round trip is the expensive part, not the ranking.
 */
export function search(queries, { limit = 6, perQuery = 2, source = null, mode = "and" } = {}) {
  const handle = open();
  const results = [];
  const vocabulary = new Set();

  for (const rawQuery of queries) {
    const query = String(rawQuery ?? "").trim();
    if (!query) continue;
    const terms = termsOf(query);
    for (const term of terms) vocabulary.add(term);

    let rows = [];
    let partial = false;
    const match = buildMatchQuery(query, mode);
    if (match) {
      try {
        rows = runSearch(match, limit, source);
      } catch {
        rows = [];
      }
      if (!rows.length && mode === "and" && terms.length > 1) {
        const orMatch = buildMatchQuery(query, "or");
        if (orMatch) {
          try { rows = runSearch(orMatch, limit, source); } catch { rows = []; }
        }
      }
      if (!rows.length) {
        // Substring fallback: catches partial identifiers ("useEff" -> "useEffect").
        const longTerms = terms.filter((t) => t.length >= 3);
        if (longTerms.length) {
          rows = runLikeSearch(longTerms, limit, source, "and");
          if (!rows.length && longTerms.length > 1) {
            const loose = runLikeSearch(longTerms, limit, source, "or");
            if (loose.length) {
              rows = loose;
              partial = true;
            }
          }
        }
      }
    }

    // At most `perQuery` hits per source, mirroring context-mode's dedup rule.
    const seen = new Map();
    const picked = [];
    for (const row of rows) {
      const count = seen.get(row.source) ?? 0;
      if (count >= perQuery) continue;
      seen.set(row.source, count + 1);
      picked.push(row);
    }

    results.push({
      query,
      terms,
      partial,
      matches: picked.map((row) => ({
        source: row.source,
        title: row.title,
        score: Number(row.score),
        // Only report a snippet when the query actually appears in the body.
        // A snippet built from "no term matched" is just the head of the
        // document, presented as if it were an answer.
        snippet: extractSnippet(row.body, terms, 700),
        bytes: Buffer.byteLength(row.body, "utf8"),
      })),
    });
  }

  return {
    results,
    vocabulary: [...vocabulary].slice(0, 40),
    totalChunks: Number(handle.prepare("SELECT COUNT(*) AS n FROM chunks").get().n),
  };
}

/* ------------------------------------------------------------------ snapshot */

/** Persist a pre-compaction working-state card. */
export function saveSnapshot({ summary, task = "", strategy = "" }) {
  const handle = open();
  const text = String(summary ?? "").slice(0, 8000);
  const info = handle
    .prepare("INSERT INTO snapshots (ts, task, strategy, summary, bytes) VALUES (?, ?, ?, ?, ?)")
    .run(Date.now(), String(task).slice(0, 120), String(strategy).slice(0, 60), text, Buffer.byteLength(text, "utf8"));
  // Keep the table small: snapshots are working state, not an archive.
  handle.prepare("DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY ts DESC LIMIT 20)").run();
  return { id: Number(info.lastInsertRowid), bytes: Buffer.byteLength(text, "utf8") };
}

/**
 * The most recent snapshot, preferring one that has not been handed back yet.
 * `session_resume` in context-mode's design; here it is one small table.
 */
export function takeSnapshot({ markConsumed = true } = {}) {
  const handle = open();
  const row = handle
    .prepare("SELECT id, ts, task, strategy, summary FROM snapshots WHERE consumed = 0 ORDER BY ts DESC LIMIT 1")
    .get();
  if (!row) return null;
  if (markConsumed) handle.prepare("UPDATE snapshots SET consumed = 1 WHERE id = ?").run(row.id);
  return { ...row, ageMs: Date.now() - Number(row.ts) };
}

export function close() {
  if (db) { try { db.close(); } catch { /* ignore */ } db = null; dbFile = null; }
}
