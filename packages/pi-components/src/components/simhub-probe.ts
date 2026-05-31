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
 * An abort signal that fires after `ms`. Prefers `AbortSignal.timeout` (the
 * Stream Deck PI WebView supports it — ird-key-binding already relies on it),
 * with an `AbortController` + `setTimeout` fallback for any older embedded
 * WebView that lacks it. Returns undefined when neither exists (request simply
 * runs without a client-side timeout rather than failing).
 */
function abortAfter(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }

  if (typeof AbortController !== "undefined") {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);

    return controller.signal;
  }

  return undefined;
}

/**
 * Returns true when SimHub's Control Mapper REST API answers at host:port.
 * Never throws — a timeout, refused connection, or non-OK status is `false`.
 */
export async function fetchSimHubReachable(host: string, port: number): Promise<boolean> {
  try {
    const url = `http://${host}:${port}/api/ControlMapper/GetRoles/`;
    const response = await fetch(url, { signal: abortAfter(500) });

    return response.ok;
  } catch {
    return false;
  }
}
