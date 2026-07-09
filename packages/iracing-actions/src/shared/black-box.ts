/**
 * Black-box selection shared across actions (issue #818).
 *
 * Two facts drive this module:
 *
 * 1. Telemetry never reports which black box iRacing is currently showing.
 * 2. A black-box hotkey TOGGLES — pressing Fuel while Fuel is shown hides it.
 *
 * Together they mean a single press cannot guarantee the target box ends up
 * visible. Pressing a DIFFERENT box first deterministically replaces whatever
 * was there; the target press then shows the target. Both presses leave as one
 * atomic key sequence (see `tapSequence` / `sendKeySequence` in deck-core), so
 * the priming box never renders.
 */
import type { ILogger } from "@iracedeck/logger";

/** Every iRacing black box, in the order the Black Box Selector lists them. */
export type BlackBoxId =
  | "lap-timing"
  | "standings"
  | "relative"
  | "fuel"
  | "tires"
  | "tire-info"
  | "pit-stop"
  | "in-car"
  | "mirror"
  | "radio"
  | "weather";

/**
 * Mapping from black-box id to its global-settings key.
 *
 * Single source of truth: consumed by the Black Box Selector action (which
 * re-exports it for its tests) and by the #612 comms catalog. `key-bindings.json`
 * remains the data source for labels and default keys, and a cross-check test
 * guards that every key here exists there.
 *
 * Declaration order is also the prime-fallback scan order in {@link resolvePrimeKey}.
 */
export const BLACK_BOX_GLOBAL_KEYS: Record<BlackBoxId, string> = {
  "lap-timing": "blackBoxLapTiming",
  standings: "blackBoxStandings",
  relative: "blackBoxRelative",
  fuel: "blackBoxFuel",
  tires: "blackBoxTires",
  "tire-info": "blackBoxTireInfo",
  "pit-stop": "blackBoxPitStop",
  "in-car": "blackBoxInCar",
  mirror: "blackBoxMirror",
  radio: "blackBoxRadio",
  weather: "blackBoxWeather",
};

/** The box pressed first, to force a deterministic switch to the target. */
export const PRIME_BLACK_BOX: BlackBoxId = "lap-timing";

/**
 * Per-chord hold for the show-black-box sequence, in milliseconds.
 *
 * `0` means the whole sequence goes out in one atomic SendInput batch with no
 * sleep, so the priming box never renders. Raise this — 16-30 ms is one frame at
 * 60 Hz — only if iRacing turns out to sample keyboard state per frame and drop a
 * zero-duration press. This constant is the single tuning point for that.
 */
export const BLACK_BOX_SEQUENCE_HOLD_MS = 0;

/** Collaborators {@link showBlackBox} needs from the calling action. */
export interface ShowBlackBoxDeps {
  /** Whether a binding (keyboard or SimHub) is set at this global-settings key. */
  isConfigured: (settingKey: string) => boolean;
  /** Send the resolved keys as one atomic sequence. Returns false when skipped. */
  tapSequence: (settingKeys: string[], holdMs?: number) => Promise<boolean>;
  logger: ILogger;
}

/**
 * Pick the box to press before the target.
 *
 * Prefers Lap Timing. When the target IS Lap Timing, or Lap Timing has no
 * binding, falls back to the first configured box that isn't the target, in
 * {@link BLACK_BOX_GLOBAL_KEYS} declaration order.
 *
 * Returns null when no other box is bound. Pressing the target alone would then
 * toggle the box OFF whenever it happened to already be shown — worse than doing
 * nothing, since the driver cannot tell which happened.
 */
export function resolvePrimeKey(targetId: BlackBoxId, isConfigured: (settingKey: string) => boolean): string | null {
  const targetKey = BLACK_BOX_GLOBAL_KEYS[targetId];
  const preferredKey = BLACK_BOX_GLOBAL_KEYS[PRIME_BLACK_BOX];

  if (preferredKey !== targetKey && isConfigured(preferredKey)) {
    return preferredKey;
  }

  for (const key of Object.values(BLACK_BOX_GLOBAL_KEYS)) {
    if (key !== targetKey && isConfigured(key)) {
      return key;
    }
  }

  return null;
}

/**
 * Show the given black box, whatever is currently on screen.
 *
 * @returns true when the sequence was dispatched; false when it was skipped
 *   (target unbound, no usable prime, or a binding that cannot be batched).
 */
export async function showBlackBox(targetId: BlackBoxId, deps: ShowBlackBoxDeps): Promise<boolean> {
  const targetKey = BLACK_BOX_GLOBAL_KEYS[targetId];

  if (!deps.isConfigured(targetKey)) {
    deps.logger.debug(`No binding for ${targetKey}, not showing the ${targetId} black box`);

    return false;
  }

  const primeKey = resolvePrimeKey(targetId, deps.isConfigured);

  if (!primeKey) {
    deps.logger.debug(`No other black-box binding to prime with, not showing the ${targetId} black box`);

    return false;
  }

  const sent = await deps.tapSequence([primeKey, targetKey], BLACK_BOX_SEQUENCE_HOLD_MS);

  if (!sent) {
    deps.logger.debug(`Black-box sequence skipped (${primeKey} -> ${targetKey})`);
  }

  return sent;
}
