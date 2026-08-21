/// <reference lib="dom" />
/**
 * SimHub Control Mapper reachability probe (issue #612).
 *
 * The binding-status component polls this to show/clear a "SimHub not
 * connected" warning live, and ird-key-binding fetches the role list through
 * it. One request answers both questions — `probeSimHub` — and the two
 * narrower helpers are projections of it, so no caller ever needs a second
 * round trip to learn what the first response already said.
 */
import { abortAfter } from "./abort-after.js";
import { inSettingsWindow, SETTINGS_WINDOW_FLAG } from "./settings-window-context.js";

/** Poll interval (ms) used by consumers that watch reachability over time. */
export const SIMHUB_POLL_INTERVAL_MS = 3000;

/**
 * Re-exported for callers/tests that reach the flag through this module. Set
 * on `window` by the settings-window bridge (#992). Inside the dedicated
 * settings window a direct fetch to SimHub is CROSS-ORIGIN (the page is
 * `http://127.0.0.1:<plugin port>`, SimHub is `:8888`) and SimHub sends no CORS
 * headers, so it always looked unreachable. There the plugin answers instead,
 * from its own SimHub service, at the same-origin `/simhub/roles`.
 */
export { SETTINGS_WINDOW_FLAG };

const PROXY_PATH = "/simhub/roles";

/** What one probe learns: is SimHub answering, and which roles does it list. */
export interface SimHubProbeResult {
  reachable: boolean;
  roles: string[];
}

const UNREACHABLE: SimHubProbeResult = { reachable: false, roles: [] };

/** Ask the plugin's proxy. Never throws. */
async function fetchViaPlugin(): Promise<SimHubProbeResult> {
  try {
    const response = await fetch(PROXY_PATH, { signal: abortAfter(1500), cache: "no-store" });

    if (!response.ok) return UNREACHABLE;

    const body = (await response.json()) as { reachable?: unknown; roles?: unknown };

    return {
      reachable: body.reachable === true,
      roles: Array.isArray(body.roles) ? body.roles.filter((r): r is string => typeof r === "string") : [],
    };
  } catch {
    return UNREACHABLE;
  }
}

/**
 * One request to SimHub's Control Mapper REST API at host:port (or, inside the
 * settings window, to the plugin's proxy): whether it answered, and the role
 * names it listed. Never throws — a timeout, refused connection, or non-OK
 * status is `{ reachable: false, roles: [] }`; an OK answer whose body isn't a
 * string array is reachable with no roles (deck-core's own SimHub service
 * reads it the same way).
 */
export async function probeSimHub(host: string, port: number): Promise<SimHubProbeResult> {
  if (inSettingsWindow()) return fetchViaPlugin();

  try {
    const url = `http://${host}:${port}/api/ControlMapper/GetRoles/`;
    const response = await fetch(url, { signal: abortAfter(500) });

    if (!response.ok) return UNREACHABLE;

    const body: unknown = await response.json().catch(() => undefined);

    if (!Array.isArray(body)) console.warn("[simhub-probe] SimHub GetRoles returned an unexpected format");

    return {
      reachable: true,
      roles: Array.isArray(body) ? body.filter((r): r is string => typeof r === "string") : [],
    };
  } catch {
    return UNREACHABLE;
  }
}

/**
 * Returns true when SimHub's Control Mapper REST API answers at host:port.
 * Never throws — a timeout, refused connection, or non-OK status is `false`.
 */
export async function fetchSimHubReachable(host: string, port: number): Promise<boolean> {
  return (await probeSimHub(host, port)).reachable;
}

/**
 * The Control Mapper role names at host:port (for the SimHub-role picker).
 * Never throws — any failure is an empty list.
 */
export async function fetchSimHubRoles(host: string, port: number): Promise<string[]> {
  return (await probeSimHub(host, port)).roles;
}
