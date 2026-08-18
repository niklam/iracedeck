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
 * A settle timer is armed on every entrance to `bootstrapping` (the initial
 * bootstrap read, in `onHostOpen()`) and to `connecting` (every `connect()`
 * call — the first attempt straight out of `bootstrapping`, a late switch
 * from `fallback`, or a reconnect after a post-switch loopback close), and is
 * cleared once that phase resolves (the loopback opens, or the router falls
 * back for any other reason). A loopback transport that never calls
 * `onOpen`/`onClose` — a stalled connect, however it was entered — still
 * resolves within `bootstrapTimeoutMs` instead of leaving sdpi's
 * `getGlobalSettings()` promise, and every `global` control, unresolved
 * forever. That fallback also closes and forgets the stalled loopback (see
 * `fallbackWith`), so a late `onOpen` arriving after the timeout can't hijack
 * whatever connection attempt is current by then.
 *
 * Fallback rule: no channel, a refused/failed/stalled loopback, or a silent
 * host → the PI drops back to the host path with a warning. Never a blank PI —
 * but only half alive: the plugin ignores every host payload once its store is
 * ready, so a global-settings edit made on the fallback path is echoed by the
 * host (the PI shows it as saved) yet never reaches the plugin or its file.
 * A late switch (a host push carrying an untried channel) recovers the page.
 *
 * `lastTried` remembers a channel that was REFUSED (closed before it ever
 * opened) so a host push repeating the same channel doesn't retry a dead end.
 * A clean close AFTER a successful switch-over is not a refusal, so it resets
 * `lastTried` — a later push repeating that channel is free to reconnect. A
 * host push carrying a DIFFERENT channel while an attempt is still connecting
 * (a PI that read the previous run's stale channel just before the new
 * plugin's mirror landed) supersedes that attempt on the spot instead of
 * waiting for it to be refused: the stale socket is closed and the new
 * channel dialled.
 *
 * Every `connect()` is one numbered attempt; the loopback handlers it hands
 * out ignore events once the attempt is no longer current (`attempt` moves
 * on whenever the router closes or replaces a socket), so a late `onClose`
 * from a socket the router already discarded can never run the "refused"
 * fallback against a newer live attempt.
 *
 * On switch-over the frames sdpi queued while the channel was being set up
 * replay to the loopback — but a queued `setGlobalSettings` carries sdpi's
 * WHOLE snapshot, which at that point is the deck host's copy (delivered by
 * the push that triggered a late switch). Replaying it verbatim would write
 * every key on which that copy had drifted from the plugin's store back to
 * the host-era value, and nothing later corrects it. So the replay is
 * REBASED: only the keys that differ from the host snapshot sdpi based the
 * write on are sent (a partial the plugin's fake host merges); a
 * `setGlobalSettings` that changed nothing is dropped.
 *
 * `onHostClose()` closes any open loopback and clears the timer. If the host
 * socket closes before the bootstrap ever completed (`idle`/`bootstrapping` —
 * e.g. a bridge's first connection attempt failing outright), the router
 * returns to `idle` so a retried `onHostOpen()` can bootstrap again instead of
 * being permanently refused; any already-queued sdpi frames stay queued and
 * replay once that retry resolves. A close from any later state
 * (`connecting`, `loopback`, `fallback`) lands in `fallback`, since the page
 * already had a live settings surface that just went away.
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
   * The host socket closed. Closes any open loopback and clears the settle
   * timer. Lands in `idle` if the bootstrap never completed
   * (`idle`/`bootstrapping`) so a retried `onHostOpen()` can bootstrap again;
   * otherwise lands in `fallback` so later frames take the host path instead
   * of being dropped (rather than leaving state pointed at a surface that no
   * longer exists).
   */
  onHostClose(): void;
}

/** How long a PI waits, per phase (the bootstrap read, and separately each loopback connect attempt), before that phase falls back to the host path. */
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
  /** Identity of the current connect attempt; bumped whenever `loop` is closed or replaced. */
  let attempt = 0;

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

  /**
   * Close and forget the tracked loopback socket (if any) and retire its
   * attempt, so whatever that socket still reports later — a stalled
   * connect's eventual close, a late open — is ignored by its handlers.
   */
  const dropLoop = (): void => {
    const stale = loop;

    // Retire the attempt BEFORE closing, so a transport whose close() reports
    // onClose synchronously already finds its handlers inert.
    loop = undefined;
    attempt++;
    stale?.close();
  };

  const hostSnapshotOf = (frame: PiFrame | undefined): Record<string, unknown> | undefined => {
    const settings = (frame?.payload as { settings?: unknown } | undefined)?.settings;

    return settings !== null && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : undefined;
  };

  /**
   * A queued `setGlobalSettings` reduced to the keys that actually differ from
   * the host snapshot sdpi built it from (see the module doc); undefined when
   * nothing differs. Frames without a comparable snapshot pass through whole.
   */
  const rebaseForLoopback = (frame: PiFrame): PiFrame | undefined => {
    if (frame.event !== "setGlobalSettings") return frame;

    const base = hostSnapshotOf(lastHostPayload);
    const payload = frame.payload;

    if (base === undefined || payload === null || typeof payload !== "object" || Array.isArray(payload)) return frame;

    const changed: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if (!(key in base) || JSON.stringify(base[key]) !== JSON.stringify(value)) changed[key] = value;
    }

    if (Object.keys(changed).length === 0) return undefined;

    return { ...frame, payload: changed };
  };

  const fallbackWith = (frame: PiFrame | undefined, why: string): void => {
    clearTimer();
    // Close and forget any loopback still tracked (the connect-timeout path:
    // openLoopback returned a socket that never called onOpen/onClose before
    // the settle timer fired), retiring its attempt so a late onOpen/onClose
    // from it is inert.
    dropLoop();
    state = "fallback";
    deps.warn(why);

    if (frame !== undefined) deps.toPi(frame);

    flushTo(deps.toHost);
  };

  /** Arms the settle timer for the current phase, clearing any existing handle first. */
  const armTimer = (): void => {
    clearTimer();
    timer = deps.setTimeout(() => {
      timer = undefined;

      if (state === "bootstrapping") {
        fallbackWith(undefined, "iRaceDeck: deck host did not answer the settings bootstrap — using the host copy");
      } else if (state === "connecting") {
        fallbackWith(lastHostPayload, "iRaceDeck: settings channel did not open — using the deck host's copy");
      }
    }, timeoutMs);
  };

  const connect = (channel: SettingsChannel): void => {
    state = "connecting";
    lastTried = channel;
    // Every entrance to "connecting" gets its own settle timer — the first
    // attempt straight out of "bootstrapping", a late switch from "fallback",
    // or a reconnect after a post-switch close — none of which onHostOpen()'s
    // own arm covers, so a stalled loopback could otherwise queue forever.
    armTimer();

    // This attempt's identity: the handlers below act only while it is the
    // current one, so a socket the router has since closed or replaced
    // (dropLoop) cannot disturb a newer attempt through the shared state.
    const id = ++attempt;
    const isCurrent = (): boolean => id === attempt;
    let openedEarly = false;

    const switchToLoopback = (): void => {
      clearTimer();
      state = "loopback";
      loop?.send(bootstrapFrame());
      // Replay what sdpi queued while the channel was being set up — with
      // any setGlobalSettings rebased onto the host snapshot it was built
      // from (module doc), so a host-era value never overwrites the store.
      flushTo((frame) => {
        const rebased = rebaseForLoopback(frame);

        if (rebased !== undefined) loop?.send(rebased);
      });
    };

    const handlers: LoopbackHandlers = {
      onOpen: () => {
        if (!isCurrent() || state !== "connecting") return;

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
        if (isCurrent() && state === "loopback") deps.toPi(frame);
      },
      onClose: () => {
        if (!isCurrent()) return;

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

    if (openedEarly && isCurrent() && state === "connecting") switchToLoopback();
  };

  return {
    get state() {
      return state;
    },

    onHostOpen() {
      if (state !== "idle") return;

      state = "bootstrapping";
      deps.toHost(bootstrapFrame());
      armTimer();
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

          // A different channel than the one being dialled means the copy we
          // bootstrapped from was stale (a plugin restart landed its mirror
          // mid-connect): supersede the attempt now rather than after it is
          // refused, or the new channel would only be stashed and the PI left
          // on the host path once the stale attempt fails.
          if (channel && !sameChannel(lastTried, channel)) {
            dropLoop();
            connect(channel);
          }

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
      const was = state;

      clearTimer();
      dropLoop();
      // A close before the bootstrap ever completed (e.g. a bridge's first
      // connection attempt failing outright) returns to "idle" so a retried
      // onHostOpen() can bootstrap again; a close from any later state means
      // the page had a live settings surface that just went away.
      state = was === "idle" || was === "bootstrapping" ? "idle" : "fallback";
    },
  };
}
