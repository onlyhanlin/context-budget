import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { storageRoot, projectRoot, projectKey, ensureDir, limits, VERSION } from "../src/config.mjs";

test("VERSION is a non-empty semver-like string", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test("storageRoot falls back to ~/.context-budget", () => {
  const saved = process.env.CONTEXT_BUDGET_DIR;
  delete process.env.CONTEXT_BUDGET_DIR;
  const root = storageRoot();
  assert.ok(root.endsWith(".context-budget"));
  if (saved) process.env.CONTEXT_BUDGET_DIR = saved;
});

test("storageRoot respects CONTEXT_BUDGET_DIR", () => {
  const saved = process.env.CONTEXT_BUDGET_DIR;
  const custom = path.join(os.tmpdir(), "cb-config-root");
  process.env.CONTEXT_BUDGET_DIR = custom;
  assert.equal(storageRoot(), path.resolve(custom));
  if (saved) process.env.CONTEXT_BUDGET_DIR = saved;
  else delete process.env.CONTEXT_BUDGET_DIR;
});

test("projectRoot falls back to cwd", () => {
  const saved = process.env.CONTEXT_BUDGET_PROJECT;
  delete process.env.CONTEXT_BUDGET_PROJECT;
  assert.equal(projectRoot(), path.resolve(process.cwd()));
  if (saved) process.env.CONTEXT_BUDGET_PROJECT = saved;
});

test("projectRoot respects CONTEXT_BUDGET_PROJECT", () => {
  const saved = process.env.CONTEXT_BUDGET_PROJECT;
  process.env.CONTEXT_BUDGET_PROJECT = "/some/project";
  assert.equal(projectRoot(), path.resolve("/some/project"));
  if (saved) process.env.CONTEXT_BUDGET_PROJECT = saved;
  else delete process.env.CONTEXT_BUDGET_PROJECT;
});

test("projectKey is stable for the same path", () => {
  const k1 = projectKey("/work/my-app");
  const k2 = projectKey("/work/my-app");
  assert.equal(k1, k2);
});

test("projectKey differs for different paths", () => {
  assert.notEqual(projectKey("/work/app-a"), projectKey("/work/app-b"));
});

test("projectKey includes a sanitised basename prefix", () => {
  const k = projectKey("/work/my-project");
  assert.ok(k.startsWith("my-project-"), `expected basename prefix, got ${k}`);
});

test("projectKey sanitises characters that are not filesystem-safe", () => {
  const k = projectKey("/work/my project!@#");
  const prefix = k.split("-")[0];
  assert.ok(/^[A-Za-z0-9._-]+$/.test(prefix), `prefix must be safe, got ${prefix}`);
});

test("ensureDir creates nested directories", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-config-"));
  const nested = path.join(base, "a", "b", "c");
  assert.equal(ensureDir(nested), nested);
  assert.ok(fs.existsSync(nested));
  fs.rmSync(base, { recursive: true, force: true });
});

test("limits getters return positive numbers with defaults", () => {
  assert.ok(limits.maxOutputBytes > 0);
  assert.ok(limits.timeoutMs > 0);
  assert.ok(limits.indexTtlMs > 0);
  assert.ok(limits.kbTtlMs > 0);
  assert.ok(limits.maxReadBytes > 0);
  assert.ok(limits.chunkChars > 0);
  assert.ok(limits.chunkOverlap >= 0);
});

test("limits respect environment overrides", () => {
  process.env.CB_MAX_OUTPUT_BYTES = "4096";
  assert.equal(limits.maxOutputBytes, 4096);
  process.env.CB_TIMEOUT_MS = "5000";
  assert.equal(limits.timeoutMs, 5000);
  delete process.env.CB_MAX_OUTPUT_BYTES;
  delete process.env.CB_TIMEOUT_MS;
});

test("limits ignore non-numeric or non-positive env values", () => {
  process.env.CB_MAX_OUTPUT_BYTES = "not-a-number";
  assert.equal(limits.maxOutputBytes, 8192, "non-numeric falls back to default");
  process.env.CB_MAX_OUTPUT_BYTES = "-5";
  assert.equal(limits.maxOutputBytes, 8192, "non-positive falls back to default");
  delete process.env.CB_MAX_OUTPUT_BYTES;
});
