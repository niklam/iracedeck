/**
 * Chromium browser discovery + chromeless "app window" spawn (issue #992).
 *
 * The settings window is opened via `<browser> --app=<url>`, which needs a
 * Chromium-based browser executable. Edge is a bundled Windows component so
 * it is nearly always present, but install locations vary (per-machine vs
 * per-user, channels), so the primary lookup is the `App Paths` registry key
 * — the OS's own answer — with the common install paths as a fallback.
 *
 * `spawnAppWindow` is the ONLY child_process usage in the plugin. It is kept
 * to one function, detached, stdio ignored, so the browser process never ties
 * itself to the plugin's lifetime.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ChromiumLookupDeps {
  exists: (path: string) => boolean;
  /** Resolves `HKLM\...\App Paths\<exe>` default value, or undefined. */
  queryAppPath: (exe: string) => string | undefined;
  env: Record<string, string | undefined>;
}

const APP_PATH_EXES = ["msedge.exe", "chrome.exe", "brave.exe"] as const;

function wellKnownPaths(env: ChromiumLookupDeps["env"]): string[] {
  const local = env.LOCALAPPDATA ?? "";

  return [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    ...(local ? [join(local, "Google/Chrome/Application/chrome.exe")] : []),
    "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
  ];
}

export function findChromiumBrowser(deps: ChromiumLookupDeps): string | undefined {
  for (const exe of APP_PATH_EXES) {
    const path = deps.queryAppPath(exe);

    if (path && deps.exists(path)) return path;
  }

  for (const path of wellKnownPaths(deps.env)) {
    if (deps.exists(path)) return path;
  }

  return undefined;
}

/** Real registry lookup via `reg query`. Returns undefined on any failure. */
export function queryWindowsAppPath(exe: string): string | undefined {
  try {
    const out = execFileSync(
      "reg",
      ["query", `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, "/ve"],
      { encoding: "utf-8", windowsHide: true },
    );
    const match = out.match(/REG_SZ\s+(.+\.exe)/i);

    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

/** Convenience: the lookup bound to the real filesystem, registry, and env. */
export function findChromiumBrowserOnThisMachine(): string | undefined {
  return findChromiumBrowser({ exists: existsSync, queryAppPath: queryWindowsAppPath, env: process.env });
}

/**
 * Initial settings-window size (outer bounds). Without an explicit size
 * Chromium reuses its last window size, which on a big monitor opens far too
 * large. 1172×788 is the size the page was designed and reviewed at; the OS
 * clamps it on smaller displays and the user can still resize afterwards.
 */
export const SETTINGS_WINDOW_SIZE = { width: 1172, height: 788 } as const;

/** The exact argument list for a chromeless app window — pure, so it can be tested without spawning. */
export function appWindowArgs(url: string): string[] {
  return [`--app=${url}`, `--window-size=${SETTINGS_WINDOW_SIZE.width},${SETTINGS_WINDOW_SIZE.height}`];
}

/** Spawn `<browserPath> --app=<url>` detached so it outlives — and never blocks — the plugin. */
export function spawnAppWindow(browserPath: string, url: string): void {
  const child = spawn(browserPath, appWindowArgs(url), { detached: true, stdio: "ignore", windowsHide: false });

  child.unref();
}
