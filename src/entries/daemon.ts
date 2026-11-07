// ADR-0026: the shared daemon entry. One process serves every agent session on one machine over
// loopback MCP Streamable HTTP, so RAM stops scaling with the session count (upstream issue #1334).
// build/build.mjs bundles it as daemon.mjs. Opt-in: `context-mode daemon` (the CLI routes here); the
// stdio spawn path is untouched and stays the default (ADR-0026 decision 5).
//
// Serving: the same server core as stdio (server-core.ts), through the SDK's own composition —
// 2025-era streamable HTTP sessions (one WebStandardStreamableHTTPServerTransport + one McpServer per
// client session, mcp-session-id routed) and the 2026-07-28 per-request envelope era through
// createMcpHandler, exactly the split the SDK documents for "a sessionful streamable HTTP wiring
// next to a strict modern endpoint" (isLegacyRequest in front of a legacy:'reject' handler).
// Identity stays request-scoped (ADR-0007 decision 4): sessionId from _meta, else the transport
// session id; the agent id comes from initialize clientInfo.name (ADR-0026 decision 3, the one
// deliberate deviation from "step 1 never reads clientInfo", because a shared process has no --agent
// per session); the workspace from the request (codex _meta, the x-context-mode-workspace header,
// roots/list, the daemon's own cwd in that order).
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  McpServer, createMcpHandler, isLegacyRequest, WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import type { ServerContext } from "@modelcontextprotocol/server";
import { AGENT_IDS, type AgentId } from "../core/contracts/agents.ts";
import { CLIENT_NAME_TO_PLATFORM, PLATFORM_TO_AGENT } from "../core/contracts/client-map.ts";
import {
  DAEMON_ADD_COMMAND, DAEMON_AGENT_HEADER, DAEMON_DEFAULT_PORT, DAEMON_HEALTH_PATH, DAEMON_HOST, DAEMON_PATH, DAEMON_SESSION_HEADER,
  DAEMON_PORT_ENV, DAEMON_UNIT_DIR, DAEMON_UNIT_NAME, DAEMON_WORKSPACE_HEADER, HOST_SESSION_ENV, WORKSPACE_FOLDER_FLAG,
} from "../core/contracts/constants.ts";
import { homeDirOf } from "../core/project/config-dir.ts";
import { markDaemonPort } from "../core/ops/daemon-state.ts";
import {
  createServerCore, resolveAgent, workspaceFromMeta, workspaceFromRoots, type CallRouting, type ServerCore,
} from "./server-core.ts";
import { isEntry } from "./is-entry.ts";

// D7 exit codes (clig.dev), same as the CLI: 0 ok, 1 failure, 2 usage error, 130 Ctrl-C.
const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
const BODY_CAP_BYTES = 4 * 1024 * 1024; // the SDK's own maxRequestBodySize default
const DAEMON_FLAGS = ["--port", "--agent", "--print-command", "--print-unit", "--install", "--remove", "--help", "-h"];

export interface DaemonArgs {
  port: number;             // resolved: --port, else CONTEXT_MODE_DAEMON_PORT, else the default
  agent?: AgentId;          // --agent <id>: the fallback when a session's client name maps to no adapter
  printCommand?: boolean;   // print the claude mcp add line, serve nothing
  printUnit?: boolean;      // print the systemd user unit, serve nothing
  install?: boolean;        // write the unit, enable and start it, serve nothing
  remove?: boolean;         // stop and remove the unit, serve nothing
  help?: boolean;
}

/** Pure: argv -> daemon flags. Unknown flags and bad values are usage errors (exit 2). */
export function parseDaemonArgs(argv: readonly string[], env: NodeJS.ProcessEnv): DaemonArgs | { error: string } {
  const out: DaemonArgs = { port: portFromEnv(env) };
  const value = (name: string, i: number): string | { error: string } => {
    const raw = argv[i];
    if (raw === undefined || raw === "" || raw.startsWith("-")) return { error: `${name} needs a value.` };
    return raw;
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!DAEMON_FLAGS.includes(raw)) return { error: `unknown option "${raw}" for context-mode daemon.` };
    switch (raw) {
      case "--help": case "-h":
        out.help = true;
        break;
      case "--port": {
        const v = value("--port", ++i);
        if (typeof v !== "string") return v;
        if (!/^[0-9]+$/.test(v)) return { error: `--port "${v}" is not a port.` };
        const port = Number(v);
        if (port > 65535) return { error: `--port "${v}" is not a port (0-65535; 0 picks a free port).` };
        out.port = port;
        break;
      }
      case "--agent": {
        const v = value("--agent", ++i);
        if (typeof v !== "string") return v;
        if (!(AGENT_IDS as readonly string[]).includes(v)) return { error: `unknown agent "${v}". Run context-mode setup --list.` };
        out.agent = v as AgentId;
        break;
      }
      case "--print-command":
        out.printCommand = true;
        break;
      case "--print-unit":
        out.printUnit = true;
        break;
      case "--install":
        out.install = true;
        break;
      case "--remove":
        out.remove = true;
        break;
    }
  }
  const oneShot = [out.printCommand, out.printUnit, out.install, out.remove].filter(Boolean).length;
  if (oneShot > 1) return { error: "--print-command, --print-unit, --install and --remove each serve nothing; pass at most one." };
  if (out.install && out.agent !== undefined) return { error: "--install writes a unit for every agent; --agent pins one agent for a foreground run only." };
  return out;
}

function portFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env[DAEMON_PORT_ENV];
  if (raw !== undefined && /^[0-9]+$/.test(raw)) {
    const port = Number(raw);
    if (port <= 65535) return port;
  }
  return DAEMON_DEFAULT_PORT;
}

export const DAEMON_HELP = `Usage: context-mode daemon [options]

Run one shared MCP server for every agent session on this machine, over loopback
Streamable HTTP (opt-in; the stdio spawn stays the default). Connect an agent with:
  claude mcp add --transport http context-mode http://127.0.0.1:${DAEMON_DEFAULT_PORT}${DAEMON_PATH}

Options:
  --port <n>          Listen on this port (default ${DAEMON_DEFAULT_PORT}, or ${DAEMON_PORT_ENV})
  --agent <id>        The agent for sessions whose client name maps to no adapter (default: none)
  --print-command     Print the claude mcp add line for this port; serve nothing
  --print-unit        Print the systemd user unit; serve nothing
  --install           Write the systemd user unit, enable and start it; serve nothing
  --remove            Stop and remove the systemd user unit; serve nothing
  -h, --help          Show this help

Exit codes: 0 success, 1 the port is taken or systemd failed, 2 usage error.
`;

/** A workspace header value that names a real workspace: POSIX absolute, Windows drive
 * (C:\ or C:/) or UNC (\\server\share); a relative path or a bare word is ignored (D-A26-ws-1). */
export function isAbsoluteWorkspacePath(raw: string): boolean {
  return raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\");
}

/** ADR-0026 decision 3: per-request routing for the daemon (see the file header). */
export function daemonRouting(argv: string[], env: NodeJS.ProcessEnv, core: ServerCore): CallRouting {
  // The daemon env is shared by every session, so the keys that pin one identity in a stdio spawn are
  // dropped from the per-call env: CLAUDE_PROJECT_DIR becomes the last workspace fallback instead of
  // the claude-code first choice, and a host session env var would give every session one session id.
  const pinnedProject = env.CLAUDE_PROJECT_DIR;
  const scrubbed: NodeJS.ProcessEnv = { ...env, CLAUDE_PROJECT_DIR: undefined };
  for (const key of Object.values(HOST_SESSION_ENV)) {
    if (key !== undefined) scrubbed[key] = undefined;
  }
  const cwdFallback = pinnedProject !== undefined && pinnedProject !== "" ? pinnedProject : process.cwd();
  const headerWorkspace = (req: ServerContext): string | undefined => {
    const raw = req.http?.req?.headers.get(DAEMON_WORKSPACE_HEADER);
    return typeof raw === "string" && raw !== "" && isAbsoluteWorkspacePath(raw) ? raw : undefined;
  };
  return {
    agentOf: (server, _meta, req) => {
      const name = server.server.getClientVersion()?.name;
      const platform = name !== undefined && Object.hasOwn(CLIENT_NAME_TO_PLATFORM, name) ? CLIENT_NAME_TO_PLATFORM[name] : undefined;
      const fromClient = platform === undefined ? undefined : PLATFORM_TO_AGENT[platform];
      if (fromClient !== undefined) return fromClient;
      const header = req.http?.req?.headers.get(DAEMON_AGENT_HEADER);
      if (typeof header === "string" && (AGENT_IDS as readonly string[]).includes(header)) return header as AgentId;
      return resolveAgent(argv, env);
    },
    cwdOf: async (meta, req, server, agent) => {
      const ws = workspaceFromMeta(meta) ?? headerWorkspace(req) ?? await workspaceFromRoots(server) ?? cwdFallback;
      // vscode resolves its project from the --workspace-folder flag, not the cwd (impl/02 §2 dirOf).
      const callArgv = agent === "vscode" ? [...argv, WORKSPACE_FOLDER_FLAG, ws] : argv;
      return { cwd: ws, argv: callArgv };
    },
    envOf: () => scrubbed,
    // Session identity for a shared process: the HOST session id when the client can set
    // per-session headers (it matches the id its hooks journal under, so scope:"session" finds
    // hook-indexed rows), else the transport session (one per connection), never the process id.
    fallbackIdOf: (req) => req.http?.req?.headers.get(DAEMON_SESSION_HEADER) ?? req.sessionId ?? core.serverId,
  };
}

// ---- node:http <-> web Request ----

async function readBody(req: IncomingMessage, res: ServerResponse): Promise<Uint8Array | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_CAP_BYTES) {
      res.writeHead(413, { "content-type": "text/plain" }).end("request body over 4 MiB\n");
      return null;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function toWebRequest(req: IncomingMessage, port: number, body: Uint8Array, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.set(name, value);
  }
  const method = req.method ?? "GET";
  return new Request(`http://${req.headers.host ?? `${DAEMON_HOST}:${port}`}${req.url ?? "/"}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : (body as BodyInit),
    redirect: "manual",
    signal,
  });
}

async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of response.headers) headers[name] = value;
  const setCookie = response.headers.getSetCookie();
  if (setCookie.length > 0) headers["set-cookie"] = setCookie;
  res.writeHead(response.status, response.statusText, headers);
  if (response.body === null) {
    res.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const stream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    stream.on("error", reject);
    res.on("close", () => resolve());
    stream.pipe(res);
    res.on("finish", () => resolve());
  }).catch(() => {
    // the client went away or the stream broke after the head was written; nothing left to answer
    try { res.destroy(); } catch { /* already gone */ }
  });
}

// ---- systemd user unit ----

/** systemd double-quoting for ExecStart/Environment words: a path with spaces (an npm prefix
 * like `/home/user/context mode`) must stay one argument (A26-r2). */
function systemdQuote(value: string): string {
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

export function daemonUnitText(nodeBin: string, daemonBundle: string, port: number): string {
  return [
    "[Unit]",
    "Description=context-mode shared MCP daemon",
    "Documentation=https://github.com/mksglu/context-mode/blob/main/docs/daemon.md",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${systemdQuote(nodeBin)} ${systemdQuote(daemonBundle)}`,
    `Environment=${systemdQuote(`${DAEMON_PORT_ENV}=${port}`)}`,
    "Restart=on-failure",
    "RestartSec=1",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function unitPath(env: NodeJS.ProcessEnv): string {
  const home = homeDirOf(env);
  if (home === null) throw new Error("no HOME: the unit file lives under $HOME/.config");
  return join(home, ".config", ...DAEMON_UNIT_DIR, DAEMON_UNIT_NAME);
}

function systemctl(env: NodeJS.ProcessEnv, args: string[]): { ok: boolean; line: string } {
  const r = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", env, windowsHide: true });
  // no systemd (macOS, Windows, a container): the spawn fails, stdout/stderr are null —
  // a "not started" line, never a TypeError from null.split (A26-r5)
  if (r.error !== undefined) return { ok: false, line: r.error.message };
  const line = ((r.stdout ?? "") + (r.stderr ?? "")).split("\n").map((l) => l.trim()).filter(Boolean).join(" | ");
  return { ok: r.status === 0, line };
}

/** --install / --remove: one line per action, the setup print conventions (no paths typed by hand). */
export function runDaemonUnitAction(args: DaemonArgs, env: NodeJS.ProcessEnv, nodeBin: string, daemonBundle: string): number {
  const path = unitPath(env);
  if (args.remove === true) {
    const stop = systemctl(env, ["disable", "--now", DAEMON_UNIT_NAME]);
    console.log(`${stop.ok ? "stopped" : "not stopped"}: systemctl --user disable --now ${DAEMON_UNIT_NAME}${stop.line ? " (" + stop.line + ")" : ""}`);
    try {
      rmSync(path, { force: true });
      console.log(`removed: ${path}`);
    } catch (err) {
      console.log(`not removed: ${path} (${(err as Error).message})`);
    }
    const reload = systemctl(env, ["daemon-reload"]);
    console.log(`${reload.ok ? "reloaded" : "not reloaded"}: systemctl --user daemon-reload`);
    return EXIT_OK;
  }
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, daemonUnitText(nodeBin, daemonBundle, args.port) + "\n");
  console.log(`wrote: ${path}`);
  const reload = systemctl(env, ["daemon-reload"]);
  console.log(`${reload.ok ? "reloaded" : "not reloaded"}: systemctl --user daemon-reload`);
  const enable = systemctl(env, ["enable", DAEMON_UNIT_NAME]);
  console.log(`${enable.ok ? "enabled" : "not enabled"}: systemctl --user enable ${DAEMON_UNIT_NAME}${enable.line ? " (" + enable.line + ")" : ""}`);
  // restart, not enable --now: a unit that is already running would keep the OLD config
  // (a new port or bundle path must take effect on the next --install, A26-r3)
  const restart = systemctl(env, ["restart", DAEMON_UNIT_NAME]);
  console.log(`${restart.ok ? "started" : "not started"}: systemctl --user restart ${DAEMON_UNIT_NAME}${restart.line ? " (" + restart.line + ")" : ""}`);
  return enable.ok && restart.ok ? EXIT_OK : EXIT_FAIL;
}

// ---- the daemon ----

interface LegacySession {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
}

export interface DaemonHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

/** Start the daemon; resolves when the listener is bound (the banner and tests read handle.url). */
export async function startDaemon(argv: string[], env: NodeJS.ProcessEnv): Promise<DaemonHandle> {
  const core = await createServerCore(argv, env);
  const routing = daemonRouting(argv, env, core);
  const args = parseDaemonArgs(argv, env);
  if ("error" in args) throw new Error(args.error);
  const port = args.port;

  // 2026-07-28 era: one server per request from the same factory, no session state (the SDK's own entry).
  const modern = createMcpHandler(() => core.createMcpServer(routing), { legacy: "reject" });

  // 2025-era streamable HTTP: one transport + one McpServer per client session, routed by mcp-session-id.
  const sessions = new Map<string, LegacySession>();
  async function legacyHandle(request: Request): Promise<Response> {
    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId !== null) {
      const entry = sessions.get(sessionId);
      // The spec's own answer for an id this server never issued (or already closed).
      if (entry === undefined) return new Response("MCP session not found: " + sessionId, { status: 404 });
      return entry.transport.handleRequest(request);
    }
    let session: LegacySession | undefined;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        if (session !== undefined) sessions.set(id, session);
      },
      onsessionclosed: (id) => {
        const entry = sessions.get(id);
        sessions.delete(id);
        void entry?.server.close().catch(() => {});
      },
    });
    session = { transport, server: core.createMcpServer(routing) };
    await session.server.connect(transport);
    const response = await transport.handleRequest(request);
    // A request that never initialized a session (a non-initialize POST without mcp-session-id, a GET
    // before initialize) is answered 400/405 by the transport; the pair it created must not stay behind
    // (ADR-0026 decision 4: no per-request state outlives its exchange).
    if (transport.sessionId === undefined) void session.server.close().catch(() => {});
    return response;
  }

  const http = createHttpServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      console.error("context-mode daemon: " + (err instanceof Error ? err.message : String(err)));
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" }).end("internal error\n");
      else try { res.destroy(); } catch { /* already gone */ }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Loopback is the trust boundary, so the Host must name it (a DNS-rebinding page points a
    // name at 127.0.0.1) and a browser Origin is refused outright (MCP clients send none).
    // hostname only: the port in Host varies (e.g. --port 0 binds a random one), and rebinding
    // protection is about the NAME pointing here, not the port
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (host !== DAEMON_HOST && host !== "localhost") {
      res.writeHead(421, { "content-type": "text/plain" }).end("misdirected request: the daemon answers loopback only\n");
      return;
    }
    if (req.headers.origin !== undefined) {
      res.writeHead(403, { "content-type": "text/plain" }).end("origin not allowed\n");
      return;
    }
    if (req.method === "GET" && req.url === DAEMON_HEALTH_PATH) {
      res.writeHead(204).end();
      return;
    }
    if (req.url !== DAEMON_PATH) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found: use " + DAEMON_PATH + "\n");
      return;
    }
    const abort = new AbortController();
    res.once("close", () => abort.abort());
    const body = await readBody(req, res);
    if (body === null) return; // over the cap: readBody already answered 413
    const request = toWebRequest(req, port, body, abort.signal);
    const response = (await isLegacyRequest(request)) ? await legacyHandle(request) : await modern.fetch(request);
    await sendResponse(res, response);
  }

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, DAEMON_HOST, () => resolve());
  });
  const boundPort = (http.address() as AddressInfo).port;
  markDaemonPort(boundPort);

  // systemd stops the unit with SIGTERM; a foreground Ctrl-C is SIGINT. Both take the stdio shutdown
  // path (removeOwnerPid, closeDb, D-M5-R1-1 stop marker), then let the loop empty (impl/11 §4 steps 2-3).
  const stop = (): void => {
    core.shutdown();
    void modern.close().catch(() => {});
    // every open session goes down with the daemon: a client holding an SSE GET would keep
    // http.close() pending forever, and each session's server holds resources (ADR-0026 d6)
    for (const [, entry] of sessions) void entry.server.close().catch(() => {});
    sessions.clear();
    http.closeAllConnections?.();
    http.close(() => {});
    setTimeout(() => process.exit(0), 2000).unref(); // a wedged connection never blocks the stop
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  return {
    port: boundPort,
    url: `http://${DAEMON_HOST}:${boundPort}${DAEMON_PATH}`,
    close: async () => {
      core.shutdown();
      await modern.close().catch(() => {});
      for (const [, entry] of sessions) await entry.server.close().catch(() => {});
      sessions.clear();
      http.closeAllConnections?.();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

async function main(): Promise<void> {
  const parsed = parseDaemonArgs(process.argv.slice(2), process.env);
  if ("error" in parsed) {
    process.stderr.write(`context-mode daemon: ${parsed.error}\n`);
    process.exitCode = EXIT_USAGE;
    return;
  }
  if (parsed.help === true) {
    process.stdout.write(DAEMON_HELP);
    return;
  }
  const url = `http://${DAEMON_HOST}:${parsed.port}${DAEMON_PATH}`;
  if (parsed.printCommand === true) {
    process.stdout.write(DAEMON_ADD_COMMAND(url) + "\n");
    return;
  }
  if (parsed.printUnit === true) {
    process.stdout.write(daemonUnitText(process.execPath, fileURLToPath(import.meta.url), parsed.port) + "\n");
    return;
  }
  if (parsed.install === true || parsed.remove === true) {
    process.exitCode = runDaemonUnitAction(parsed, process.env, process.execPath, fileURLToPath(import.meta.url));
    return;
  }
  let handle: DaemonHandle;
  try {
    handle = await startDaemon(process.argv.slice(2), process.env);
  } catch (err) {
    process.stderr.write(`context-mode daemon: ${(err as Error).message}\n`);
    process.exit(EXIT_FAIL);
  }
  // The startup banner names the exact connect command (ADR-0026 decision 2a): stdout is not an MCP
  // channel here, so it is safe to write to.
  process.stdout.write(`context-mode daemon listening on ${handle.url}\n`);
  process.stdout.write(DAEMON_ADD_COMMAND(handle.url) + "\n");
  await new Promise<void>((resolve) => process.once("exit", () => resolve()));
}

if (isEntry(import.meta.main, process.argv[1], fileURLToPath(import.meta.url))) await main();
