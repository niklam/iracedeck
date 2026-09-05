/**
 * Pit limiter warnings — four scenarios covering the different limiter
 * anomaly states emitted by `@iracedeck/sim-events-iracing`:
 *
 *   - `carControl.limiterToggled`: limiter was engaged while the driver is
 *     on the track (not in pit lane). Suppressed when on pit road because
 *     that's the expected behavior.
 *   - `limiter.missing`: entered pit road without the limiter on.
 *   - `limiter.dropped`: limiter disengaged while still between pit cones.
 *   - `limiter.speeding`: above the pit speed limit.
 *
 * All four use the default weight (`WEIGHT.NORMAL`) — informational callouts
 * that yield to higher-weight in-flight pit-lane messages.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { hasPitLimiter, type TelemetryData } from "@iracedeck/iracing-sdk";
import { getLatestTelemetry } from "@iracedeck/sim-events-iracing";

import type { Scenario } from "../../dsl.js";
import { POOL_REGISTRY } from "./pools.js";

/**
 * Delay before re-checking that the limiter is STILL engaged after leaving pit
 * road, and before re-checking that it is STILL not engaged after arriving
 * (issue #1051). Both are deliberately short: long enough for a driver who is
 * already reaching for the button to beat the callout, short enough that the
 * line still arrives while it is worth acting on.
 */
export const LIMITER_ON_TRACK_DELAY_MS = 1500;
export const LIMITER_MISSING_DELAY_MS = 2500;

/**
 * Live telemetry for the two DELAYED scenarios below.
 *
 * Read live, NOT from `e.telemetry`, and that distinction is the whole point of
 * the delay. `triggerDelay` re-runs `where:` after N ms, but the interpreter
 * calls it with the ORIGINAL event envelope, whose telemetry was captured when
 * the event was published. Testing `e.telemetry` would therefore re-examine a
 * snapshot from before the window we are waiting through — the delay would be
 * decorative, the callout would fire at a driver who has already fixed it, and
 * every test that only checks "does it fire" would still pass.
 *
 * Same reasoning and same source as `flag-alerts.ts`'s `furledBitUp` /
 * `penaltyBitUp` (#846). Do not "simplify" these back to `e.telemetry`.
 */
function liveTelemetry(): TelemetryData | null {
  return getLatestTelemetry() as TelemetryData | null;
}

/**
 * The two delayed conditions, each written ONCE and used twice — as the
 * `where:` fire decision and again as the speak-time `if:` gate. Sharing the
 * definition is deliberate: the flag-alerts precedent (#846) notes that two
 * layers with their own copy of "is this still true" can drift apart, and here
 * a drift would mean announcing a limiter state the driver already fixed.
 */
function limiterStillEngagedOffPitRoad(): boolean {
  const telemetry = liveTelemetry();

  // Suppress on cars without a pit limiter (issue #639).
  if (!hasPitLimiter(telemetry)) return false;

  return telemetry?.dcPitSpeedLimiterToggle === true && telemetry?.OnPitRoad !== true;
}

function limiterStillMissingOnPitRoad(): boolean {
  const telemetry = liveTelemetry();

  // Cars without a pit limiter can't be "missing" one (issue #639).
  if (!hasPitLimiter(telemetry)) return false;

  return telemetry?.dcPitSpeedLimiterToggle !== true && telemetry?.OnPitRoad === true;
}

export const LIMITER_ON_TRACK: Scenario = {
  id: "pit-crew.limiter-on-track",
  when: {
    // Fires a beat AFTER leaving pit road, not on the limiter toggle (#1051).
    // The toggle is a pure bit-change edge, so a limiter left engaged through
    // the pit exit changes nothing and emits nothing — which made the case
    // everyone actually means ("I forgot to switch it off") permanently silent,
    // while the only reachable case was pressing the button out on track, which
    // a driver already knows they did.
    event: "pitLane.exited",
    where: limiterStillEngagedOffPitRoad,
  },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-crew",
  family: "limiter",
  triggerDelay: LIMITER_ON_TRACK_DELAY_MS,
  // `queueable` because at 1.5s after leaving pit road the Voice bus is often
  // still busy with an equal-or-higher-weight line (a flag call, a toggle
  // confirmation, the spotter), and a non-queueable fire arriving then is dropped.
  // Without this the callout would be dropped nearly every time in real
  // driving while passing every test that lets the bus idle first.
  queueable: true,
  // ...and a speak-time gate, because queueing reintroduces staleness: the
  // whole framed sequence sits inside `then`, so a driver who switched the
  // limiter off while this waited expands to SILENCE rather than a radio click
  // with nothing after it. Same shape as FURLED (#669).
  sequence: [
    {
      if: limiterStillEngagedOffPitRoad,
      then: ["pool:pit-limiter-on-track"],
    },
  ],
};

export const LIMITER_MISSING: Scenario = {
  id: "pit-crew.limiter-missing",
  when: {
    event: "limiter.missing",
    // Delayed so this is an ESCALATION rather than a duplicate (#1051). The
    // pit-service readback already says "Remember the pit limiter." on the same
    // transition; that early nudge is kept, and this only speaks if it went
    // unheeded. Re-checked live, so engaging the limiter in the meantime is
    // silence rather than a scolding.
    where: limiterStillMissingOnPitRoad,
  },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-crew",
  family: "limiter",
  triggerDelay: LIMITER_MISSING_DELAY_MS,
  // Same pair as LIMITER_ON_TRACK: queue rather than be dropped behind the
  // pit-entry traffic this deliberately follows, and re-check at speak time so
  // a driver who engaged the limiter while this waited hears nothing.
  queueable: true,
  sequence: [
    {
      if: limiterStillMissingOnPitRoad,
      then: ["pool:pit-limiter-missing"],
    },
  ],
};

export const LIMITER_DROPPED: Scenario = {
  id: "pit-crew.limiter-dropped",
  when: {
    event: "limiter.dropped",
    // Cars without a pit limiter can't drop one (issue #639).
    where: (e) => hasPitLimiter(e.telemetry as TelemetryData | null),
  },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-crew",
  family: "limiter",
  sequence: ["pool:pit-limiter-dropped"],
};

export const LIMITER_SPEEDING: Scenario = {
  id: "pit-crew.limiter-speeding",
  when: {
    event: "limiter.speeding",
    // A pit-limiter speeding warning is meaningless without a limiter (issue #639).
    where: (e) => hasPitLimiter(e.telemetry as TelemetryData | null),
  },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-crew",
  family: "limiter",
  sequence: ["pool:pit-limiter-speeding"],
};

export const PIT_LIMITER_SCENARIOS: readonly Scenario[] = [
  LIMITER_ON_TRACK,
  LIMITER_MISSING,
  LIMITER_DROPPED,
  LIMITER_SPEEDING,
];

export const PIT_LIMITER_SCENARIO_IDS: readonly string[] = PIT_LIMITER_SCENARIOS.map((s) => s.id);

/** Stable identifier for each user-toggleable pit-limiter callout (issue #1051). */
export type PitLimiterCalloutId = "on-track" | "missing" | "dropped" | "speeding";

/**
 * Canonical id -> plugin-global setting key. Plugins read the live opt-in
 * through this rather than duplicating the key strings.
 */
export const PIT_LIMITER_CALLOUT_SETTING_KEYS: Record<PitLimiterCalloutId, string> = {
  "on-track": "calloutEnabledLimiterOnTrack",
  missing: "calloutEnabledLimiterMissing",
  dropped: "calloutEnabledLimiterDropped",
  speeding: "calloutEnabledLimiterSpeeding",
};

/** Scenario id -> callout id, consumed by `wrapCalloutScenario` in `index.ts`. */
export const SCENARIO_ID_TO_PIT_LIMITER_ID: Record<string, PitLimiterCalloutId> = {
  "pit-crew.limiter-on-track": "on-track",
  "pit-crew.limiter-missing": "missing",
  "pit-crew.limiter-dropped": "dropped",
  "pit-crew.limiter-speeding": "speeding",
};

/**
 * Pool names referenced by these scenarios, derived from the single source of
 * truth in `pools.ts` so a rename there flows through without a parallel list.
 */
export const PIT_LIMITER_POOL_NAMES: readonly string[] = Object.keys(POOL_REGISTRY).filter((name) =>
  name.startsWith("pit-limiter-"),
);
