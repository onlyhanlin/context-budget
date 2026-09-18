/**
 * Locate the Cline installations on this machine.
 *
 * We do not hard-code editor names. Every VS Code-family editor keeps
 * extensions' data under `<app>/User/globalStorage`, so we enumerate the roots
 * and look for a Cline-owned storage directory inside. That is how a fork like
 * `codearts-agent` gets picked up without appearing in any list we maintain.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Directories that contain one subdirectory per installed editor. */
function editorDataRoots() {
  const home = os.homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return [appData].filter((d) => fs.existsSync(d));
  }
  if (process.platform === "darwin") {
    const base = path.join(home, "Library", "Application Support");
    return fs.existsSync(base) ? [base] : [];
  }
  const base = path.join(home, ".config");
  return fs.existsSync(base) ? [base] : [];
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Every `<app>/User/globalStorage` directory we can find. */
export function globalStorageRoots() {
  const roots = [];
  for (const base of editorDataRoots()) {
    for (const entry of safeReaddir(base)) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(base, entry.name, "User", "globalStorage");
      if (fs.existsSync(candidate)) roots.push({ app: entry.name, dir: candidate });
    }
  }
  return roots;
}

/** Telltale names used by Cline and its forks inside globalStorage. */
const CLINE_STORAGE = /cline|claude-dev|kilo|roo/i;

function mcpSettingsInside(storageDir) {
  const candidates = [
    path.join(storageDir, "settings", "cline_mcp_settings.json"),
    path.join(storageDir, "cline_mcp_settings.json"),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/**
 * All Cline surfaces present on this machine.
 *
 * @returns {Array<{kind:string,label:string,mcpSettings:string|null,
 *   rulesDir:string|null,hooksDir:string|null,scoped:boolean}>}
 */
export function discoverClineTargets() {
  const home = os.homedir();
  const targets = [];

  // ---- VS Code family extensions -------------------------------------------
  for (const { app, dir } of globalStorageRoots()) {
    for (const entry of safeReaddir(dir)) {
      if (!entry.isDirectory() || !CLINE_STORAGE.test(entry.name)) continue;
      const storage = path.join(dir, entry.name);
      const settings = mcpSettingsInside(storage);
      // A Cline storage directory with no settings file yet still counts: the
      // user has the extension, they just have no MCP servers configured.
      targets.push({
        kind: "extension",
        label: `${app} · ${entry.name}`,
        mcpSettings: settings,
        storageDir: storage,
        rulesDir: null,
        hooksDir: null,
        scoped: false,
      });
    }
  }

  // ---- CLI ------------------------------------------------------------------
  const cliData = path.join(home, ".cline", "data");
  const cliSettings =
    [
      path.join(cliData, "settings", "cline_mcp_settings.json"),
      path.join(home, ".cline", "mcp.json"),
    ].find((f) => fs.existsSync(f)) ?? path.join(cliData, "settings", "cline_mcp_settings.json");

  if (fs.existsSync(cliData) || fs.existsSync(path.join(home, ".cline"))) {
    targets.push({
      kind: "cli",
      label: "Cline CLI",
      mcpSettings: cliSettings,
      storageDir: path.join(home, ".cline"),
      rulesDir: path.join(home, "Documents", "Cline", "Rules"),
      hooksDir: path.join(home, "Documents", "Cline", "Hooks"),
      scoped: false,
    });
  }

  // ---- Global rules/hooks folders (shared by the extension) -----------------
  for (const target of targets) {
    if (target.rulesDir) continue;
    const rules = path.join(home, "Documents", "Cline", "Rules");
    const hooks = path.join(home, "Documents", "Cline", "Hooks");
    if (fs.existsSync(rules) || fs.existsSync(hooks)) {
      target.rulesDir = fs.existsSync(rules) ? rules : null;
      target.hooksDir = fs.existsSync(hooks) ? hooks : null;
    }
  }

  return targets;
}

/** Human-readable summary used by `setup` and `doctor`. */
export function describeTargets(targets) {
  if (!targets.length) return ["  (no Cline installation detected)"];
  return targets.map((t) => {
    const bits = [];
    bits.push(t.mcpSettings && fs.existsSync(t.mcpSettings) ? "mcp settings found" : "mcp settings will be created");
    if (t.rulesDir) bits.push("global rules");
    if (t.hooksDir) bits.push("global hooks");
    return `  [${t.kind === "cli" ? "cli" : "ext"}] ${t.label.padEnd(28)} ${bits.join(", ")}`;
  });
}
