/**
 * Settings-window launcher (issue #992).
 *
 * Opens the plugin-served settings page as a chromeless browser "app" window
 * (`--app=<url>` — a genuine top-level window with no tab strip or URL bar),
 * degrading to the host's ordinary `openUrl` when no Chromium-based browser
 * is found. Kept pure over injected delegates so the decision is testable
 * without touching the filesystem or spawning a process; the concrete
 * browser lookup and spawner live beside it.
 */

export type SettingsWindowLaunch = "app-window" | "browser-tab";

/** Outer window bounds (CSS px). Position is optional — size-only is fine. */
export interface SettingsWindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

export interface SettingsWindowLaunchInput {
  /** Fully formed page URL, token included. */
  url: string;
  /** Returns the path of a Chromium-based browser executable, or undefined. */
  findBrowser: () => string | undefined;
  /**
   * Spawns `<browserPath> --app=<url>`, detached, at `bounds` when given.
   * May throw synchronously or return a promise that rejects — `spawn()`
   * reports "can't start this exe" asynchronously, so the real spawner
   * resolves on the child's `spawn` event and rejects on its `error` event.
   */
  spawnApp: (browserPath: string, url: string, bounds?: SettingsWindowBounds) => void | Promise<void>;
  /** Where the user last left the window, if known. */
  bounds?: SettingsWindowBounds;
  /**
   * The host's own URL opener — the fallback.
   *
   * Note what its resolution does and does not mean (#1005): every adapter
   * resolves once the command has been SENT, not once a page has appeared —
   * Elgato's on the WebSocket write, Mirabox's and Ulanzi's fire-and-forget. No
   * host protocol reports whether a browser actually opened, so this function
   * returning `"browser-tab"` is "handed off", not "displayed". A machine with
   * no usable browser therefore looks like a success from here, and the
   * open-failure warning banner it feeds is a DEFENSIVE net for the case where
   * the opener itself rejects (a dead host socket, say) rather than a reliable
   * detector of "nothing opened". Detecting the latter would need a signal that
   * does not exist; do not add a proxy for it — falling back to a normal
   * browser tab is a supported, working path, so treating "no Chromium found"
   * as a failure would warn on machines where everything is fine.
   */
  openUrl: (url: string) => Promise<void>;
}

export async function launchSettingsWindow(input: SettingsWindowLaunchInput): Promise<SettingsWindowLaunch> {
  const browserPath = input.findBrowser();

  if (browserPath !== undefined) {
    try {
      await input.spawnApp(browserPath, input.url, input.bounds);

      return "app-window";
    } catch {
      // A browser that was found but won't start (removed since lookup, blocked
      // by policy) is not worth failing over — the tab fallback still works.
    }
  }

  await input.openUrl(input.url);

  return "browser-tab";
}
