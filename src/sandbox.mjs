/**
 * Sandboxed execution.
 *
 * The whole point: a subprocess runs the analysis, and ONLY its stdout is
 * allowed to cross back into the conversation. Raw file contents, log dumps,
 * HTML pages and test output stay here and are discarded.
 *
 * The sandbox is a process boundary, not a security boundary. See security.mjs
 * for the practical guardrails applied on top.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { tmpDir, limits } from "./config.mjs";
import { sandboxEnv, checkCommand } from "./security.mjs";

export const STATS_SENTINEL = "__CB_STATS__";

/* ------------------------------------------------------------------ plumbing */

/**
 * Byte counter shared by every instrumented module in the sandbox.
 *
 * This is what makes "how much did we keep out of the conversation?"
 * measurable. It is deliberately a LOWER BOUND: only the `node:fs`,
 * `node:fs/promises` and `node:child_process` surfaces are observed, and only
 * for Node runtimes. Other languages report stdout volume alone.
 */
const INSTRUMENT_CORE = `import { writeSync } from "node:fs";
globalThis.__cbRead = globalThis.__cbRead ?? 0;
export const __cbCount = (value) => {
  try {
    if (typeof value === "string") globalThis.__cbRead += Buffer.byteLength(value, "utf8");
    else if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) globalThis.__cbRead += value.byteLength;
  } catch {}
  return value;
};
export const __cbTotal = () => globalThis.__cbRead;
// Network payloads count too. Without this, "fetch a page in the sandbox"
// reports zero savings — the single most important case this tool exists for.
//
// We count at BODY-READ time, not from Content-Length: servers send the
// compressed size, so the header under-reports a gzipped page by 3-4x. Reading
// the body gives the real, decoded size, and a body nobody reads contributed
// nothing to the conversation anyway. Manual stream reads are not counted.
const __cbResponseProto = globalThis.Response && globalThis.Response.prototype;
if (__cbResponseProto) {
  for (const __cbMethod of ["text", "json", "arrayBuffer", "blob"]) {
    const __cbOriginal = __cbResponseProto[__cbMethod];
    if (typeof __cbOriginal !== "function") continue;
    Object.defineProperty(__cbResponseProto, __cbMethod, {
      value: async function (...args) {
        const result = await __cbOriginal.apply(this, args);
        try {
          if (typeof result === "string") globalThis.__cbRead += Buffer.byteLength(result, "utf8");
          else if (result instanceof ArrayBuffer) globalThis.__cbRead += result.byteLength;
          else if (result && typeof result.size === "number") globalThis.__cbRead += result.size;
        } catch {}
        return result;
      },
      writable: true,
      configurable: true,
    });
  }
}
// Writes to a piped stderr are ASYNCHRONOUS in Node, and a process that exits on
// an uncaught exception does not wait for them. The practical effect was that a
// failing script returned exactly zero stderr — the model saw "exit 1" and no
// reason why. Every diagnostic below therefore goes out through writeSync.
const __cbReport = () => {
  try {
    writeSync(2, "\\n${STATS_SENTINEL}" + JSON.stringify({ bytesRead: globalThis.__cbRead }) + "\\n");
  } catch {}
};

process.on("uncaughtException", (error) => {
  try {
    writeSync(2, "\\n" + (error?.stack ?? String(error)) + "\\n");
  } catch {}
  // If the script installed its own handler, let it deal with the error.
  if (process.listeners("uncaughtException").length <= 1) {
    __cbReport();
    process.exit(1);
  }
});

process.on("exit", __cbReport);
`;

const INSTRUMENT_FS = `import * as real from "node:fs";
import { __cbCount } from "./__cb_instrument.mjs";
export * from "node:fs";
export function readFileSync(...args) { return __cbCount(real.readFileSync(...args)); }
export function readFile(...args) {
  const result = real.readFile(...args);
  return result && typeof result.then === "function" ? result.then(__cbCount) : result;
}
export default new Proxy(real.default ?? real, {
  get(target, prop, receiver) {
    if (prop === "readFileSync") return readFileSync;
    if (prop === "readFile") return readFile;
    return Reflect.get(target, prop, receiver);
  },
});
`;

const INSTRUMENT_FSP = `import * as real from "node:fs/promises";
import { __cbCount } from "./__cb_instrument.mjs";
export * from "node:fs/promises";
export async function readFile(...args) { return __cbCount(await real.readFile(...args)); }
export default new Proxy(real.default ?? real, {
  get(target, prop, receiver) {
    if (prop === "readFile") return readFile;
    return Reflect.get(target, prop, receiver);
  },
});
`;

const INSTRUMENT_CP = `import * as real from "node:child_process";
import { __cbCount } from "./__cb_instrument.mjs";
export * from "node:child_process";
const wrap = (fn) => function (...args) {
  const result = fn.apply(this, args);
  try { if (result && typeof result === "object") { __cbCount(result.stdout); __cbCount(result.stderr); } } catch {}
  return result;
};
export const execSync = wrap(real.execSync);
export const spawnSync = wrap(real.spawnSync);
export default new Proxy(real.default ?? real, {
  get(target, prop, receiver) {
    if (prop === "execSync") return execSync;
    if (prop === "spawnSync") return spawnSync;
    return Reflect.get(target, prop, receiver);
  },
});
`;

const INSTRUMENT_FILES = {
  "__cb_instrument.mjs": INSTRUMENT_CORE,
  "__cb_fs.mjs": INSTRUMENT_FS,
  "__cb_fsp.mjs": INSTRUMENT_FSP,
  "__cb_cp.mjs": INSTRUMENT_CP,
};

/**
 * Redirect `node:fs` imports at the source level.
 *
 * Patching the module object is not enough: `import { readFileSync } from
 * "node:fs"` binds the original function and is unaffected by any later
 * mutation. Rewriting the specifier is the only way to observe named imports,
 * which is how most model-written code reads files.
 */
export function rewriteInstrumentedSpecifiers(source) {
  return String(source).replace(
    /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(["'])(?:node:)?(fs|fs\/promises|child_process)\2/g,
    (_match, lead, quote, mod) => {
      const file = mod === "fs" ? "__cb_fs.mjs" : mod === "fs/promises" ? "__cb_fsp.mjs" : "__cb_cp.mjs";
      return `${lead}${quote}./${file}${quote}`;
    }
  );
}

/* ----------------------------------------------------------------- runtimes */

function jsPreamble(typed) {
  const t = typed ? ": string | null" : "";
  // Imports are aliased to internal names so a user script that itself imports
  // `readFileSync` from "node:fs" (rewritten to ./__cb_fs.mjs) or `createRequire`
  // from "node:module" does not collide with the preamble's bindings.
  return `import { readFileSync as __cb_readFileSync } from "./__cb_fs.mjs";
import { createRequire as __cb_createRequire } from "node:module";
// Models write CommonJS as often as ESM. Provide require so both work — and
// Note that introducing require() into a module that ALSO has top-level await
// makes Node refuse the file outright. That is why the file read below is
// synchronous rather than awaited.
globalThis.require = globalThis.require || __cb_createRequire(import.meta.url);
const filePath${t} = process.env.CB_FILE_ORIG || null;
const content${t} = filePath ? __cb_readFileSync(filePath, "utf8") : null;
`;
}

/**
 * Runtime registry. Each entry declares how to detect the runtime and how to
 * turn a source string into a runnable invocation.
 */
const RUNTIMES = {
  javascript: {
    aliases: ["js", "node", "mjs"],
    candidates: ["node"],
    ext: ".mjs",
    args: (file) => [file],
    instrumented: true,
    preamble: () => jsPreamble(false),
  },
  typescript: {
    aliases: ["ts"],
    candidates: ["node"],
    ext: ".ts",
    // Node >= 23 strips types by default; older versions need the flag.
    args: (file) => [file],
    extraArgs: ["--experimental-strip-types"],
    instrumented: true,
    preamble: () => jsPreamble(true),
  },
  python: {
    aliases: ["py", "python3"],
    candidates: ["python", "python3", "py"],
    ext: ".py",
    args: (file) => [file],
    // Python on Windows encodes piped stdout with the ANSI codepage and
    // errors="replace", silently turning every non-ASCII character into '?'.
    // UTF-8 mode keeps both the source and the output byte-exact.
    env: { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    preamble: () =>
      `import os\n` +
      `filePath = os.environ.get("CB_FILE_ORIG")\n` +
      `content = open(filePath, encoding="utf-8", errors="replace").read() if filePath else None\n`,
  },
  shell: {
    aliases: ["bash", "sh"],
    candidates: ["bash", "sh"],
    ext: ".sh",
    args: (file) => [file],
    preamble: () =>
      `filePath="\${CB_FILE_ORIG:-}"\n` +
      `if [ -n "$filePath" ]; then content="$(cat "$filePath" 2>/dev/null)"; else content=""; fi\n`,
  },
  powershell: {
    aliases: ["pwsh", "ps1"],
    candidates: ["pwsh", "powershell"],
    ext: ".ps1",
    // Windows PowerShell 5.1 does not understand --version; use a trivial
    // command that both pwsh and powershell.exe can execute successfully.
    probeArgs: ["-NoProfile", "-NonInteractive", "-Command", "exit 0"],
    args: (file) => ["-NoProfile", "-NonInteractive", "-File", file],
    preamble: () =>
      `$filePath = $env:CB_FILE_ORIG\n` +
      `if ($filePath) { $content = Get-Content -Raw -LiteralPath $filePath } else { $content = $null }\n`,
  },
  batch: {
    aliases: ["bat", "cmd", "cmdscript"],
    candidates: ["cmd"],
    ext: ".bat",
    // `cmd --version` does not exist (and `/d /c exit 0` is the only probe form
    // that returns exit code 0 across cmd.exe implementations).
    probeArgs: ["/d", "/c", "exit 0"],
    args: (file) => ["/d", "/c", file],
    // cmd.exe's batch parser is DBCS-aware: on a double-byte system codepage
    // (e.g. cp936) a lead byte followed by a bare LF eats the line break, and
    // EVERY later line — even pure ASCII — is parsed wrong. CRLF endings make
    // the whole class of corruption disappear (verified on cp936: with LF,
    // `echo hello-world` after a line containing 你好 fails with "'hello-world'
    // is not recognized"; with CRLF, non-ASCII passes through byte-for-byte).
    crlf: true,
    // Batch has no multiline string variable, so `content` cannot be bound the
    // way the other runtimes bind it. Expose `filePath` instead; the script can
    // `type "%filePath%"` when it needs the file. `if not ...==""` (rather than
    // `if defined`) is used because CB_FILE_ORIG is always present, sometimes
    // empty — and an empty env var counts as "defined" on some cmd builds.
    preamble: () =>
      `@echo off\n` +
      `if not "%CB_FILE_ORIG%"=="" set "filePath=%CB_FILE_ORIG%"\n`,
  },
};

const resolvedCache = new Map();

/** Find a working executable for a runtime, or null. */
export function resolveRuntime(name) {
  const key = normalizeLanguage(name);
  if (!key) return null;
  if (resolvedCache.has(key)) return resolvedCache.get(key);
  const spec = RUNTIMES[key];
  const probeArgs = spec.probeArgs ?? ["--version"];
  let found = null;
  for (const candidate of spec.candidates) {
    const probe = spawnSync(candidate, probeArgs, { stdio: "ignore", windowsHide: true, shell: false });
    if (!probe.error && probe.status === 0) {
      found = { language: key, command: candidate, spec };
      break;
    }
  }
  resolvedCache.set(key, found);
  return found;
}

export function normalizeLanguage(name) {
  const n = String(name ?? "").trim().toLowerCase();
  if (!n) return null;
  if (RUNTIMES[n]) return n;
  for (const [key, spec] of Object.entries(RUNTIMES)) {
    if (spec.aliases.includes(n)) return key;
  }
  return null;
}

export function supportedLanguages() {
  return Object.keys(RUNTIMES);
}

export function detectRuntimes() {
  return Object.keys(RUNTIMES).map((language) => {
    const resolved = resolveRuntime(language);
    return {
      language,
      available: Boolean(resolved),
      command: resolved?.command ?? null,
      candidates: RUNTIMES[language].candidates,
      instrumented: Boolean(RUNTIMES[language].instrumented),
    };
  });
}

/* ------------------------------------------------------------- process mgmt */

function cap(buffer, chunk, limit) {
  if (buffer.length >= limit) return { buffer, dropped: chunk.length };
  const room = limit - buffer.length;
  if (chunk.length <= room) return { buffer: Buffer.concat([buffer, chunk]), dropped: 0 };
  return { buffer: Buffer.concat([buffer, chunk.subarray(0, room)]), dropped: chunk.length - room };
}

/** Slice a buffer to at most `limit` bytes without emitting a broken character. */
function truncateUtf8(buffer, limit) {
  let text = buffer.subarray(0, Math.max(0, limit)).toString("utf8");
  while (text.endsWith("\uFFFD")) text = text.slice(0, -1);
  return text;
}

function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

/* -------------------------------------------------------------------- run */

/**
 * Run a source string in an isolated subprocess.
 *
 * @returns {Promise<{ok:boolean, stdout:string, stderr:string, exitCode:number|null,
 *   timedOut:boolean, truncated:boolean, durationMs:number, language:string,
 *   command:string|null, bytesOut:number, stdoutBytesTotal:number, bytesRead:number}>}
 */
export async function run({
  language,
  code,
  cwd,
  timeoutMs = limits.timeoutMs,
  maxOutputBytes = limits.maxOutputBytes,
  captureLimit = null,
  filePath = null,
  env: extraEnv = {},
}) {
  const resolved = resolveRuntime(language);
  if (!resolved) {
    return {
      ok: false,
      stdout: "",
      stderr:
        `no runtime available for language "${language}". ` +
        `Supported: ${supportedLanguages().join(", ")}. ` +
        "Run `context-budget doctor` to see which are installed.",
      exitCode: null, timedOut: false, truncated: false, durationMs: 0,
      language: String(language), command: null, bytesOut: 0, stdoutCaptured: "", stdoutBytesTotal: 0, bytesRead: 0,
    };
  }

  const spec = resolved.spec;
  const id = crypto.randomBytes(6).toString("hex");
  const dir = path.join(tmpDir(), id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `script${spec.ext}`);

  // Instrumented runtimes always emit the preamble: it is what loads the byte
  // counter. Emitting it only when a file was supplied silently disabled all
  // measurement for plain ctx_execute calls.
  const preamble = spec.preamble && (spec.instrumented || filePath) ? spec.preamble(extraEnv) : "";
  const body = preamble + String(code ?? "");
  const source = spec.instrumented ? rewriteInstrumentedSpecifiers(body) : body;
  // Runtimes flagged `crlf` must be written with Windows line endings; see the
  // comment on the batch runtime for why this is correctness, not cosmetics.
  fs.writeFileSync(file, spec.crlf ? source.replace(/\r\n|\r|\n/g, "\r\n") : source, "utf8");

  if (spec.instrumented) {
    for (const [name, content] of Object.entries(INSTRUMENT_FILES)) {
      fs.writeFileSync(path.join(dir, name), content, "utf8");
    }
  }

  // Some runtimes need a flag before the script path (older Node type stripping).
  const flagArgs = [];
  if (spec.extraArgs && resolved.command === "node") {
    const probe = spawnSync(resolved.command, [...spec.extraArgs, "--version"], { stdio: "ignore", windowsHide: true });
    if (probe.error || probe.status !== 0) flagArgs.push(...spec.extraArgs);
  }

  const args = [...flagArgs, ...spec.args(file)];
  // spec.env provides runtime-level defaults (e.g. Python UTF-8 mode); an
  // explicit per-run env deliberately wins over them.
  const env = sandboxEnv({ ...spec.env, ...extraEnv, CB_FILE_ORIG: filePath ?? "", CB_SANDBOX_DIR: dir });

  const started = Date.now();
  // How much stdout we are willing to hold in memory. `maxOutputBytes` caps what
  // the MODEL sees; this caps what we KEEP, so intent-driven filtering can search
  // the whole output instead of only the part that happened to fit.
  const hardCap = captureLimit ?? Math.max(maxOutputBytes * 3, maxOutputBytes + 64 * 1024);

  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(resolved.command, args, {
        cwd: cwd || dir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      resolve({
        ok: false, stdout: "", stderr: `failed to spawn ${resolved.command}: ${error.message}`,
        exitCode: null, timedOut: false, truncated: false, durationMs: 0,
        language: resolved.language, command: resolved.command,
        bytesOut: 0, stdoutCaptured: "", stdoutBytesTotal: 0, bytesRead: 0,
      });
      return;
    }

    let stdout = Buffer.alloc(0);
    let stdoutBytesTotal = 0;
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      // Invariant: no more than maxOutputBytes ever leaves the sandbox.
      let out = stdout.toString("utf8");
      let outBytes = Buffer.byteLength(out, "utf8");
      if (outBytes > maxOutputBytes) {
        truncated = true;
        const notice = `\n…[truncated ${outBytes}→${maxOutputBytes} B]`;
        const room = Math.max(0, maxOutputBytes - Buffer.byteLength(notice, "utf8"));
        out = truncateUtf8(stdout, room) + notice;
        outBytes = Buffer.byteLength(out, "utf8");
        if (outBytes > maxOutputBytes) out = truncateUtf8(Buffer.from(out, "utf8"), maxOutputBytes);
      }

      // Keep the full capture for indexing; `out` is only what the model sees.
      const captured = stdout.toString("utf8");

      // Pull the instrumentation report out of stderr; it must never be shown.
      let err = stderr.toString("utf8");
      let bytesRead = 0;
      const marker = err.indexOf(STATS_SENTINEL);
      if (marker !== -1) {
        const json = err.slice(marker + STATS_SENTINEL.length).split("\n")[0];
        try { bytesRead = Number(JSON.parse(json).bytesRead) || 0; } catch { /* keep 0 */ }
        err = err.slice(0, marker).replace(/\s+$/, "");
      }

      resolve({
        ok: exitCode === 0 && !timedOut,
        stdout: out,
        stderr: err.length > 4096 ? err.slice(0, 4096) + `\n… (${err.length - 4096} more stderr bytes suppressed)` : err,
        exitCode,
        timedOut,
        truncated,
        durationMs: Date.now() - started,
        language: resolved.language,
        command: resolved.command,
        bytesOut: Buffer.byteLength(out, "utf8"),
        stdoutCaptured: captured,
        stdoutBytesTotal,
        bytesRead,
      });
    };

    child.stdout.on("data", (chunk) => {
      stdoutBytesTotal += chunk.length;
      const r = cap(stdout, chunk, hardCap);
      stdout = r.buffer;
      if (r.dropped || stdout.length >= maxOutputBytes * 3) truncated = true;
    });
    child.stderr.on("data", (chunk) => {
      const r = cap(stderr, chunk, 256 * 1024);
      stderr = r.buffer;
    });
    child.on("error", (error) => {
      stderr = Buffer.concat([stderr, Buffer.from(String(error.message), "utf8")]);
      finish(null);
    });
    child.on("close", (exitCode) => finish(exitCode));
  });
}

/** Convenience wrapper: run a single shell command through the deny-list first. */
export async function runCommand(command, opts = {}) {
  const verdict = checkCommand(command);
  // A null verdict means the command was empty/absent — refuse it the same way
  // as a denied command instead of crashing on property access.
  if (!verdict || !verdict.allowed) {
    return {
      ok: false, stdout: "",
      stderr: verdict?.reason ?? "refused by context-budget policy: empty or missing command.",
      exitCode: null, timedOut: false, truncated: false, durationMs: 0,
      language: "shell", command: null, bytesOut: 0, stdoutCaptured: "", stdoutBytesTotal: 0, bytesRead: 0, refused: true,
    };
  }
  return run({ language: "shell", code: command, ...opts });
}
