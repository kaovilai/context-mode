# Shared daemon: many sessions, one process

By default every agent session starts its own context-mode MCP server (stdio). On a machine that runs
many sessions at once — T3 Code threads, a stack of terminal tabs — that is RAM × sessions. The shared
daemon is the fix: one process serves every session over loopback HTTP, so the cost stops scaling. See
[ADR-0026](architecture/adr/0026-shared-http-daemon.md) for the design.

The daemon is opt-in for every surface but one: the Claude Code **plugin** connects straight to the
daemon's URL instead of spawning a per-session stdio bridge, so it needs the daemon running (on
systemd, `context-mode daemon --install`; without systemd, `context-mode daemon` in the foreground).
The plugin's URL is `http://127.0.0.1:${CONTEXT_MODE_DAEMON_PORT:-8790}/mcp` — the same override
variable the daemon reads — and it sends `x-context-mode-session: ${CLAUDE_CODE_SESSION_ID}`, so its
session scope keeps matching the hooks. Every other host keeps the stdio spawn as its default:
nothing changes until you run the daemon.

## What you need

- The npm route: `npm i -g context-mode`, then `context-mode setup` (see the
  [Install guide](https://contextmode.ai/docs/engine/install?utm_source=github&utm_medium=docs&utm_content=daemon)).
- Node 24.15.0 or later, same as the plugin.

## Start it (systemd)

```sh
context-mode daemon --install
```

That writes the user unit, enables and starts it. The unit binds `127.0.0.1:8790` (change it with
`--port <n>` before `--install`, or the `CONTEXT_MODE_DAEMON_PORT` env), and restarts on failure.

```sh
systemctl --user status context-mode-daemon
```

Without systemd, run it in the foreground (the banner names the port it picked):

```sh
context-mode daemon
```

## Point one agent at it

**With the Claude Code plugin (2.2.5+): do nothing.** The plugin's own MCP entry is the daemon's URL
(`http://127.0.0.1:${CONTEXT_MODE_DAEMON_PORT:-8790}/mcp`) and sends the session header — no `claude mcp
add` is needed. Worse, one is harmful: Claude Code drops a plugin MCP server whose URL matches a
manually-configured server (the 2.1.322 binary logs `Suppressing plugin MCP server
"plugin:context-mode:context-mode": duplicates manually-configured "context-mode"`), so a manual entry
with this URL silently disables the plugin's entry — and with it the `x-context-mode-session` header the
hooks' session continuity needs. An older install or the pre-plugin docs may have left that entry behind;
the daemon banner, `ctx_doctor` (row `D13 claude-entry`) and `context-mode setup` all name it. Remove it:

```sh
claude mcp remove context-mode -s user
```

`context-mode setup --agents claude-code` removes the entry too (it is also a D4 "old MCP entry"
leftover that `ctx_upgrade` clears), and `claude mcp remove context-mode -s project` clears a project-scope
copy that suppresses the plugin entry the same way.

Without the plugin — a bare Claude Code that should still reach the daemon — the connect command is what
the daemon prints (`context-mode daemon --print-command`; the line after it is the caveat above):

```sh
claude mcp add --transport http context-mode http://127.0.0.1:8790/mcp
```

Remove the entry to go back to the stdio spawn:

```sh
claude mcp remove context-mode
```

## One daemon, many projects

Sessions of different projects share the daemon. A session that sends no workspace itself names its
project in a header (run the command in the repo root; `claude mcp remove context-mode` first if the
entry above exists; with the plugin installed, a project-scope entry with the daemon URL suppresses the
plugin's entry exactly like a user-scope one, and Claude Code names the workspace through `roots/list`
anyway — A26-r14 — so the plugin needs none of this):

```sh
claude mcp add --scope project --transport http context-mode \
  http://127.0.0.1:8790/mcp --header "x-context-mode-workspace: $PWD"
```

Each session keeps its own session scope (a `scope: "session"` search never sees another session's
rows); the project index is shared by design, so `scope: "project"` finds what any session of that
project indexed.

A client that declares the `roots` capability (Claude Code, VS Code) needs no header: the daemon
answers its `server/discover` probe with "method not found" — the answer of a 2025-era-only server —
so it negotiates the sessionful Streamable HTTP era, where the daemon can ask `roots/list` and take
the workspace from the answer (A26-r14). On the 2026-07-28 per-request-envelope era the SDK cannot
deliver server-to-client requests at all, so without the steer such a client's workspace fell back
to the daemon's own cwd (`$HOME` under the systemd unit) and every session of every project pooled
into that one project's index: cross-project search results and source handles that named another
session's rows. Clients that declare no roots keep the modern era and use the header above (or the
Codex `_meta` workspace) to name the project.

## Session identity over HTTP

The daemon names a session by, in order: the request's `_meta.sessionId`, the
`x-context-mode-session` header, the transport session id (`mcp-session-id`, one per connection).
A request that sends none of these gets a fresh id per request (its session-scoped rows are
write-only, never pooled).

Two consequences to know:

- A host whose **hooks** journal rows under its own session id (Claude Code journals under
  `CLAUDE_CODE_SESSION_ID`) only matches those rows over the daemon when its MCP connection sends
  that id. The Claude Code **plugin** sends it: its manifest entry sets
  `x-context-mode-session: ${CLAUDE_CODE_SESSION_ID}` through Claude Code's `.mcp.json` `${VAR}`
  expansion (the value is the process's session id, the same one its hooks report; an unexpanded
  header value is rejected by the daemon's id validation and falls back to the connection id). A
  hand-added `claude mcp add` entry has static headers, so there the session-scoped hook continuity
  still needs a per-session header or the stdio spawn; project scope is unaffected either way. And a
  hand-added entry whose URL is the daemon's replaces the plugin's entry outright (Claude Code's
  same-URL dedup; see *Point one agent at it*), so on a plugin install the entry is a loss on both
  counts — remove it rather than keep it next to the plugin.
- **Shared hosts:** loopback is not user-isolated — another OS user on the machine can also
  reach the port and call `ctx_execute` with the daemon owner's permissions, a broader exposure
  than spawning a stdio server as their own user. Do not run the daemon on a shared host without
  OS-level access controls.
- The trust boundary is the loopback port: any LOCAL process can reach the daemon and set the
  session header to another session's id, reading that session's `scope: "session"` rows. That is
  the same local trust as a stdio spawn (any local process can spawn its own server); there is no
  inbound authentication by design. The header value is validated (bounded, plain id characters)
  before it is used as a journal key.
- A request with no identity at all gets a fresh id per request: its `scope: "session"` rows are
  write-only (it cannot even read back its own), but two unidentified clients can never see each
  other's rows. Sending `_meta.sessionId` (most SDK clients can) or the header restores continuity.

## Check it

The daemon answers a liveness probe with no MCP traffic:

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8790/healthz
```

`ctx_doctor` shows a `D12 daemon` row while you are connected through the daemon. To also check the
daemon from stdio sessions, name its port in your shell profile:

```sh
export CONTEXT_MODE_DAEMON_PORT=8790
```

A down daemon is a FAIL with the fix `context-mode daemon --install`.

## Stop it

```sh
context-mode daemon --remove
```

## Limits

- The daemon has no inbound auth: it binds loopback only, like the stdio spawn trusts the local user.
- `ctx_upgrade` with mode `uninstall` stops the whole daemon (one process owns the data it removes).
- A session that dies without a clean close leaves a small in-memory entry until the daemon restarts.
- One data root per daemon, from the daemon's own environment. `CONTEXT_MODE_DATA_DIR` set in an
  agent session's env (a Claude Code profile's settings `env`) routes that session's hooks but not
  the daemon: set it on the daemon (its unit or starting shell) so both agree. Per-profile data
  separation through one shared daemon is not supported.
