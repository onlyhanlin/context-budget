# context-budget

**Pour off the answer, leave the sediment.**

Raw tool output is what fills a context window. A 50 KB file is roughly 13,000
tokens, and once it is in the conversation it is re-sent on **every later turn**.
context-budget moves the work into a sandbox and keeps an index instead of a
transcript.

An MCP server plus Cline hooks. Works with any MCP client; the hooks are Cline's.

---

## Quick start

```bash
# 1. Get the CLI (not on npm yet — install from the repository)
git clone https://github.com/onlyhanlin/context-budget.git
cd context-budget && npm install && npm link

# 2. Install — DRY RUN first, it writes nothing
context-budget setup          # shows exactly what it would change

#    Pick ONE of these two:
context-budget setup --yes              # this project only
context-budget setup --global --yes     # every project, installed once

# 3. Check
context-budget doctor
```

**Which one?** The MCP server is registered globally either way — it lives in
Cline's settings, not in your project. The choice only affects the routing rules
and hook files: `--global` puts them in `~/Documents/Cline/` so every workspace
gets them without running `setup` again. Use the per-project form when you want
to tune one repository; use `--global` when you just want it everywhere.
Both can coexist.

Then do the one step nothing can do for you:

> **Cline → Settings → Features → tick "Enable Hooks"**, then restart Cline.

That is the whole install. If you would rather not run an installer, see
[Configuring the MCP server by hand](#3-configuring-the-mcp-server-by-hand).

---

## If you are an AI agent, follow this

This section is written to be executed, not read. Work top to bottom; stop where
it says STOP.

### Step 0 — prerequisites

```bash
node --version      # must be >= 22.5 (the knowledge base uses built-in node:sqlite with FTS5)
```

If Node is older than 22.5, **stop and tell the user**. There is no workaround.

### Step 1 — install the CLI

```bash
git clone https://github.com/onlyhanlin/context-budget.git /tmp/context-budget
cd /tmp/context-budget
npm install
npm link
```

Verify — this must print `0.1.0` (or later):

```bash
context-budget version
```

If `context-budget` is not found, `npm link` did not write to a directory on
PATH. Either fix the npm prefix, or skip the link and use the absolute path form
in [Configuring the MCP server by hand](#3-configuring-the-mcp-server-by-hand).

### Step 2 — look before you write

Run the dry run **from the user's project directory** and read the output:

```bash
cd /path/to/the/users/project
context-budget setup
```

It prints:

- every Cline installation it found, and whether `context-budget` is registered in each
- the hook and rules files it would create, update, or leave alone
- the exact MCP config block it would merge

A file that says `update` instead of `create` already existed. **If it is a
hook the user wrote themselves, stop and ask before overwriting it.**

### Step 3 — apply

```bash
context-budget setup --yes              # this project only
context-budget setup --global --yes     # every project, installed once
```

**Choose one.** The MCP server is registered globally in both cases — it lives
in Cline's settings file, not in the project. The flag only decides where the
routing rules and hook files go. Prefer `--global` when the user has not asked
for a project-scoped install, because it means never running `setup` again.

This writes only files it owns (each carries a `context-budget:generated`
marker), merges exactly one key into each `cline_mcp_settings.json`, and takes a
timestamped `.backup-…` next to any file it changes.

Expect a verification block. All lines must be `[x]`:

```
Verification
  [x] a page fetch is surfaced to the model
  [x] the editor tool is never interrupted
  [x] a noisy command is nudged toward ctx_batch
  [x] PostToolUse nudges an oversized tool result
  [x] CONTEXT_BUDGET_FETCH=cancel really blocks the fetch
  [x] hook entry exists: pretooluse
  ...
```

If a line is `[ ]`, **stop and report it verbatim**. Do not try to fix it by
editing generated files.

### Step 4 — STOP. Ask the human to enable hooks

You cannot do this part. Tell the user, in their language:

> Please open **Cline → Settings → Features** and tick **"Enable Hooks"**, then
> restart Cline.

Without that switch the hook files sit on disk and never fire. Routing drops from
enforced to advisory — roughly 98% to 60% effectiveness. Everything else still
works; the sandbox tools simply stop being used automatically.

### Step 5 — verify without waiting for the agent

```bash
echo '{"hookName":"PreToolUse","preToolUse":{"toolName":"fetch_web_content","parameters":{"url":"https://example.com"}}}' | context-budget hook pretooluse
```

Expected — a non-empty `contextModification`:

```json
{"cancel":false,"contextModification":"Page fetches are better routed through the sandbox: ...","context":"..."}
```

If stdout is `{"cancel":false}` with no `contextModification`, the hook ran but
decided nothing applied — that is fine for a plain payload, not for this one.

### Step 6 — confirm the tools are reachable

```bash
context-budget doctor
```

Read the `cline` section. For the editor the user is in, it must say
`mcp: registered`. If it says `NOT registered`, re-run `context-budget setup
--yes`; if it still does, add the block from
[Configuring the MCP server by hand](#3-configuring-the-mcp-server-by-hand) through
the Cline panel.

### If something goes wrong

| Symptom | Do this |
|---|---|
| `context-budget: command not found` | Step 1. Use the absolute-path form of the MCP config. |
| `[ ] node:sqlite + FTS5` in doctor | Node is older than 22.5. Stop. |
| `[ ] knowledge` / `[ ] ledger` in doctor | The storage root is not writable. Set `CONTEXT_BUDGET_DIR` to a writable path and re-run. |
| `mcp: NOT registered` | Re-run `context-budget setup --yes`, or register by hand. |
| Hooks never fire | "Enable Hooks" is off, or the CLI is in `--yolo` mode (which disables hooks by design). |
| `ctx_*` tools missing in chat | The MCP server is not registered, or Cline has not been restarted. |
| Everything worked, then stopped | The package moved. `context-budget doctor --fix`. |

**Rollback:** `context-budget uninstall --yes` removes every file carrying the
marker and only the `context-budget` key from `mcpServers`, with a backup.

---

## What it does

| Layer | Tools | Effect |
|---|---|---|
| **Sandbox** | `ctx_execute` `ctx_execute_file` `ctx_batch` | A subprocess runs the analysis. **Only stdout returns.** File contents, log dumps and HTML never enter the conversation. |
| **Index** | `ctx_index` `ctx_search` | Documents and command output are chunked and stored in SQLite **FTS5**. You search them later instead of pasting them now. |
| **Enforcement** | Cline hooks | `PreToolUse` redirects page fetches and nudges oversized reads before they happen. This is the difference between roughly 60% and 98% effectiveness. |
| **Continuity** | `PreCompact` + `TaskResume` | Captures a ≤2 KB working-state card just before compaction and hands it back afterwards, so a compacted or resumed task does not restart by asking what it was doing. |
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

> Payload-only. It does not model tool-schema overhead, routing rules or prompt
> caching, so treat it as an upper bound. Use `context-budget stats` for real
> sessions.

---

## Installation (the long version)

### Prerequisites

- **Node.js ≥ 22.5.** The knowledge base uses the built-in `node:sqlite` with
  FTS5 — no native compilation, no `better-sqlite3`.
- Cline. The **extension** gets automatic routing via hooks; any MCP client gets
  the tools without them.
- Python, bash and PowerShell are optional runtimes for `ctx_execute`.
  `context-budget doctor` reports which are available.

### 1. Get the CLI

```bash
git clone https://github.com/onlyhanlin/context-budget.git
cd context-budget
npm install
npm link
```

`npm link` puts `context-budget` on your PATH. Without it, use
`node /path/to/context-budget/bin/cli.mjs` everywhere below.

The package will be on npm eventually; until then the repository is the only
source.

### 2. Run the installer

```bash
cd /path/to/your/project
context-budget setup          # DRY RUN — shows exactly what it would change
context-budget setup --yes    # apply to this project (see 2b for global)
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

MCP server config (what setup writes; paste it by hand if your file was not detected):
{ "mcpServers": { "context-budget": { ... } } }

DRY RUN — nothing was written. Re-run with --yes to apply.
```

```bash
context-budget setup --hooks-only  # skip MCP registration
context-budget setup --mcp-only    # skip the hook files
```

### 2b. Global install — once, for every project

**The MCP server is already global.** It lives in the *editor's* settings file,
not in the project, so registering it once covers every workspace you ever open.

What a per-project `setup` adds is the routing rules and the hook files. If you
would rather not run `setup` in every repository:

```bash
context-budget setup --global --yes
```

That writes into Cline's own global directories, which every workspace reads:

| What | Where |
|---|---|
| Routing rules | `~/Documents/Cline/Rules/context-budget.md` |
| Hooks | `~/Documents/Cline/Hooks/PreToolUse`, `PostToolUse`, `PreCompact`, `TaskResume` (Windows: `.ps1`) |

Global and workspace hooks all run — Cline executes every hooks directory it
finds. A project can therefore add to the global set, but it cannot switch it off.

> **A hook slot holds exactly one file.** Cline looks for one exact file name, so
> if `~/Documents/Cline/Hooks/PreToolUse` is already a hook you wrote, `setup`
> reports a **CONFLICT** and leaves it untouched rather than overwriting it.
> Merge it, move it aside, then re-run.

`context-budget uninstall --global --yes` reverses exactly that, and touches
only files carrying our marker.

### 3. Configuring the MCP server by hand

`setup` writes this for you. You need the block below when it **cannot** — an
editor it does not recognise, a portable install, a locked-down settings file, or
any MCP client that is not Cline. `context-budget mcp-config` prints the same
thing at any time; it is generated from the same source of truth the installer
writes, so it can never drift.

```json
{
  "mcpServers": {
    "context-budget": {
      "command": "context-budget",
      "args": ["mcp"],
      "disabled": false,
      "autoApprove": [
        "ctx_execute",
        "ctx_execute_file",
        "ctx_batch",
        "ctx_index",
        "ctx_search",
        "ctx_stats"
      ]
    }
  }
}
```

Where that goes:

| Client | Location |
|---|---|
| Cline (VS Code / JetBrains) | **MCP Servers → Configure MCP Servers** in the Cline panel. The panel opens the right file for you; that is safer than guessing the path. |
| Cline CLI | `~/.cline/data/settings/cline_mcp_settings.json` |

Notes:

- `"command": "context-budget"` requires the CLI on your `PATH`
  (`npm install -g context-budget`, or `npm link` from a clone). If you would
  rather not install it globally, use an absolute path to `bin/cli.mjs`:
  `"command": "node", "args": ["/abs/path/to/context-budget/bin/cli.mjs", "mcp"]`.
- `autoApprove` is a **Cline** field; other clients ignore it. Leaving tools out
  of it is fine — you will simply be asked to confirm each call.
- `ctx_doctor` is deliberately not auto-approved: it is a diagnostic you should
  read, not something the model should call on its own.
- The server speaks plain stdio MCP, so any client works:

  ```json
  { "command": "context-budget", "args": ["mcp"] }
  ```

Two things must both be true before any of this has an effect:

1. the MCP server is registered (the block above), **and**
2. **Cline → Settings → Features → "Enable Hooks"** is ticked.

Verify with `context-budget doctor` — it lists every Cline install it found and
whether `context-budget` is registered in each.

### 4. Enable hooks in Cline

> **Cline → Settings → Features → tick "Enable Hooks"**, then restart Cline.

Without that switch the hook files exist but never fire, and routing drops from
enforced back to advisory — the difference between roughly 98% and 60%
effectiveness. **Note for CLI users:** file hooks are disabled in `--yolo` mode
by design; use `--act` or `--plan`.

### 5. Verify

```bash
context-budget doctor          # runtimes, storage, detected Cline installs, hook checks
context-budget doctor --fix    # rewrite launchers pointing at a moved package
```

To confirm a hook fires end to end without waiting for the agent:

```bash
echo '{"hookName":"PreToolUse","preToolUse":{"toolName":"fetch_web_content","parameters":{"url":"https://example.com"}}}' | context-budget hook pretooluse
# → {"cancel":false,"contextModification":"Page fetches are better routed through the sandbox: ..."}
```

### 6. Uninstall

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
| `ctx_doctor()` | Runtimes, FTS5, storage paths, detected Cline installs. |

### When the sandbox is the wrong answer

- **You are about to edit a file** → use the native read tool. The editor needs
  the exact bytes to match against.
- **The output is short and known** (`pwd`, a clean `git status`) → run it
  directly; the sandbox adds overhead for no gain.
- **The command changes state** (`git commit`, `npm install`) → native tool.
  Sandbox file writes are discarded.
- **You need a browser interaction**, not a page fetch → native browser tool.

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
| `CONTEXT_BUDGET_HOOK_ENTRY` | — | Overrides the hook entry point baked into generated launchers. |
| `CONTEXT_BUDGET_MCP_ASSUME` | — | `registered` \| `missing`. Forces the redirect-availability check (useful for testing). |
| `CB_MAX_OUTPUT_BYTES` | `8192` | Cap on stdout returned from a sandbox call. |
| `CB_TIMEOUT_MS` | `30000` | Sandbox wall-clock budget. |
| `CB_INDEX_TTL_MS` | `86400000` | Freshness window for an indexed source. |
| `CB_KB_TTL_MS` | `1209600000` | Knowledge-base garbage collection age (14 days). |

CLI: `context-budget mcp | setup | mcp-config | uninstall | doctor | stats | sources | index | search | purge | reset | hook | version`.

`setup` flags: `--yes` (apply; default is a dry run) · `--global` (rules + hooks for
every workspace instead of this one) · `--hooks-only` · `--mcp-only`.
`doctor` flag: `--fix`. `uninstall` flag: `--global`.

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
character space-separated, because SQLite otherwise treats a whole Han run as a
single token and Chinese search stops working. Queries are matched with AND,
falling back to OR and then to a substring scan for partial identifiers.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `context-budget: command not found` | `npm link` did not land on PATH | Fix the npm prefix, or use `node /path/bin/cli.mjs` |
| `ctx_*` tools do not appear in Cline | MCP server not registered, or Cline not restarted | `context-budget doctor`, then `setup --yes`, then restart |
| Hooks never fire | "Enable Hooks" is off | Settings → Features → tick it |
| Hooks never fire in the CLI | `--yolo` disables hooks by design | use `--act` or `--plan` |
| `[ ] node:sqlite + FTS5` | Node older than 22.5 | upgrade Node |
| `[ ] knowledge` / `[ ] ledger`, "unable to open database file" | storage root not writable (network drive, read-only mount, sandbox) | point `CONTEXT_BUDGET_DIR` at a writable local path |
| `! could not enable WAL` | WAL is unavailable on that filesystem | harmless; the tool falls back to the default journal mode |
| Chinese search returns nothing | — | should not happen; CJK is tokenised per character. If it does, `ctx_purge` and re-index |
| Everything worked, then stopped | the package moved after an upgrade | `context-budget doctor --fix` |
| `setup` reports a file as `SKIPPED` | a path it owns exists as a plain file | move that file aside and re-run |

---

## Known limits — read these before you judge it

1. **Hook file names are a hard contract, and they differ per platform.** Cline
   looks for exactly one file per hook
   (`apps/vscode/src/core/hooks/hook-factory.ts`):

   | Platform | Extension hooks | CLI hooks |
   |---|---|---|
   | Windows | `<HookName>.ps1` — an extensionless file is **ignored** | `<HookName>.sh` |
   | macOS / Linux | extensionless `<HookName>`, and it must be **executable** — a `.ps1` is **ignored** | `<HookName>.sh` |

   Writing the wrong one produces a hook that never runs and never says why.
   `context-budget setup` writes the right one for the platform it runs on, and
   `context-budget doctor` reports what it found. Windows has no `chmod`, which
   is the whole reason a PowerShell launcher exists.
2. **Cline's hook output field is `contextModification`, not `context`.** The
   extension validates `{ cancel, contextModification, errorMessage }`
   (`apps/vscode/src/core/hooks/hook-factory.ts`); the SDK file hooks read
   `context`. This hook emits both, because getting it wrong fails *silently* —
   the hook exits 0 and the model simply never sees the message.
3. **PreCompact hands over ephemeral files.** Cline passes `contextJsonPath` and
   `contextRawPath` and deletes them the moment the hook returns, so the capture
   has to happen inside the hook. We build a ≤2 KB working-state card and index
   the full history; we deliberately inject *nothing* at that moment, because
   anything added now would be compacted away seconds later. The card is handed
   back by whichever hook fires first afterwards — `TaskResume`, or `PreToolUse`
   / `PostToolUse` when auto-compaction continues the same task.
4. **Cline subagents cannot reach MCP servers.** The sandbox tools are
   unavailable inside `use_subagents` runs, so that portion of the saving is
   not reachable.
5. **Only Node runtimes are instrumented.** Python, bash and PowerShell report
   stdout volume only, so their savings are understated.
6. **The sandbox is a process boundary, not a security boundary.** The deny-list
   and path containment are guardrails against a careless agent, not a jail.
   Credentials in the environment are inherited on purpose, so `gh`, `aws` and
   `kubectl` keep working without secrets entering the conversation.

---

## What it deliberately does not do

- **It does not tell the model how to write.** Brevity prompts measurably hurt
  coding benchmarks. This only routes *where data goes*, never *how the model
  talks*.
- **It does not edit your files.** Sandbox writes are discarded; that is the
  point.
- **It does not touch your Cline settings beyond one key.** `init` and `setup`
  write only files they own, and merge exactly one entry into `mcpServers`.
  Auto-rewriting a user's config is how a hook tool loses people's trust.
- **It does not phone home.** No telemetry, no account, no network beyond what
  your own sandboxed scripts choose to do. Everything lives in a local SQLite
  file you can delete with `context-budget purge`.

---

## Development

```bash
npm test              # 69 unit tests
npm run test:e2e      # real MCP over stdio
npm run test:scenario # hook routing matrix, real processes
npm run test:workflow # live network end to end
npm run test:audit    # 84 checks: every tool, every CLI command, every hook
npm run test:audit2   # 38 checks: protocol abuse, dirty storage, concurrency
npm run test:audit3   # 30 checks: data loss, retrieval quality, TTL
npm run test:recipe   # 53 checks: executes the install recipe in this README
npm run test:all      # all of the above
npm run bench -- src  # payload comparison
```

## License

MIT
