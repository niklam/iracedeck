/**
 * The deck layer's whole view of a simulator (#1351): whether it is connected,
 * a per-tick signal, the flags the overlay draws and title-template resolution.
 * Everything sim-specific (telemetry, session info, commands) lives in the
 * sim's own deck package — `@iracedeck/deck-iracing` for iRacing — which
 * initialises this singleton. Spec:
 * docs/superpowers/specs/2026-10-07-issue-1351-deck-core-split-and-sim-seam.md
 *
 * It also derives one debounced sim-presence signal from the connection's
 * ticks (#1599): {@link isSimAbsent} / {@link onSimPresenceChange}, which the
 * disconnected key look reads. It is seeded from `isConnected()` when it
 * subscribes and then follows the connection-change calls, so a connection
 * need not call a new subscriber back for it. Spec:
 * docs/superpowers/specs/2026-11-02-issue-1599-disconnected-key-look.md
 */
import { createErrorBoundary, type ErrorBoundary, type ILogger, silentLogger } from "@iracedeck/logger";

/** One active flag as the key overlay draws it. */
export interface OverlayFlag {
  label: string;
  color: string;
  textColor: string;
  /** Whether the overlay pulses continuously (black, meatball). */
  pulse: boolean;
}

export interface SimConnection {
  isConnected(): boolean;
  /**
   * Called once per sim tick, and on connection changes, with the current
   * connection state. A connection may also call `onTick` as it registers it,
   * but nothing in the deck layer relies on that: the presence signal
   * ({@link isSimAbsent}) seeds itself from `isConnected()` when it
   * subscribes, so it needs only `isConnected()` and a call on every
   * connection change — not a callback at registration, nor ticks while the
   * sim is closed.
   *
   * The contract every `deck-<sim>` connection must honour (#1558): a throw
   * from `onTick` never reaches the caller — not from `subscribe`, nor from
   * any other method whose call runs subscribers — and never stops another
   * subscriber from being called. The connection isolates it, reports it, and
   * keeps the failing subscriber subscribed. iRacing's connection gets this
   * from its SDK controller's error boundary.
   */
  subscribe(id: string, onTick: (isConnected: boolean) => void): void;
  unsubscribe(id: string): void;
  /**
   * Active flags in priority order, as of the latest tick; empty when none are
   * out, the sim is disconnected, or no tick has been seen yet.
   */
  activeFlags(): readonly OverlayFlag[];
  /** Resolves a user-entered title template; a disconnected sim renders variables empty and leaves parse errors verbatim. */
  resolveTitleTemplate(text: string): string;
}

let current: SimConnection | null = null;

/** Subscriptions made before a sim connection exists, replayed onto it at initialisation (insertion order). */
const pendingSubscriptions = new Map<string, (isConnected: boolean) => void>();

/**
 * Served before a sim is initialised: never connected, no flags, and — with no
 * sim connection yet, and so no template engine — title text returned as the
 * user typed it. A subscription made on it is queued, not lost:
 * {@link initializeSimConnection} replays every queued one onto the real
 * connection. Once a connection is set, every method delegates to it, so a
 * reference obtained before initialisation and kept keeps working.
 */
const PENDING_SIM_CONNECTION: SimConnection = Object.freeze({
  isConnected: () => current?.isConnected() ?? false,
  subscribe: (id: string, onTick: (isConnected: boolean) => void) => {
    if (current) {
      current.subscribe(id, onTick);
    } else {
      pendingSubscriptions.set(id, onTick);
    }
  },
  unsubscribe: (id: string) => {
    if (current) {
      current.unsubscribe(id);
    } else {
      pendingSubscriptions.delete(id);
    }
  },
  activeFlags: () => current?.activeFlags() ?? [],
  resolveTitleTemplate: (text: string) => (current ? current.resolveTitleTemplate(text) : text),
});

/**
 * How long a disconnection must last before the sim counts as absent, when the
 * sim's deck package passes no delay of its own: 5 s. The delay is the sim's
 * to choose (iRacing passes its app monitor's exit confirm, also 5 s); this
 * default only keeps a connection that names none conservative — well above a
 * reconnect poll of a couple of seconds, so a short drop never reads as gone.
 */
export const DEFAULT_SIM_ABSENT_DELAY_MS = 5000;

/** What {@link initializeSimConnection} takes beside the connection. */
export interface SimConnectionOptions {
  /**
   * How long, in milliseconds, the connection must stay disconnected before
   * {@link isSimAbsent} turns true. A finite number, 0 or more. Defaults to
   * {@link DEFAULT_SIM_ABSENT_DELAY_MS}.
   */
  absentDelayMs?: number;
  /** Where the presence signal logs its changes and any listener's throw. Defaults to a silent logger. */
  logger?: ILogger;
}

/**
 * Installs the sim connection, then subscribes every subscription queued
 * before it existed onto it, in the order they were made.
 *
 * @throws Error on a second call; RangeError when `absentDelayMs` is negative
 *   or not finite (checked before anything is installed)
 */
export function initializeSimConnection(connection: SimConnection, options: SimConnectionOptions = {}): void {
  if (current) {
    throw new Error("Sim connection already initialized. initializeSimConnection() should only be called once.");
  }

  const { absentDelayMs = DEFAULT_SIM_ABSENT_DELAY_MS, logger = silentLogger } = options;

  if (!Number.isFinite(absentDelayMs) || absentDelayMs < 0) {
    throw new RangeError(`initializeSimConnection: absentDelayMs must be a finite number >= 0, got ${absentDelayMs}`);
  }

  presenceAbsentDelayMs = absentDelayMs;
  presenceLogger = logger;
  current = connection;

  const queued = [...pendingSubscriptions];
  pendingSubscriptions.clear();

  // A connection may notify a subscriber as it registers it (iRacing's does),
  // and under the `subscribe` contract a throwing callback never surfaces
  // here. This aggregation is a defence against a connection that breaks the
  // contract: replay every queued subscription regardless, keep the one whose
  // `subscribe` threw (it is registered; only its first notification failed),
  // and rethrow the first failure afterwards so the broken contract is not
  // swallowed.
  const failures: unknown[] = [];

  for (const [id, onTick] of queued) {
    try {
      connection.subscribe(id, onTick);
    } catch (err) {
      failures.push(err);
    }
  }

  // The presence signal's subscription, when a listener queued it, is on the
  // connection now: seed it, whether or not that subscribe threw (it is
  // registered either way).
  if (queued.some(([id]) => id === PRESENCE_SUBSCRIPTION_ID)) seedPresence(connection);

  if (failures.length > 0) {
    throw new Error(
      `${failures.length} of ${queued.length} queued sim subscription(s) threw while being replayed; every one was still subscribed`,
      { cause: failures[0] },
    );
  }
}

export function getSimConnection(): SimConnection {
  return current ?? PENDING_SIM_CONNECTION;
}

export function isSimConnectionInitialized(): boolean {
  return current !== null;
}

// ---------------------------------------------------------------------------
// Sim presence (#1599)
// ---------------------------------------------------------------------------

/** The id of the presence signal's own subscription on the connection. */
const PRESENCE_SUBSCRIPTION_ID = "__sim_presence__";

/** Listener ids, for the error boundary's reports. */
const PRESENCE_LISTENER_PREFIX = "simPresence:";

let presenceAbsentDelayMs = DEFAULT_SIM_ABSENT_DELAY_MS;
let presenceLogger: ILogger = silentLogger;
let presenceBoundary: ErrorBoundary | null = null;
let presenceSubscribed = false;
let presenceAbsent = false;
let presenceTimer: ReturnType<typeof setTimeout> | null = null;
let presenceListenerCounter = 0;
const presenceListeners = new Map<string, (absent: boolean) => void>();

/**
 * Whether the sim has been disconnected for at least the sim's absent delay
 * (iRacing: 5 s). False at start, so a plugin started with the sim already
 * running never reads it as absent, and false again on the first connected
 * tick. Meaningful once something has called {@link onSimPresenceChange},
 * which is what starts the signal; until then it is always false.
 */
export function isSimAbsent(): boolean {
  return presenceAbsent;
}

/**
 * Calls `listener` with the new value of {@link isSimAbsent} whenever it
 * changes — never for a disconnection shorter than the absent delay, and never
 * twice with the same value. Returns the function that removes it.
 *
 * The first call subscribes the signal to the sim connection, queued like any
 * subscription when no connection is installed yet, and that subscription is
 * kept for the plugin's lifetime: the value survives every listener leaving
 * (a page switch with the sim closed) and is current for the next to arrive.
 *
 * A listener's throw is reported through an error boundary and stops neither
 * the other listeners nor the tick that caused the change.
 */
export function onSimPresenceChange(listener: (absent: boolean) => void): () => void {
  const id = `${PRESENCE_LISTENER_PREFIX}${++presenceListenerCounter}`;

  presenceListeners.set(id, listener);
  ensurePresenceSubscription();

  return () => {
    if (presenceListeners.delete(id)) presenceBoundary?.forget(id);
  };
}

function ensurePresenceSubscription(): void {
  if (presenceSubscribed) return;

  presenceSubscribed = true;
  getSimConnection().subscribe(PRESENCE_SUBSCRIPTION_ID, onPresenceTick);

  // Before initialisation the subscription is only queued; the seed then
  // happens in initializeSimConnection, once it is replayed.
  if (current) seedPresence(current);
}

/**
 * Feeds the connection's current state to the signal as one tick, once its
 * subscription is on a real connection. `subscribe` only says a connection
 * *may* call a new subscriber back at once (iRacing's does), so without this a
 * plugin started with the sim already closed would never arm the absence timer
 * on a connection that waits for its next tick, which a closed sim never
 * sends. Idempotent with a connection that does call back: a second
 * disconnected tick finds the timer armed, and a connected one finds the
 * signal present. A throw from `isConnected()` is logged and leaves the signal
 * to the next tick rather than breaking the caller.
 */
function seedPresence(connection: SimConnection): void {
  let isConnected: boolean;

  try {
    isConnected = connection.isConnected();
  } catch (err) {
    presenceLogger.warn(
      `Sim presence not seeded: isConnected() threw: ${err instanceof Error ? err.message : String(err)}`,
    );

    return;
  }

  onPresenceTick(isConnected);
}

/**
 * One sim tick, or the seed from `isConnected()` when the signal subscribes. A
 * connected tick clears a pending absence and turns the signal present at
 * once; a disconnected tick arms one absence timer, unless one is armed
 * already or the signal is already absent. The seed is what arms the timer at
 * start when the sim is closed, so a connection need not call a new
 * subscriber back, nor tick while the sim is closed.
 */
function onPresenceTick(isConnected: boolean): void {
  if (isConnected) {
    clearPresenceTimer();

    if (presenceAbsent) setPresence(false);

    return;
  }

  if (presenceAbsent || presenceTimer !== null) return;

  presenceTimer = setTimeout(() => {
    presenceTimer = null;
    setPresence(true);
  }, presenceAbsentDelayMs);
}

function clearPresenceTimer(): void {
  if (presenceTimer === null) return;

  clearTimeout(presenceTimer);
  presenceTimer = null;
}

function setPresence(absent: boolean): void {
  if (presenceAbsent === absent) return;

  presenceAbsent = absent;
  presenceLogger.info(`Sim ${absent ? "absent" : "present"}`);

  // A snapshot, so a listener that adds or removes one does not change this dispatch.
  const snapshot = [...presenceListeners];

  getPresenceBoundary().callEach(snapshot, (listener) => listener(absent));
}

function getPresenceBoundary(): ErrorBoundary {
  presenceBoundary ??= createErrorBoundary({
    logger: presenceLogger,
    isRegistered: (id) => presenceListeners.has(id),
  });

  return presenceBoundary;
}

/**
 * @internal For tests: forgets the connection, every queued subscription, and
 * the presence signal (its timer, listeners, subscription, delay and value).
 */
export function _resetSimConnection(): void {
  current = null;
  pendingSubscriptions.clear();
  clearPresenceTimer();
  presenceListeners.clear();
  presenceSubscribed = false;
  presenceAbsent = false;
  presenceAbsentDelayMs = DEFAULT_SIM_ABSENT_DELAY_MS;
  presenceLogger = silentLogger;
  presenceBoundary = null;
}
