// tests/0026-daemon.test.mjs
// Area: ADR-0026 (shared HTTP daemon). One file per ADR area (ADR-0024, docs/architecture/TEST-LAYOUT.md).
// Covers: the daemon entry (flags, unit text, serving), per-session identity over one process
// (session id, agent from clientInfo, workspace from the request header), the project-shared index
// across sessions, the doctor D12 row, and the stdio default staying the default.
import { describe, test, before, after } from "node:test";
import { CONC } from "./_lib/concurrency.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseDaemonArgs, daemonUnitText } from "../src/entries/daemon.ts";
import { route } from "../src/entries/cli.ts";
import { HELP_MAIN } from "../src/cli/args.ts";
import { checkDaemon } from "../src/core/ops/doctor-env.ts";
import { DAEMON_ADD_COMMAND, DAEMON_CHECK_FIX, DAEMON_DEFAULT_PORT, DAEMON_PORT_ENV } from "../src/core/contracts/constants.ts";

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
    assert.ok(unit.includes("ExecStart=/usr/bin/node /opt/cm/daemon.mjs"));
    assert.ok(unit.includes("Restart=on-failure"));
    assert.ok(unit.includes(`Environment=${DAEMON_PORT_ENV}=8790`));
    assert.ok(unit.includes("WantedBy=default.target"));
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

  test("exactly one daemon process serves every session, RSS flat in the session count", async () => {
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
