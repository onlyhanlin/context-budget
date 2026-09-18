/**
 * Containment rules for the sandbox.
 *
 * These are practical guardrails, not a security boundary. The sandbox is a
 * child process: it can do whatever the user account can do. What this module
 * buys you is that the *agent* cannot casually read outside the workspace or
 * shell out to something catastrophic without a human noticing.
 */
import path from "node:path";

/** Commands that are refused outright, with the reason shown to the model. */
const DENY_RULES = [
  { re: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+)+\/(\s|$)/, why: "recursive delete of filesystem root" },
  { re: /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+~(\/|\s|$)/, why: "recursive delete of home directory" },
  { re: /\bmkfs(\.|\s)/, why: "filesystem format" },
  { re: /\bdd\s+[^|]*of=\/dev\/(sd|nvme|hd)/, why: "raw write to a block device" },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: "fork bomb" },
  { re: /\bshutdown\b|\breboot\b|\bhalt\b/, why: "host power control" },
  { re: /\bformat\s+[a-zA-Z]:/i, why: "Windows volume format" },
  { re: /\bRemove-Item\b[^|]*-Recurse[^|]*-Force[^|]*\b[A-Za-z]:\\(\s|$)/i, why: "recursive delete of a drive root" },
  { re: /\bgit\s+push\s+[^|]*--force(?!-with-lease)/, why: "force push (use --force-with-lease)" },
  { re: /\b(curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(ba)?sh/i, why: "pipe remote content into a shell" },
];

export function checkCommand(command) {
  if (!command) return null;
  for (const rule of DENY_RULES) {
    if (rule.re.test(command)) {
      return {
        allowed: false,
        reason:
          `refused by context-budget policy: ${rule.why}. ` +
          "This is a genuine safety restriction, not a routing redirect — stop and ask the user if you believe it is required.",
      };
    }
  }
  return { allowed: true };
}

/**
 * Resolve a user-supplied path and refuse anything outside the workspace.
 * Symlinks are not resolved: a path that lexically stays inside the workspace
 * is allowed, which keeps behaviour predictable across platforms.
 */
export function resolveInsideWorkspace(root, candidate) {
  if (!candidate) return { ok: false, error: "path is required" };
  const abs = path.resolve(root, candidate);
  const rel = path.relative(root, abs);
  const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (!inside) {
    return {
      ok: false,
      error:
        `refused by context-budget policy: ${candidate} is outside the workspace (${root}). ` +
        "Run the tool from the project you actually want to inspect.",
    };
  }
  return { ok: true, path: abs };
}

/** Environment inherited by sandbox children. */
export function sandboxEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.CONTEXT_BUDGET_TOOL_CALL;
  return env;
}

export const DENY_PATTERN_SOURCE = DENY_RULES.map((r) => r.re.source);
