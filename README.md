# context-budget

**Pour off the answer, leave the sediment.**

Raw tool output is what fills a context window. A 50 KB file is roughly 13,000
tokens, and once it is in the conversation it is re-sent on **every later turn**
until something compacts it away. This project moves that work into a sandbox
and keeps an index instead of a transcript.

Works with **Cline** (extension and CLI) and any other MCP client.

---

## What it actually does

| Layer | Tool | Effect |
|---|---|---|
| **Sandbox** | `ctx_execute` `ctx_execute_file` `ctx_batch` | A subprocess runs the analysis. **Only stdout returns.** File contents, log dumps and HTML never enter the conversation. |
| **Index** | `ctx_index` `ctx_search` | Documents and command output are chunked and stored in SQLite **FTS5**. You search them later instead of pasting them now. |
| **Enforcement** | Cline hooks | `PreToolUse` redirects page fetches and nudges oversized reads before they happen. This is the difference between ~60% and ~98% effectiveness. |
| **Continuity** | `PreCompact` + `TaskResume` | Captures a ≤2 KB working-state card just before compaction and hands it back afterwards, so a compacted or resumed task does not restart by asking what you were doing. |
| **Accounting** | `ctx_stats` | Every call records how many bytes stayed in the sandbox. Measured, not claimed. |

### Measured on this repository

```
$ npm run bench -- src

A. naive read (native read_file per file)
   payload     61.8 KB  ≈ 15,828 tokens
   plus one tool round trip per file (8 round trips)

B. ctx_execute (one script, only stdout returns)
   payload        57 B  ≈ 15 tokens
   one round trip, 179 ms wall clock

payload kept out of context: 61.8 KB (99.9%)
```

> That is a **payload-only** comparison. It does not model tool-schema overhead,
> routing rules or prompt caching, so treat it as an upper bound. Use
> `context-budget stats` for your real sessions.

---

## Requirements

- **Node.js ≥ 22.5** — the knowledge base uses the built-in `node:sqlite` with
  FTS5. No native compilation, no `better-sqlite3`.
- Python, bash and PowerShell are optional; `context-budget doctor` reports
  which runtimes are available.

---

## Install

```bash
npm install -g context-budget

# or from a clone
npm install && npm link
```

### Run the installer

```bash
cd /path/to/your/project
context-budget setup          # DRY RUN — shows exactly what it would change
context-budget setup --yes    # apply
```

`setup` is a real installer, not a snippet to paste. It:

1. **Installs four hooks** — `PreToolUse`, `PostToolUse`, `PreCompact`,
   `TaskResume` — into both the workspace (`.clinerules/hooks/`, `.cline/hooks/`)
   and, with `--global`, `~/Documents/Cline/Hooks/`.
2. **Finds every Cline installation on the machine.** It enumerates
   `<editor>/User/globalStorage` roots and picks out the Cline-owned storage
   directories rather than checking a hard-coded list of editors — so forks get
   detected too. On the author's machine that is the VS Code extension, a
   `codearts-agent` install, and the CLI.
3. **Registers the MCP server** by merging a single key into `mcpServers` of
   each `cline_mcp_settings.json`. It never replaces the file, never touches
   another server's entry, and writes a timestamped `.backup-…` sibling first.
4. **Verifies** the routing logic and that every generated launcher points at an
   entry that exists.

Example dry run:

```
Cline installs detected
  [ext] Code · saoudrizwan.claude-dev   mcp settings found, global rules, global hooks
  [cli] Cline CLI                       mcp settings found, global rules, global hooks

Hook + rules files: 17 to create, 0 to update, 0 already current
  create    .clinerules/context-budget.md   (routing rules)
  ...

MCP server registration
  update    Code · saoudrizwan.claude-dev → …/settings/cline_mcp_settings.json
            1 other server(s) preserved: mcp-filesystem

DRY RUN — nothing was written. Re-run with --yes to apply.
```

```bash
context-budget setup --global      # rules + hooks for every workspace
context-budget setup --hooks-only  # skip MCP registration
context-budget setup --mcp-only    # skip the hook files
```

### Then do the one thing it cannot do for you

**Cline → Settings → Features → "Enable Hooks".**

Without that switch the hook files exist but never fire, and routing drops from
enforced back to advisory — the difference between roughly 98% and 60%
effectiveness.

### Verify

```bash
context-budget doctor          # runtimes, storage, detected Cline installs, hook checks
context-budget doctor --fix    # rewrite launchers pointing at a moved package
```

To confirm the hook fires end to end without waiting for the agent:

```bash
echo '{"tool_call":{"name":"fetch_web_content","input":{"url":"https://example.com"}}}' \
  | node "$(npm root -g)/context-budget/hooks/pretooluse.mjs"
# → {"cancel":true,"errorMessage":"redirected to ctx_execute — ..."}
```

### Uninstall

```bash
context-budget uninstall          # dry description
context-budget uninstall --yes    # reverse exactly what setup did
```

Every generated file carries a `context-budget:generated` marker. Uninstall
deletes **only** marked files — a `PreToolUse` hook you wrote yourself in the
same directory is left untouched — and removes only the `context-budget` key
from `mcpServers`, again with a backup.

---

## Tools

| Tool | Use it for |
|---|---|
| `ctx_execute(language, code)` | Derive an answer from data. Only `console.log()` output returns. |
| `ctx_execute_file(path, language, code)` | Analyze one file. Its text is bound to the variable `content`. |
| `ctx_batch(tasks, queries)` | Several commands in ONE call; outputs are indexed and your questions answered in the same round trip. |
| `ctx_index(source, content)` | Store a document instead of pasting it. |
| `ctx_search(queries, source?)` | Search everything already indexed. Batch all your questions into one array. |
| `ctx_stats(session?)` | Bytes and tokens kept out, per tool. |
| `ctx_doctor()` | Runtimes, FTS5, storage paths. |

### When the sandbox is the wrong answer

- **You are about to edit a file** → use the native read tool. The editor needs
  the exact bytes to match against.
- **The output is short and known** (`pwd`, a clean `git status`) → run it
  directly; the sandbox adds overhead for no gain.
- **The command changes state** (`git commit`, `npm install`) → native tool.
  Sandbox file writes are discarded.
- **You need a browser interaction**, not a page fetch → native browser tool.

---

## How it works

```
                    ┌─────────────────────────┐
  Cline ──MCP──────▶│  context-budget          │
   │                │   ├ sandbox (subprocess) │──▶ only stdout returns
   │                │   ├ knowledge base (FTS5)│──▶ chunked, searchable
   └──hooks────────▶│   └ ledger (SQLite)      │──▶ ctx_stats
                    └─────────────────────────┘
```

**The invariant.** A sandbox call never returns more than
`CB_MAX_OUTPUT_BYTES` (default 8 KB) to the model. Everything else is
truncated, indexed, or discarded.

**The measurement.** Node runtimes get an instrumentation preamble that counts
every byte the script pulls off disk, out of a child process, or out of a
network response body. `ctx_stats` reports the larger of "what the script
printed" and "what it actually read", so a sandboxed page fetch is credited with
the whole page rather than the three lines it logged.

Two honest caveats: it is a **lower bound** (only `node:fs`,
`node:fs/promises`, `node:child_process` and `Response` body reads are
observed, and only for Node), and network size is taken from the **decoded**
body rather than `Content-Length`, because servers report the compressed size —
which under-reports a gzipped page by 3–4x.

**The search.** Content is chunked by markdown heading with code fences kept
intact, then indexed with `porter unicode61`. CJK text is stored with each
character space-separated, because SQLite otherwise treats a whole Han run as
a single token and Chinese search stops working. Queries are matched with AND,
falling back to OR and then to a substring scan for partial identifiers.

---

## What happens when you ask it to read a web page

Short answer: **by default it reads the page.** The hook nudges, it does not block.

This is a deliberate reversal of the obvious design, for two reasons found in
Cline's own source:

1. **Cancellation is task-scoped, not call-scoped.** `CombinedHookRunner`
   documents that "if ANY hook requests cancellation, the task will be
   cancelled". Hard-blocking a fetch can therefore end your whole run — and if
   the model does not switch to `ctx_execute`, you asked for a page and got
   nothing.
2. **Injected context only affects FUTURE decisions.** Cline's hook docs are
   explicit that a `PreToolUse` hook cannot change the call it is running
   against. So a nudge cannot prevent *this* fetch's payload; it shapes the next
   one. In a session that fetches five pages, four of them go through the
   sandbox.

Set `CONTEXT_BUDGET_FETCH=cancel` if you want the hard block. It comes with
three safety valves:

- **Availability gate** — if context-budget is not registered as an MCP server in
  any detected Cline install, `ctx_execute` is not callable, so blocking would
  strand the model. It degrades to a nudge and says why.
- **Retry valve** — after two cancellations of the same URL within ten minutes,
  the third attempt is allowed through. A model that keeps retrying is never
  trapped.
- **Allowlist** — `CONTEXT_BUDGET_FETCH_ALLOW=docs.internal,example.com`, or a
  `fetch-allow.json` file in the storage root. Useful for sites that need
  JavaScript rendering, where a raw `fetch()` in the sandbox would only return
  an empty shell.

---

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CONTEXT_BUDGET_DIR` | `~/.context-budget` | Storage root (knowledge base, ledger, temp scripts). |
| `CONTEXT_BUDGET_PROJECT` | `cwd` | Workspace the sandbox is bounded by. |
| `CONTEXT_BUDGET_HOOKS` | `on` | Set to `off` to disable hook routing. |
| `CONTEXT_BUDGET_FETCH` | `nudge` | Page-fetch policy: `nudge` \| `cancel` \| `off`. See below. |
| `CONTEXT_BUDGET_FETCH_ALLOW` | — | Comma-separated domains to never intercept, e.g. `docs.internal,example.com`. |
| `CONTEXT_BUDGET_MCP_ASSUME` | — | `registered` \| `missing`. Forces the redirect-availability check (useful for testing). |
| `CB_MAX_OUTPUT_BYTES` | `8192` | Cap on stdout returned from a sandbox call. |
| `CB_TIMEOUT_MS` | `30000` | Sandbox wall-clock budget. |
| `CB_INDEX_TTL_MS` | `86400000` | Freshness window for an indexed source. |
| `CB_KB_TTL_MS` | `1209600000` | Knowledge-base garbage collection age (14 days). |

CLI: `context-budget setup | uninstall | doctor [--fix] | stats | sources | index | search | purge | reset | mcp`.

---

## What it deliberately does not do

- **It does not tell the model how to write.** Brevity prompts measurably hurt
  coding benchmarks. This only routes *where data goes*, never *how the model
  talks*.
- **It does not edit your files.** Sandbox writes are discarded; that is the
  point.
- **It does not touch your Cline settings.** `init` writes only files it owns.
  Auto-rewriting a user's config is how a hook tool loses people's trust.
- **It does not phone home.** No telemetry, no account, no network beyond what
  your own sandboxed scripts choose to do. Everything lives in a local SQLite
  file you can delete with `context-budget purge`.

---

## Known limits — read these before you judge it

1. **File hooks are disabled in Cline CLI's `--yolo` mode.** Use `--act` or
   `--plan`.
2. **The extension hook path is `.clinerules/hooks/PreToolUse`** (no
   extension) and requires "Enable Hooks" in settings. Cline's own examples use
   bash; on Windows `init` also writes a `.cmd` sibling. Verify with the
   echo command above before trusting it.
3. **Cline's hook output field is `contextModification`, not `context`.** The
   extension validates `{ cancel, contextModification, errorMessage }`
   (`apps/vscode/src/core/hooks/hook-factory.ts`); the SDK file hooks read
   `context`. This hook emits both, because getting it wrong fails *silently* —
   the hook exits 0 and the model simply never sees the message.
4. **PreCompact hands over ephemeral files.** Cline passes `contextJsonPath` and
   `contextRawPath` and deletes them the moment the hook returns, so the capture
   has to happen inside the hook. We build a ≤2 KB working-state card and index
   the full history; we deliberately inject *nothing* at that moment, because
   anything added now would be compacted away seconds later. The card is handed
   back by whichever hook fires first afterwards — `TaskResume`, or `PreToolUse`
   / `PostToolUse` when auto-compaction continues the same task.
5. **Windows hooks are not officially supported by the Cline extension.** Cline's
   own hook documentation states hooks are executed through a shebang-aware shell
   and that Windows is "not currently supported". `setup` still writes a
   `.cmd` launcher and a Node-native `.mjs` launcher, but on Windows treat hooks
   as best-effort: verify with the echo command below before relying on routing.
   The sandbox tools themselves are unaffected — they work everywhere.
6. **Cline subagents cannot reach MCP servers.** The sandbox tools are
   unavailable inside `use_subagents` runs, so that portion of the saving is
   not reachable.
5. **Only Node runtimes are instrumented.** Python, bash and PowerShell report
   stdout volume only, so their savings are understated.
6. **The sandbox is a process boundary, not a security boundary.** The deny-list
   and path containment are guardrails against a careless agent, not a jail.
   Credentials in the environment are inherited on purpose, so `gh`, `aws` and
   `kubectl` keep working without secrets entering the conversation.

---

## Development

```bash
npm test          # 39 unit tests
npm run test:e2e  # speaks real MCP to the real server over stdio
npm run bench -- src
```

## License

MIT
