/**
 * The deck layer's whole view of a simulator (#1351): whether it is connected,
 * a per-tick signal, the flags the overlay draws and title-template resolution.
 * Everything sim-specific (telemetry, session info, commands) lives in the
 * sim's own deck package — `@iracedeck/deck-iracing` for iRacing — which
 * initialises this singleton. Spec:
 * docs/superpowers/specs/2026-10-07-issue-1351-deck-core-split-and-sim-seam.md
 */

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
  /** Called once per sim tick, and on connection changes, with the current connection state. */
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
 * Installs the sim connection, then subscribes every subscription queued
 * before it existed onto it, in the order they were made.
 */
export function initializeSimConnection(connection: SimConnection): void {
  if (current) {
    throw new Error("Sim connection already initialized. initializeSimConnection() should only be called once.");
  }

  current = connection;

  const queued = [...pendingSubscriptions];
  pendingSubscriptions.clear();

  // A connection may notify a subscriber as it registers it (iRacing's does),
  // so a throwing callback surfaces here. Replay every queued subscription
  // regardless, keep the one that threw (it is registered; only its first
  // notification failed), and rethrow the first failure afterwards so it is
  // not swallowed.
  const failures: unknown[] = [];

  for (const [id, onTick] of queued) {
    try {
      connection.subscribe(id, onTick);
    } catch (err) {
      failures.push(err);
    }
  }

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

/** @internal For tests: forgets the connection and every queued subscription. */
export function _resetSimConnection(): void {
  current = null;
  pendingSubscriptions.clear();
}
