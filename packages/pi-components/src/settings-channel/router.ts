/**
 * Settings-channel router (issue #993, phase 2).
 *
 * Decides, per Property Inspector page, where the global-settings frames go.
 * A PI is a host-hosted page whose only universal input is the deck host's own
 * global-settings store; the plugin mirrors its settings there once per start
 * together with `_settingsChannel = { port, token }` of its loopback settings
 * server. The router reads that ONCE (the "bootstrap" read), opens the
 * loopback socket, and from then on sends `getGlobalSettings`/
 * `setGlobalSettings` to the plugin and delivers the plugin's
 * `didReceiveGlobalSettings` pushes to sdpi — the plugin-owned settings file is
 * the truth, so host pushes are dropped after the switch. Everything else a PI
 * sends or receives passes through untouched.
 *
 * One settle timer bridges both the `bootstrapping` and `connecting` states:
 * it is armed on the bootstrap read and only cleared once the loopback
 * actually opens (or the router falls back for any other reason). A loopback
 * transport that never calls `onOpen`/`onClose` — a stalled connect — still
 * resolves within `bootstrapTimeoutMs` instead of leaving sdpi's
 * `getGlobalSettings()` promise, and every `global` control, unresolved
 * forever.
 *
 * Fallback rule: no channel, a refused/failed/stalled loopback, or a silent
 * host → the PI keeps working against the host path exactly as before, with a
 * warning. Never a blank PI.
 *
 * `lastTried` remembers a channel that was REFUSED (closed before it ever
 * opened) so a host push repeating the same channel doesn't retry a dead end.
 * A clean close AFTER a successful switch-over is not a refusal, so it resets
 * `lastTried` — a later push repeating that channel is free to reconnect.
 *
 * Pure: no DOM, no sockets — both bridges (Elgato/Mirabox `pi-settings-bridge`
 * and the Ulanzi PI bridge) supply the transports.
 */

export interface SettingsChannel {
  port: number;
  token: string;
}

export type PiFrame = Record<string, unknown> & { event?: unknown; payload?: unknown };

export interface LoopbackSocket {
  send(frame: PiFrame): void;
  close(): void;
}

export interface LoopbackHandlers {
  onOpen(): void;
  onMessage(frame: PiFrame): void;
  onClose(): void;
}

export interface SettingsChannelRouterDeps {
  /** sdpi's envelope identity for the router's own reads (`context` = PI uuid, `action` = action UUID). */
  identity: { context: string; action: string };
  /** Send an Elgato-shape frame to the deck host (the Ulanzi bridge translates inside). */
  toHost(frame: PiFrame): void;
  /** Deliver an Elgato-shape frame to sdpi. */
  toPi(frame: PiFrame): void;
  /**
   * Open the loopback socket. Must invoke `onClose` on connect failure, error,
   * or close (exactly once); must NOT invoke handlers synchronously from
   * inside `openLoopback` — a throw counts as an immediate close. (The router
   * defensively tolerates a synchronous `onOpen` call anyway; see `connect()`.)
   */
  openLoopback(channel: SettingsChannel, handlers: LoopbackHandlers): LoopbackSocket;
  warn(message: string): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Test hook; production uses BOOTSTRAP_TIMEOUT_MS. */
  bootstrapTimeoutMs?: number;
}

export type RouterState = "idle" | "bootstrapping" | "connecting" | "loopback" | "fallback";

export interface SettingsChannelRouter {
  readonly state: RouterState;
  /** The host socket opened (call AFTER sdpi's onopen ran, i.e. after the register frame went out). */
  onHostOpen(): void;
  /** Every frame sdpi sends. */
  onPiSend(frame: PiFrame): void;
  /** Every Elgato-shape frame the host delivered. */
  onHostMessage(frame: PiFrame): void;
  /**
   * The host socket closed. Closes any open loopback and lands the router in
   * `fallback` so later frames take the host path instead of being dropped
   * (rather than leaving state pointed at a surface that no longer exists).
   */
  onHostClose(): void;
}

/** How long a PI waits — across both the bootstrap read and the loopback connect — before falling back to the host path. */
export const BOOTSTRAP_TIMEOUT_MS = 3000;

const GLOBAL_EVENTS = new Set(["getGlobalSettings", "setGlobalSettings"]);
const TOKEN_RE = /^[0-9a-f]{32,}$/i; // tolerance: the producer always emits lowercase hex

function isValidPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535;
}

export function parseSettingsChannel(settings: unknown): SettingsChannel | undefined {
  if (settings === null || typeof settings !== "object") return undefined;

  const raw = (settings as Record<string, unknown>)._settingsChannel;

  if (raw === null || typeof raw !== "object") return undefined;

  const { port, token } = raw as Record<string, unknown>;

  if (!isValidPort(port)) return undefined;

  if (typeof token !== "string" || !TOKEN_RE.test(token)) return undefined;

  return { port, token };
}

function sameChannel(a: SettingsChannel | undefined, b: SettingsChannel): boolean {
  return a !== undefined && a.port === b.port && a.token === b.token;
}

export function createSettingsChannelRouter(deps: SettingsChannelRouterDeps): SettingsChannelRouter {
  const timeoutMs = deps.bootstrapTimeoutMs ?? BOOTSTRAP_TIMEOUT_MS;
  const bootstrapFrame = (): PiFrame => ({
    event: "getGlobalSettings",
    context: deps.identity.context,
    action: deps.identity.action,
  });

  let state: RouterState = "idle";
  let queue: PiFrame[] = [];
  let timer: unknown;
  let loop: LoopbackSocket | undefined;
  let lastHostPayload: PiFrame | undefined;
  let lastTried: SettingsChannel | undefined;

  const clearTimer = (): void => {
    if (timer !== undefined) {
      deps.clearTimeout(timer);
      timer = undefined;
    }
  };

  const flushTo = (send: (frame: PiFrame) => void): void => {
    const pending = queue;

    queue = [];

    for (const frame of pending) send(frame);
  };

  const fallbackWith = (frame: PiFrame | undefined, why: string): void => {
    clearTimer();
    state = "fallback";
    deps.warn(why);

    if (frame !== undefined) deps.toPi(frame);

    flushTo(deps.toHost);
  };

  const connect = (channel: SettingsChannel): void => {
    state = "connecting";
    lastTried = channel;

    let openedEarly = false;

    const switchToLoopback = (): void => {
      clearTimer();
      state = "loopback";
      loop?.send(bootstrapFrame());
      // A setGlobalSettings sdpi issues during the connecting window still carries
      // the deck host's settings snapshot (sdpi always saves its whole settings
      // object), so replaying it here can briefly let a stale host value win for a
      // differing key until sdpi's next debounced save (~250ms). Narrow,
      // self-correcting race — accepted.
      flushTo((frame) => loop?.send(frame));
    };

    const handlers: LoopbackHandlers = {
      onOpen: () => {
        if (state !== "connecting") return;

        if (!loop) {
          // Defensive only: openLoopback's contract forbids invoking handlers
          // synchronously, but if a transport does it anyway (before the `loop`
          // assignment below completes), finish the switch once openLoopback
          // returns instead of silently dropping the read and the queue.
          openedEarly = true;

          return;
        }

        switchToLoopback();
      },
      onMessage: (frame) => {
        if (state === "loopback") deps.toPi(frame);
      },
      onClose: () => {
        const was = state;

        loop = undefined;

        if (was === "connecting") {
          fallbackWith(lastHostPayload, "iRaceDeck: settings channel refused — using the deck host's copy");
        } else if (was === "loopback") {
          lastTried = undefined; // a clean close is not a refusal — allow a later push to reconnect
          state = "fallback";
          deps.warn("iRaceDeck: settings channel closed — falling back to the deck host's copy");
        }
      },
    };

    try {
      loop = deps.openLoopback(channel, handlers);
    } catch {
      loop = undefined;
      handlers.onClose();

      return;
    }

    if (openedEarly && state === "connecting") switchToLoopback();
  };

  return {
    get state() {
      return state;
    },

    onHostOpen() {
      if (state !== "idle") return;

      state = "bootstrapping";
      deps.toHost(bootstrapFrame());
      timer = deps.setTimeout(() => {
        timer = undefined;

        if (state === "bootstrapping") {
          fallbackWith(undefined, "iRaceDeck: deck host did not answer the settings bootstrap — using the host copy");
        } else if (state === "connecting") {
          fallbackWith(lastHostPayload, "iRaceDeck: settings channel did not open — using the deck host's copy");
        }
      }, timeoutMs);
    },

    onPiSend(frame) {
      if (!GLOBAL_EVENTS.has(String(frame.event))) {
        deps.toHost(frame);

        return;
      }

      switch (state) {
        case "bootstrapping":
        case "connecting":
          queue.push(frame);
          break;
        case "loopback":
          loop?.send(frame);
          break;
        default:
          deps.toHost(frame);
      }
    },

    onHostMessage(frame) {
      if (frame.event !== "didReceiveGlobalSettings") {
        deps.toPi(frame);

        return;
      }

      const settings = (frame.payload as { settings?: unknown } | undefined)?.settings;
      const channel = parseSettingsChannel(settings);

      switch (state) {
        case "bootstrapping":
          lastHostPayload = frame;

          if (channel) connect(channel);
          else fallbackWith(frame, "iRaceDeck: no _settingsChannel in the deck host's settings — using the host copy");

          break;
        case "connecting":
          lastHostPayload = frame;
          break;
        case "loopback":
          break; // the store is truth; the host copy is not
        default: {
          deps.toPi(frame);

          if (channel && !sameChannel(lastTried, channel)) {
            lastHostPayload = frame;
            connect(channel);
          }
        }
      }
    },

    onHostClose() {
      clearTimer();
      loop?.close();
      loop = undefined;
      state = "fallback";
    },
  };
}
