// 2.2.6: the user-scope `claude mcp add` entry for the daemon URL in ~/.claude.json. Claude Code dedupes a
// plugin MCP server against manually-configured servers by URL (2.1.322 binary, function Iys: "Suppressing
// plugin MCP server \"plugin:<name>:<server>\": duplicates manually-configured \"<manual>\""), and the manual
// entry wins — headers are not part of the signature, so the plugin entry's x-context-mode-session header is
// lost with it. The entry is what docs/daemon.md taught and the daemon banner printed before the plugin
// shipped its own daemon entry (2.2.5), so machines that followed those steps suppress their plugin entry.
// Doctor D13, setup (plan + verify) and ctx_upgrade (D4 "old MCP entry") all point at the same removal.
import { existsSync, readFileSync } from "node:fs";
import { claudeUserConfigOf } from "../project/config-dir.ts";
import { MCP_SERVERS_KEY, SERVER_KEY } from "../contracts/constants.ts";

/** The user-scope context-mode MCP entry in the Claude Code user config: its url when the entry has one,
 *  "" when it has none, undefined when there is no entry (or the file does not parse — the host's own file,
 *  never an error here). Only the user scope: a project `.mcp.json` or a local-scope entry can suppress the
 *  plugin entry the same way, but the user scope is the one our own docs and banner created. */
export function claudeUserMcpEntry(env: NodeJS.ProcessEnv, home: string): { url: string } | undefined {
  const file = claudeUserConfigOf(env, home);
  if (!existsSync(file)) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  const entry = typeof doc === "object" && doc !== null
    ? (doc as Record<string, unknown>)[MCP_SERVERS_KEY]
    : undefined;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  const own = (entry as Record<string, unknown>)[SERVER_KEY];
  if (typeof own !== "object" || own === null || Array.isArray(own)) return undefined;
  const url = (own as Record<string, unknown>).url;
  return { url: typeof url === "string" ? url : "" };
}
