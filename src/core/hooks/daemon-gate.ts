// kaovilai/context-mode#11: the replace and read-deny routes hand the model ctx_search/ctx_execute
// pointers. Those tools live in the MCP server; the hooks are separate processes that keep running
// when it is gone, so a replace or deny issued while the server is down is a dead end — the output
// is swallowed and the only named recovery tool does not exist in the session. This module answers
// one question for the decision paths: are the ctx_* tools this install routes to unreachable?
//
// Scope (ADR-0026): only the claude-code marketplace install routes MCP through the shared daemon
// (build/manifests.ts claudeMcpManifest, type "http"); every other surface keeps the stdio
// server.mjs bridge, a child of the host that no probe can see. Two checks arm the gate, both
// needed: the manifest next to the running hook bundle must ship the http entry (the same
// dirname(process.argv[1]) location caseB uses for run.mjs — one release tree serves several
// agents, e.g. codex's ${PLUGIN_ROOT}/hook.mjs is the same root file, so the manifest alone would
// wrongly arm codex), AND the session's agent must be the one the daemon entry routes (claude-code).
// A src import (tests) or a stdio bundle never gates either way.
// D-CI-PERF-3: node:http and node:fs load through getBuiltinModule inside the probe, so a hook
// that never gates pays no module-load cost.
import { dirname, join } from "node:path";
import type { AgentId } from "../contracts/agents.ts";
import {
  BYPASS_ENV, DAEMON_DEFAULT_PORT, DAEMON_HEALTH_PATH, DAEMON_HOST, DAEMON_PATH, DAEMON_PORT_ENV, DAEMON_PROBE_TIMEOUT_MS, SERVER_KEY,
} from "../contracts/constants.ts";

/** The one agent whose MCP entry is the daemon (build/manifests.ts claudeMcpManifest). */
const DAEMON_ROUTED_AGENT: AgentId = "claude-code";

/** #11: "1" = the user asked for raw output; replace and read-deny stand down for the session.
 *  Set in the environment the host starts from (a shell export inside a tool call cannot reach it:
 *  the hook inherits the host process env, not the model's shell). */
export function hookBypassed(env: NodeJS.ProcessEnv): boolean {
  return env[BYPASS_ENV] === "1";
}

let entryCache: boolean | undefined;

/** True when this hook bundle ships the daemon HTTP MCP entry (claude-code marketplace install).
 *  Read once per process; any read or parse failure means "no" (a stdio bundle never gates). */
export function daemonEntryExpected(): boolean {
  if (entryCache === undefined) {
    entryCache = false;
    try {
      const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
      const manifest: unknown = JSON.parse(fs.readFileSync(join(dirname(process.argv[1] ?? ""), ".claude-plugin", "plugin.json"), "utf8"));
      const entry = (manifest as { mcpServers?: Record<string, { type?: unknown }> })?.mcpServers?.[SERVER_KEY];
      entryCache = entry !== null && typeof entry === "object" && entry.type === "http";
    } catch {
      // not a daemon-mode bundle (no manifest next to it, or an unreadable one): never gate
    }
  }
  return entryCache;
}

/** Tests only: the manifest read caches for the process' life; a test that points process.argv[1]
 *  at a different bundle resets the cache. Production code never calls this. */
export function resetDaemonGateCacheForTest(): void {
  entryCache = undefined;
}

/** The daemon's /healthz answers 204 (daemon.ts, DAEMON_HEALTH_PATH). Any other answer, timeout or
 *  connection error means the ctx_* routes are dead. Loopback, so a healthy daemon answers in
 *  well under a millisecond and a down one refuses instantly. Two separate guards close the probe:
 *  the request's own `timeout` (socket inactivity) and an absolute deadline — a server that
 *  trickles a byte at a time never goes inactive and never completes its headers, and without the
 *  deadline it would hold the hook open (D-M3-H2-8) until the host kills it. Every exit destroys
 *  the request, so no answer path leaves a socket behind; a socket error after the headers
 *  resolves false the same way — the probe never crashes the hook. */
async function healthzUp(port: number): Promise<boolean> {
  const http = process.getBuiltinModule("node:http") as typeof import("node:http");
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    const finish = (up: boolean): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      req.destroy();
      resolve(up);
    };
    deadline = setTimeout(() => finish(false), DAEMON_PROBE_TIMEOUT_MS);
    deadline.unref(); // the probe is awaited; the timer never holds the hook's loop on its own
    // A fresh Agent, never the global one: NODE_USE_ENV_PROXY=1 routes the global agent through
    // HTTP_PROXY, and a proxy without a loopback NO_PROXY exclusion cannot answer for 127.0.0.1 —
    // the probe would read every healthy daemon as down (Copilot review). Loopback stays direct.
    const req = http.request({ host: DAEMON_HOST, port, path: DAEMON_HEALTH_PATH, method: "GET", timeout: DAEMON_PROBE_TIMEOUT_MS, agent: new http.Agent() }, (res) => {
      res.on("error", () => finish(false));
      finish(res.statusCode === 204);
    });
    req.on("timeout", () => finish(false));
    req.on("error", () => finish(false));
    req.end();
  });
}

const HTTP_DEFAULT_PORT = 80; // new URL() drops a scheme's default port, so "" means 80 here

/** #11 + CodeRabbit review: the port the session's MCP entry actually points at. The plugin URL
 *  expands ${CONTEXT_MODE_DAEMON_PORT} raw into `http://127.0.0.1:<value>/mcp`, so the probe must
 *  read the value the same way — URL semantics, not daemonConfiguredPort's digits-only parse.
 *  Returns null when the expanded entry cannot work at all, so the gate fails open instead of
 *  blessing a session whose entry is dead: a value like "8791/" names port 8791 but the path
 *  becomes "//mcp", which the daemon answers 404 (it serves DAEMON_PATH only); an unparseable
 *  value makes an invalid URL. Unset or empty keeps the ${VAR:-default} expansion's default. */
export function effectiveMcpTarget(env: NodeJS.ProcessEnv): { port: number } | null {
  const raw = env[DAEMON_PORT_ENV];
  if (raw === undefined || raw === "") return { port: DAEMON_DEFAULT_PORT };
  let url: URL;
  try {
    url = new URL("http://" + DAEMON_HOST + ":" + raw + DAEMON_PATH);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null; // userinfo: the template never makes one, a value that does has redirected the target
  if (url.hostname !== DAEMON_HOST) return null; // "8790@127.0.0.2:8790" makes 127.0.0.2 the host: the daemon binds DAEMON_HOST only, that entry is dead
  if (url.pathname !== DAEMON_PATH || url.search !== "") return null; // the entry's whole request target must be exactly DAEMON_PATH: a value like "8790/mcp?x" keeps the pathname but adds a query the daemon 404s
  const port = url.port === "" ? HTTP_DEFAULT_PORT : Number(url.port);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535 ? { port } : null;
}

/** #11: true when the ctx_* tools this session's routes point at are unreachable — the daemon-routed
 *  agent (claude-code) on a daemon-mode bundle whose /healthz probe fails, or whose MCP entry
 *  cannot work at all (effectiveMcpTarget null). False everywhere else: another agent's stdio
 *  server is a host child no probe can see (and the same release tree serves those agents, so the
 *  manifest alone must never arm the gate), and gating on it would disable interception for every
 *  stdio user. */
export async function daemonToolsDown(env: NodeJS.ProcessEnv, agent: AgentId): Promise<boolean> {
  if (agent !== DAEMON_ROUTED_AGENT || !daemonEntryExpected()) return false;
  const target = effectiveMcpTarget(env);
  if (target === null) return true;
  return !(await healthzUp(target.port));
}
