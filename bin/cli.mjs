#!/usr/bin/env node
/**
 * context-budget CLI.
 *
 * `context-budget mcp` is what an MCP client launches. `setup` is the
 * installer. Everything else is inspection and maintenance.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { VERSION, storageRoot, projectRoot, kbPath } from "../src/config.mjs";
import * as store from "../src/store.mjs";
import * as stats from "../src/stats.mjs";
import { ctxDoctor, ctxStats, ctxSearch, ctxIndex } from "../src/tools.mjs";
import { formatBytes } from "../src/text.mjs";
import { buildPlan, formatPlan, applySetup, verify, uninstall, repair } from "../src/setup.mjs";
import { HOOK_EVENTS, packageRoot } from "../hooks/install.mjs";

const USAGE = `context-budget ${VERSION}

Install
  context-budget setup [--yes]         dry run by default; --yes applies
        --global                       install global rules/hooks (~/Documents/Cline)
        --hooks-only                   skip MCP server registration
        --mcp-only                     skip hook + rules files
  context-budget uninstall [--yes] [--global]
  context-budget doctor [--fix]        diagnose; --fix repairs stale hook launchers

Run
  context-budget mcp                   start the MCP server (Cline launches this)

Inspect
  context-budget stats [--session] [--json]
  context-budget sources
  context-budget index <source> <file|-> 
  context-budget search <query...>
  context-budget purge --yes
  context-budget reset [--all]

Environment
  CONTEXT_BUDGET_DIR       storage root (default ~/.context-budget)
  CONTEXT_BUDGET_PROJECT   workspace the sandbox is bounded by (default cwd)
  CONTEXT_BUDGET_HOOKS     "off" disables hook routing
  CONTEXT_BUDGET_HOOK_ENTRY  overrides the hook entry point in generated launchers
  CB_MAX_OUTPUT_BYTES      cap on stdout returned from a sandbox call
  CB_TIMEOUT_MS            sandbox wall-clock budget

Agent routing rules come from ${path.join(packageRoot, "rules", "context-budget.md")}.`;

function parse(argv) {
  const positional = [];
  const flags = new Map();
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const [key, value] = arg.slice(2).split("=");
      flags.set(key, value ?? true);
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function fail(message) {
  process.stderr.write(`context-budget: ${message}\n`);
  process.exitCode = 1;
}

function out(text) {
  process.stdout.write(text + "\n");
}

async function main() {
  const { positional, flags } = parse(process.argv.slice(2));
  const command = positional[0] ?? "help";

  switch (command) {
    case "mcp": {
      const { main: startServer } = await import("../src/server.mjs");
      await startServer();
      return;
    }

    /* ------------------------------------------------------------- install */

    case "setup":
    case "init": {
      // `init` is kept as a shortcut for the old behaviour: workspace files only.
      const legacy = command === "init";
      const plan = buildPlan({
        root: projectRoot(),
        global: flags.has("global"),
        hooksOnly: legacy || flags.has("hooks-only"),
        mcpOnly: flags.has("mcp-only"),
      });

      out(formatPlan(plan));

      const apply = flags.has("yes") || flags.has("y");
      if (!apply) {
        out("");
        out("DRY RUN — nothing was written. Re-run with --yes to apply.");
        return;
      }

      const result = applySetup(plan);
      out("");
      out(`applied: ${result.files.length} file(s) written`);
      for (const problem of result.blocked ?? []) out(`  SKIPPED  ${problem}`);
      for (const m of result.merges) {
        out(`  mcp ${String(m.action).padEnd(9)} ${m.file}`);
      }
      for (const backup of result.backups) {
        out(`  backup written: ${backup}`);
      }

      out("");
      out("Verification");
      const checks = await verify(plan);
      for (const check of checks) {
        out(`  ${check.ok ? "[x]" : "[ ]"} ${check.name}${check.ok || !check.detail ? "" : " — " + check.detail}`);
      }

      out("");
      out("Now do this in Cline:");
      out('  1. Settings → Features → tick "Enable Hooks".');
      out("  2. Restart the extension (or start a new CLI session).");
      out("  3. Confirm with:  context-budget doctor");
      out("");
      out("Prove the hook fires without waiting for the agent:");
      out(`  node "${path.join(packageRoot, "hooks", "pretooluse.mjs")}" < sample.json`);
      return;
    }

    case "uninstall": {
      const apply = flags.has("yes") || flags.has("y");
      if (!apply) {
        return fail(
          "uninstall removes only files carrying the context-budget marker, and only the " +
            '\"context-budget\" key from Cline\'s MCP settings (with a backup). Re-run with --yes to proceed.'
        );
      }
      const result = uninstall({ root: projectRoot(), global: flags.has("global") });
      out(`removed ${result.removed.length} generated file(s)`);
      for (const file of result.removed) out(`  ${file}`);
      if (result.skipped.length) {
        out(`left alone ${result.skipped.length} file(s) we do not own`);
        for (const file of result.skipped) out(`  ${file}`);
      }
      for (const m of result.mcp) {
        out(`  mcp ${m.action.padEnd(9)} ${m.target.label} → ${m.target.mcpSettings}`);
        if (m.backup) out(`        backup: ${m.backup}`);
      }
      return;
    }

    case "doctor": {
      out(await ctxDoctor());
      const plan = buildPlan({ root: projectRoot() });
      const checks = await verify(plan);
      const bad = checks.filter((c) => !c.ok);
      out("");
      out(`hook checks: ${checks.length - bad.length}/${checks.length} passing`);
      for (const check of bad) out(`  [ ] ${check.name}${check.detail ? " — " + check.detail : ""}`);
      if (bad.length) {
        const repaired = flags.has("fix") ? repair({ root: projectRoot() }) : [];
        if (repaired.length) {
          out("");
          out(`repaired ${repaired.length} stale launcher(s):`);
          for (const file of repaired) out(`  ${file}`);
        } else if (!flags.has("fix")) {
          out("");
          out("Re-run with --fix to rewrite stale hook launchers.");
        }
      }
      return;
    }

    /* ------------------------------------------------------------- inspect */

    case "stats": {
      if (flags.has("json")) {
        out(JSON.stringify(stats.summary({ session: flags.has("session") }), null, 2));
      } else {
        out(await ctxStats({ session: flags.has("session") }));
      }
      return;
    }

    case "sources": {
      const rows = store.listSources();
      if (!rows.length) return out(`knowledge base is empty (${kbPath()})`);
      for (const row of rows) {
        const ageH = (row.ageMs / 3600000).toFixed(1);
        out(`${row.source.padEnd(40)} ${String(row.chunks).padStart(5)} chunks  ${formatBytes(row.bytes).padStart(10)}  ${ageH}h old`);
      }
      return;
    }

    case "index": {
      const source = positional[1];
      const file = positional[2];
      if (!source || !file) return fail('usage: context-budget index <source> <file|->');
      const content = file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(path.resolve(file), "utf8");
      out(await ctxIndex({ source, content }));
      return;
    }

    case "search": {
      const queries = positional.slice(1);
      if (!queries.length) return fail("usage: context-budget search <query...>");
      out(await ctxSearch({ queries, source: flags.get("source") || undefined }));
      return;
    }

    case "purge": {
      if (!flags.has("yes")) return fail("this deletes every indexed chunk. Re-run with --yes to confirm.");
      out(`purged ${store.purge()} chunk(s) from ${kbPath()}`);
      return;
    }

    case "reset": {
      stats.reset({ all: flags.has("all") });
      out(flags.has("all") ? "cleared all token accounting" : "cleared this session's accounting");
      return;
    }

    case "hook": {
      const event = positional[1];
      if (!HOOK_EVENTS.includes(event)) return fail(`unknown hook event "${event}". Expected: ${HOOK_EVENTS.join(", ")}`);
      const { runHookEvent } = await import("../hooks/run.mjs");
      await runHookEvent(event);
      return;
    }

    case "version":
      return out(VERSION);

    default:
      return out(USAGE);
  }
}

main()
  .catch((error) => {
    process.stderr.write(`context-budget: ${error?.stack ?? String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    try { store.close(); } catch { /* ignore */ }
    try { stats.close(); } catch { /* ignore */ }
  });
