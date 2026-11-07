/**
 * contracts/client-map — MCP clientInfo.name → PlatformId mapping.
 *
 * Source: Apify MCP Client Capabilities Registry
 * https://github.com/apify/mcp-client-capabilities
 *
 * Only includes platforms we have adapters for.
 */

// Local string type: v2 does not import the v1 PlatformId (W0-client-map).
// v1 src/adapters/detect.ts keeps its own copy of this table until W3.
type PlatformId = string;

export const CLIENT_NAME_TO_PLATFORM: Record<string, PlatformId> = {
  "claude-code": "claude-code",
  "gemini-cli-mcp-client": "gemini-cli",
  "antigravity-client": "antigravity",
  "antigravity-cli": "antigravity-cli",
  "agy": "antigravity-cli",
  "cursor-vscode": "cursor",
  "Visual-Studio-Code": "vscode-copilot",
  "copilot-cli": "copilot-cli",
  "GitHub Copilot CLI": "copilot-cli",
  "github-copilot-cli": "copilot-cli",
  "JetBrains Client": "jetbrains-copilot",
  "IntelliJ IDEA": "jetbrains-copilot",
  "PyCharm": "jetbrains-copilot",
  "Codex": "codex",
  "codex-mcp-client": "codex",
  "Kilo Code": "kilo",
  // #1276: OpenCode sends clientInfo.name = "opencode". v2 routing still takes the agent id
  // from --agent (ADR-0007 decision 4); this row is for detection/display only.
  "opencode": "opencode",
  "Kiro CLI": "kiro",
  "Pi CLI": "pi",
  "Pi Coding Agent": "pi",
  // Issue #542 — Pi rebranded to OMP. Upstream
  // refs/platforms/oh-my-pi/packages/coding-agent/src/mcp/client.ts:46-49
  // ships clientInfo.name = "omp-coding-agent". Resolved to the OMP
  // adapter (~/.omp/, PI_CODING_AGENT_DIR). Legacy "Pi CLI" /
  // "Pi Coding Agent" entries above still resolve to the pi adapter.
  "omp-coding-agent": "omp",
  "Zed": "zed",
  "zed": "zed",
  "qwen-code": "qwen-code",
  "qwen-cli-mcp-client": "qwen-code",
  "kimi-code": "kimi",
  "kimi": "kimi",
  "Kimi Code": "kimi",
};

// ADR-0026: the shared daemon resolves the agent id per session from initialize clientInfo.name
// (the stdio spawn keeps taking it from --agent, ADR-0007 decision 4). Only platforms with an
// adapter row map to an AgentId; an unmapped name falls back to the daemon's own --agent.
export const PLATFORM_TO_AGENT: Readonly<Partial<Record<PlatformId, import("./agents.ts").AgentId>>> = Object.freeze({
  "claude-code": "claude-code",
  "gemini-cli": "gemini",
  "vscode-copilot": "vscode",
  "copilot-cli": "copilot-cli",
  "codex": "codex",
  "qwen-code": "qwen",
  "opencode": "opencode",
  "kiro": "kiro",
  "pi": "pi",
});

