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
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { SettingsWindowBounds } from "./settings-window-launcher.js";

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

let cachedBrowserPath: string | undefined;

/**
 * Convenience: the lookup bound to the real filesystem, registry, and env.
 *
 * Memoized per process: the registry lookup shells out to `reg query` (up to
 * three synchronous process spawns, ~15 ms each here) on the plugin's main
 * thread, and browsers don't move between opens. A cached path that has since
 * vanished (`existsSync` false) is dropped and the lookup runs again.
 */
export function findChromiumBrowserOnThisMachine(): string | undefined {
  if (cachedBrowserPath !== undefined && existsSync(cachedBrowserPath)) return cachedBrowserPath;

  cachedBrowserPath = findChromiumBrowser({ exists: existsSync, queryAppPath: queryWindowsAppPath, env: process.env });

  return cachedBrowserPath;
}

/** @internal Exported for testing — forget the memoized browser path. */
export function _resetChromiumBrowserCache(): void {
  cachedBrowserPath = undefined;
}

/**
 * Initial settings-window size (outer bounds). Without an explicit size
 * Chromium reuses its last window size, which on a big monitor opens far too
 * large. 1172×788 is the size the page was designed and reviewed at; the OS
 * clamps it on smaller displays and the user can still resize afterwards.
 */
export const SETTINGS_WINDOW_SIZE = { width: 1172, height: 788 } as const;

/**
 * The exact argument list for a chromeless app window — pure, so it can be
 * tested without spawning.
 *
 * `--user-data-dir` is the load-bearing flag: when the user's browser is
 * already running, a plain `--app=` launch just hands the URL to that process
 * and exits, and Chromium honours `--window-size` only for a NEW process — so
 * the window opened at whatever size the browser last had (observed: huge).
 * A dedicated profile directory forces a separate process every time, which
 * also isolates the window's cookies from the user's browsing profile, keeps
 * extensions out of it, and gives it its own taskbar entry.
 */
export function appWindowArgs(url: string, profileDir: string, bounds?: SettingsWindowBounds): string[] {
  const size = bounds ?? SETTINGS_WINDOW_SIZE;
  const args = [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${Math.round(size.width)},${Math.round(size.height)}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];

  if (bounds?.x !== undefined && bounds.y !== undefined) {
    args.push(`--window-position=${Math.round(bounds.x)},${Math.round(bounds.y)}`);
  }

  return args;
}

/**
 * Where the settings window's private browser profile lives:
 * `%LOCALAPPDATA%\iRaceDeck\settings-window-profile`. Per-user, survives
 * plugin updates (it is not inside the plugin folder), safe to delete.
 */
export function defaultSettingsWindowProfileDir(env: Record<string, string | undefined> = process.env): string {
  const base = env.LOCALAPPDATA ?? join(env.USERPROFILE ?? ".", "AppData", "Local");

  return join(base, "iRaceDeck", "settings-window-profile");
}

/**
 * Spawn the app window detached so it outlives — and never blocks — the plugin.
 *
 * Resolves once the process has actually started and rejects when it could
 * not (ENOENT/EACCES — the exe vanished since lookup, or policy blocks it).
 * `spawn()` reports those failures as an asynchronous `'error'` event, NOT a
 * synchronous throw; with no listener that event is an uncaught exception
 * that ends the plugin process. Surfacing it as a rejection lets the launcher
 * fall back to the host's `openUrl` instead.
 */
export function spawnAppWindow(browserPath: string, url: string, bounds?: SettingsWindowBounds): Promise<void> {
  const profileDir = defaultSettingsWindowProfileDir();

  mkdirSync(profileDir, { recursive: true });

  const child = spawn(browserPath, appWindowArgs(url, profileDir, bounds), {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });

  return new Promise<void>((resolve, reject) => {
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", (error) => {
      child.unref();
      reject(error);
    });
  });
}
