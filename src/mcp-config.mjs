/**
 * Read, merge and write a Cline MCP settings file.
 *
 * Rules this module will not break:
 *   1. Never replace the file. Only our own key under `mcpServers` is touched.
 *   2. Always back up before writing, to a sibling file nobody else reads.
 *   3. Refuse to overwrite a file we cannot parse — report it instead.
 *
 * Silently rewriting a user's config is how an installer loses their trust,
 * and it is the single most common complaint about hook-based tooling.
 */
import fs from "node:fs";
import path from "node:path";

export const SERVER_NAME = "context-budget";

export function serverEntry() {
  return {
    command: "context-budget",
    args: ["mcp"],
    disabled: false,
    autoApprove: [
      "ctx_execute",
      "ctx_execute_file",
      "ctx_batch",
      "ctx_index",
      "ctx_search",
      "ctx_stats",
    ],
  };
}

export function readSettings(file) {
  if (!fs.existsSync(file)) return { exists: false, data: { mcpServers: {} }, error: null };
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { exists: true, data: null, error: `cannot read: ${error.message}` };
  }
  // Windows editors — and PowerShell's `Set-Content -Encoding utf8` — write a
  // UTF-8 BOM, which JSON.parse rejects. Without this the file was reported as
  // "invalid JSON" and setup skipped it, silently leaving the MCP server
  // unregistered while telling the user nothing actionable.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { exists: true, data: null, error: "top level is not a JSON object" };
    }
    if (data.mcpServers != null && (typeof data.mcpServers !== "object" || Array.isArray(data.mcpServers))) {
      return { exists: true, data: null, error: "\"mcpServers\" exists but is not an object" };
    }
    return { exists: true, data, error: null };
  } catch (error) {
    return { exists: true, data: null, error: `invalid JSON: ${error.message}` };
  }
}

/**
 * Compute the merge without touching disk.
 * @returns {{action:"create"|"update"|"unchanged"|"skip", before:string|null,
 *   after:string|null, error:string|null, otherServers:string[]}}
 */
export function planMerge(file, { entry = serverEntry(), name = SERVER_NAME } = {}) {
  const current = readSettings(file);
  if (current.error) {
    return { action: "skip", before: null, after: null, error: `${file}: ${current.error}`, otherServers: [] };
  }

  const before = current.exists ? JSON.stringify(current.data, null, 2) + "\n" : null;
  const next = { ...(current.data ?? {}), mcpServers: { ...(current.data?.mcpServers ?? {}) } };
  next.mcpServers[name] = entry;
  const after = JSON.stringify(next, null, 2) + "\n";
  const otherServers = Object.keys(current.data?.mcpServers ?? {}).filter((k) => k !== name);

  if (before === after) return { action: "unchanged", before, after, error: null, otherServers };
  return { action: current.exists ? "update" : "create", before, after, error: null, otherServers };
}

/** Write the merged file, backing up whatever was there first. */
export function applyMerge(file, plan) {
  if (plan.action === "skip" || plan.action === "unchanged") return { file, backup: null, written: false };

  let backup = null;
  if (plan.before != null) {
    backup = `${file}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.writeFileSync(backup, plan.before, "utf8");
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, plan.after, "utf8");
  return { file, backup, written: true };
}

/** Remove our key. Returns whether anything changed. */
export function planRemoval(file, { name = SERVER_NAME } = {}) {
  const current = readSettings(file);
  if (current.error || !current.exists) return { action: "skip", error: current.error, before: null, after: null };
  if (!(name in (current.data?.mcpServers ?? {}))) return { action: "unchanged", error: null, before: null, after: null };
  const next = { ...current.data, mcpServers: { ...current.data.mcpServers } };
  delete next.mcpServers[name];
  return {
    action: "update",
    error: null,
    before: JSON.stringify(current.data, null, 2) + "\n",
    after: JSON.stringify(next, null, 2) + "\n",
  };
}

export function isRegistered(file, { name = SERVER_NAME } = {}) {
  const current = readSettings(file);
  return Boolean(current.data?.mcpServers?.[name]);
}
