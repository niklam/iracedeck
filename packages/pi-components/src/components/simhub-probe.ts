/// <reference lib="dom" />
/**
 * SimHub Control Mapper reachability probe (issue #612).
 *
 * The binding-status component polls this to show/clear a "SimHub not
 * connected" warning live. Mirrors the endpoint the ird-key-binding component
 * already uses to fetch roles, but reduced to a boolean health check.
 */

/** Poll interval (ms) used by consumers that watch reachability over time. */
export const SIMHUB_POLL_INTERVAL_MS = 3000;

/**
 * Returns true when SimHub's Control Mapper REST API answers at host:port.
 * Never throws — a timeout, refused connection, or non-OK status is `false`.
 */
export async function fetchSimHubReachable(host: string, port: number): Promise<boolean> {
  try {
    const url = `http://${host}:${port}/api/ControlMapper/GetRoles/`;
    const response = await fetch(url, { signal: AbortSignal.timeout(500) });

    return response.ok;
  } catch {
    return false;
  }
}
