/**
 * Shared per-page Property Inspector poller (issue #903).
 *
 * PI pages poll sdpi component values as a fallback because their change/input
 * events are unreliable. Before this helper, every partial and action template
 * created its own uncleaned 100 ms `setInterval` — 5–9 timers per open PI page,
 * never cleared, which leaks the whole document on hosts that keep navigated-away
 * PI pages alive (observed as memory/CPU growth in UlanziStudio's QWebEngineView).
 *
 * This module runs ONE interval per page that inline scripts register callbacks
 * on via `window.irdPoll(fn)`, and clears it on `pagehide` so a navigated-away
 * document releases its timer (restarting on `pageshow` covers a bfcache-style
 * restore). Callbacks are page-lifetime by default; `irdPoll` returns an
 * unregister function for callers that need to stop earlier.
 */

/** Cadence of the shared poll tick — matches the 100 ms the inline pollers used. */
export const POLL_INTERVAL_MS = 100;

type PollCallback = () => void;

/** The timer surface the poller needs; injectable for testing. */
type TimerHost = Pick<Window, "setInterval" | "clearInterval">;

export interface SharedPoller {
  /** Register a callback on the shared tick. Returns an unregister function. */
  register(callback: PollCallback): () => void;
  /** Clear the interval, keeping registrations (pagehide). */
  stop(): void;
  /** Restart the interval if any callbacks are registered (pageshow). */
  resume(): void;
}

/** Create an isolated poller instance. Production code uses {@link installSharedPoller}. */
export function createSharedPoller(win: TimerHost = window): SharedPoller {
  const callbacks = new Set<PollCallback>();
  let timer: ReturnType<Window["setInterval"]> | undefined;

  function tick(): void {
    for (const callback of callbacks) {
      try {
        callback();
      } catch (error) {
        // One throwing callback must not starve the others; surface it in the
        // PI console rather than swallowing it silently.
        console.error("irdPoll callback failed", error);
      }
    }
  }

  function start(): void {
    if (timer === undefined && callbacks.size > 0) {
      timer = win.setInterval(tick, POLL_INTERVAL_MS);
    }
  }

  function stop(): void {
    if (timer !== undefined) {
      win.clearInterval(timer);
      timer = undefined;
    }
  }

  return {
    register(callback: PollCallback): () => void {
      callbacks.add(callback);
      start();

      return () => {
        callbacks.delete(callback);

        if (callbacks.size === 0) stop();
      };
    },
    stop,
    resume: start,
  };
}

/** The window surface `installSharedPoller` needs; injectable for testing. */
type InstallTarget = TimerHost & {
  irdPoll?: (callback: PollCallback) => () => void;
  addEventListener(type: "pagehide" | "pageshow", listener: () => void): void;
};

declare global {
  interface Window {
    /** Register a callback on the shared PI page poller (issue #903). */
    irdPoll?: (callback: PollCallback) => () => void;
  }
}

/**
 * Expose the shared poller as `window.irdPoll` and tie it to the page lifecycle.
 * Idempotent, so the bundle being evaluated more than once never installs a
 * second interval or duplicate lifecycle listeners.
 */
export function installSharedPoller(win: InstallTarget = window): void {
  if (win.irdPoll) return;

  const poller = createSharedPoller(win);

  win.irdPoll = (callback) => poller.register(callback);
  win.addEventListener("pagehide", () => poller.stop());
  win.addEventListener("pageshow", () => poller.resume());
}
