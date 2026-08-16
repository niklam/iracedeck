/**
 * Settings-window bridge (issue #992).
 *
 * The dedicated settings window is a page served by the plugin process over a
 * loopback HTTP server and opened as a chromeless browser app window. It
 * reuses the vendored `sdpi-components.js` and the built `pi-components.js`
 * VERBATIM, so every existing `global-*.ejs` partial and `ird-*` component
 * renders unchanged.
 *
 * sdpi-components' only integration seam is `window.connectElgatoStreamDeckSocket`,
 * which then opens its OWN WebSocket to the hardcoded `ws://localhost:{port}` —
 * no path, no query string, so no way to carry the per-launch security token
 * the server requires on the upgrade. Same problem the Ulanzi bridge solves,
 * same solution: monkeypatch `WebSocket` for the duration of the synchronous
 * `connect()` call, hand sdpi a socket that actually opens the tokenised
 * loopback URL, then restore.
 *
 * Unlike the Ulanzi bridge there is NO frame translation here: the plugin's
 * settings server speaks the Elgato PI protocol natively (`getGlobalSettings` /
 * `setGlobalSettings` / `didReceiveGlobalSettings` / `openUrl` / `logMessage`),
 * so the socket is a plain pass-through.
 *
 * The plugin injects `<script src="settings-window-bridge.js">` before
 * `sdpi-components.js` into the served page.
 */

/** Synthetic action id the window registers as — never a real action, only a scope label. */
export const SETTINGS_WINDOW_ACTION = "com.iracedeck.sd.core.settings-window";

/** Synthetic PI context for the window (sdpi sends it as `context` on every frame). */
export const SETTINGS_WINDOW_CONTEXT = "settings-window";

export interface SettingsWindowIdentity {
  /** The per-launch token from the page URL's `t` query parameter. */
  token: string;
}

/** Read the launch identity from a URL query string (`location.search`). */
export function readSettingsWindowIdentity(search: string): SettingsWindowIdentity {
  return { token: new URLSearchParams(search).get("t") ?? "" };
}

/**
 * Install the bridge on `win`: monkeypatch `WebSocket` so sdpi's socket opens
 * `ws://<page host>/ws?t=<token>` instead of `ws://localhost:<port>`, drive
 * `connectElgatoStreamDeckSocket` with a synthetic identity, then restore.
 * Exposed (with an injectable `win`) so it can be unit-tested without a DOM.
 */
export function installSettingsWindowBridge(win: Window & typeof globalThis = window): void {
  const identity = readSettingsWindowIdentity(win.location.search);
  const host = win.location.host; // "127.0.0.1:<port>" — same origin as the page
  const port = host.split(":")[1] ?? "";
  const Native = win.WebSocket;
  const target = `ws://${host}/ws?t=${encodeURIComponent(identity.token)}`;

  // sdpi opens `new WebSocket("ws://localhost:{port}")`; open the real target instead.
  (win as unknown as { WebSocket: unknown }).WebSocket = function settingsWindowWebSocket(): WebSocket {
    return new Native(target);
  } as unknown as typeof WebSocket;

  const info = JSON.stringify({
    application: { language: "en", platform: "windows", version: "" },
    plugin: { uuid: "com.iracedeck.sd.core", version: "" },
    devicePixelRatio: 1,
    colors: {},
  });
  const actionInfo = JSON.stringify({
    action: SETTINGS_WINDOW_ACTION,
    context: SETTINGS_WINDOW_CONTEXT,
    device: "",
    payload: { settings: {} },
  });

  const connect = (win as unknown as { connectElgatoStreamDeckSocket?: (...args: unknown[]) => void })
    .connectElgatoStreamDeckSocket;

  try {
    if (typeof connect === "function") {
      connect(port, SETTINGS_WINDOW_CONTEXT, "registerPropertyInspector", info, actionInfo);
    }
  } finally {
    // Restore the native WebSocket even if connect throws: sdpi created its
    // (bridged) socket synchronously inside connect, so nothing else should be bridged.
    (win as unknown as { WebSocket: unknown }).WebSocket = Native;
  }
}

// Bootstrap once the DOM — and the synchronous sdpi-components.js script that
// defines connectElgatoStreamDeckSocket — is ready. Guarded by a window check
// so importing this module under Node (tests) does not auto-run.
if (typeof window !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => installSettingsWindowBridge());
  } else {
    installSettingsWindowBridge();
  }
}
