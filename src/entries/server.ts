// impl/11 §5, impl/00 §5.1. MCP server entry; build/build.mjs bundles it as server.mjs with the prompt
// inlined (src/prompt/_generated.ts, impl/13 §2.2 step 3). M1 wires the store (DEVIATIONS D-M1-10,
// D-M1-11, D-M1-T10-1); adapters (M3) and the tool modules (M2-M5) come with their own milestones.
// ADR-0026: the shared core (DB pool, journal, dispatch) lives in server-core.ts so the daemon entry
// can serve many sessions through the same code; this file is only the stdio wiring, byte-identical
// to the pre-daemon behavior when no daemon flag or env is present (ADR-0026 decision 5).
import { fileURLToPath } from "node:url";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { installExitGuard } from "../core/lifecycle/exit.ts";
import { isEntry } from "./is-entry.ts";
import {
  createServerCore, stdioRouting, INSTRUCTIONS,
} from "./server-core.ts";

export { INSTRUCTIONS };
export {
  sessionIdOf, workspaceCwdOf, workspaceFromMeta, workspaceFromRoots, hasWorkspaceFolder,
  resolveAgent, isDegraded, metaNumber, errorReply,
  type CallRouting, type ServerCore,
} from "./server-core.ts";

export async function startServer(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const core = await createServerCore(argv, env);
  const routing = stdioRouting(argv, env, core.serverId);

  // §5 step 9, then step 10 (stdio last). No other timer (§5 step 9c).
  let handle: StdioServerHandle | undefined;
  installExitGuard({ onShutdown: core.shutdown, isTTY: process.stdin.isTTY === true });
  handle = serveStdio(() => core.createMcpServer(routing));

  // §5 step 11: the promise is the server's lifetime.
  await new Promise<void>((resolve) => process.once("exit", () => resolve()));
}

// The bundle (server.mjs) is the process entry, so import.meta.main is true there; a unit test that
// imports this module for INSTRUCTIONS does not start the server (DEVIATIONS D-M2-R1-1).
if (isEntry(import.meta.main, process.argv[1], fileURLToPath(import.meta.url))) {
  const [, , ...cliArgs] = process.argv; // node <server.mjs> <args...>
  await startServer(cliArgs, process.env);
}
