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
  /** Active flags in priority order; empty when none are out or the sim is disconnected. */
  activeFlags(): readonly OverlayFlag[];
  /** Resolves a user-entered title template; disconnected, variables render empty and parse errors stay verbatim. */
  resolveTitleTemplate(text: string): string;
}

/**
 * Served before a sim is initialised: never connected, no flags, and title
 * text returned verbatim (there is no template engine without a sim).
 * Subscribing to it does nothing, so callers that must not lose a
 * subscription check {@link isSimConnectionInitialized} first.
 */
const NULL_SIM_CONNECTION: SimConnection = Object.freeze({
  isConnected: () => false,
  subscribe: () => undefined,
  unsubscribe: () => undefined,
  activeFlags: () => [],
  resolveTitleTemplate: (text: string) => text,
});

let current: SimConnection | null = null;

export function initializeSimConnection(connection: SimConnection): void {
  if (current) {
    throw new Error("Sim connection already initialized. initializeSimConnection() should only be called once.");
  }

  current = connection;
}

export function getSimConnection(): SimConnection {
  return current ?? NULL_SIM_CONNECTION;
}

export function isSimConnectionInitialized(): boolean {
  return current !== null;
}

/** @internal For tests. */
export function _resetSimConnection(): void {
  current = null;
}
