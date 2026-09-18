import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { serverEntry, SERVER_NAME } = await import("../src/mcp-config.mjs");

/** Pull the first fenced json block that follows a heading matching `marker`. */
function jsonBlockAfter(text, marker) {
  const at = text.indexOf(marker);
  assert.ok(at >= 0, `marker not found: ${marker}`);
  const rest = text.slice(at);
  const fence = rest.indexOf("```json");
  assert.ok(fence >= 0, `no json block after ${marker}`);
  const start = rest.indexOf("\n", fence) + 1;
  const end = rest.indexOf("```", start);
  return JSON.parse(rest.slice(start, end));
}

const expected = { mcpServers: { [SERVER_NAME]: serverEntry() } };

test("README.md documents the exact MCP config the installer writes", () => {
  const text = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.deepEqual(jsonBlockAfter(text, "Configuring the MCP server by hand"), expected);
});

test("README.zh-CN.md documents the exact MCP config the installer writes", () => {
  const text = fs.readFileSync(path.join(root, "README.zh-CN.md"), "utf8");
  assert.deepEqual(jsonBlockAfter(text, "手工配置 MCP server"), expected);
});

test("both READMEs list every auto-approved tool by name", () => {
  for (const file of ["README.md", "README.zh-CN.md"]) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    for (const tool of serverEntry().autoApprove) {
      assert.ok(text.includes(`"${tool}"`), `${file} is missing autoApprove entry ${tool}`);
    }
  }
});

test("the README install section mentions the Enable Hooks switch", () => {
  for (const file of ["README.md", "README.zh-CN.md"]) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(text, /Enable Hooks/, `${file} must tell the user about Enable Hooks`);
  }
});

test("the CLI reference line lists every command the CLI actually implements", () => {
  // Two-way guard: never document a command that does not exist, and never ship
  // one that nobody can discover.
  const cli = fs.readFileSync(path.join(root, "bin", "cli.mjs"), "utf8");
  const implemented = [...cli.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]).filter((c) => c !== "init");
  for (const file of ["README.md", "README.zh-CN.md"]) {
    const readme = fs.readFileSync(path.join(root, file), "utf8");
    const line = readme.split("\n").find((l) => /^CLI[:：]/.test(l));
    assert.ok(line, `${file} has no CLI reference line`);
    for (const command of implemented) {
      assert.ok(new RegExp(`\\b${command}\\b`).test(line), `${file} CLI line omits: ${command}`);
    }
  }
});
