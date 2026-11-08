// ADR-0026: runtime facts about the shared daemon, for ctx_doctor D12. A tiny module of its own so
// doctor-env can read them without importing the server core (no import cycle: the daemon entry is
// the only writer, the doctor the only reader).
import { DAEMON_PORT_ENV, DAEMON_DEFAULT_PORT } from "../contracts/constants.ts";

let selfPort: number | undefined; // set once by the daemon entry: this process serves HTTP on this port

/** The daemon entry marks itself, so its own ctx_doctor D12 row is a self-probe, not a guess. */
export function markDaemonPort(port: number): void {
  selfPort = port;
}

/** The port this process is serving HTTP on, when it is the daemon. */
export function daemonSelfPort(): number | undefined {
  return selfPort;
}

/** The configured port: CONTEXT_MODE_DAEMON_PORT when set to a valid port, else the default. */
export function daemonConfiguredPort(env: NodeJS.ProcessEnv): number {
  const raw = env[DAEMON_PORT_ENV];
  if (raw !== undefined && /^[0-9]+$/.test(raw)) {
    const port = Number(raw);
    if (port >= 1 && port <= 65535) return port;
  }
  return DAEMON_DEFAULT_PORT;
}

/** True when the user opted into the daemon check from a stdio session (the env var names a port). */
export function daemonCheckWanted(env: NodeJS.ProcessEnv): boolean {
  const raw = env[DAEMON_PORT_ENV];
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return false;
  const port = Number(raw);
  return port >= 1 && port <= 65535;
}
