/**
 * Shared hook runtime.
 *
 * A file hook receives a JSON payload on stdin and prints a JSON object on
 * stdout. It runs before (and after) every single tool call, so this code must
 * be fast, must never throw, and must never block the agent by accident.
 *
 * OUTPUT CONTRACT — verified against Cline's own source
 * (apps/vscode/src/core/hooks/hook-factory.ts, which validates the response):
 *
 *     { cancel: boolean, contextModification: string, errorMessage: string }
 *
 * The VS Code extension reads `contextModification`. The SDK/CLI file hooks
 * read `context`. We emit BOTH so one hook works on every surface. Getting this
 * wrong is silent: the hook "succeeds" and the model simply never sees it.
 *
 * stdout is reserved for the JSON. Diagnostics go to stderr.
 */
import process from "node:process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WEB_FETCH_TOOLS = new Set(["fetch_web_content", "web_fetch", "WebFetch", "fetch_url"]);
const EDITOR_TOOLS = new Set(["editor", "write_file", "apply_patch", "replace_in_file", "edit_file", "str_replace_editor"]);

/** Commands whose output is routinely enormous. */
const NOISY_COMMAND = [
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|install|ci)\b/,
  /\b(vitest|jest|pytest|go test|cargo (test|build)|mvn|gradle|dotnet (build|test))\b/,
  /\bgit\s+(log|diff|show)\b/,
  /\b(rg|grep)\s+.*(-r|--recursive|-R)\b/,
  /\b(find|fd)\s+/,
  /\b(docker|kubectl|helm)\s+(logs|describe|build|get)\b/,
  /\b(ls|dir|tree)\s+.*(-R|--recursive)\/?/,
  /\b(cat|type|Get-Content)\s+\S*(log|lock|json)\b/i,
  /\bpip\s+(list|freeze)\b|\bnpm\s+ls\b/,
  /\bcurl\b|\bwget\b/,
];

export const HOOK_EVENTS = ["pretooluse", "posttooluse", "precompact", "taskresume"];

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) return resolve("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
      if (data.length > 16 * 1024 * 1024) { process.stdin.destroy(); resolve(data); }
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

/* ------------------------------------------------------------ fetch policy */

const FETCH_WINDOW_MS = 10 * 60 * 1000;
/** After this many cancellations of the same URL, let it through. */
const FETCH_CANCEL_LIMIT = 2;

/**
 * How to treat a page fetch.
 *
 *   nudge  (default) — let it through, tell the model to use the sandbox NEXT time.
 *   cancel           — block the call and demand a redirect. Opt-in.
 *   off              — say nothing.
 *
 * Why `nudge` is the default: Cline's CombinedHookRunner documents that
 * "if ANY hook requests cancellation, the task will be cancelled" — cancellation
 * is task-scoped, not call-scoped. Blocking a fetch can therefore end the user's
 * whole run, and if the model does not switch to ctx_execute the user simply
 * does not get the page. That is too sharp an edge for a default.
 *
 * Injected context only affects FUTURE decisions anyway, so on the first fetch
 * a nudge is useless either way; from the second fetch onward it does the work,
 * which is where most of the saving lives.
 */
export function fetchPolicy(env = process.env) {
  const mode = String(env.CONTEXT_BUDGET_FETCH ?? "nudge").toLowerCase();
  return ["off", "nudge", "cancel"].includes(mode) ? mode : "nudge";
}

function storageRoot() {
  return process.env.CONTEXT_BUDGET_DIR || path.join(os.homedir(), ".context-budget");
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(storageRoot(), "hook-state.json"), "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(storageRoot(), { recursive: true });
    fs.writeFileSync(path.join(storageRoot(), "hook-state.json"), JSON.stringify(state));
  } catch {
    /* best effort */
  }
}

function cancelCount(url) {
  const record = readState().fetchCancels?.[url];
  if (!record || Date.now() - record.at > FETCH_WINDOW_MS) return 0;
  return Number(record.count) || 0;
}

function bumpCancelCount(url) {
  const state = readState();
  const cancels = state.fetchCancels ?? {};
  const record = cancels[url];
  const expired = !record || Date.now() - record.at > FETCH_WINDOW_MS;
  cancels[url] = { count: expired ? 1 : (Number(record.count) || 0) + 1, at: Date.now() };
  for (const [key, value] of Object.entries(cancels)) {
    if (Date.now() - value.at > FETCH_WINDOW_MS) delete cancels[key];
  }
  writeState({ ...state, fetchCancels: cancels });
}

/** Domains the user has explicitly opted out of interception. */
function domainAllowed(url) {
  const fromEnv = String(process.env.CONTEXT_BUDGET_FETCH_ALLOW ?? "").split(",");
  let fromFile = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(storageRoot(), "fetch-allow.json"), "utf8"));
    if (Array.isArray(parsed.allow)) fromFile = parsed.allow;
  } catch {
    /* no allowlist file */
  }
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return [...fromEnv, ...fromFile]
    .map((d) => String(d).trim().toLowerCase())
    .filter(Boolean)
    .some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * Cancelling is only safe when the redirect target actually exists. If
 * context-budget is not registered as an MCP server in any detected Cline
 * install, `ctx_execute` is not callable and blocking would leave the model
 * with nowhere to go.
 */
async function redirectAvailable() {
  if (String(process.env.CONTEXT_BUDGET_MCP_ASSUME ?? "") === "registered") return true;
  if (String(process.env.CONTEXT_BUDGET_MCP_ASSUME ?? "") === "missing") return false;
  try {
    const [{ discoverClineTargets }, { isRegistered }] = await Promise.all([
      import("../src/cline-paths.mjs"),
      import("../src/mcp-config.mjs"),
    ]);
    return discoverClineTargets().some((t) => t.mcpSettings && isRegistered(t.mcpSettings));
  } catch {
    return false;
  }
}

function fetchNudge(url) {
  return (
    `Page fetches are better routed through the sandbox: ctx_execute has full network access and only what you console.log() enters the conversation. ` +
    `For the NEXT page use ctx_execute(language: "javascript", code: "const res = await fetch('${url || "URL"}'); ... console.log(extracted)"), ` +
    `or ctx_index the page if you will need it for several later questions.`
  );
}

async function decideFetch(url) {
  const mode = fetchPolicy();
  if (mode === "off") return { cancel: false };

  if (mode === "nudge" || domainAllowed(url)) {
    return { cancel: false, contextModification: fetchNudge(url) };
  }

  if (!(await redirectAvailable())) {
    return {
      cancel: false,
      contextModification:
        `${fetchNudge(url)} (Not enforcing this one: context-budget is not registered as an MCP server in this Cline install yet, ` +
        `so ctx_execute is not callable. Run \`context-budget setup --yes\` and enable hooks.)`,
    };
  }

  if (cancelCount(url) >= FETCH_CANCEL_LIMIT) {
    return {
      cancel: false,
      contextModification: `${fetchNudge(url)} (Allowing this one through — the same URL has been redirected repeatedly.)`,
    };
  }

  bumpCancelCount(url);
  return {
    cancel: true,
    errorMessage:
      `redirected to ctx_execute — it has full network access and only the bytes you console.log() reach the conversation. ` +
      `Call ctx_execute(language: "javascript", code: "const res = await fetch('${url || "the URL"}'); ... console.log(extracted)") now. ` +
      `If you need the whole page for later questions, ctx_index it instead of returning it. ` +
      `If ctx_execute is genuinely unavailable to you, say so plainly instead of retrying this fetch.`,
  };
}

/**
 * Cline has two payload shapes in the wild:
 *   extension  { hookName: "PreToolUse", preToolUse: { toolName, parameters } }
 *   sdk/cli    { hookName: "tool_call", tool_call: { name, input } }
 */
export function normalizePayload(payload) {
  const sdk = payload?.tool_call ?? payload?.toolCall ?? {};
  const ext = payload?.preToolUse ?? {};
  const name = sdk.name ?? ext.toolName ?? payload?.tool_name ?? payload?.toolName ?? ext.tool_name ?? "";
  const input = sdk.input ?? ext.parameters ?? payload?.tool_input ?? payload?.toolInput ?? ext.input ?? {};
  const result = payload?.tool_result ?? payload?.toolResult ?? payload?.postToolUse ?? {};
  const output =
    typeof result.output === "string" ? result.output
    : typeof result.result === "string" ? result.result
    : typeof payload?.output === "string" ? payload.output
    : "";
  return {
    event: payload?.hookName ?? payload?.hook ?? "",
    toolName: String(name),
    input: input && typeof input === "object" ? input : {},
    output,
    workspaceRoots: Array.isArray(payload?.workspaceRoots) ? payload.workspaceRoots : [],
    raw: payload,
  };
}

function firstString(...values) {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return "";
}

/** Byte size of a file, or 0 when it cannot be stat'ed. */
function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

/* ------------------------------------------------------- pre-compaction card */

const FILE_RE = /(?:[A-Za-z]:)?[\w./\\-]*[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|h|cpp|hpp|cs|md|json|ya?ml|toml|css|html|sql|sh|ps1)\b/g;
const ERROR_RE = /(?:error TS\d+|\bError:|\berror:|\bFAILED\b|\bexit code [1-9]\d*\b|\bcommand failed\b)[^\n"]{0,160}/g;
const COMMAND_RE = /"command"\s*:\s*"((?:[^"\\]|\\.){1,200})"/g;
const USER_TEXT_RE = /"ask"\s*:\s*"followup"[\s\S]{0,6000}?"text"\s*:\s*"((?:[^"\\]|\\.){1,600})"/g;

function uniqCap(list, cap) {
  return [...new Set(list.map((s) => String(s).replace(/\\n/g, " ").trim()).filter(Boolean))].slice(-cap);
}

/**
 * Build a small working-state card from the pre-compaction conversation.
 *
 * Best-effort and deliberately capped: the point is a ≤2 KB card that says
 * "here is where we were", not a summary of the whole session. The full history
 * is indexed separately and stays searchable with ctx_search.
 */
export function buildSnapshotCard({ raw = "", json = "", strategy = "", contextSize = 0, maxChars = 2000 }) {
  const source = json && json.length > raw.length ? json : raw;
  const text = String(source ?? "");

  const prompts = [...text.matchAll(USER_TEXT_RE)].map((m) => m[1]);
  const files = [...text.matchAll(FILE_RE)].map((m) => m[0]);
  const errors = [...text.matchAll(ERROR_RE)].map((m) => m[0]);
  const commands = [...text.matchAll(COMMAND_RE)].map((m) => m[1]);

  const lines = ["WORKING STATE (captured just before context compaction)"];
  if (contextSize) lines.push(`context was ${contextSize}% full · strategy ${strategy || "unknown"}`);

  const lastPrompt = prompts.length ? prompts[prompts.length - 1] : "";
  lines.push("", "LAST USER REQUEST", lastPrompt || "(not recovered)");

  const recentFiles = uniqCap(files, 15);
  if (recentFiles.length) lines.push("", "FILES TOUCHED", ...recentFiles.map((f) => `- ${f}`));

  const recentErrors = uniqCap(errors, 5);
  if (recentErrors.length) lines.push("", "UNRESOLVED-LOOKING ERRORS", ...recentErrors.map((e) => `- ${e}`));

  const recentCommands = uniqCap(commands, 6);
  if (recentCommands.length) lines.push("", "COMMANDS RUN", ...recentCommands.map((c) => `- ${c}`));

  lines.push(
    "",
    "The full pre-compaction conversation was indexed. Before asking the user to repeat",
    'anything, search it: ctx_search(queries: ["..."], source: "compaction:<taskId>").'
  );

  let card = lines.join("\n");
  if (card.length > maxChars) card = card.slice(0, maxChars - 20) + "\n…(card truncated)";
  return card;
}

function readEphemeral(file) {
  const p = firstString(file);
  if (!p) return "";
  try {
    const size = fileSize(p);
    if (!size || size > 8 * 1024 * 1024) return "";
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------- decisions */

/** Hand back a pending post-compaction state card, if there is one. */
async function drainSnapshot() {
  try {
    const store = await import("../src/store.mjs");
    const snap = store.takeSnapshot();
    if (!snap) return null;
    // Do not resurrect ancient state in a task the user has moved on from.
    if (snap.ageMs > 60 * 60 * 1000) return null;
    return `<session_knowledge>\n${snap.summary}\n</session_knowledge>`;
  } catch (error) {
    process.stderr.write(`[context-budget] snapshot restore failed: ${error?.message ?? error}\n`);
    return null;
  }
}

export async function decidePreToolUse(payload) {
  const { toolName, input } = normalizePayload(payload);
  const lower = toolName.toLowerCase();

  // Writes and edits need the exact bytes in context; never interfere.
  if (EDITOR_TOOLS.has(toolName) || /patch|write|edit/.test(lower)) return { cancel: false };

  if (WEB_FETCH_TOOLS.has(toolName) || /^web_?fetch$/.test(lower)) {
    return decideFetch(firstString(input.url, input.uri, input.href));
  }

  const filePath = firstString(input.path, input.file_path, input.filePath, input.absolutePath);
  if (filePath && /read|open/.test(lower)) {
    const size = fileSize(filePath);
    if (size > 40_000) {
      return {
        cancel: false,
        contextModification:
          `${filePath} is ${Math.round(size / 1024)} KB — reading it whole costs roughly ${Math.round(size / 4000)}k tokens and stays in context for the rest of the session. ` +
          `If you are ANALYZING it, use ctx_execute_file(path, language, code) and console.log() only the answer. ` +
          `Read it directly only if you are about to EDIT it.`,
      };
    }
  }

  const command = firstString(input.command, input.cmd, input.script, input.query);
  if (command && NOISY_COMMAND.some((re) => re.test(command))) {
    return {
      cancel: false,
      contextModification:
        `"${command.slice(0, 120)}" tends to produce a lot of output. ` +
        `Consider ctx_batch(tasks: [{ label, command }], queries: [...]) — it runs the command, indexes the output, and returns only matching sections. ` +
        `Run it directly if you already know the output is short.`,
    };
  }

  const restored = await drainSnapshot();
  return restored ? { cancel: false, contextModification: restored } : { cancel: false };
}

export async function decidePostToolUse(payload) {
  const { toolName, output } = normalizePayload(payload);
  const restored = await drainSnapshot();
  if (restored) return { cancel: false, contextModification: restored };

  const bytes = Buffer.byteLength(output ?? "", "utf8");
  if (bytes < 30_000) return { cancel: false };
  return {
    cancel: false,
    contextModification:
      `The last ${toolName || "tool"} call returned ${Math.round(bytes / 1024)} KB (${Math.round(bytes / 4000)}k tokens) which is now permanently in context. ` +
      `For the next bulk read, prefer ctx_execute / ctx_execute_file / ctx_batch so only the derived answer enters the conversation. ` +
      `You can also ctx_index the relevant part now so it stays searchable after compaction.`,
  };
}

/**
 * PreCompact: capture, do not talk.
 *
 * Cline deletes contextJsonPath / contextRawPath the moment this hook returns,
 * so everything we want has to be read and copied here.
 */
export async function decidePreCompact(payload) {
  const data = payload?.preCompact ?? {};
  const raw = readEphemeral(data.contextRawPath);
  const json = readEphemeral(data.contextJsonPath);
  const card = buildSnapshotCard({
    raw,
    json,
    strategy: data.compactionStrategy,
    contextSize: data.contextSize,
  });

  let indexed = 0;
  let saved = false;
  try {
    if (raw || json) {
      const store = await import("../src/store.mjs");
      const info = store.index({
        source: `compaction:${firstString(data.taskId) || "latest"}`,
        content: raw || json,
        title: "pre-compaction conversation",
      });
      indexed = info.chunks;
      // Only persist a card when we actually captured something. An empty card
      // would otherwise be injected into the next tool call for no reason.
      store.saveSnapshot({ summary: card, task: firstString(data.taskId), strategy: firstString(data.compactionStrategy) });
      saved = true;
    }
  } catch (error) {
    process.stderr.write(`[context-budget] precompact capture failed: ${error?.message ?? error}\n`);
  }
  void saved;

  process.stderr.write(
    `[context-budget] precompact captured ${indexed} chunk(s), card ${Buffer.byteLength(card, "utf8")} B\n`
  );
  return { cancel: false };
}

/** TaskResume: restore. Falls back silently when there is nothing to restore. */
export async function decideTaskResume() {
  const restored = await drainSnapshot();
  return restored ? { cancel: false, contextModification: restored } : { cancel: false };
}

/* ---------------------------------------------------------------- driver */

const DECIDERS = {
  pretooluse: decidePreToolUse,
  posttooluse: decidePostToolUse,
  precompact: decidePreCompact,
  taskresume: decideTaskResume,
};

function emit(decision) {
  const out = { cancel: decision?.cancel === true };
  if (typeof decision?.errorMessage === "string" && decision.errorMessage) out.errorMessage = decision.errorMessage;

  // On a cancellation the redirect explanation must reach the model by every
  // channel available: it is unclear whether errorMessage is surfaced to the
  // model or only shown to the user, and a silent cancellation is the exact
  // failure mode ADR-0003 warns about. Mirror it into contextModification too.
  const context =
    typeof decision?.contextModification === "string" && decision.contextModification
      ? decision.contextModification
      : out.cancel && out.errorMessage
        ? out.errorMessage
        : null;

  if (context) {
    out.contextModification = context; // VS Code extension
    out.context = context;             // SDK / CLI file hooks
  }
  process.stdout.write(JSON.stringify(out));
}

export async function runHookEvent(event) {
  if (process.env.CONTEXT_BUDGET_HOOKS === "off") return emit({ cancel: false });

  let payload = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) payload = JSON.parse(raw);
  } catch {
    return emit({ cancel: false });
  }

  const decide = DECIDERS[event];
  if (!decide) return emit({ cancel: false });

  try {
    return emit(await decide(payload));
  } catch (error) {
    process.stderr.write(`[context-budget] hook error (failing open): ${error?.message ?? error}\n`);
    return emit({ cancel: false });
  }
}

export const HOOK_HELPERS = { normalizePayload, buildSnapshotCard };
