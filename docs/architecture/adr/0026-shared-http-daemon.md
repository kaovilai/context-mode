# ADR-0026: One shared daemon serves every session over loopback HTTP

- Status: Accepted (2026-11-07).
- Related: ADR-0007 (stateless identity, decision 4), ADR-0002 (single DB per project), upstream issue mksglu/context-mode#1334.
- Keeps: the stdio spawn as the default, byte-identical when no daemon flag or env is present.

## Context

The plugin manifest starts one MCP server process per agent session (stdio). A machine running many
concurrent sessions — T3 Code threads are the measured case — pays RAM × sessions: 4 server processes
for 2 active threads, 32-66 MB each. Upstream has no shared mode (verified before filing #1334); this
fork builds one.

The server was already stateless per request (ADR-0007 decision 4): `ToolContext` is built fresh from
each call's `_meta` (session id, turn, codex workspace), the `ProjectContext` is resolved per call, and
the only process-shared state is the per-project DB handle pool and the owner identity — resources, not
session identity. An audit for this ADR found no other module-scope mutable state on the serving path:
`src/core` has exactly two module-level `let`s (`hooks/fallback.ts` `fired`, a test fault-injection
seam that is a no-op in production; `ops/bundle-dir.ts` `memo`, a pure argv→dir cache), and the store
caches are per-DB-connection. Nothing keys identity at process scope except the session-id fallback.

## Decision

1. **Opt-in daemon, one per machine.** A new entry `src/entries/daemon.ts` (bundled as `daemon.mjs`,
   routed as `context-mode daemon`) serves the same tools from the same core over MCP Streamable HTTP
   on `127.0.0.1` (default port 8790; `--port` or `CONTEXT_MODE_DAEMON_PORT` override; `--port 0` picks
   a free port and the banner names it). The stdio spawn path is untouched: with no daemon flag or env,
   behavior is byte-identical (decision 5 pins it).
2. **The SDK's own composition, both protocol eras.** The daemon routes with the SDK's `isLegacyRequest`:
   2025-era streamable HTTP sessions go to a hand-wired stateful leg (one
   `WebStandardStreamableHTTPServerTransport` + one `McpServer` per client session, routed by
   `mcp-session-id`, `DELETE` closes the session), and 2026-07-28 per-request-envelope traffic goes to
   `createMcpHandler` with `legacy: "reject"` — exactly the split the SDK documents for a sessionful
   streamable HTTP wiring next to a strict modern endpoint. One `ServerCore` (the DB pool, journal,
   owner files, stop marker extracted from `server.ts` into `src/entries/server-core.ts`) serves every
   session of both legs.
   - The connect command is emitted by the daemon's startup banner and by `context-mode daemon
     --print-command`: `claude mcp add --transport http context-mode http://127.0.0.1:<port>/mcp`.
   - A systemd user unit is generated (never hand-edited): `context-mode daemon --install` writes
     `~/.config/systemd/user/context-mode-daemon.service` (loopback `ExecStart`, `Restart=on-failure`,
     the port env), daemon-reloads and enables it; `--remove` undoes it; `--print-unit` shows the text.
     Lifecycle is signal-based (SIGTERM/SIGINT run the stdio shutdown path); the stdin exit guard is
     not installed — a daemon under systemd has no stdin pipe to lose.
3. **Per-session identity, one deviation from ADR-0007 decision 4.** A shared process has no `--agent`
   per session, so the daemon resolves the agent id per session from initialize `clientInfo.name`
   through `CLIENT_NAME_TO_PLATFORM` + the new `PLATFORM_TO_AGENT` map (the one place routing reads
   `clientInfo`; stdio never does). Session id: `_meta.sessionId`, else `mcp:<transport session id>`
   (per client session, preserving the F4 no-leak rule), never the process id. Workspace, in order:
   the codex `sandboxCwd` `_meta`; the `x-context-mode-workspace` request header (wired with
   `claude mcp add --header`, the documented way to pin a project); `roots/list` when the client
   declares roots (generalized from the vscode-only stdio path); the daemon env's `CLAUDE_PROJECT_DIR`
   (single-project deployments); the daemon cwd. The per-call env drops `CLAUDE_PROJECT_DIR` and the
   `HOST_SESSION_ENV` keys before `resolveProject`/`sessionIdOf` see it, so one session's env pins
   nothing for the others.
4. **Accepted limits, named.** No inbound auth: the boundary is the loopback bind (same posture as the
   stdio spawn's local trust). `ctx_upgrade` mode "uninstall" stops the whole daemon (one stop marker,
   one process — documented, `Restart=on-failure` brings it back without the uninstalled data). A
   client that dies without `DELETE` leaves its session entry in memory until the daemon restarts
   (one transport pair per session, small; no idle timer on purpose — PRD P5's no-idle-timer rule).
5. **The default is pinned.** D12 (below) and every daemon surface appear only on the daemon path; the
   stdio report, CLI routing and bundle tree for `server.mjs` keep their bytes.
6. **Roots-capable clients are steered off the 2026-07-28 era (A26-r14).** Decision 3's workspace order
   puts `roots/list` before the daemon cwd, but on the per-request-envelope era the SDK cannot deliver
   server-to-client requests ("roots/list cannot be sent while serving a request on that revision"), so
   a client that negotiated that era — Claude Code does: it probes `server/discover` before
   `initialize` — never got its roots asked and fell through to the daemon-cwd workspace. Under the
   systemd unit that cwd is `$HOME`, so every such session of every project pooled into one project DB
   whose `worktree` column matched every row: cross-session, cross-project `ctx_search` results and
   source handles that named another session's rows (the hook-side `s<N>` handles live in the
   per-project DB the session's cwd keys, so they resolved to unrelated sources over the daemon). The
   daemon answers a `server/discover` probe whose declared client capabilities include `roots` with
   `-32601` — the answer of a 2025-era-only server, which is what the SDK itself gives without modern
   versions in `supportedProtocolVersions` — and the client negotiates the sessionful leg, where
   `roots/list` answers and the project resolves per session (verified live: Claude Code 2.1.317 falls
   back to the sessionful handshake on that answer and reports its cwd in `roots/list`). A client that
   declares no roots cannot help resolve the workspace either way and keeps the modern era, where the
   `x-context-mode-workspace` header (or the Codex `_meta` workspace) names the project.

## Doctor D12

`ctx_doctor` gains a `D12 daemon` row, outside `DOCTOR_CHECK_ORDER`: it exists only when this process
is the daemon (a self-probe of its own `/healthz`, PASS names the URL) or when
`CONTEXT_MODE_DAEMON_PORT` names a port (the opt-in signal from a stdio session); a plain stdio session
shows no D12 row, so the default report is unchanged. A configured port that does not answer is FAIL
with the fix `context-mode daemon --install`. `GET /healthz` answers 204 with no MCP traffic.

## Consequences

- RAM stops scaling with sessions: N concurrent sessions are N transport pairs inside one process
  (tests/0026-daemon.test.mjs pins one process and flat RSS across sessions).
- The per-project index is shared by design: a session's `scope: "project"` search sees other
  sessions' rows of the same project (pinned by test); `scope: "session"` stays isolated per
  `_meta.sessionId` (pinned by test).
- `server.ts` becomes a thin stdio wrapper over `server-core.ts`; the extraction is behavior-neutral
  (the existing 0007 suite pins the stdio path, and a new test pins the routing table).
- New files: `src/entries/daemon.ts`, `src/entries/server-core.ts`, `src/core/ops/daemon-state.ts`,
  `tests/0026-daemon.test.mjs`, `docs/daemon.md`. `daemon.mjs` ships in the npm package and every
  plugin tree (build row + `OUT_FILES`).

## Result

Checked 2026-11-07 on the fork (`feat/stateless-shared-daemon`): two SDK streamable-HTTP clients with
different `_meta.sessionId` values against one daemon — session B's `scope: "project"` search finds
session A's indexed content, `scope: "session"` does not; `ps` shows exactly one process; RSS flat
within the test bound across 4 further sessions; D12 PASS in the daemon and FAIL + fix on a dead
configured port; `server.mjs` still speaks stdio with no flags. Suite green (tests/0026 + the
pre-existing files unchanged).
