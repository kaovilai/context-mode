// e2e/harness/hook-runner.mjs
// Spawns a hook entry bundle with argv --agent <id> --event <name>,
// writes the payload to stdin, and returns stdout/stderr/exitCode/ms.
// Spec: docs/architecture/modules/14-tests.md §1, 00-architecture.md e2e table.
// kaovilai/context-mode#11: every hook child also gets CONTEXT_MODE_DAEMON_PORT naming the
// harness's stub daemon (a 204 on /healthz), so a case machine with no daemon still exercises
// the replace and deny routes. The caller's own value for that var wins.
import { spawn } from "node:child_process";
import { stubDaemonEnv } from "./daemon-stub.mjs";

/**
 * @param {string} bundlePath
 * @param {{agent:string, event:string, payload:unknown, env?:Record<string,string>}} opts
 * @returns {Promise<{stdout:string, stderr:string, exitCode:number|null, ms:number}>}
 */
export async function runHook(bundlePath, opts) {
  const { agent, event, payload, env } = opts;
  const stub = await stubDaemonEnv();
  // A caller-provided env wins over the stub (a case may point at its own port); the ambient
  // process.env does not — on a machine with the var set (a stale or real daemon port), the stub
  // must still own it or hook children would probe that port and fail open unpredictably.
  const childEnv = env === undefined ? { ...process.env, ...stub } : { ...stub, ...env };
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(
      process.execPath,
      [bundlePath, "--agent", agent, "--event", event],
      { stdio: ["pipe", "pipe", "pipe"], env: childEnv }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    child.on("error", reject);
    child.on("exit", (code) => {
      const ms = Date.now() - start;
      resolve({ stdout, stderr, exitCode: code, ms });
    });

    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    child.stdin.write(body);
    child.stdin.end();
  });
}

/**
 * runHookFixture(bundlePath, agent, payload) -> same result as runHook.
 * Thin wrapper for GP3 fixture replay (e2e/cases/GP3-hooks.e2e.mjs): the hook
 * entry (src/entries/hook.ts) only reads --agent off argv, so no event name
 * is needed to run the bundle.
 */
export function runHookFixture(bundlePath, agent, payload, env) {
  return runHook(bundlePath, { agent, event: undefined, payload, env });
}
