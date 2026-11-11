# Install context-mode v2 on Claude Code

## Install

```sh
claude plugin marketplace add mksglu/context-mode
claude plugin install context-mode@context-mode
```

Update:

```sh
claude plugin update context-mode@context-mode
```

Check: `context-mode doctor`

Restart Claude Code after the install and after each update.

`npm i -g context-mode` also gives the `context-mode` command for doctor.

Setup is the fallback and the repair for what the native step cannot do:

```sh
context-mode setup --agents claude-code
```

With no terminal (a script or CI), add `--yes`: `context-mode setup --yes --agents claude-code`. Without it, setup stops with exit 2.

To do the setup step by hand, run `context-mode setup --print claude-code` and follow what it prints.

## What setup changes

- Runs `claude plugin marketplace add` on the installed package folder, then `claude plugin install context-mode@context-mode`.
- The plugin brings the hooks (`hooks/claude-code.json`: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse) and the skills `/ctx-doctor`, `/ctx-stats` and `/ctx-upgrade`. Its MCP entry connects to the shared daemon over loopback HTTP instead of spawning a per-session stdio bridge, so the daemon must be running. On systemd, run `context-mode daemon --install`. Without systemd (macOS, Windows), run `context-mode daemon` in the foreground and keep it running. Setup and `context-mode doctor` report a `daemon` warning row with the same fix when it is not.
- Removes old context-mode hook commands from `~/.claude/settings.json`.
- Effect: the call runs, then a large result is replaced by a short selection that names `ctx_search` (replace).
- Backs up each file first. A failed step is rolled back byte for byte.
- Never edits `CLAUDE.md`, `AGENTS.md` or other instruction files.

## Verify

```sh
context-mode doctor --agents claude-code
claude plugin list
```

`context-mode@context-mode` must be listed and enabled. Then run `/ctx-doctor` in Claude Code.

## Remove

```sh
claude plugin marketplace remove context-mode
```

`claude plugin marketplace remove` removes the marketplace and its plugins. If you also ran setup, undo it first:

```sh
context-mode setup --remove --agents claude-code
```

It puts each touched file back. To remove the package too, see [Uninstall](./README.md#uninstall).

## Known limits

- The setup route adds the package folder from npm as a marketplace. The native route adds `mksglu/context-mode` from GitHub; use one of the two, not both.
- The plugin's MCP entry needs the shared daemon. Its URL is `http://127.0.0.1:${CONTEXT_MODE_DAEMON_PORT:-8790}/mcp` (Claude Code expands `${VAR}`/`${VAR:-default}` in `.mcp.json`), so a daemon on the default port needs no configuration and `CONTEXT_MODE_DAEMON_PORT` moves both the daemon and the plugin entry. Set the variable, never set it to an empty string (an empty value expands to an invalid URL).
- The entry also sends `x-context-mode-session: ${CLAUDE_CODE_SESSION_ID}`, so session-scoped search and `ctx_resume` keep seeing the hooks' rows, as the stdio spawn did. If the header ever arrives unexpanded, the daemon rejects the value (it does not match a session id) and falls back to the connection's own id; per-session identity is per Claude Code process.
- `CONTEXT_MODE_DATA_DIR` set per profile (in that profile's settings `env`) routes the hooks' writes but not the daemon's: the daemon has one data root, from its own environment. Set `CONTEXT_MODE_DATA_DIR` on the daemon itself (its unit or the shell that starts it) so both agree; per-profile data separation is not supported through the plugin's daemon entry.
- Verified live on Claude Code 2.1.274 without a login: `claude -p` against a local fake Anthropic endpoint ran our hook and the model saw the `ctx_search(` redirect for a 200 KB file (`tests/e2e/claude-code-fire.test.mjs`). A logged-in session was not run.
- Hooks do not run when the plugin is disabled (`claude plugin enable context-mode@context-mode`; setup does this for you) or when `disableAllHooks` is `true` in a Claude Code settings file. Doctor fails with the fix for both; it never edits your settings.
- `claude mcp add` by hand adds the MCP server only, with no hooks — and when its URL is the daemon's, Claude Code drops the plugin's own MCP entry (its same-URL dedup: a manually-configured server wins over a plugin one, verified on 2.1.322), losing the `x-context-mode-session` header with it. A machine that connected to the daemon before 2.2.5 may still carry that entry: `claude mcp remove context-mode -s user` (or run `context-mode setup --agents claude-code`, which removes it). `ctx_doctor` shows it as the `D13 claude-entry` row. Use `context-mode setup --print claude-code` for the full wiring instead.
- Skill and rule files under `~/.claude` (or `$CLAUDE_CONFIG_DIR`), such as `skills/<skill>/references/*.md`, rule files and `CLAUDE.md`, reach the model whole at any size (#1326).
- A tool output over 4,096 bytes comes back as a short search pointer. To get larger outputs whole, set `CTX_REPLACE_TRIGGER_BYTES` (a positive integer of bytes, for example `8192`) in the environment Claude Code starts from. A higher value saves less context: 8192 saves about 23% of tool bytes against 42% at 4096 on our bench.
- When the daemon is down, the hooks stop intercepting: a large tool output goes through whole and a big Read is denied with the ranged-read route only (never a `ctx_execute` pointer the session cannot call) — the pointer names a tool the daemon serves, so it is only printed while the daemon answers its health probe. Set `CTX_MODE_BYPASS=1` in the environment Claude Code starts from to get raw output for a whole session (replace and read-deny stand down; the model cannot set it from a shell call — the hook inherits the Claude Code process env, not the shell's).

## Report a problem

Run `context-mode doctor --agents claude-code`. A failed check prints a `gh issue create` command and a report file under `~/.context-mode/reports/`. Open the [v2 bug form](https://github.com/mksglu/context-mode/issues/new?template=bug.yml) and paste the report.

To keep the data of each Claude Code profile apart, set `CONTEXT_MODE_DATA_DIR` to its own folder, for example in the `env` block of that profile's `settings.json`. Unset, the data stays in `~/.context-mode`.

## Verified

Tested on macOS (arm64), Node 26, a clean temporary HOME, the npm-packed build of commit 5c41eb61.

| Command | Claude Code version | Date | Result |
|---|---|---|---|
| `context-mode setup --yes --agents claude-code` | 2.1.309 | 2026-10-23 | Pass: `~/.claude/settings.json` (`extraKnownMarketplaces`, `enabledPlugins`) and `~/.claude.json` written |
| `context-mode setup --yes --agents claude-code` (second run) | 2.1.309 | 2026-10-23 | Pass |
| `context-mode doctor --agents claude-code` | 2.1.309 | 2026-10-23 | Pass |
| `context-mode setup --remove --yes` | 2.1.309 | 2026-10-23 | Pass: files restored (`Restored N file(s).`) |

Not run: a live, logged-in Claude Code session that fires the hooks. Windows commands. Evidence: [CLI report](https://github.com/mksglu/context-mode/blob/274600e2ffab843e89c1dfa09b0d649e650c962f/docs/v2/CLI-REPORT.md), [engine tests](../../tests/0019-setup-engine.test.mjs), [DEVIATIONS](../architecture/modules/DEVIATIONS.md).
