/**
 * Pit-road speed callouts for cars with NO pit limiter (issue #1051).
 *
 * The sibling family in `pit-limiter.ts` covers cars that HAVE a limiter and is
 * gated on `hasPitLimiter` per #639. This one is its mirror, and the split
 * exists because the two differ by REMEDY rather than merely by wording: a
 * limiter car speeding on pit road is almost always speeding because the
 * limiter is not engaged, and the fix is to press the button; a car without one
 * has to modulate the throttle, and the fix is to lift. No single sentence
 * carries both instructions honestly.
 *
 * So nothing here may mention a limiter — that is the whole point of the
 * family, and it constrains any clip added to it later.
 *
 * Both scenarios sit alongside the always-on tick from #912, which is not
 * limiter-gated and is the layer common to every car. The tick is the reflex
 * signal (instant, any overage); a spoken line is the escalation that says what
 * the beep means.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SessionStartSnapshot } from "@iracedeck/event-bus";
import { hasPitLimiter, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { Scenario } from "../../dsl.js";
import { poolRef } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import { POOL_REGISTRY } from "./pools.js";

/**
 * @internal Exported for testing
 *
 * Whether the car is KNOWN to have no pit limiter.
 *
 * This is deliberately not `!hasPitLimiter(t)`. `hasPitLimiter` is
 * `t?.dcPitSpeedLimiterToggle !== undefined`, so it folds "unknown" into
 * "false" and fails SAFE — the limiter family stays silent when it cannot see
 * the car. A bare negation inverts that into failing LOUD: it returns true for
 * null telemetry, so this family would fire on unknown data, including for cars
 * that do have a limiter — the exact audience the split exists to protect,
 * told to lift by an engineer that cannot see their car.
 *
 * The null test is load-bearing, not defensive. More generally: a negation is
 * not the mirror image of its predicate whenever that predicate folds unknown
 * into false, which is most safe-by-default predicates in this codebase.
 *
 * Residual, accepted: telemetry present but `dc*` fields not yet populated
 * during early connection reads as "no limiter". Both triggers only fire on pit
 * road, by which point the snapshot is fully populated.
 */
export function lacksPitLimiter(telemetry: TelemetryData | null): boolean {
  return telemetry !== null && !hasPitLimiter(telemetry);
}

export const PIT_SPEED_NO_LIMITER: Scenario = {
  id: "pit-crew.pit-speed-no-limiter",
  when: {
    event: "limiter.speeding",
    where: (e) => lacksPitLimiter(e.telemetry as TelemetryData | null),
  },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-crew",
  sequence: ["@pit-crew.radio-open", "pool:pit-speed-no-limiter", "@pit-crew.radio-close"],
};

export const PIT_SPEED_ENTRY: Scenario = {
  id: "pit-crew.pit-speed-entry",
  when: {
    event: "pitLane.entered",
    where: (e) => lacksPitLimiter(e.telemetry as TelemetryData | null),
  },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-crew",
  // "Pit entry. Mind the limit." plus, when the limit is speakable, "The pit
  // speed limit is 60 kilometres per hour." The limit clause is `optional` so a
  // limit with no number clip skips the WHOLE clause rather than speaking "The
  // pit speed limit is" into silence — the session-start pattern from #835/#836,
  // which this reuses clip-for-clip.
  //
  // Saying it again here rather than only in the session brief is the point: at
  // pit entry the number is about to matter, where the brief may have been forty
  // minutes ago.
  sequence: [
    "@pit-crew.radio-open",
    "pool:pit-speed-entry",
    {
      optional: [
        { var: "pitSpeed.limitIntro" },
        { var: "pitSpeed.limitNumber" },
        { var: "pitSpeed.limitUnit" },
      ],
    },
    "@pit-crew.radio-close",
  ],
};

export const PIT_SPEED_SCENARIOS: readonly Scenario[] = [PIT_SPEED_NO_LIMITER, PIT_SPEED_ENTRY];

export const PIT_SPEED_SCENARIO_IDS: readonly string[] = PIT_SPEED_SCENARIOS.map((s) => s.id);

/** Stable identifier for each user-toggleable pit-speed callout (issue #1051). */
export type PitSpeedCalloutId = "no-limiter" | "entry";

/**
 * Canonical id -> plugin-global setting key. The ids name the AUDIENCE rather
 * than the condition, because "the pit-speed callouts for cars without a
 * limiter" is what a user is choosing.
 */
export const PIT_SPEED_CALLOUT_SETTING_KEYS: Record<PitSpeedCalloutId, string> = {
  "no-limiter": "calloutEnabledPitSpeedNoLimiter",
  entry: "calloutEnabledPitSpeedEntry",
};

/** Scenario id -> callout id, consumed by `wrapCalloutScenario` in `index.ts`. */
export const SCENARIO_ID_TO_PIT_SPEED_ID: Record<string, PitSpeedCalloutId> = {
  "pit-crew.pit-speed-no-limiter": "no-limiter",
  "pit-crew.pit-speed-entry": "entry",
};

/**
 * Pool names referenced by these scenarios, derived from `pools.ts` so a rename
 * there flows through without a parallel list to keep in sync.
 */
export const PIT_SPEED_POOL_NAMES: readonly string[] = Object.keys(POOL_REGISTRY).filter((name) =>
  name.startsWith("pit-speed-"),
);

/**
 * Registers the three vars behind the entry callout's optional limit clause.
 *
 * The limit is read from the SAME resolver the session-start brief uses, so the
 * two can never disagree about the number, and no new parameter is threaded
 * through `registerPitCrew` for it. That resolver is computed live from current
 * telemetry rather than frozen at session start, so it is correct at pit entry.
 *
 * All three vars gate on the same snapshot check, following the `gap.readout*`
 * precedent, so a partial readout ("The pit speed limit is" with no number) can
 * never play — and the `optional` wrapper drops the clause as a unit.
 *
 * Known coupling, accepted rather than worked around: the shared resolver
 * returns null when `TrackWetness` is out of range, which is unrelated to the
 * speed limit. The clause then skips and "Pit entry. Mind the limit." still
 * plays as a complete sentence. A dedicated limit resolver would decouple it at
 * the cost of another positional parameter on an already long signature.
 */
export function registerPitSpeedVars(
  engine: IScenarioEngine,
  getSessionStartSnapshot: () => SessionStartSnapshot | null,
): void {
  engine.defineVar("pitSpeed.limitIntro", () => {
    const s = getSessionStartSnapshot();

    return s ? poolRef("session-start", "pit-speed-intro") : null;
  });

  engine.defineVar("pitSpeed.limitNumber", () => {
    const s = getSessionStartSnapshot();

    // The number group is deliberately sparse — iRacing pit limits are a small
    // known set, so it covers observed values rather than a range. A limit with
    // no clip resolves to an EMPTY pool, which skips the optional clause. Do
    // not clamp to the nearest available number: speaking a wrong limit is
    // worse than speaking none.
    return s ? poolRef("session-start-speed-numbers", String(s.pitSpeedLimit)) : null;
  });

  engine.defineVar("pitSpeed.limitUnit", () => {
    const s = getSessionStartSnapshot();

    return s ? poolRef("session-start", `speed-unit-${s.speedUnit}`) : null;
  });
}
