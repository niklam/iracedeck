/**
 * Dual-press tracker
 *
 * One physical key, two outcomes: a short press fires one outcome and a long
 * press (held ≥ `dualPressThresholdMs` from global settings) fires the other.
 * Used by setup actions in `view-*` sub-modes (issue #540) so a single key can
 * both display the live value and adjust it in either direction.
 *
 * Mechanism is plugin-agnostic — actions instantiate a tracker, call
 * `recordKeyDown(contextId)` in `onKeyDown`, and resolve the outcome in
 * `onKeyUp` via `computeOutcome(contextId, tapOutcome, longPressOutcome)`.
 * The tracker reads the live threshold from global settings on every resolve,
 * so a slider change in the PI takes effect on the next press without
 * re-registering anything.
 */
import { getGlobalSettings } from "./global-settings.js";

/**
 * Fallback threshold used when the global setting is missing or out of range.
 * Mirrors the schema default in `global-settings.ts`.
 */
export const DUAL_PRESS_THRESHOLD_FALLBACK_MS = 500;

/**
 * Resolve the live dual-press threshold from global settings, with a safe
 * fallback when the cache is empty (early startup) or the persisted value
 * isn't a finite number.
 */
export function getDualPressThresholdMs(): number {
  const settings = getGlobalSettings() as Record<string, unknown>;
  const raw = settings.dualPressThresholdMs;

  if (typeof raw === "number" && Number.isFinite(raw)) return raw;

  if (typeof raw === "string" && raw.length > 0) {
    const parsed = Number(raw);

    if (Number.isFinite(parsed)) return parsed;
  }

  return DUAL_PRESS_THRESHOLD_FALLBACK_MS;
}

/** Which direction a tap fires; the long-press fires the opposite. */
export type DualPressDirections = "tap-increases" | "tap-decreases";

/** Fallback used by `getDualPressDirections()` when the setting is missing. */
export const DUAL_PRESS_DIRECTIONS_FALLBACK: DualPressDirections = "tap-increases";

/**
 * Resolve the live dual-press tap direction from global settings. Falls back
 * to `"tap-increases"` when the value is missing or not one of the two known
 * enum values.
 */
export function getDualPressDirections(): DualPressDirections {
  const settings = getGlobalSettings() as Record<string, unknown>;
  const raw = settings.dualPressDirections;

  if (raw === "tap-increases" || raw === "tap-decreases") return raw;

  return DUAL_PRESS_DIRECTIONS_FALLBACK;
}

/**
 * Per-action tap-vs-long-press timing helper. State is keyed by an opaque
 * context id (typically the deck action context id) so a single tracker
 * instance can serve every visible key for an action class.
 */
export class DualPressTracker {
  private readonly keyDownTimestamps = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Stamp the moment a context's key went down. Overwrites any previous stamp. */
  recordKeyDown(contextId: string): void {
    this.keyDownTimestamps.set(contextId, this.now());
  }

  /**
   * Resolve which outcome to fire on key-up. Consumes the recorded key-down
   * timestamp; returns `undefined` when no key-down was ever recorded so a
   * stray key-up (or a second key-up after the first was consumed) is a
   * no-op for the caller. This matters when dual-press is enabled mid-press:
   * the key-down never landed under the new rule, and silently firing the
   * tap outcome on the key-up would surprise the driver.
   */
  computeOutcome<T>(contextId: string, tapOutcome: T, longPressOutcome: T): T | undefined {
    const start = this.keyDownTimestamps.get(contextId);
    this.keyDownTimestamps.delete(contextId);

    if (start === undefined) return undefined;

    const duration = this.now() - start;

    return duration >= getDualPressThresholdMs() ? longPressOutcome : tapOutcome;
  }

  /** Drop any pending key-down for a context (call from `onWillDisappear`). */
  clear(contextId: string): void {
    this.keyDownTimestamps.delete(contextId);
  }

  /** @internal */
  hasPending(contextId: string): boolean {
    return this.keyDownTimestamps.has(contextId);
  }
}
