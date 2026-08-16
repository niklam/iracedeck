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
 * Set on `window` by the settings-window bridge (#992). Inside the dedicated
 * settings window a direct fetch to SimHub is CROSS-ORIGIN (the page is
 * `http://127.0.0.1:<plugin port>`, SimHub is `:8888`) and SimHub sends no CORS
 * headers, so it always looked unreachable. There the plugin answers instead,
 * from its own SimHub service, at the same-origin `/simhub/roles`.
 */
export const SETTINGS_WINDOW_FLAG = "__irdSettingsWindow";

const PROXY_PATH = "/simhub/roles";

function inSettingsWindow(): boolean {
  return typeof window !== "undefined" && (window as unknown as Record<string, unknown>)[SETTINGS_WINDOW_FLAG] === true;
}

/** Ask the plugin's proxy. Never throws. */
async function fetchViaPlugin(): Promise<{ reachable: boolean; roles: string[] }> {
  try {
    const response = await fetch(PROXY_PATH, { signal: abortAfter(1500), cache: "no-store" });

    if (!response.ok) return { reachable: false, roles: [] };

    const body = (await response.json()) as { reachable?: unknown; roles?: unknown };

    return {
      reachable: body.reachable === true,
      roles: Array.isArray(body.roles) ? body.roles.filter((r): r is string => typeof r === "string") : [],
    };
  } catch {
    return { reachable: false, roles: [] };
  }
}

/**
 * Returns true when SimHub's Control Mapper REST API answers at host:port.
 * Never throws — a timeout, refused connection, or non-OK status is `false`.
 */
export async function fetchSimHubReachable(host: string, port: number): Promise<boolean> {
  if (inSettingsWindow()) return (await fetchViaPlugin()).reachable;

  try {
    const url = `http://${host}:${port}/api/ControlMapper/GetRoles/`;
    const response = await fetch(url, { signal: abortAfter(500) });

    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The Control Mapper role names at host:port (for the SimHub-role picker).
 * Never throws — any failure is an empty list.
 */
export async function fetchSimHubRoles(host: string, port: number): Promise<string[]> {
  if (inSettingsWindow()) return (await fetchViaPlugin()).roles;

  try {
    const url = `http://${host}:${port}/api/ControlMapper/GetRoles/`;
    const response = await fetch(url, { signal: abortAfter(500) });

    if (!response.ok) return [];

    const body: unknown = await response.json();

    return Array.isArray(body) ? body.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}
