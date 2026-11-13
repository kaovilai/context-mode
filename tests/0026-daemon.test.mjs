// tests/0026-daemon.test.mjs
// Area: ADR-0026 (shared HTTP daemon). One file per ADR area (ADR-0024, docs/architecture/TEST-LAYOUT.md).
// Covers: the daemon entry (flags, unit text, serving), per-session identity over one process
// (session id, agent from clientInfo, workspace from the request header), the project-shared index
// across sessions, the doctor D12 row, and the stdio default staying the default.
import { describe, test, before, after } from "node:test";
import { CONC } from "./_lib/concurrency.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer, request } from "node:http";
import { parseDaemonArgs, daemonUnitText, discoverSteer, DAEMON_HELP } from "../src/entries/daemon.ts";
import { route } from "../src/entries/cli.ts";
import { HELP_MAIN } from "../src/cli/args.ts";
import { checkDaemon } from "../src/core/ops/doctor-env.ts";
import { isAbsoluteWorkspacePath } from "../src/entries/daemon.ts";
import { sessionIdOf } from "../src/entries/server-core.ts";
import { DAEMON_ADD_CAVEAT, DAEMON_ADD_COMMAND, DAEMON_CHECK_FIX, DAEMON_DEFAULT_PORT, DAEMON_PORT_ENV, DAEMON_SESSION_HEADER } from "../src/core/contracts/constants.ts";
import { daemonEntryExpected, daemonToolsDown, effectiveMcpTarget } from "../src/core/hooks/daemon-gate.ts";
import { DEAD_PORT, HTTP_ENTRY, STDIO_ENTRY, fakeBundle, gateBed, withBundle } from "./_lib/daemon-gate-fixtures.mjs";

const REPO = join(import.meta.dirname, "..");

describe("ADR-0026 daemon flags and unit", { concurrency: CONC }, () => {
  test("parseDaemonArgs: default port, env override, --port override (0 picks a free port)", () => {
    assert.equal(parseDaemonArgs([], {}).port, DAEMON_DEFAULT_PORT);
    assert.equal(parseDaemonArgs([], { [DAEMON_PORT_ENV]: "9001" }).port, 9001);
    assert.equal(parseDaemonArgs(["--port", "9002"], { [DAEMON_PORT_ENV]: "9001" }).port, 9002);
    assert.equal(parseDaemonArgs(["--port", "0"], {}).port, 0);
  });

  test("parseDaemonArgs: usage errors are one line, exit-2 shaped", () => {
    for (const [argv, want] of [
      [["--port"], "--port needs a value."],
      [["--port", "70000"], "is not a port"],
      [["--port", "abc"], "is not a port"],
      [["--no-such-flag"], "unknown option"],
      [["--agent", "nope"], "unknown agent"],
      [["--print-command", "--install"], "at most one"],
      [["--install", "--agent", "codex"], "every agent"],
    ]) {
      const r = parseDaemonArgs([...argv], {});
      assert.ok("error" in r, argv.join(" "));
      assert.ok(r.error.includes(want), `${argv.join(" ")}: ${r.error}`);
    }
  });

  test("daemonUnitText: loopback daemon unit with Restart=on-failure and the port env", () => {
    const unit = daemonUnitText("/usr/bin/node", "/opt/cm/daemon.mjs", 8790);
    assert.ok(unit.includes('ExecStart="/usr/bin/node" "/opt/cm/daemon.mjs"'));
    assert.ok(unit.includes("Restart=on-failure"));
    assert.ok(unit.includes(`Environment="${DAEMON_PORT_ENV}=8790"`));
    assert.ok(unit.includes("WantedBy=default.target"));
  });

  test("daemonUnitText quotes paths with spaces (an npm prefix like /home/u/context mode)", () => {
    const unit = daemonUnitText("/home/u/context mode/node", "/home/u/context mode/daemon.mjs", 8790);
    assert.ok(unit.includes('ExecStart="/home/u/context mode/node" "/home/u/context mode/daemon.mjs"'));
  });

  test("the CLI routes daemon to the daemon bundle; server/mcp stay stdio; help names daemon", () => {
    assert.deepEqual(route(["daemon"], "2.1.5"), { kind: "run", file: "daemon.mjs", args: [] });
    assert.deepEqual(route(["daemon", "--port", "0"], "2.1.5"), { kind: "run", file: "daemon.mjs", args: ["--port", "0"] });
    assert.deepEqual(route(["server"], "2.1.5"), { kind: "run", file: "server.mjs", args: [] });
    assert.ok(HELP_MAIN.includes("daemon"));
  });

  test("the add command line is the one the daemon prints", () => {
    assert.equal(DAEMON_ADD_COMMAND("http://127.0.0.1:8790/mcp"), "claude mcp add --transport http context-mode http://127.0.0.1:8790/mcp");
  });

  // 2.2.6 D-CC-MCP-SUPPRESS-1: the add line alone taught the step that suppresses the plugin's MCP entry,
  // so every surface that prints it (banner, --print-command, help) carries the caveat naming the removal.
  test("the add command is always followed by the plugin caveat (D-CC-MCP-SUPPRESS-1)", () => {
    assert.ok(DAEMON_ADD_CAVEAT.includes("claude mcp remove context-mode -s user"), DAEMON_ADD_CAVEAT);
    assert.ok(DAEMON_ADD_CAVEAT.includes("drop the plugin"), DAEMON_ADD_CAVEAT);
    assert.ok(DAEMON_HELP.includes(DAEMON_ADD_CAVEAT), "help carries the caveat");
    // fork-sync validation runs the suite with CONTEXT_MODE_DAEMON_PORT=0; the printed line describes
    // the default install, so the spawned print-command must not see that env override (it printed
    // :0 and failed this test under the fork-sync runner).
    const printEnv = { ...process.env };
    delete printEnv.CONTEXT_MODE_DAEMON_PORT;
    const r = spawnSync(process.execPath, [join(REPO, "src", "entries", "daemon.ts"), "--print-command"], { encoding: "utf8", timeout: 30000, env: printEnv });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const lines = r.stdout.split("\n").filter((l) => l !== "");
    assert.equal(lines[0], DAEMON_ADD_COMMAND(`http://127.0.0.1:${DAEMON_DEFAULT_PORT}/mcp`));
    assert.equal(lines[1], DAEMON_ADD_CAVEAT);
  });
});

describe("ADR-0026 doctor D12", { concurrency: CONC }, () => {
  test("no row when this process is not the daemon and no port is configured (default report unchanged)", async () => {
    assert.equal(await checkDaemon({}), undefined);
    assert.equal(await checkDaemon({ [DAEMON_PORT_ENV]: "not-a-port" }), undefined);
  });

  test("FAIL with the fix command when a port is configured and nothing answers", async () => {
    const row = await checkDaemon({ [DAEMON_PORT_ENV]: "59998" }); // nothing listens here
    assert.ok(row !== undefined);
    assert.equal(row.id, "D12");
    assert.equal(row.status, "FAIL");
    assert.equal(row.fixCommand, DAEMON_CHECK_FIX);
    assert.ok(row.detail.includes("no daemon answers"));
  });
});

// The serving block runs in order: one daemon child, N clients, /proc reads (Linux) for the process facts.
describe("ADR-0026 one daemon, many sessions", () => {
  let root;
  let repo;
  let bundleDir;
  let child;
  let url;
  let oldHome;

  before(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "cm-daemon-")));
    repo = join(root, "repo");
    mkdirSync(repo);
    oldHome = process.env.HOME;
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    bundleDir = join(root, "bundle");
    const r = spawnSync(process.execPath, [join(REPO, "build", "build.mjs"), "--out", bundleDir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });

  after(() => {
    process.env.HOME = oldHome;
    process.env.USERPROFILE = oldHome;
    child?.kill("SIGTERM");
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      if (process.platform !== "win32" || err.code !== "EPERM") throw err;
    }
  });

  async function connect(sessionId) {
    const client = new Client({ name: "claude-code", version: "2.1.303" });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { "x-context-mode-workspace": repo } },
    });
    await client.connect(transport);
    return {
      client,
      call: (name, args) => client.callTool({ name, arguments: args, _meta: { sessionId } }),
      close: () => client.close(),
    };
  }

  test("starts on a free port, answers healthz, prints the connect command", async () => {
    child = spawn(process.execPath, [join(bundleDir, "daemon.mjs"), "--port", "0"], {
      env: { ...process.env, HOME: root, USERPROFILE: root },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let banner = "";
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("daemon did not print its banner: " + banner)), 20000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        banner += chunk;
        const line = banner.split("\n").find((l) => l.startsWith("context-mode daemon listening on "));
        if (line !== undefined) {
          clearTimeout(timer);
          url = line.slice("context-mode daemon listening on ".length);
          resolve();
        }
      });
      child.once("exit", (code) => reject(new Error("daemon exited before the banner (code " + code + ")")));
    });
    assert.ok(/http:\/\/127\.0\.0\.1:[0-9]+\/mcp$/.test(url), url);
    const health = await fetch(url.replace(/\/mcp$/, "/healthz"), { redirect: "manual" });
    assert.equal(health.status, 204);
    // D-CC-MCP-SUPPRESS-1: the startup banner prints the caveat right after the connect line.
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      const check = () => {
        if (banner.includes(DAEMON_ADD_CAVEAT)) { clearTimeout(timer); resolve(); return true; }
        return false;
      };
      if (!check()) child.stdout.on("data", () => check());
    });
    assert.ok(banner.includes(DAEMON_ADD_CAVEAT), "banner: " + banner);
  });

  test("two sessions share one process: session B's project search finds session A's content", async () => {
    const a = await connect("daemon-s1");
    const list = await a.client.listTools();
    assert.deepEqual(list.tools.map((t) => t.name).map(String), [
      "ctx_execute", "ctx_batch", "ctx_index", "ctx_search", "ctx_resume", "ctx_stats", "ctx_doctor", "ctx_upgrade", "ctx_purge",
    ]);
    const indexed = await a.call("ctx_index", { content: "albatross cargo manifest, port side, row 13" });
    assert.notEqual(indexed.isError, true, indexed.content?.[0]?.text);
    await a.close();

    const b = await connect("daemon-s2");
    const project = await b.call("ctx_search", { queries: ["albatross"], scope: "project" });
    assert.ok(JSON.stringify(project.content).includes("albatross"), "session B must find session A's project-indexed content");
    // ADR-0007 decision 4 / DECISIONS-r9 F4: the session scope never leaks across sessions.
    const own = await b.call("ctx_search", { queries: ["albatross"], scope: "session" });
    assert.ok(JSON.stringify(own.content).includes("No hits"), "session B must not see session A's rows in scope session");
    await b.close();
  });

  test("exactly one daemon process serves every session, RSS flat in the session count", { skip: process.platform !== "linux" }, async () => {
    // /proc exists only on Linux; the count assertion below still runs everywhere
    const rssKb = () => Number(readFileSync(join("/proc", String(child.pid), "status"), "utf8").split("\n").find((l) => l.startsWith("VmRSS:"))?.replace(/[^0-9]/g, "") ?? NaN);
    const before = rssKb();
    const clients = [];
    for (let i = 0; i < 4; i++) clients.push(await connect("daemon-flat-" + i));
    for (const c of clients) {
      const r = await c.call("ctx_stats", {});
      assert.notEqual(r.isError, true, r.content?.[0]?.text);
    }
    const ps = spawnSync("ps", ["-eo", "pid,args"], { encoding: "utf8" });
    const mine = ps.stdout.split("\n").filter((l) => l.includes(join(bundleDir, "daemon.mjs")) && !l.includes("ps "));
    assert.equal(mine.length, 1, "one daemon process: " + mine.join(" / "));
    assert.equal(Number(mine[0].trim().split(/\s+/)[0]), child.pid);
    if (Number.isFinite(before)) {
      const delta = rssKb() - before;
      assert.ok(delta < 32 * 1024, `RSS grew ${delta} kB for 4 sessions; a session is a transport pair, not a process`);
    }
    for (const c of clients) await c.close();
  });

  test("a closed session id is gone: the next request with it gets 404", async () => {
    const c = await connect("daemon-close-1");
    await c.close();
    const gone = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": "no-such-session" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    assert.equal(gone.status, 404);
    // A non-initialize POST with no session id at all is the spec's 400, and the pair it created is
    // closed, not kept (ADR-0026 decision 4: no per-request state outlives its exchange).
    const noSession = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    });
    assert.equal(noSession.status, 400);
  });

  test("ctx_doctor shows D12 PASS while the daemon answers, FAIL lines name the fix when it is down", async () => {
    const port = Number(url.match(/:([0-9]+)\/mcp$/)[1]);
    const c = await connect("daemon-doc-1");
    const r = await c.call("ctx_doctor", {});
    const text = String(r.content[0].text);
    assert.ok(text.includes("| D12 daemon | PASS |"), text);
    await c.close();
    // The down path: a configured port with no listener (the live daemon is on another port).
    const row = await checkDaemon({ [DAEMON_PORT_ENV]: String(port + 1) });
    assert.equal(row?.status, "FAIL");
    assert.equal(row?.fixCommand, DAEMON_CHECK_FIX);
  });

  test("the stdio default: server.mjs with no flags still speaks stdio, daemon.mjs is a separate bundle", async () => {
    assert.ok(existsSync(join(bundleDir, "daemon.mjs")));
    assert.ok(existsSync(join(bundleDir, "server.mjs")));
    const { spawnBundle } = await import("../e2e/harness/mcp-client.mjs");
    const client = spawnBundle(join(bundleDir, "server.mjs"), { HOME: root, USERPROFILE: root }, ["--agent", "codex"], { cwd: repo });
    const init = await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex-mcp-client", version: "0" } });
    assert.equal(init.serverInfo.name, "context-mode");
    const tools = await client.request("tools/list", {});
    assert.equal(tools.tools.length, 9);
    await client.close();
  });
});


describe("A26 review round 1", { concurrency: false }, () => {
  let proc;
  let root;
  let repo;
  let bundleDir;
  let oldHome;

  before(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "cm-daemon-r1-")));
    repo = join(root, "repo");
    mkdirSync(repo);
    oldHome = process.env.HOME;
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    bundleDir = join(root, "bundle");
    const r = spawnSync(process.execPath, [join(REPO, "build", "build.mjs"), "--out", bundleDir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });

  after(() => {
    process.env.HOME = oldHome;
    process.env.USERPROFILE = oldHome;
    proc?.kill("SIGTERM");
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      if (err.code !== "EPERM") throw err;
    }
  });

  async function spawnDaemon() {
    proc?.kill("SIGTERM"); // only the last spawn is killed by after(); earlier ones die here
    proc = spawn(process.execPath, [join(bundleDir, "daemon.mjs"), "--port", "0"], {
      env: { ...process.env, HOME: root, USERPROFILE: root },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let banner = "";
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("daemon did not print its banner: " + banner)), 20000);
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk) => {
        banner += chunk;
        const line = banner.split("\n").find((l) => l.startsWith("context-mode daemon listening on "));
        if (line !== undefined) { clearTimeout(timer); resolve(line.slice("context-mode daemon listening on ".length)); }
      });
      proc.once("exit", (code) => reject(new Error("daemon exited before the banner (code " + code + ")")));
    });
    return url;
  }

  test("D12 FAILs when something else answers the port (a 404 or 500 is not a healthy daemon)", async () => {
    const other = createServer((req, res) => { res.writeHead(404).end(); });
    await new Promise((r) => other.listen(0, "127.0.0.1", r));
    const port = other.address().port;
    try {
      const row = await checkDaemon({ [DAEMON_PORT_ENV]: String(port) });
      assert.ok(row !== undefined && row.status === "FAIL", JSON.stringify(row));
      assert.ok(row.detail.includes("404"), row.detail);
      assert.equal(row.fixCommand, DAEMON_CHECK_FIX);
    } finally {
      other.close();
      other.closeAllConnections?.();
    }
  });

  test("the daemon refuses a foreign Host (DNS rebinding) and any Origin (browsers)", async () => {
    const url = await spawnDaemon();
    // fetch cannot override Host (a forbidden header), so the rebinding probe is a raw request
    const foreign = await new Promise((resolve, reject) => {
      const u = new URL(url);
      const r = request({ host: u.hostname, port: Number(u.port), path: u.pathname, method: "POST", headers: { host: "evil.example", "content-type": "application/json" }, setHost: false }, (res) => { res.resume(); resolve(res.statusCode); });
      r.on("error", reject);
      r.end("{}");
    });
    assert.equal(foreign, 421);
    const browser = await fetch(url, { headers: { origin: "https://evil.example" } });
    assert.equal(browser.status, 403);
    // and loopback Host still works (the health probe)
    const health = await fetch(url.replace(/\/mcp$/, "/healthz"), { redirect: "manual" });
    assert.equal(health.status, 204);
  });

  test("systemctl failure is a line, not a crash (hosts without systemd)", async () => {
    const url = await spawnDaemon(); // ensure the bundle exists
    assert.ok(url.length > 0);
    const r = spawnSync(process.execPath, [join(bundleDir, "daemon.mjs"), "--install"], {
      encoding: "utf8",
      env: { ...process.env, HOME: root, USERPROFILE: root, PATH: "" }, // no systemctl anywhere
    });
    assert.equal(r.status, 1, r.stdout + r.stderr); // EXIT_FAIL: reported, not crashed
    assert.ok((r.stdout + r.stderr).includes("not started"), r.stdout + r.stderr);
    assert.ok(!/TypeError|^\s+at .+[(:]/mu.test(r.stderr), r.stderr);
  });

  test("an unidentified request never pools into the process session (A26-r6)", async () => {
    const { daemonRouting } = await import("../src/entries/daemon.ts");
    const core = { serverId: "mcp:proc", createMcpServer: () => { throw new Error("unused"); } };
    const routing = daemonRouting([], process.env, core);
    const anonReq = () => ({ http: { req: { headers: new Headers() } }, sessionId: undefined });
    const a = routing.fallbackIdOf(anonReq());
    const b = routing.fallbackIdOf(anonReq());
    assert.notEqual(a, core.serverId, "the process id must not be the anonymous fallback");
    assert.notEqual(a, b, "two unidentified requests must not share a session id");
    assert.ok(a.startsWith("anon-") && b.startsWith("anon-"), `${a} ${b}`);
    const withHeader = { http: { req: { headers: new Headers({ [DAEMON_SESSION_HEADER]: "host-1" }) } }, sessionId: undefined };
    assert.equal(routing.fallbackIdOf(withHeader), "host-1");
    // unprefixed through sessionIdOf: the whole point is to equal the hooks' host id (A26-r8)
    assert.equal(sessionIdOf(undefined, "claude-code", {}, routing.fallbackIdOf(withHeader)), "host-1");
    // an EMPTY header is absent (A26-r11): Headers.get returns "", and ?? alone would pass it
    const emptyHeader = { http: { req: { headers: new Headers({ [DAEMON_SESSION_HEADER]: "" }) } }, sessionId: "transport-1" };
    assert.equal(routing.fallbackIdOf(emptyHeader), "transport-1");
    // a hostile header value is ignored, never a journal key (A26-r9)
    for (const bad of ["has space", "x".repeat(129), ";; rm -rf", "drop;table"]) {
      const hostile = { http: { req: { headers: new Headers({ [DAEMON_SESSION_HEADER]: bad }) } }, sessionId: "transport-1" };
      assert.equal(routing.fallbackIdOf(hostile), "transport-1", bad);
    }
    const withTransport = { http: { req: { headers: new Headers() } }, sessionId: "transport-1" };
    assert.equal(routing.fallbackIdOf(withTransport), "transport-1");
    // the stdio fallback keeps its process-local prefix
    assert.equal(sessionIdOf(undefined, "claude-code", {}, "mcp:proc"), "mcp:proc");
  });

  // A26-r7 skip on Windows: child.kill("SIGTERM") there is TerminateProcess — the process dies
  // without running any handler, so the graceful exit-0 path this test pins cannot be observed.
  test("SIGTERM during an in-flight tool call exits cleanly (A26-r7: core shuts down last)", { skip: process.platform === "win32" }, async () => {
    const url = await spawnDaemon();
    const client = new Client({ name: "claude-code", version: "2.1.303" });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { "x-context-mode-workspace": repo } },
    });
    await client.connect(transport);
    const slow = client.callTool({ name: "ctx_index", arguments: { content: "in-flight database write " + "x".repeat(200000) } }).catch(() => "cut");
    await new Promise((r) => setTimeout(r, 150));
    const exited = new Promise((resolve) => proc.once("exit", (c, sig) => resolve(c ?? sig)));
    proc.kill("SIGTERM");
    await slow;
    const code = await exited;
    assert.equal(code, 0, "the daemon must exit 0 on SIGTERM with a call in flight");
    await client.close();
    proc = undefined; // already dead; after() must not kill it again
  });

  test("close() resolves with an open SSE stream (A26-r11: connections drop before the close wait)", async () => {
    const { startDaemon } = await import("../src/entries/daemon.ts");
    const handle = await startDaemon([], { ...process.env, HOME: root, USERPROFILE: root });
    const client = new Client({ name: "claude-code", version: "2.1.303" });
    const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: { headers: { "x-context-mode-workspace": repo } },
    });
    await client.connect(transport); // the 2025 transport holds an open SSE GET stream
    let hung;
    try {
      await Promise.race([
        handle.close(),
        new Promise((_, reject) => { hung = setTimeout(() => reject(new Error("close() hung on the open SSE stream")), 8000); }),
      ]);
    } finally {
      clearTimeout(hung);
    }
    await client.close().catch(() => {});
  });

  test("an in-flight database call completes through close() (A26-r12: drain before shutdown)", async () => {
    const { startDaemon } = await import("../src/entries/daemon.ts");
    const handle = await startDaemon([], { ...process.env, HOME: root, USERPROFILE: root });
    const client = new Client({ name: "claude-code", version: "2.1.303" });
    const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: { headers: { "x-context-mode-workspace": repo } },
    });
    await client.connect(transport);
    // fire a call whose dispatch spans the sandbox run AND its journal write (the DB write is
    // part of the counted dispatch), SYNCHRONIZE on the handler being mid-flight (inFlight),
    // then close: the drain must hold the transports and the core open until the dispatch
    // finishes, so the call succeeds with its row written to still-open databases
    const call = client.callTool({ name: "ctx_execute", arguments: { language: "bash", code: "sleep 1" } });
    const until = Date.now() + 10000;
    while (handle.inFlight() < 1 && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    assert.ok(handle.inFlight() >= 1, "the call must be mid-flight before the close starts");
    await handle.close();
    const r = await call;
    assert.notEqual(r.isError, true, JSON.stringify(r.content));
    await client.close().catch(() => {});
  });

  test("--install with no HOME is a line, not a stack trace (A26-r10)", async () => {
    await spawnDaemon(); // ensure the bundle exists
    // on win32 homeDirOf reads HOMEDRIVE+HOMEPATH before HOME (config-dir.ts), so an empty-HOME
    // probe must clear those too or the runner's real home answers and the unit is written for real
    const r = spawnSync(process.execPath, [join(bundleDir, "daemon.mjs"), "--install"], {
      encoding: "utf8",
      env: { ...process.env, HOME: "", USERPROFILE: "", ...(process.platform === "win32" ? { HOMEDRIVE: "", HOMEPATH: "" } : {}) },
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.ok((r.stdout + r.stderr).includes("not written"), r.stdout + r.stderr);
    assert.ok(!/TypeError|at /u.test(r.stderr), r.stderr);
  });

  test("isAbsoluteWorkspacePath: POSIX, Windows drive and UNC pass; relative and bare words do not", () => {
    for (const good of ["/home/u/repo", "/tmp/x", "C:\\work\\repo", "D:/repo", "\\\\server\\\\share\\\\repo"]) {
      assert.ok(isAbsoluteWorkspacePath(good), good);
    }
    for (const bad of ["repo", "./repo", "../repo", "repo/x", ""]) {
      assert.ok(!isAbsoluteWorkspacePath(bad), bad);
    }
  });

  test("the session header separates two clients on one daemon", async () => {
    const url = await spawnDaemon();
    const mk = async (session) => {
      const client = new Client({ name: "claude-code", version: "2.1.303" });
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { "x-context-mode-workspace": repo, "x-context-mode-session": session } },
      });
      await client.connect(transport);
      return { client, call: (name, args) => client.callTool({ name, arguments: args }) };
    };
    const a = await mk("host-session-A");
    await a.call("ctx_index", { content: "session header A marker albatross" });
    const b = await mk("host-session-B");
    const own = await b.call("ctx_search", { queries: ["albatross"], scope: "session" });
    assert.ok(JSON.stringify(own.content).includes("No hits"), "session B must not see session header A rows");
    const viaHeader = await a.call("ctx_search", { queries: ["albatross"], scope: "session" });
    assert.ok(JSON.stringify(viaHeader.content).includes("albatross"), "session A must see its own rows via the header id");
    await a.client.close();
    await b.client.close();
  });

  // A26-r14: on the 2026-07-28 per-request-envelope era the SDK cannot deliver server-to-client
  // requests, so roots/list never ran there and every roots-capable client that negotiated the
  // modern era fell through to the daemon-cwd workspace — one pooled project DB for every session
  // of every project. The daemon steers such clients to the 2025-era sessionful leg by answering
  // their server/discover probe with -32601 (the answer of a 2025-era-only server).
  const discoverBody = (caps) => JSON.stringify({
    jsonrpc: "2.0",
    id: "server-discover-probe-1",
    method: "server/discover",
    params: { _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "claude-code", version: "2.1.317" },
      "io.modelcontextprotocol/clientCapabilities": caps,
    } },
  });
  const discoverProbe = (url, caps) => fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28", // the full modern envelope, as a negotiating client sends it
      "Mcp-Method": "server/discover",
    },
    body: discoverBody(caps),
  });

  test("discoverSteer: a roots-capable probe is steered; everything else is not (A26-r14)", () => {
    assert.deepEqual(discoverSteer(discoverBody({ roots: { listChanged: true } })), { id: "server-discover-probe-1" });
    assert.deepEqual(discoverSteer(discoverBody({ roots: {} })), { id: "server-discover-probe-1" });
    assert.equal(discoverSteer(discoverBody({ elicitation: {} })), null, "no roots: the modern era is kept");
    assert.equal(discoverSteer(discoverBody({})), null);
    assert.equal(discoverSteer("[]"), null, "a batch is never steered");
    assert.equal(discoverSteer("not json"), null);
    assert.equal(discoverSteer(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/clientCapabilities": { roots: {} } } } })), null, "only server/discover");
    assert.equal(discoverSteer(JSON.stringify({ jsonrpc: "2.0", method: "server/discover", params: { _meta: { "io.modelcontextprotocol/clientCapabilities": { roots: {} } } } })), null, "a notification carries no id to answer");
    assert.deepEqual(discoverSteer(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/clientCapabilities": { roots: {} } } } })), { id: 7 });
  });

  test("a roots-capable server/discover probe is answered method-not-found; a roots-less one keeps the modern era (A26-r14)", async () => {
    const url = await spawnDaemon();
    const steered = await discoverProbe(url, { roots: { listChanged: true } });
    assert.equal(steered.status, 200);
    const msg = await steered.json();
    assert.equal(msg.error?.code, -32601, JSON.stringify(msg));
    assert.equal(msg.id, "server-discover-probe-1");
    const modern = await discoverProbe(url, { elicitation: {} });
    assert.equal(modern.status, 200);
    const msg2 = await modern.json();
    assert.ok(msg2.error === undefined && msg2.result !== undefined, JSON.stringify(msg2));
  });

  test("a roots-capable client with no workspace header resolves its project from roots/list: no pooled DB, no cross-project hits (A26-r14)", async () => {
    const url = await spawnDaemon();
    const repoA = join(root, "rootsA");
    const repoB = join(root, "rootsB");
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });
    writeFileSync(join(repoA, "roots-marker.log"), "2026-11-08 ERROR a26r14 quota exceeded\n");
    // the Claude Code shape: a modern discover probe first — it MUST be steered to -32601 (the
    // change under test), because the SDK client below would otherwise connect sessionful on its
    // own and the isolation could pass without the steer
    const steered = await discoverProbe(url, { roots: { listChanged: true } });
    assert.equal(steered.status, 200);
    const steerMsg = await steered.json();
    assert.equal(steerMsg.error?.code, -32601, "the roots-capable discover probe must be steered off the 2026-07-28 era: " + JSON.stringify(steerMsg));
    // then no workspace header, roots declared and answered per roots/list
    const connect = async (workspace) => {
      const client = new Client({ name: "claude-code", version: "2.1.317" }, { capabilities: { roots: { listChanged: true } } });
      client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(workspace).href, name: "repo" }] }));
      const transport = new StreamableHTTPClientTransport(new URL(url)); // no headers at all
      await client.connect(transport);
      return { client, call: (name, args) => client.callTool({ name, arguments: args }) };
    };
    const a = await connect(repoA);
    // a relative path resolves inside the roots-listed workspace, so the workspace did resolve
    // (a pooled daemon-cwd fallback would not find the file: it is in repoA, not HOME)
    const indexed = await a.call("ctx_index", { path: "roots-marker.log" });
    assert.notEqual(indexed.isError, true, indexed.content?.[0]?.text);
    await a.call("ctx_index", { content: "a26r14 cross-talk canary: quipline fremen zeta" });
    const b = await connect(repoB);
    await b.call("ctx_index", { content: "a26r14 own-project marker: sandworm arrakis" });
    // default scope is worktree: B must not see A's rows (before A26-r14 both pooled into the
    // daemon-cwd project, whose worktree column matched every row, and this search found A's canary)
    const miss = await b.call("ctx_search", { queries: ["quipline"] });
    assert.ok(JSON.stringify(miss.content).includes("No hits"), "session B's worktree must not see session A's project: " + JSON.stringify(miss.content));
    const own = await b.call("ctx_search", { queries: ["sandworm"] });
    assert.ok(JSON.stringify(own.content).includes("sandworm"), "session B must find its own project's rows");
    await a.client.close();
    await b.client.close();
  });
});

// kaovilai/context-mode#11, daemon side (ADR-0026 owns the daemon and its reachability): the hook
// gate that probes /healthz before routing the model at ctx_* tools. The gate's pieces live in
// src/core/hooks/daemon-gate.ts; the hook-decision-path tests are in prd10-hooks-runtime. Serial:
// withBundle patches process.argv[1].
describe("kaovilai/context-mode#11: the daemon-down gate (daemon side)", { concurrency: false }, () => {
  let bed;

  before(async () => { bed = await gateBed(); });
  after(() => bed.close());

  test("#11 daemonEntryExpected: the http manifest arms the gate; stdio or none does not", async () => {
    await withBundle(HTTP_ENTRY, () => {
      assert.equal(daemonEntryExpected(), true);
    });
    await withBundle(STDIO_ENTRY, () => {
      assert.equal(daemonEntryExpected(), false);
    });
    await withBundle(null, () => {
      assert.equal(daemonEntryExpected(), false);
    });
  });

  test("#11 daemonToolsDown: 204 is up; refused and 404 are down; a stdio bundle never gates", async () => {
    await withBundle(HTTP_ENTRY, async () => {
      assert.equal(await daemonToolsDown({ [DAEMON_PORT_ENV]: String(bed.up204) }, "claude-code"), false, "the daemon's 204 means up");
      assert.equal(await daemonToolsDown({ [DAEMON_PORT_ENV]: String(DEAD_PORT) }, "claude-code"), true, "a refused port means down");
      assert.equal(await daemonToolsDown({ [DAEMON_PORT_ENV]: String(bed.notDaemon) }, "claude-code"), true, "a 404 answer means down");
    });
    await withBundle(STDIO_ENTRY, async () => {
      assert.equal(await daemonToolsDown({ [DAEMON_PORT_ENV]: String(DEAD_PORT) }, "claude-code"), false, "a stdio bundle never probes");
    });
  });

  test("#11 effectiveMcpTarget: URL-expansion semantics, the entry's own view of the port", async () => {
    // The plugin URL expands ${CONTEXT_MODE_DAEMON_PORT} raw into http://127.0.0.1:<value>/mcp;
    // the resolver must read the value exactly that way (CodeRabbit review, two rounds).
    assert.deepEqual(effectiveMcpTarget({}), { port: DAEMON_DEFAULT_PORT }, "unset keeps the ${VAR:-default} expansion's default");
    assert.deepEqual(effectiveMcpTarget({ [DAEMON_PORT_ENV]: "" }), { port: DAEMON_DEFAULT_PORT }, "empty keeps the default (:- treats empty as unset)");
    assert.deepEqual(effectiveMcpTarget({ [DAEMON_PORT_ENV]: "9001" }), { port: 9001 });
    assert.deepEqual(effectiveMcpTarget({ [DAEMON_PORT_ENV]: "80" }), { port: 80 }, "the scheme's default port: new URL() drops it, the entry still targets it");
    assert.deepEqual(effectiveMcpTarget({ [DAEMON_PORT_ENV]: "9001/" }), null, "'9001/' makes the path //mcp, which the daemon 404s: the entry is dead");
    assert.deepEqual(effectiveMcpTarget({ [DAEMON_PORT_ENV]: "8790/mcp?x" }), null, "a query in the value makes the request target /mcp?x/mcp, which the daemon 404s");
    assert.deepEqual(effectiveMcpTarget({ [DAEMON_PORT_ENV]: "8790#" }), null, "a fragment in the value makes the request target /, which the daemon 404s");
    assert.deepEqual(effectiveMcpTarget({ [DAEMON_PORT_ENV]: "8790@127.0.0.2:8790" }), null, "userinfo redirects the host to 127.0.0.2: the daemon binds 127.0.0.1 only, the entry is dead");
    assert.deepEqual(effectiveMcpTarget({ [DAEMON_PORT_ENV]: "x@127.0.0.1:8790" }), null, "userinfo alone also means a redirected target");
    assert.deepEqual(effectiveMcpTarget({ [DAEMON_PORT_ENV]: "abc" }), null, "an unparseable value makes an invalid URL: the entry is dead");
    assert.deepEqual(effectiveMcpTarget({ [DAEMON_PORT_ENV]: "0" }), null, "port 0 is not a port");
    await withBundle(HTTP_ENTRY, async () => {
      assert.equal(await daemonToolsDown({ [DAEMON_PORT_ENV]: "9001/" }, "claude-code"), true, "a dead entry fails open even if some other port answers 204");
    });
  });

  test("#11 another agent sharing the release tree never gates, manifest or not", async () => {
    // codex runs ${PLUGIN_ROOT}/hook.mjs — the same root file that sits next to the claude-code
    // http manifest — so the manifest alone must never arm the gate for it (finding: the gate
    // once disabled codex's interception on every daemon-less machine).
    await withBundle(HTTP_ENTRY, async () => {
      assert.equal(daemonEntryExpected(), true, "the shared tree does ship the http manifest");
      for (const agent of ["codex", "gemini", "qwen", "copilot-cli", "vscode", "kiro", "zcode", "pi", "opencode"]) {
        assert.equal(await daemonToolsDown({ [DAEMON_PORT_ENV]: String(DEAD_PORT) }, agent), false, agent + " never gates");
      }
      assert.equal(await daemonToolsDown({ [DAEMON_PORT_ENV]: String(DEAD_PORT) }, "claude-code"), true, "claude-code still gates");
    });
  });

  test("#11 a trickling server cannot hold the probe past its deadline (Copilot review)", async () => {
    // Valid but never-completed headers, one fragment every 200 ms: the socket never goes inactive
    // (the request's own timeout never fires) and the response event never arrives (no \r\n\r\n),
    // so only the probe's absolute deadline ends it. Garbage bytes would fail on a parse error
    // instead and pass without the deadline — the fragments must be header-shaped (Copilot review).
    const trickle = createServer((req, res) => {
      res.socket.write("HTTP/1.1 200 OK\r\n");
      const iv = setInterval(() => { try { res.socket.write("X-Trickle: fragment\r\n"); } catch { /* gone */ } }, 200);
      res.on("close", () => clearInterval(iv));
    });
    await new Promise((r) => trickle.listen(0, "127.0.0.1", r));
    try {
      await withBundle(HTTP_ENTRY, async () => {
        const start = Date.now();
        assert.equal(await daemonToolsDown({ [DAEMON_PORT_ENV]: String(trickle.address().port) }, "claude-code"), true, "a trickling server reads as down");
        const elapsed = Date.now() - start;
        assert.ok(elapsed < 4000, "the probe ends at its deadline, not at the host's hook timeout: " + elapsed + "ms");
      });
    } finally {
      trickle.close();
    }
  });

  test("#11 a degraded daemon fails /healthz, and the gate reads it as tools-down (Copilot review)", async () => {
    // --no-experimental-sqlite makes isDegraded() true (node:sqlite fails to import), the mode
    // that registers ctx_doctor only — exactly the hollow-server state the 503 exists for.
    const daemonSrc = join(import.meta.dirname, "..", "src", "entries", "daemon.ts");
    const child = spawn(process.execPath, [daemonSrc, "--port", "0"], {
      env: { ...process.env, HOME: bed.root, USERPROFILE: bed.root, NODE_OPTIONS: "--no-experimental-sqlite" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let url = "";
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("daemon did not print its banner: " + banner)), 20000);
        let banner = ""; // accumulated: a data event is not a line boundary, the banner can split across chunks (Copilot review)
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          banner += chunk;
          const line = banner.split("\n").find((l) => l.startsWith("context-mode daemon listening on "));
          if (line !== undefined) { clearTimeout(timer); url = line.slice("context-mode daemon listening on ".length); resolve(); }
        });
        child.once("exit", (code) => reject(new Error("daemon exited before the banner (code " + code + ")")));
      });
      const health = await fetch(url.replace(/\/mcp$/, "/healthz"));
      assert.equal(health.status, 503, "degraded mode must not answer the healthy 204");
      const port = Number(new URL(url).port);
      await withBundle(HTTP_ENTRY, async () => {
        assert.equal(await daemonToolsDown({ [DAEMON_PORT_ENV]: String(port) }, "claude-code"), true, "the gate reads a degraded daemon as tools-down");
      });
    } finally {
      child.kill();
    }
  });

  test("#11 an env proxy never routes the loopback probe (Copilot review)", async () => {
    // NODE_USE_ENV_PROXY routes the global agent through HTTP_PROXY; a proxy without a loopback
    // NO_PROXY cannot answer for 127.0.0.1 and would read every healthy daemon as down. The probe
    // uses its own Agent, so it stays direct. Run in a child (the env proxy is read at startup),
    // async: spawnSync would freeze this process' loop and the stub could never answer.
    const script = join(bed.root, "proxy-probe.mjs");
    writeFileSync(script, 'const g = await import(process.argv[4]);\n' +
      'process.argv[1] = process.argv[2];\n' +
      'const down = await g.daemonToolsDown({ CONTEXT_MODE_DAEMON_PORT: process.argv[3] }, "claude-code");\n' +
      'console.log(down ? "down" : "up");\n');
    const bundle = fakeBundle(HTTP_ENTRY);
    const child = spawn(process.execPath, [script, bundle.hook, String(bed.up204), pathToFileURL(join(import.meta.dirname, "..", "src", "core", "hooks", "daemon-gate.ts")).href], {
      env: { PATH: process.env.PATH ?? "", HOME: bed.root, USERPROFILE: bed.root, NODE_USE_ENV_PROXY: "1", HTTP_PROXY: "http://127.0.0.1:" + DEAD_PORT },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const answer = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("proxy-probe child did not answer")), 30000);
        let out = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (d) => { out += d; const nl = out.indexOf("\n"); if (nl >= 0) { clearTimeout(timer); resolve(out.slice(0, nl).trim()); } });
        child.once("exit", (code) => reject(new Error("proxy-probe child exited (code " + code + ")")));
      });
      assert.equal(answer, "up", "the probe ignores HTTP_PROXY: a healthy daemon reads as up");
    } finally {
      child.kill();
      rmSync(bundle.dir, { recursive: true, force: true });
      rmSync(script, { force: true });
    }
  });
});
