/**
 * Tool implementations.
 *
 * Every function here returns a STRING, and that string is the only thing that
 * reaches the model. Keeping the return path narrow is the entire product.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { projectRoot, limits, storageRoot, kbPath, VERSION } from "./config.mjs";
import { run, runCommand, normalizeLanguage, detectRuntimes } from "./sandbox.mjs";
import { resolveInsideWorkspace, checkCommand } from "./security.mjs";
import { discoverClineTargets } from "./cline-paths.mjs";
import { isRegistered, SERVER_NAME } from "./mcp-config.mjs";
import * as store from "./store.mjs";
import * as stats from "./stats.mjs";
import { formatBytes, estimateTokens } from "./text.mjs";

const SHELL_LANGUAGES = new Set(["shell", "powershell"]);

function renderHeader({ res, rawBytes = 0, outBytes = 0, note = "" }) {
  const parts = [];
  parts.push(res.timedOut ? "TIMED OUT" : res.exitCode === 0 ? "exit 0" : `exit ${res.exitCode ?? "?"}`);
  parts.push(`${res.durationMs} ms`);
  if (res.language) parts.push(res.language);
  if (rawBytes > 0) parts.push(`${formatBytes(rawBytes)} → ${formatBytes(outBytes)}`);
  if (res.truncated) parts.push("output truncated");
  if (note) parts.push(note);
  return `[${parts.join(" · ")}]`;
}

function renderResult(res, { rawBytes, outBytes, extraNote = "" }) {
  const lines = [renderHeader({ res, rawBytes, outBytes, note: extraNote })];
  const out = res.stdout.trimEnd();
  lines.push(out.length ? out : "(no stdout)");
  const err = res.stderr.trimEnd();
  if (err) lines.push("", "--- stderr ---", err);
  if (res.timedOut) lines.push("", `The script exceeded its ${limits.timeoutMs} ms budget and was killed. Narrow the work or raise timeout_ms.`);
  return lines.join("\n");
}

/* ------------------------------------------------------------ ctx_execute */

export async function ctxExecute(args = {}) {
  const language = String(args.language ?? "javascript");
  const code = String(args.code ?? "");
  if (!code.trim()) return "ctx_execute: \"code\" is required.";

  const normalized = normalizeLanguage(language);
  if (SHELL_LANGUAGES.has(normalized)) {
    const verdict = checkCommand(code);
    if (!verdict.allowed) {
      stats.record({ tool: "ctx_execute", ok: false });
      return verdict.reason;
    }
  }

  const timeoutMs = Number(args.timeout_ms) || limits.timeoutMs;
  const maxOutputBytes = Number(args.max_output_bytes) || limits.maxOutputBytes;
  const intent = typeof args.intent === "string" ? args.intent.trim() : "";
  const res = await run({
    language,
    code,
    cwd: projectRoot(),
    timeoutMs,
    maxOutputBytes,
    // An intent-filtered call must be able to search the WHOLE output. Capturing
    // only what fits in the response means searching the prefix — which is

    // exactly where the answer is not.
    captureLimit: intent ? 8 * 1024 * 1024 : null,
  });

  // Counterfactual: without the sandbox the model would have had to pull all of
  // this through the conversation. Take the larger of "what the script printed"
  // and "what it actually read" — both are lower bounds on the real saving.
  const rawBytes = Math.max(res.stdoutBytesTotal, res.bytesRead ?? 0);
  let text = renderResult(res, { rawBytes, outBytes: res.bytesOut });

  // Intent-driven filtering: when the payload blew past the cap, index the whole
  // thing and hand back only the slices that match what the caller asked for.
  if (intent && (res.truncated || res.stdoutBytesTotal > maxOutputBytes)) {
    const source = `exec:${crypto.randomBytes(4).toString("hex")}`;
    const indexed = res.stdoutCaptured || res.stdout;
    const indexedBytes = Buffer.byteLength(indexed, "utf8");
    const complete = indexedBytes >= res.stdoutBytesTotal;
    store.index({ source, content: indexed, title: intent.slice(0, 120) });
    const found = store.search([intent], { limit: 4, perQuery: 4 });
    const sections = found.results[0]?.matches ?? [];
    text = [
      renderHeader({ res, rawBytes, outBytes: res.bytesOut, note: "intent-filtered" }),
      `Output exceeded ${formatBytes(maxOutputBytes)}; it was indexed as source "${source}" instead of being returned whole.`,
      complete
        ? `${formatBytes(indexedBytes)} of output is searchable.`
        : `Only the first ${formatBytes(indexedBytes)} of ${formatBytes(res.stdoutBytesTotal)} was captured — re-run with a narrower query if the answer is not here.`,
      "",
      ...sections.flatMap((m) => [`## ${m.title || m.source}`, m.snippet, ""]),
      sections.length
        ? `Follow up with ctx_search(queries: [...], source: "${source}"). Searchable terms: ${(found.vocabulary || []).slice(0, 24).join(", ")}`
        : `No section matched the intent. Search it directly: ctx_search(queries: [...], source: "${source}")`,
    ].join("\n");
  }

  stats.record({
    tool: "ctx_execute",
    rawBytes,
    outBytes: Buffer.byteLength(text, "utf8"),
    durationMs: res.durationMs,
    ok: res.ok,
  });
  return text;
}

/* ------------------------------------------------------- ctx_execute_file */

export async function ctxExecuteFile(args = {}) {
  const rel = String(args.path ?? "");
  if (!rel) return "ctx_execute_file: \"path\" is required.";
  const root = projectRoot();
  const bounded = resolveInsideWorkspace(root, rel);
  if (!bounded.ok) return bounded.error;

  let size = 0;
  try {
    const st = fs.statSync(bounded.path);
    if (!st.isFile()) return `ctx_execute_file: ${rel} is not a regular file.`;
    size = st.size;
  } catch {
    return `ctx_execute_file: cannot read ${rel} (does it exist?)`;
  }
  if (size > limits.maxReadBytes) {
    return `ctx_execute_file: ${rel} is ${formatBytes(size)}, above the ${formatBytes(limits.maxReadBytes)} ceiling. Narrow the file first.`;
  }

  const language = String(args.language ?? "javascript");
  const code = String(args.code ?? "");
  if (!code.trim()) return "ctx_execute_file: \"code\" is required.";

  const timeoutMs = Number(args.timeout_ms) || limits.timeoutMs;
  const maxOutputBytes = Number(args.max_output_bytes) || limits.maxOutputBytes;
  const res = await run({
    language,
    code,
    cwd: root,
    timeoutMs,
    maxOutputBytes,
    filePath: bounded.path,
  });

  const rawBytes = Math.max(size, res.stdoutBytesTotal, res.bytesRead ?? 0);
  const text = renderResult(res, {
    rawBytes,
    outBytes: res.bytesOut,
    extraNote: `read ${rel}`,
  });

  stats.record({
    tool: "ctx_execute_file",
    source: rel,
    rawBytes,
    outBytes: Buffer.byteLength(text, "utf8"),
    durationMs: res.durationMs,
    ok: res.ok,
  });
  return text;
}

/* ----------------------------------------------------------- ctx_batch */

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function ctxBatch(args = {}) {
  const raw = Array.isArray(args.tasks) ? args.tasks : [];
  if (!raw.length) return "ctx_batch: provide \"tasks\" as an array of { label, command }.";
  // Labels become the index key. Two tasks sharing a label would make the second
  // OVERWRITE the first in the knowledge base, silently destroying output, so
  // duplicates are disambiguated here rather than at the storage layer.
  const MAX_TASKS = 24;
  const requested = raw.length;
  const usedLabels = new Map();
  const tasks = raw.slice(0, MAX_TASKS).map((task, index) => {
    let label = String(task?.label ?? `task-${index + 1}`).slice(0, 80);
    const seen = (usedLabels.get(label) ?? 0) + 1;
    usedLabels.set(label, seen);
    if (seen > 1) label = `${label}#${seen}`;
    return {
      label,
      command: String(task?.command ?? ""),
      cwd: task?.cwd ? String(task.cwd) : null,
    };
  });
  const dropped = Math.max(0, requested - tasks.length);
  const invalid = tasks.filter((t) => !t.command.trim());
  if (invalid.length) return `ctx_batch: these tasks have an empty command: ${invalid.map((t) => t.label).join(", ")}`;

  const concurrency = Math.max(1, Math.min(8, Number(args.concurrency) || 1));
  const timeoutMs = Number(args.timeout_ms) || limits.timeoutMs;
  const root = projectRoot();
  const perCommandCap = 2 * 1024 * 1024;

  const outcomes = await pool(tasks, concurrency, async (task) => {
    let cwd = root;
    if (task.cwd) {
      const bounded = resolveInsideWorkspace(root, task.cwd);
      if (!bounded.ok) {
        return { task, res: { ok: false, stdout: "", stderr: bounded.error, exitCode: null, durationMs: 0, truncated: false, timedOut: false, language: "shell", bytesOut: 0, stdoutBytesTotal: 0 } };
      }
      cwd = bounded.path;
    }
    const res = await runCommand(task.command, { cwd, timeoutMs, maxOutputBytes: perCommandCap });
    return { task, res };
  });

  const rawBytes = outcomes.reduce((sum, o) => sum + (o.res.stdoutBytesTotal || 0), 0);
  const sourceFor = (label) => `cmd:${label}`;

  // Everything is indexed, whether or not queries were supplied.
  for (const { task, res } of outcomes) {
    if (res.stdout) store.index({ source: sourceFor(task.label), content: res.stdout, title: task.command.slice(0, 160) });
  }

  const queries = Array.isArray(args.queries) ? args.queries.map(String).filter(Boolean) : [];
  const digestLines = outcomes.map(({ task, res }) => {
    const status = res.refused ? "REFUSED" : res.timedOut ? "TIMED OUT" : res.exitCode === 0 ? "exit 0" : `exit ${res.exitCode ?? "?"}`;
    return `- ${task.label}: ${status}, ${formatBytes(res.stdoutBytesTotal || 0)}${res.stderr && !res.stdout ? ` — ${res.stderr.split("\n")[0].slice(0, 160)}` : ""}`;
  });

  let body;
  let outNote = "";
  if (queries.length) {
    const found = store.search(queries, { limit: 8, perQuery: 2 });
    body = found.results
      .map((r) =>
        [
          `### ${r.query}`,
          ...(r.matches.length
            ? r.matches.flatMap((m) => [`[${m.source}] ${m.title || "(untitled)"}`, m.snippet, ""])
            : ["(no match)"]),
        ].join("\n")
      )
      .join("\n");
    outNote = "indexed + searched";
  } else {
    const digest = outcomes.map(({ task, res }) => {
      const out = res.stdout.trimEnd();
      if (!out) return `### ${task.label}\n(no stdout)`;
      const lines = out.split("\n");
      const head = lines.slice(0, 40).join("\n");
      const tail = lines.length > 60 ? lines.slice(-12).join("\n") : "";
      return [
        `### ${task.label}`,
        head,
        tail ? `… ${lines.length - 52} lines omitted (indexed as "${sourceFor(task.label)}")` : "",
        tail,
      ].filter(Boolean).join("\n");
    });
    body = digest.join("\n\n");
    outNote = "indexed";
  }

  const text = [
    `[${tasks.length} task(s)${dropped ? ` · ${dropped} DROPPED (cap ${MAX_TASKS})` : ""} · concurrency ${concurrency} · ${formatBytes(rawBytes)} processed → ${formatBytes(Buffer.byteLength(body, "utf8"))} returned]`,
    ...(dropped
      ? [`${dropped} of ${requested} tasks were NOT run: ctx_batch accepts at most ${MAX_TASKS} per call. Split the batch and call again.`]
      : []),
    ...digestLines,
    "",
    body,
    "",
    queries.length
      ? "Ask follow-ups with ctx_search(queries: [...])."
      : `Every output is indexed. Ask follow-ups with ctx_search(queries: [...])${tasks.length ? `, or narrow with source: "${sourceFor(tasks[0].label)}"` : ""}.`,
  ].join("\n");

  stats.record({
    tool: "ctx_batch",
    rawBytes,
    outBytes: Buffer.byteLength(text, "utf8"),
    durationMs: outcomes.reduce((s, o) => s + (o.res.durationMs || 0), 0),
    ok: outcomes.every((o) => o.res.ok),
  });
  return text;
}

/* ------------------------------------------------------------ ctx_index */

export async function ctxIndex(args = {}) {
  const source = String(args.source ?? "").trim();
  const content = String(args.content ?? "");
  if (!source) return "ctx_index: \"source\" is required (a short human label such as \"react-docs\" or a URL).";
  if (!content.trim()) return "ctx_index: \"content\" is empty, nothing to index.";

  const info = store.index({ source, content, title: String(args.title ?? "") });
  const text =
    `indexed "${info.source}": ${info.chunks} chunk(s), ${formatBytes(info.bytes)} ` +
    `(≈${info.indexedTokens} tokens kept out of context).\n` +
    `Retrieve with ctx_search(queries: [...]). A refresh after ${Math.round(limits.indexTtlMs / 3600000)}h re-indexes it.`;
  stats.record({ tool: "ctx_index", source, rawBytes: info.bytes, outBytes: Buffer.byteLength(text, "utf8") });
  return text;
}

/* ----------------------------------------------------------- ctx_search */

export async function ctxSearch(args = {}) {
  const queries = Array.isArray(args.queries) ? args.queries.map(String).filter(Boolean) : [];
  if (!queries.length) return "ctx_search: provide \"queries\" as a non-empty array. Batch every question into one call.";
  if (queries.length > 12) return "ctx_search: at most 12 queries per call. Split the batch.";

  const found = store.search(queries, {
    limit: Math.max(1, Math.min(20, Number(args.limit) || 6)),
    perQuery: Math.max(1, Math.min(6, Number(args.per_query) || 2)),
    source: args.source ? String(args.source) : null,
    mode: args.mode === "or" ? "or" : "and",
  });

  const body = found.results
    .map((r) =>
      [
        `### ${r.query}`,
        // Say so when the hit is fuzzy. A loose match presented as a real one is
        // worse than no match: the model cannot tell that only one word lined up.
        ...(r.partial ? ["(partial match — only some query terms appear in these results; verify before relying on them)"] : []),
        ...(r.matches.length
          ? r.matches.flatMap((m) => [
              `[${m.source}${m.title ? " › " + m.title : ""}]`,
              m.snippet,
              "",
            ])
          : [`(no match — ${found.totalChunks} chunk(s) indexed)`]),
      ].join("\n")
    )
    .join("\n");

  const text = [
    `[knowledge base: ${found.totalChunks} chunk(s), ${queries.length} quer${queries.length === 1 ? "y" : "ies"}]`,
    body,
    found.vocabulary.length ? `\nSearchable terms: ${found.vocabulary.slice(0, 30).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  stats.record({ tool: "ctx_search", outBytes: Buffer.byteLength(text, "utf8") });
  return text;
}

/* ------------------------------------------------------------ ctx_stats */

export async function ctxStats(args = {}) {
  const s = stats.summary({ session: args.session === true });
  const scope = args.session === true ? s.session : s.lifetime;
  const lines = [
    `context-budget ${VERSION} · project ${path.basename(projectRoot())}`,
    `session ${s.sessionId}`,
    "",
    args.session === true ? "THIS SESSION" : "THIS PROJECT (lifetime)",
    `  calls            ${scope.calls}`,
    `  bytes processed  ${formatBytes(scope.inBytes)}`,
    `  bytes returned   ${formatBytes(scope.outBytes)}`,
    `  kept out         ${formatBytes(scope.savedBytes)}  (≈${scope.savedTokens.toLocaleString()} tokens)`,
  ];
  if (scope.inBytes > 0) lines.push(`  reduction        ${(scope.ratio * 100).toFixed(1)}%`);
  if (s.byTool.length) {
    lines.push("", "BY TOOL");
    for (const t of s.byTool) {
      lines.push(`  ${t.tool.padEnd(17)} ${String(t.calls).padStart(4)} calls   ${formatBytes(t.savedBytes).padStart(10)} kept out`);
    }
  }
  lines.push(
    "",
    `all projects: ${s.allProjects.calls} calls, ${formatBytes(s.allProjects.savedBytes)} kept out`,
    `storage: ${s.storageRoot}`
  );
  return lines.join("\n");
}

/* ------------------------------------------------------------- ctx_doctor */

export async function ctxDoctor() {
  const runtimes = detectRuntimes();
  const lines = [`context-budget ${VERSION}`, `node ${process.version}`, `platform ${process.platform}`, ""];
  lines.push("runtime", ...runtimes.map((r) => `  [${r.available ? "x" : " "}] ${r.language.padEnd(12)} ${r.command ?? "not found — tried " + r.candidates.join(", ")}`));

  let sqliteOk = false;
  let ftsOk = false;
  let sqliteError = "";
  // Importing node:sqlite emits an ExperimentalWarning on stderr. A diagnostic
  // command should not greet the user with a warning it caused on purpose.
  const emitWarning = process.emitWarning;
  process.emitWarning = () => {};
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const probe = new DatabaseSync(":memory:");
    probe.exec("CREATE VIRTUAL TABLE t USING fts5(a)");
    probe.exec("INSERT INTO t VALUES ('ok')");
    sqliteOk = probe.prepare("SELECT count(*) AS n FROM t WHERE t MATCH 'ok'").get().n === 1;
    ftsOk = sqliteOk;
    probe.close();
  } catch (error) {
    sqliteError = error.message;
  } finally {
    process.emitWarning = emitWarning;
  }
  lines.push("", "storage");
  lines.push(`  [${sqliteOk ? "x" : " "}] node:sqlite +${ftsOk ? " FTS5" : ""}${sqliteError ? ` — ${sqliteError}` : ""}`);
  lines.push(`  [x] root      ${storageRoot()}`);
  lines.push(`  [x] knowledge ${kbPath()}`);
  lines.push(`  [x] stats     ${stats.summary().statsFile}`);
  lines.push(`  [x] workspace ${projectRoot()}`);
  lines.push("", "cline");
  const targets = discoverClineTargets();
  if (!targets.length) {
    lines.push("  (no Cline installation detected)");
  } else {
    for (const target of targets) {
      const settings = target.mcpSettings;
      const state = !settings
        ? "no mcp settings file"
        : isRegistered(settings)
          ? "mcp: registered"
          : "mcp: NOT registered";
      lines.push(`  [x] ${target.label.padEnd(30)} ${state}`);
      if (settings) lines.push(`      ${settings}`);
    }
  }
  lines.push("", "hooks: run `context-budget setup` — dry run by default, `--yes` applies.");
  lines.push(`mcp server name expected in settings: "${SERVER_NAME}"`);
  return lines.join("\n");
}

export const STATS = { record: stats.record, summary: stats.summary };
