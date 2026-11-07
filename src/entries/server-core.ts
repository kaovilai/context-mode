// ADR-0026: the server core shared by the stdio entry (src/entries/server.ts) and the daemon entry
// (src/entries/daemon.ts). Everything impl/11 §5 put in startServer before the transport wiring lives
// here: the per-project DB pool, the owner files, the journal, the stop marker and the dispatch wrapper.
// The file holds no entry guard on purpose (the run.mjs/search.mjs rule, DEVIATIONS D-M3-X1-2): each
// bundle inlines it behind exactly one guarded entry, so a daemon.mjs bundle never also runs the stdio
// bottom of server.ts. ADR-0007 decision 4 keeps holding: every value the tools see is built fresh from
// the request; the only process-shared state is the DB handle pool and the owner identity, which hold
// resources, not session identity (impl/11 §5 step 6 comment).
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, type ServerContext, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { AGENT_IDS, type AgentId } from "../core/contracts/agents.ts";
import {
  HOST_SESSION_ENV, INTERNAL_ERROR_LINE, NODE_MIN, OWNER_STOP_EXT, OWNERS_DIR_NAME, PROJECTS_DIR_NAME, RUN_SESSION_PREFIX, SERVER_KEY, TOOLS_TTL_MS,
  UPGRADE_STOP_DELAY_MS, JOURNAL_SKIPPED_LINE, ROOTS_TIMEOUT_MS, VSCODE_WORKSPACE_VAR, WORKSPACE_FOLDER_FLAG,
} from "../core/contracts/constants.ts";
import { CtxError } from "../core/contracts/errors.ts";
import type { DbHandle, ProjectContext, ToolContext, ToolReply } from "../core/contracts/types.ts";
import { appendEvent, ownCallRow } from "../core/journal/append.ts";
import { resolveConfigDir } from "../core/project/config-dir.ts";
import { resolveProject } from "../core/project/resolve.ts";
import { cleanupProject, sweepDeadProjects } from "../core/store/cleanup.ts";
import { closeDb, openDb } from "../core/store/db.ts";
import { removeOwnerPid, writeOwnerPid } from "../core/store/owners.ts";
import { z } from "zod/v4";
import { TOOLS, checkCall, type RegisteredTool } from "../core/tools/registry.ts";
import { INSTRUCTIONS } from "../prompt/_generated.ts";

export { INSTRUCTIONS };

// §5 step 1a-1d. Re-run per call (Assumption A3); no clientInfo read.
export function resolveAgent(argv: readonly string[], env: NodeJS.ProcessEnv): AgentId | undefined {
  let afterFlag = false;
  for (const arg of argv) {
    if (afterFlag) {
      const known = AGENT_IDS.find((a) => a === arg);
      if (known === undefined) console.error("context-mode: unknown --agent " + arg);
      return known;
    }
    afterFlag = arg === "--agent";
  }
  if (env.CLAUDE_PROJECT_DIR !== undefined) return "claude-code";
  return undefined; // §5 step 1c-1d: a spawn-cwd agent also passes --agent at install; else unresolved
}

// §5 step 2a: compare dotted versions as numbers, not strings (numeric collation, no parsing).
const NUMERIC = new Intl.Collator("en", { numeric: true });
function versionAtLeast(have: string, min: string): boolean {
  const [lower] = [have, min].sort(NUMERIC.compare);
  return lower === min;
}

// D-CALL-SHAPE-1: the host gets the real JSON Schema (required, enums, descriptions kept); the SDK's own
// validation accepts every input, so a bad call reaches dispatch, which answers with one line that shows the exact call.
function passThrough(tool: RegisteredTool<unknown>): StandardSchemaWithJSON {
  const json = (): Record<string, unknown> => z.toJSONSchema(tool.schema, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>;
  return {
    "~standard": {
      version: 1,
      vendor: "context-mode",
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: json, output: json },
    },
  } as unknown as StandardSchemaWithJSON;
}

// §5 step 2.
export async function isDegraded(): Promise<boolean> {
  if (!versionAtLeast(process.versions.node, NODE_MIN)) return true;
  try {
    await import("node:sqlite");
    return false;
  } catch {
    return true;
  }
}

function metaString(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = meta?.[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

export function metaNumber(meta: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = meta?.[key];
  return typeof v === "number" && Number.isSafeInteger(v) ? v : undefined;
}

// D-CR2-SID-1: _meta.sessionId, else the session id the host put in the server env (the id its hooks
// journal under, so scope:"session" finds hook-indexed rows), else the caller's fallback id,
// UNCHANGED: the stdio routing passes mcp:<serverId> (a process-local id), the daemon routing
// passes the session header, the transport session id, or a fresh anonymous id — prefixing here
// would break the header case, whose whole point is to equal the hooks' unprefixed host id (A26-r8).
export function sessionIdOf(meta: Record<string, unknown> | undefined, agent: AgentId | undefined, env: NodeJS.ProcessEnv, fallbackId: string): string {
  const fromMeta = metaString(meta, "sessionId");
  if (fromMeta !== undefined) return fromMeta;
  const key = agent === undefined ? undefined : HOST_SESSION_ENV[agent];
  const fromHost = key === undefined ? undefined : env[key];
  if (typeof fromHost === "string" && fromHost !== "") return fromHost;
  return fallbackId;
}

// D-C166-NATIVE-CWD-1: a plugin host starts this server in the plugin dir (Codex mcp.json "cwd": "."), so the spawn cwd
// is not the workspace. Codex 0.166 sends the workspace as _meta["codex/sandbox-state-meta"].sandboxCwd (a file URL) to
// a server that declares that experimental capability at initialize (roots is [], no workspace env: probed live).
const CODEX_SANDBOX_STATE_META = "codex/sandbox-state-meta";
const FILE_URL_PREFIX = "file:";

export function workspaceFromMeta(meta: Record<string, unknown> | undefined): string | undefined {
  const state = meta?.[CODEX_SANDBOX_STATE_META];
  const cwd = typeof state === "object" && state !== null ? (state as Record<string, unknown>).sandboxCwd : undefined;
  if (typeof cwd !== "string" || cwd === "") return undefined;
  if (!cwd.startsWith(FILE_URL_PREFIX)) return cwd;
  try {
    return fileURLToPath(cwd);
  } catch {
    return undefined;
  }
}

function realOrSame(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/** D-VSCODE-ROOTS-1: true when argv names a real workspace folder (an unexpanded ${workspaceFolder} is not one). */
export function hasWorkspaceFolder(argv: readonly string[]): boolean {
  const i = argv.indexOf(WORKSPACE_FOLDER_FLAG);
  const v = i < 0 ? undefined : argv[i + 1];
  return v !== undefined && v !== "" && v !== VSCODE_WORKSPACE_VAR;
}

/** D-VSCODE-ROOTS-1: the first file root the host lists, as a path; undefined when the host declares no roots,
 *  lists none, or does not answer within ROOTS_TIMEOUT_MS. */
export async function workspaceFromRoots(server: McpServer): Promise<string | undefined> {
  if (server.server.getClientCapabilities()?.roots === undefined) return undefined;
  try {
    const { roots } = await server.server.listRoots(undefined, { timeout: ROOTS_TIMEOUT_MS });
    for (const root of roots) {
      if (root.uri.startsWith(FILE_URL_PREFIX)) return fileURLToPath(root.uri);
    }
  } catch (err) {
    console.error("context-mode: roots/list: " + (err instanceof Error ? err.message : String(err)));
  }
  return undefined;
}

/** The dir the project is resolved from: the host's workspace when it sent one, else the spawn cwd, never the dir this
 *  bundle runs from (that is the plugin cache dir, not a project): "" then, and resolveProject throws NO_PROJECT. */
export function workspaceCwdOf(meta: Record<string, unknown> | undefined, spawnCwd: string, script: string | undefined): string {
  const fromHost = workspaceFromMeta(meta);
  if (fromHost !== undefined) return fromHost;
  if (script === undefined || script === "") return spawnCwd;
  return realOrSame(spawnCwd) === realOrSame(dirname(script)) ? "" : spawnCwd;
}

// §5 step 7d: one line to the client, the stack to stderr only.
export function errorReply(err: unknown): ToolReply {
  if (err instanceof CtxError) return { text: err.toLine(), isError: true, sandboxBytes: 0 };
  console.error(err);
  return { text: INTERNAL_ERROR_LINE, isError: true, sandboxBytes: 0 };
}

/** ADR-0026 decision 2: how a call finds its agent, its workspace and its session scope. The stdio entry
 *  uses the argv/env/cwd behavior of impl/11 §5 unchanged (stdioRouting); the daemon entry resolves all
 *  three per request from the client session (clientInfo name, request headers, roots/list). */
export interface CallRouting {
  /** §5 step 1 per call. */
  agentOf(server: McpServer, meta: Record<string, unknown> | undefined, req: ServerContext): AgentId | undefined;
  /** §5 steps 5-6a: the dir the project resolves from, and the argv resolveProject reads (the vscode flag). */
  cwdOf(meta: Record<string, unknown> | undefined, req: ServerContext, server: McpServer, agent: AgentId | undefined): Promise<{ cwd: string; argv: string[] }>;
  /** The env sessionIdOf and resolveProject read. stdio: the process env as given. */
  envOf(): NodeJS.ProcessEnv;
  /** The "mcp:<id>" fallback id when the request carries no session id. stdio: the process serverId. */
  fallbackIdOf(req: ServerContext): string;
}

/** impl/11 §5 verbatim: the stdio routing. agent from --agent/env, workspace from _meta/spawn cwd, one process one client. */
export function stdioRouting(argv: string[], env: NodeJS.ProcessEnv, serverId: string): CallRouting {
  return {
    agentOf: (_server, _meta) => resolveAgent(argv, env),
    cwdOf: async (meta, _req, server, agent) => {
      // D-VSCODE-ROOTS-1: VS Code (user mcp.json, spawn cwd HOME) names the workspace only in roots/list. Asked on
      // each call, so a folder the user opens later is the project of the next call.
      const fromRoots = agent === "vscode" && !hasWorkspaceFolder(argv) ? await workspaceFromRoots(server) : undefined;
      const callArgv = fromRoots === undefined ? argv : [...argv, WORKSPACE_FOLDER_FLAG, fromRoots];
      return { cwd: workspaceCwdOf(meta, process.cwd(), process.argv[1]), argv: callArgv };
    },
    envOf: () => env,
    fallbackIdOf: () => RUN_SESSION_PREFIX + serverId, // process-local id (§4 step 5, 00 A8)
  };
}

export interface ServerCore {
  readonly serverId: string;
  readonly degraded: boolean;
  /** A26-r12: resolves when no tool-call handler is mid-flight (shutdown waits for this, so a
   * handler never runs into databases the shutdown closed). */
  drain(): Promise<void>;
  /** A26-r12: the current in-flight handler count (tests synchronize on it). */
  inFlight(): number;
  /** §5 step 9a, impl/02 §7.2: removeOwnerPid, then closeDb, each best-effort (never blocks shutdown). */
  shutdown(): void;
  /** D-M5-R1-1: the uninstall stop takes the same path as stdin EOF. */
  stopSelf(): void;
  /** §5 step 4: one McpServer bound to `routing`; the stdio entry asks once, the daemon once per session. */
  createMcpServer(routing: CallRouting): McpServer;
}

/** impl/11 §5 steps 1-8: the shared core. One per process; the daemon serves every session through it. */
export async function createServerCore(argv: string[], env: NodeJS.ProcessEnv): Promise<ServerCore> {
  const serverId = randomUUID(); // 00 Assumption A8: process-local, generated once
  const degraded = await isDegraded();
  // §5 step 3: degraded mode serves ctx_doctor only (PRD §13).
  const tools = degraded ? TOOLS.filter((t) => t.name === "ctx_doctor") : TOOLS;

  // The server's own DB handles, one per project it has written to, opened on the first call for
  // that project (§5 step 6, 00 §5.1 step 5) and closed at shutdown (§5 step 9a). These hold
  // resources, not identity: the ProjectContext itself is resolved again on every call (§5 step 5b).
  const pending = new Map<string, Promise<DbHandle>>(); // dbPath -> open in progress or done
  const held: DbHandle[] = [];
  // D-M1-11: cleanup runs once per database, never on a timer. The daemon serves many projects
  // through one process, so "once per process" would clean only the first project (A26-r1).
  // The dead-project sweep stays once per process: it walks every project's files (D-M1-T7-1).
  const cleaned = new Set<string>();
  let swept = false;

  // §5 step 6b, D-M1-11, D-M1-T7-1: openDb, then cleanupProject (before our own owner file, else
  // its live-owner check always sees us), then writeOwnerPid, then sweepDeadProjects.
  async function openOwn(project: ProjectContext): Promise<DbHandle> {
    const db = await openDb(project);
    // D-M1-T3-5: the config dir comes from the process env, the same one resolveProject used.
    const configDir = resolveConfigDir(process.env);
    try {
      const dbPath = project.projectKey;
      if (!cleaned.has(dbPath)) {
        cleaned.add(dbPath);
        cleanupProject(db, configDir);
      }
      writeOwnerPid(configDir, project.projectKey, serverId);
    } catch (err) {
      closeDb(db);
      throw err;
    }
    held.push(db);
    if (!swept) {
      swept = true;
      sweepDeadProjects(configDir);
    }
    return db;
  }

  // ADR-0002 decision 3: a held handle whose path has vanished is a hard error, never a recreate.
  async function ownDb(project: ProjectContext): Promise<DbHandle> {
    let opening = pending.get(project.dbPath);
    if (opening === undefined) {
      opening = openOwn(project);
      pending.set(project.dbPath, opening);
      // A failed open leaves no entry, so the next call opens again (one attempt per call, no loop).
      opening.catch(() => pending.delete(project.dbPath));
    }
    const db = await opening;
    if (!existsSync(db.path)) throw new CtxError("DB_GONE");
    return db;
  }

  // impl/07 uninstall step 1 (D-M5-U7-3): <DATA_ROOT>/projects/<projectKey>/owners/<serverId>.stop.
  function stopMarker(configDir: string, projectKey: string): string {
    return join(configDir, PROJECTS_DIR_NAME, projectKey, OWNERS_DIR_NAME, serverId + OWNER_STOP_EXT);
  }
  // Only a project this server owns can carry its marker (uninstall marks live owners only).
  function stopRequested(): boolean {
    const configDir = resolveConfigDir(process.env);
    return held.some((db) => existsSync(stopMarker(configDir, db.projectKey)));
  }

  // impl/00 §5.2 step 5, ADR-0009 §0: one journal row per own call (D-M1-10).
  async function journal(project: ProjectContext, ctx: ToolContext, name: string, reply: ToolReply): Promise<void> {
    const db = await ownDb(project);
    appendEvent(db, ownCallRow(project, ctx, name, reply));
  }

  // §5 steps 5-7: stateless dispatch; ToolContext is built fresh from each request.
  // A26-r12: in-flight tool-call handlers, so a shutdown can wait them out instead of closing
  // the databases underneath one. Counted per call; drain() resolves when the count returns to 0.
  let activeCalls = 0;
  let idleWaiters: (() => void)[] = [];
  const callStarted = (): void => {
    activeCalls++;
  };
  const callEnded = (): void => {
    activeCalls--;
    if (activeCalls === 0) {
      const wake = idleWaiters;
      idleWaiters = [];
      for (const w of wake) w();
    }
  };
  const inFlight = (): number => activeCalls;
  const drain = async (): Promise<void> => {
    if (activeCalls === 0) return;
    await new Promise<void>((resolve) => { idleWaiters.push(resolve); });
  };

  function dispatch(server: McpServer, tool: RegisteredTool<unknown>, routing: CallRouting) {
    return async (input: unknown, req: ServerContext) => {
      callStarted();
      try {
        return await dispatchInner(server, tool, routing, input, req);
      } finally {
        callEnded();
      }
    };
  }

  async function dispatchInner(server: McpServer, tool: RegisteredTool<unknown>, routing: CallRouting, input: unknown, req: ServerContext) {
      const meta = req.mcpReq._meta as Record<string, unknown> | undefined;
      const agent = routing.agentOf(server, meta, req);
      // §5 step 6a, 7a: resolved lazily, at most once per call, never cached across calls.
      const { cwd, argv: callArgv } = await routing.cwdOf(meta, req, server, agent);
      let project: ProjectContext | undefined;
      const projectOf = (): ProjectContext => {
        if (agent === undefined) throw new CtxError("NO_PROJECT", { kind: "--agent" });
        project ??= resolveProject(agent, { env: routing.envOf(), argv: callArgv, cwd, piCwd: undefined });
        return project;
      };
      const ctx: ToolContext = {
        get project(): ProjectContext {
          return projectOf();
        },
        sessionId: sessionIdOf(meta, agent, routing.envOf(), routing.fallbackIdOf(req)),
        turn: metaNumber(meta, "turn") ?? 0,
        signal: req.mcpReq.signal,
        clientInfo: server.server.getClientVersion(),
        protocolVersion: server.server.getNegotiatedProtocolVersion() ?? "",
      };
      // D-CALL-SHAPE-1: the SDK passes the input through (see passThrough); the check and its one-line error live here.
      let reply: ToolReply;
      const checked = checkCall(tool, input);
      if (!checked.ok) {
        reply = { text: checked.line, isError: true, sandboxBytes: 0 };
      } else {
        try {
          reply = await tool.handler(checked.data, ctx);
        } catch (err) {
          reply = errorReply(err);
        }
      }
      // impl/07 uninstall step 1, D-M5-R1-1: a call that left this server's own stop marker (ctx_upgrade
      // mode "uninstall") writes no journal row (the project data is going away) and ends the process
      // UPGRADE_STOP_DELAY_MS after the reply is written.
      if (stopRequested()) {
        setTimeout(stopSelf, UPGRADE_STOP_DELAY_MS);
        return { content: [{ type: "text" as const, text: reply.text }], isError: reply.isError };
      }
      // D-M1-T10-1: degraded mode has no node:sqlite, and an unresolved project has no DB, so
      // neither writes a row (a handler that needs the project already surfaced NO_PROJECT).
      // A failure on a resolved project (DB_GONE, DB_CORRUPT, busy) becomes the call's result.
      if (!degraded) {
        let resolved: ProjectContext | undefined;
        try {
          resolved = projectOf();
        } catch (err) {
          console.error("context-mode: no journal row: " + (err instanceof Error ? err.message : String(err)));
        }
        if (resolved !== undefined) {
          try {
            await journal(resolved, ctx, tool.name, reply);
          } catch (err) {
            // D-ORPHAN-WAL-1, ADR-0010 "doctor always answers": a doctor reply that cannot be journaled stays the
            // reply, with one line that says the row was skipped. Every other tool returns the failure.
            reply = tool.name === "ctx_doctor" ? { ...reply, text: reply.text + "\n" + JOURNAL_SKIPPED_LINE(errorReply(err).text) } : errorReply(err);
          }
        }
      }
      return { content: [{ type: "text" as const, text: reply.text }], isError: reply.isError };
  }

  // §5 step 4. One factory serves both eras through the SDK's own negotiation: initialize (2025-xx)
  // and server/discover (2026-07-28) answer from the same INSTRUCTIONS bytes (ADR-0007 d3, GS9).
  function createMcpServer(routing: CallRouting): McpServer {
    const server = new McpServer(
      { name: SERVER_KEY, version: "dev" }, // DEVIATIONS: no version constant in contracts yet
      {
        instructions: INSTRUCTIONS,
        capabilities: { experimental: { [CODEX_SANDBOX_STATE_META]: {} } },
        cacheHints: {
          "tools/list": { ttlMs: TOOLS_TTL_MS, cacheScope: "public" },
          "server/discover": { ttlMs: TOOLS_TTL_MS, cacheScope: "public" },
        },
      },
    );
    for (const tool of tools) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          // zod 3.25 `zod/v4` has no ~standard.jsonSchema type; the SDK converts it with z.toJSONSchema (DEVIATIONS).
          inputSchema: passThrough(tool),
          ...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {}),
          ...(tool.alwaysLoad ? { _meta: { "anthropic/alwaysLoad": true } } : {}),
        },
        dispatch(server, tool, routing),
      );
    }
    return server;
  }

  // §5 step 9, then step 10 (stdio last). No other timer (§5 step 9c).
  // D-M5-R1-1: the server also removes its own stop marker, so owners/ holds no file of a dead server.
  function shutdown(): void {
    for (const db of held) {
      try {
        const configDir = resolveConfigDir(process.env);
        removeOwnerPid(configDir, db.projectKey, serverId);
        rmSync(stopMarker(configDir, db.projectKey), { force: true });
      } catch (err) {
        console.error(err);
      }
      closeDb(db); // never throws (impl/02 §6.3)
    }
  }
  // D-M5-R1-1: the uninstall stop takes the same path as stdin EOF (impl/11 §4 steps 2-3).
  function stopSelf(): void {
    shutdown();
    process.kill(process.pid, "SIGTERM");
  }

  return { serverId, degraded, drain, inFlight, shutdown, stopSelf, createMcpServer };
}
