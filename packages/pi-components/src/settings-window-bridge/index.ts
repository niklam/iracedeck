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
 * no path, no query string, so no way to carry the security token
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

/**
 * Set to `true` on `window` so shared PI code can tell it is running inside the
 * settings window (e.g. simhub-probe routes through the plugin's proxy there).
 * Kept in sync with `SETTINGS_WINDOW_FLAG` in components/simhub-probe.ts.
 */
export const SETTINGS_WINDOW_FLAG = "__irdSettingsWindow";

/** How often the bounds watcher looks for a move/resize (ms). */
const BOUNDS_POLL_MS = 1000;

/**
 * Report the window's outer bounds to the plugin when they change, so the
 * next open can restore them. A window MOVE has no DOM event, so this polls
 * (cheap: four integer reads a second) instead of listening for `resize`,
 * which would miss every drag. Only a SETTLED position is reported — bounds
 * that read the same on two consecutive ticks — so a drag or resize costs one
 * report when it ends, not one per second while it lasts: every report is a
 * global-settings write in the plugin (whole-blob parse, fan-out to every
 * action's re-render, a host round trip) and only the final position is ever
 * read back. A final report on `pagehide` keeps a move made right before
 * closing. Sent as a `sendToPlugin` frame the fake host forwards to the
 * plugin's command handler, which validates and persists it.
 */
function watchWindowBounds(win: Window & typeof globalThis, socket: WebSocket): void {
  const read = (): { width: number; height: number; x: number; y: number } => ({
    width: win.outerWidth,
    height: win.outerHeight,
    x: win.screenX,
    y: win.screenY,
  });
  const key = (b: ReturnType<typeof read>): string => `${b.width},${b.height},${b.x},${b.y}`;

  // Baseline at load: only CHANGES are reported.
  let lastReported = key(read());
  let previousTick = lastReported;

  const post = (payload: Record<string, unknown>): void => {
    socket.send(
      JSON.stringify({
        event: "sendToPlugin",
        context: SETTINGS_WINDOW_CONTEXT,
        action: SETTINGS_WINDOW_ACTION,
        payload: { event: "windowBounds", ...payload },
      }),
    );
  };

  const send = (bounds: ReturnType<typeof read>, k: string): void => {
    if (k === lastReported || socket.readyState !== 1 /* OPEN */) return;

    lastReported = k;
    post(bounds);
  };

  const tick = (): void => {
    const bounds = read();
    const k = key(bounds);

    // Settled = unchanged since the previous tick (the gesture has ended).
    if (k === previousTick) send(bounds, k);

    previousTick = k;
  };

  // The window is going away: whatever it reads now is final.
  const flush = (): void => {
    const bounds = read();

    send(bounds, key(bounds));
  };

  win.setInterval(tick, BOUNDS_POLL_MS);
  win.addEventListener("pagehide", flush);

  // Bounds saved on a monitor that has since been unplugged reopen the window
  // FULLY off-screen: Chromium applies `--window-position` unclamped and the
  // OS does not relocate a new window. Nobody can drag an invisible window,
  // and an unmoved window never re-reports (baseline above), so it would stay
  // that way on every later open. Recover: pull it onto the display Chromium
  // considers it nearest to, and persist a size-only report so the next open
  // gets default placement even if the move was refused.
  if (isOffScreen(win)) {
    const { left, top } = availableArea(win);

    win.moveTo(left, top);

    const sizeOnly = (): void => post({ width: win.outerWidth, height: win.outerHeight });

    if (socket.readyState === 1 /* OPEN */) sizeOnly();
    else socket.addEventListener("open", sizeOnly, { once: true });
  }
}

/** The usable rectangle of the display the window is (nearest to) on, in CSS px. */
function availableArea(win: Window & typeof globalThis): { left: number; top: number; width: number; height: number } {
  // `availLeft`/`availTop` are Chromium (and Firefox) extensions — exactly the
  // engines this window runs in — not in the DOM lib typings.
  const screen = win.screen as Screen & { availLeft?: number; availTop?: number };

  return {
    left: screen.availLeft ?? 0,
    top: screen.availTop ?? 0,
    width: screen.availWidth,
    height: screen.availHeight,
  };
}

/** True when the window's outer rectangle does not intersect its display at all. */
function isOffScreen(win: Window & typeof globalThis): boolean {
  if (typeof win.screen === "undefined" || typeof win.moveTo !== "function") return false;

  const { left, top, width, height } = availableArea(win);

  if (!(width > 0 && height > 0)) return false;

  const right = left + width;
  const bottom = top + height;

  return (
    win.screenX + win.outerWidth <= left ||
    win.screenX >= right ||
    win.screenY + win.outerHeight <= top ||
    win.screenY >= bottom
  );
}

export interface SettingsWindowIdentity {
  /** The server's token from the page URL's `t` query parameter. */
  token: string;
}

/** Read the launch identity from a URL query string (`location.search`). */
export function readSettingsWindowIdentity(search: string): SettingsWindowIdentity {
  return { token: new URLSearchParams(search).get("t") ?? "" };
}

/**
 * Close the window because its plugin has gone away. `window.close()` is
 * honoured for a script-closable top-level window (the normal `--app=` case);
 * if the browser refuses, leave an unmistakable overlay rather than a page that
 * looks alive but saves nothing.
 */
export function closeSettingsWindow(win: Window & typeof globalThis): void {
  win.close();

  win.setTimeout(() => {
    if (win.closed) return;

    const overlay = win.document.createElement("div");

    overlay.textContent = "iRaceDeck is no longer running — you can close this window.";
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      display: "grid",
      placeItems: "center",
      background: "rgba(0,0,0,.85)",
      color: "#fff",
      font: '11pt "Segoe UI", Arial, sans-serif',
      zIndex: "2147483647",
    });
    win.document.body.appendChild(overlay);
  }, 250);
}

/**
 * Install the bridge on `win`: monkeypatch `WebSocket` so sdpi's socket opens
 * `ws://<page host>/ws?t=<token>` instead of `ws://localhost:<port>`, drive
 * `connectElgatoStreamDeckSocket` with a synthetic identity, then restore.
 * Exposed (with an injectable `win`) so it can be unit-tested without a DOM.
 */
export function installSettingsWindowBridge(win: Window & typeof globalThis = window): void {
  (win as unknown as Record<string, unknown>)[SETTINGS_WINDOW_FLAG] = true;

  const identity = readSettingsWindowIdentity(win.location.search);
  const host = win.location.host; // "127.0.0.1:<port>" — same origin as the page
  const port = host.split(":")[1] ?? "";
  const Native = win.WebSocket;
  const target = `ws://${host}/ws?t=${encodeURIComponent(identity.token)}`;

  // sdpi opens `new WebSocket("ws://localhost:{port}")`; open the real target instead.
  (win as unknown as { WebSocket: unknown }).WebSocket = function settingsWindowWebSocket(): WebSocket {
    const socket = new Native(target);

    // The socket only ever closes when the plugin process is gone (the deck host
    // shut down, restarted, or the server was torn down). The page is then dead
    // and would otherwise linger — a detached app window is not tied to the
    // plugin's lifetime, and when the browser was already running our spawn
    // just handed off to it, so the plugin holds no handle to close. Close from
    // the inside: an `--app=` window with one history entry is script-closable.
    socket.addEventListener("close", () => closeSettingsWindow(win));
    watchWindowBounds(win, socket);

    return socket;
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
