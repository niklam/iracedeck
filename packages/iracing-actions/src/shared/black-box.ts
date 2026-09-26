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
 * was there; the target press then shows the target.
 *
 * How the two presses leave is decided from the bindings, up front (#962):
 *
 * - **Atomic** — when the target and the prime are both keyboard-bound, both
 *   presses leave as one atomic key sequence (see `tapSequence` /
 *   `sendKeySequence` in deck-core), so the priming box never renders. If that
 *   sequence is refused (a key with no scan-code mapping) the result is a skip,
 *   never two separate taps: keyboard users keep the #818 no-flash guarantee.
 * - **Serialized** — when either is a SimHub Control Mapper role, which goes over
 *   HTTP and cannot join a SendInput batch, the prime and the target are tapped
 *   one after the other. The priming box may flash briefly before the target
 *   opens; that is the accepted trade-off for the box opening at all. The target
 *   is pressed only when the prime tap actually went out — pressing it alone
 *   would toggle the box OFF whenever it was already shown. Before pressing
 *   anything, the serialized path checks that SimHub is reachable and skips when
 *   it is not: a SimHub press would only wait out its HTTP timeout, and a
 *   keyboard prime would toggle a box the SimHub target then never follows.
 *
 * Dispatches are queued: each call runs only after the previous one settled, so
 * two in flight (a double-press, or two keys) can never interleave their presses
 * (prime, prime, target, target) and leave the box hidden.
 *
 * `tapSequence` itself never degrades to separate taps; the serialized path is
 * this module's policy, not deck-core's.
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
  /** Whether the binding at this global-settings key is a keyboard binding. */
  isKeyboardBound: (settingKey: string) => boolean;
  /** Send the resolved keys as one atomic sequence. Returns false when skipped. */
  tapSequence: (settingKeys: string[], holdMs?: number) => Promise<boolean>;
  /** Tap one binding (keyboard or SimHub). Returns true when the press went out. */
  tap: (settingKey: string) => Promise<boolean>;
  /** Whether SimHub is reachable right now (false until its health check has seen it). */
  isSimHubReachable: () => boolean;
  logger: ILogger;
}

/**
 * Pick the box to press before the target.
 *
 * Scans in two tiers (#962), matching the target's own binding kind first:
 *
 * - Keyboard target: keyboard-bound boxes first, so both keys can leave as one
 *   atomic batch; SimHub-bound boxes only when no other box has a key.
 * - SimHub target: SimHub-bound boxes first, then keyboard-bound ones. The path
 *   is serialized either way and SimHub must already be reachable for the
 *   target, so a SimHub prime adds no failure mode — and it is the faster one:
 *   a keyboard tap focuses iRacing and holds the key ~100 ms natively, while a
 *   local SimHub start/stop is a few milliseconds (measured in the sim).
 *
 * Within each tier Lap Timing is preferred, then {@link BLACK_BOX_GLOBAL_KEYS}
 * declaration order, never the target itself.
 *
 * Returns null when no other box is bound. Pressing the target alone would then
 * toggle the box OFF whenever it happened to already be shown — worse than doing
 * nothing, since the driver cannot tell which happened.
 */
export function resolvePrimeKey(
  targetId: BlackBoxId,
  isConfigured: (settingKey: string) => boolean,
  isKeyboardBound: (settingKey: string) => boolean,
): string | null {
  const targetKey = BLACK_BOX_GLOBAL_KEYS[targetId];
  const preferredKey = BLACK_BOX_GLOBAL_KEYS[PRIME_BLACK_BOX];
  const candidates = [preferredKey, ...Object.values(BLACK_BOX_GLOBAL_KEYS)].filter((key) => key !== targetKey);

  const keyboardBound = (key: string) => isKeyboardBound(key);
  const simHubBound = (key: string) => isConfigured(key) && !isKeyboardBound(key);
  const tiers = isKeyboardBound(targetKey) ? [keyboardBound, simHubBound] : [simHubBound, keyboardBound];

  for (const inTier of tiers) {
    const key = candidates.find(inTier);

    if (key) return key;
  }

  return null;
}

/**
 * Tail of the dispatch queue. Every {@link showBlackBox} call chains onto it, and
 * it always settles fulfilled, so a rejected dispatch never wedges the next one.
 */
let dispatchQueue: Promise<void> = Promise.resolve();

/**
 * @internal Exported for testing — drop whatever the queue is waiting on.
 */
export function resetBlackBoxDispatchQueue(): void {
  dispatchQueue = Promise.resolve();
}

/**
 * Show the given black box, whatever is currently on screen.
 *
 * Chooses the atomic or the serialized path from the bindings up front (see the
 * module header), never from `tapSequence` returning false. Runs only after every
 * earlier call has settled, so two dispatches never interleave their presses.
 *
 * @returns true when both presses were dispatched; false when it was skipped
 *   (target unbound, no usable prime, a refused keyboard sequence, SimHub
 *   unreachable on the serialized path, or a serialized tap that did not go out).
 */
export function showBlackBox(targetId: BlackBoxId, deps: ShowBlackBoxDeps): Promise<boolean> {
  const dispatch = dispatchQueue.then(() => dispatchBlackBox(targetId, deps));

  dispatchQueue = dispatch.then(
    () => undefined,
    () => undefined,
  );

  return dispatch;
}

async function dispatchBlackBox(targetId: BlackBoxId, deps: ShowBlackBoxDeps): Promise<boolean> {
  const targetKey = BLACK_BOX_GLOBAL_KEYS[targetId];

  if (!deps.isConfigured(targetKey)) {
    deps.logger.debug(`No binding for ${targetKey}, not showing the ${targetId} black box`);

    return false;
  }

  const primeKey = resolvePrimeKey(targetId, deps.isConfigured, deps.isKeyboardBound);

  if (!primeKey) {
    deps.logger.debug(`No other black-box binding to prime with, not showing the ${targetId} black box`);

    return false;
  }

  if (deps.isKeyboardBound(targetKey) && deps.isKeyboardBound(primeKey)) {
    const sent = await deps.tapSequence([primeKey, targetKey], BLACK_BOX_SEQUENCE_HOLD_MS);

    if (!sent) {
      deps.logger.debug(`Black-box sequence skipped (${primeKey} -> ${targetKey})`);
    }

    return sent;
  }

  // A SimHub role is involved: it cannot join a SendInput batch, so the two are
  // tapped one after the other and the priming box may flash briefly (#962).
  // Check reachability before pressing anything: an offline SimHub would only
  // wait out its HTTP timeout, and a keyboard prime would toggle a box the
  // SimHub target never follows.
  if (!deps.isSimHubReachable()) {
    deps.logger.debug(`SimHub is not reachable, not showing the ${targetId} black box (${primeKey} -> ${targetKey})`);

    return false;
  }

  const primed = await deps.tap(primeKey);

  if (!primed) {
    deps.logger.debug(`Black-box prime ${primeKey} did not go out, not pressing ${targetKey}`);

    return false;
  }

  const sent = await deps.tap(targetKey);

  if (!sent) {
    deps.logger.debug(`Black-box target ${targetKey} did not go out after priming with ${primeKey}`);
  }

  return sent;
}
