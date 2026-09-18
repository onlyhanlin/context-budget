/**
 * SQLite plumbing shared by the knowledge base and the token ledger.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Loaded lazily so unrelated commands do not emit Node's ExperimentalWarning. */
export function Database() {
  return require("node:sqlite").DatabaseSync;
}

/**
 * Open a SQLite file with our standard pragmas.
 *
 * WAL is *requested, never required*. It cannot be enabled on network shares,
 * read-only mounts, some overlay filesystems, and confined sandboxes — and when
 * it failed, the exception propagated out of open() and took down the entire
 * tool, including `doctor`, which is the command you run precisely when
 * something is already broken. Falling back to the default journal mode keeps
 * everything working; it only costs concurrent-writer throughput.
 *
 * @returns {{db: object, warnings: string[]}}
 */
export function openDatabase(file) {
  const DatabaseSync = Database();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  const warnings = [];

  try {
    const row = db.prepare("PRAGMA journal_mode = WAL").get();
    const mode = String(row?.journal_mode ?? "").toLowerCase();
    if (mode !== "wal") warnings.push(`journal_mode is "${mode || "unknown"}", not WAL (concurrent writers may fail)`);
  } catch (error) {
    warnings.push(`could not enable WAL: ${error.message}`);
  }

  try {
    db.exec("PRAGMA busy_timeout = 5000;");
  } catch (error) {
    warnings.push(`could not set busy_timeout: ${error.message}`);
  }

  return { db, warnings };
}

/** True when the file looks like a SQLite database we can actually query. */
export function isUsable(db, table) {
  try {
    db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    return true;
  } catch {
    return false;
  }
}
