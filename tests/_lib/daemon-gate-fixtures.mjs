// tests/_lib/daemon-gate-fixtures.mjs
// Shared fixtures for the kaovilai/context-mode#11 daemon-down gate tests, used by both owning
// area files (tests/prd10-hooks-runtime.test.mjs for the hook decision paths, tests/0026-daemon.test.mjs
// for the gate and daemon behavior). One copy of each body lives here per TEST-LAYOUT.md.
// The manifest the gate reads is dirname(argv[1])/.claude-plugin/plugin.json — the same location
// caseB uses for run.mjs — so withBundle patches process.argv[1]; every describe using it runs
// serial (node:test runs a file's tests in order).
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { resetDaemonGateCacheForTest } from "../../src/core/hooks/daemon-gate.ts";
import { OUTPUT_CAP } from "../../src/core/contracts/constants.ts";

/** The mcpServers entries a fake bundle's manifest can carry. */
export const HTTP_ENTRY = { type: "http", url: "http://127.0.0.1:8790/mcp" };
export const STDIO_ENTRY = { command: "node", args: ["server.mjs", "--agent", "claude-code"] };

/** Nothing listens here (tests/0026-daemon.test.mjs uses the same trick). */
export const DEAD_PORT = 59998;

export function rmTemp(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    if (process.platform !== "win32" || err.code !== "EPERM") throw err;
  }
}

/** A bundle dir whose .claude-plugin/plugin.json names the given mcpServers entry, plus the hook
 *  path the gate reads it from (argv[1]). entry === null means no manifest at all. */
export function fakeBundle(entry) {
  const dir = mkdtempSync(join(tmpdir(), "cm-gate-"));
  if (entry !== null) {
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "context-mode", mcpServers: { "context-mode": entry } }));
  }
  return { dir, hook: join(dir, "hook.mjs") };
}

/** Runs fn with the gate reading the given bundle's manifest (argv[1] patched, cache reset before
 *  and after, temp dir removed). Serial only: process.argv is process-global. */
export async function withBundle(entry, fn) {
  const oldArgv1 = process.argv[1];
  const { dir, hook } = fakeBundle(entry);
  resetDaemonGateCacheForTest();
  process.argv[1] = hook;
  try {
    await fn();
  } finally {
    process.argv[1] = oldArgv1;
    resetDaemonGateCacheForTest();
    rmTemp(dir);
  }
}

/** A throwaway bed for gate tests: temp HOME, a git repo as the project, an env for handleHook,
 *  a big file over OUTPUT_CAP, and two stub servers — one answering /healthz with 204 like the
 *  daemon, one answering 404 (up, but not the daemon). Call close() in after(). */
export async function gateBed() {
  const root = mkdtempSync(join(tmpdir(), "cm-gate-bed-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const big = join(repo, "big.log");
  writeFileSync(big, "x".repeat(OUTPUT_CAP * 2 + 100));
  const ok = createServer((req, res) => { if (req.url === "/healthz") res.writeHead(204).end(); else res.writeHead(404).end(); });
  const bad = createServer((_req, res) => { res.writeHead(404).end(); });
  await Promise.all([new Promise((r) => ok.listen(0, "127.0.0.1", r)), new Promise((r) => bad.listen(0, "127.0.0.1", r))]);
  return {
    root,
    repo,
    big,
    env: { HOME: root, USERPROFILE: root, CLAUDE_PROJECT_DIR: repo, PATH: process.env.PATH },
    up204: ok.address().port,
    notDaemon: bad.address().port,
    close: () => { ok.close(); bad.close(); rmTemp(root); },
  };
}
