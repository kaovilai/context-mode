# Shared daemon: many sessions, one process

By default every agent session starts its own context-mode MCP server (stdio). On a machine that runs
many sessions at once — T3 Code threads, a stack of terminal tabs — that is RAM × sessions. The shared
daemon is the fix: one process serves every session over loopback HTTP, so the cost stops scaling. See
[ADR-0026](architecture/adr/0026-shared-http-daemon.md) for the design.

The daemon is opt-in for every surface but one: the Claude Code **plugin** connects straight to the
daemon's URL (`http://127.0.0.1:8790/mcp`) instead of spawning a per-session stdio bridge, so it needs
the daemon running (`context-mode daemon --install`; doctor D12 names the fix when it is not). Every
other host keeps the stdio spawn as its default: nothing changes until you run the daemon.

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

Copy the command the daemon printed at startup, or print it again:

```sh
context-mode daemon --print-command
```

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
entry above exists):

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
  that id — today that means a client that can set per-session headers
  (`--header "x-context-mode-session: $CLAUDE_CODE_SESSION_ID"` in a config that expands it per
  session). Claude Code's `claude mcp add` headers are static, so until it grows dynamic headers,
  session-scoped hook continuity keeps requiring the stdio spawn; project scope is unaffected.
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
