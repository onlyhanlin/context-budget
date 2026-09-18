import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-hooks-"));
process.env.CONTEXT_BUDGET_DIR = dir;

const { normalizePayload, decidePreToolUse, decidePostToolUse, decidePreCompact, decideTaskResume } =
  await import("../hooks/run.mjs");

test("normalizePayload reads the CLI file-hook shape", () => {
  const p = normalizePayload({ hookName: "tool_call", tool_call: { name: "read_files", input: { path: "a.ts" } } });
  assert.equal(p.toolName, "read_files");
  assert.equal(p.input.path, "a.ts");
});

test("normalizePayload reads the VS Code extension shape", () => {
  const p = normalizePayload({ hookName: "PreToolUse", preToolUse: { toolName: "execute_command", parameters: { command: "ls" } } });
  assert.equal(p.toolName, "execute_command");
  assert.equal(p.input.command, "ls");
});

test("nudges use contextModification, the field Cline actually reads", () => {
  // Verified against apps/vscode/src/core/hooks/hook-factory.ts: the response is
  // validated for cancel / contextModification / errorMessage. A hook returning
  // `context` succeeds silently and the model never sees it.
  return decidePreToolUse({ hookName: "PreToolUse", preToolUse: { toolName: "execute_command", parameters: { command: "npm test" } } })
    .then((decision) => {
      assert.ok(typeof decision.contextModification === "string" && decision.contextModification.length > 0);
      assert.equal(decision.context, undefined, "do not rely on the SDK-only field name");
      assert.equal(decision.cancel, false);
    });
});

test("every decision carries an explicit cancel flag", async () => {
  const cases = [
    await decidePreToolUse({ preToolUse: { toolName: "editor", parameters: {} } }),
    await decidePreToolUse({ preToolUse: { toolName: "execute_command", parameters: { command: "pwd" } } }),
    await decidePostToolUse({ postToolUse: { toolName: "read_files", result: "tiny" } }),
  ];
  for (const decision of cases) assert.equal(decision.cancel, false);
});

test("PreCompact captures state and deliberately injects nothing", async () => {
  const history = path.join(dir, "history.txt");
  fs.writeFileSync(history, [
    '{"type":"ask","ask":"followup","text":"fix the parser in src/parser.ts"}',
    '{"type":"say","say":"tool","text":"Error: unexpected token at line 42"}',
    '{"type":"say","say":"tool","text":"{ \"command\": \"npm test\" }"}',
  ].join("\n"));

  const decision = await decidePreCompact({
    hookName: "PreCompact",
    preCompact: { taskId: "t1", contextSize: 3, compactionStrategy: "auto-condense", contextRawPath: history },
  });
  assert.equal(decision.cancel, false);
  assert.equal(decision.contextModification, undefined, "injecting here would be compacted away a moment later");
});

test("TaskResume hands the card back exactly once", async () => {
  const first = await decideTaskResume({ hookName: "TaskResume" });
  assert.ok(typeof first.contextModification === "string");
  assert.match(first.contextModification, /fix the parser/);
  assert.match(first.contextModification, /session_knowledge/);
  assert.match(first.contextModification, /src\/parser\.ts/);

  const second = await decideTaskResume({ hookName: "TaskResume" });
  assert.equal(second.contextModification, undefined, "a snapshot must not be replayed forever");
});

test("PreCompact with no context files saves nothing and injects nothing", async () => {
  const decision = await decidePreCompact({ hookName: "PreCompact", preCompact: { taskId: "t2", contextSize: 8 } });
  assert.equal(decision.cancel, false);
  assert.equal(decision.contextModification, undefined);
  const resume = await decideTaskResume({ hookName: "TaskResume" });
  assert.equal(resume.contextModification, undefined, "an empty capture must not produce a card");
});

function fetchEvent(url = "https://example.com/spec") {
  return { hookName: "PreToolUse", preToolUse: { toolName: "fetch_web_content", parameters: { url } } };
}

test("by default a page fetch is nudged, never blocked", async () => {
  delete process.env.CONTEXT_BUDGET_FETCH;
  const decision = await decidePreToolUse(fetchEvent());
  assert.equal(decision.cancel, false, "cancelling is task-scoped in Cline and must not be the default");
  assert.ok(decision.contextModification.includes("ctx_execute"));
  assert.equal(decision.errorMessage, undefined);
});

test("fetch mode can be turned off entirely", async () => {
  process.env.CONTEXT_BUDGET_FETCH = "off";
  const decision = await decidePreToolUse(fetchEvent());
  assert.equal(decision.cancel, false);
  assert.equal(decision.contextModification, undefined);
  delete process.env.CONTEXT_BUDGET_FETCH;
});

test("cancel mode still refuses when the redirect target is missing", async () => {
  process.env.CONTEXT_BUDGET_FETCH = "cancel";
  process.env.CONTEXT_BUDGET_MCP_ASSUME = "missing";
  const decision = await decidePreToolUse(fetchEvent("https://example.com/a"));
  assert.equal(decision.cancel, false, "blocking without ctx_execute would strand the model");
  assert.ok(decision.contextModification.includes("not registered as an MCP server"));
  delete process.env.CONTEXT_BUDGET_FETCH;
  delete process.env.CONTEXT_BUDGET_MCP_ASSUME;
});

test("cancel mode blocks, then lets the URL through after repeated attempts", async () => {
  process.env.CONTEXT_BUDGET_FETCH = "cancel";
  process.env.CONTEXT_BUDGET_MCP_ASSUME = "registered";
  const url = "https://example.com/retry-me";

  const first = await decidePreToolUse(fetchEvent(url));
  assert.equal(first.cancel, true);
  assert.ok(first.errorMessage.includes("redirected to ctx_execute"));
  assert.ok(first.errorMessage.includes("full network access"));
  // ADR-0003 wording rules: no bare "blocked", no ironic negation.
  assert.ok(!/\bblocked\b/i.test(first.errorMessage));
  assert.ok(!/\bNOT\b/.test(first.errorMessage));

  const second = await decidePreToolUse(fetchEvent(url));
  assert.equal(second.cancel, true);

  const third = await decidePreToolUse(fetchEvent(url));
  assert.equal(third.cancel, false, "a model that keeps retrying must not be trapped");
  assert.ok(third.contextModification.includes("Allowing this one through"));

  delete process.env.CONTEXT_BUDGET_FETCH;
  delete process.env.CONTEXT_BUDGET_MCP_ASSUME;
});

test("an allowlisted domain is never intercepted, even in cancel mode", async () => {
  process.env.CONTEXT_BUDGET_FETCH = "cancel";
  process.env.CONTEXT_BUDGET_MCP_ASSUME = "registered";
  process.env.CONTEXT_BUDGET_FETCH_ALLOW = "internal.example.com";
  const decision = await decidePreToolUse(fetchEvent("https://docs.internal.example.com/page"));
  assert.equal(decision.cancel, false);
  delete process.env.CONTEXT_BUDGET_FETCH_ALLOW;
  delete process.env.CONTEXT_BUDGET_FETCH;
  delete process.env.CONTEXT_BUDGET_MCP_ASSUME;
});

test("editor and write tools are never intercepted", async () => {
  for (const name of ["editor", "apply_patch", "write_file", "edit_file"]) {
    const decision = await decidePreToolUse({ hookName: "PreToolUse", preToolUse: { toolName: name, parameters: { path: "src/a.ts" } } });
    assert.equal(decision.cancel, false, `${name} must not be cancelled`);
    assert.equal(decision.contextModification, undefined, `${name} must not be nudged`);
  }
});

test("large reads get a nudge, small reads do not", async () => {
  const big = path.join(dir, "big.txt");
  fs.writeFileSync(big, "a".repeat(60_000));
  const small = path.join(dir, "small.txt");
  fs.writeFileSync(small, "a".repeat(100));

  const nudged = await decidePreToolUse({ hookName: "PreToolUse", preToolUse: { toolName: "read_files", parameters: { path: big } } });
  assert.ok(nudged.contextModification?.includes("ctx_execute_file"));
  assert.equal(nudged.cancel, false, "a nudge must never cancel the call");

  const quiet = await decidePreToolUse({ hookName: "PreToolUse", preToolUse: { toolName: "read_files", parameters: { path: small } } });
  assert.equal(quiet.contextModification, undefined);
});

test("noisy commands get a nudge", async () => {
  for (const command of ["npm test", "git log --stat", "docker build .", "rg -r foo src"]) {
    const decision = await decidePreToolUse({ hookName: "PreToolUse", preToolUse: { toolName: "execute_command", parameters: { command } } });
    assert.ok(decision.contextModification, `${command} should be nudged`);
  }
  const quiet = await decidePreToolUse({ hookName: "PreToolUse", preToolUse: { toolName: "execute_command", parameters: { command: "pwd" } } });
  assert.equal(quiet.contextModification, undefined);
});

test("post tool use nudges only for genuinely large output", async () => {
  const small = await decidePostToolUse({ hookName: "PostToolUse", postToolUse: { toolName: "read_files", result: "tiny" } });
  assert.equal(small.contextModification, undefined);
  const large = await decidePostToolUse({ hookName: "PostToolUse", postToolUse: { toolName: "read_files", result: "x".repeat(50_000) } });
  assert.ok(large.contextModification?.includes("ctx_execute"));
});

test("the hook process emits the contract Cline validates", () => {
  const entry = path.join(root, "hooks", "pretooluse.mjs");
  const payload = JSON.stringify({
    clineVersion: "x",
    hookName: "PreToolUse",
    taskId: "t",
    preToolUse: { toolName: "fetch_web_content", parameters: { url: "https://example.com" } },
  });
  const result = spawnSync(process.execPath, [entry], {
    input: payload,
    encoding: "utf8",
    env: { ...process.env, CONTEXT_BUDGET_FETCH: "cancel", CONTEXT_BUDGET_MCP_ASSUME: "registered" },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.cancel, true);
  assert.equal(typeof parsed.errorMessage, "string");
  assert.equal(typeof parsed.contextModification, "string", "the extension reads contextModification");
  assert.ok(!/\bblocked\b/i.test(parsed.errorMessage));
});

test("decisions are always JSON-serialisable", async () => {
  const decision = await decidePreToolUse({ tool_call: { name: "fetch_web_content", input: {} } });
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(decision)));
});
