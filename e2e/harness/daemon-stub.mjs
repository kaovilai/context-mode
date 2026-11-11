// e2e/harness/daemon-stub.mjs
// kaovilai/context-mode#11: the claude-code hook bundle gates its replace and read-deny routes on
// the shared daemon's /healthz (the manifest next to release-out/hook.mjs arms the gate). A case
// machine (CI) runs no daemon, so every hook spawn that asserts a replace or a deny would fail
// open instead. This stub answers /healthz with 204 — exactly what daemon.ts does — on an
// ephemeral port, and stubDaemonEnv() names that port for a hook child. A case that passes its own
// CONTEXT_MODE_DAEMON_PORT keeps it (the caller's env wins over the stub's).
// No src import here: ci-gs4-lint keeps e2e off src/, so the env var name is spelled out
// (it is DAEMON_PORT_ENV in src/core/contracts/constants.ts).
import { createServer } from "node:http";

const DAEMON_PORT_ENV = "CONTEXT_MODE_DAEMON_PORT";

let portPromise = null;

/** The stub's port, started on first use and shared for the process' life.
 *  unref(): the listening socket never keeps the test process' event loop alive — every GP file
 *  runs as its own process (e2e/cases/run.mjs, node:test isolation) and would otherwise hang after
 *  its last test, holding the whole suite open. While tests run, the loop is busy anyway, so the
 *  stub answers the whole time. */
export function stubDaemonPort() {
  if (portPromise === null) {
    portPromise = new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        if (req.url === "/healthz") res.writeHead(204).end();
        else res.writeHead(404).end();
      });
      server.on("error", reject);
      server.unref();
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
  }
  return portPromise;
}

/** The env patch a hook child needs to see the stub: the port, and the bypass off. The bypass is
 *  pinned to "0" (not merely unset) so a developer who exports CTX_MODE_BYPASS=1 globally cannot
 *  silently flip every replace-asserting case to fail-open; a case that means to test the bypass
 *  passes its own env with "1", and the caller's env wins over the stub. */
export async function stubDaemonEnv() {
  return { [DAEMON_PORT_ENV]: String(await stubDaemonPort()), CTX_MODE_BYPASS: "0" };
}
