/**
 * Pit-road speed callouts for cars with NO pit limiter (issue #1051; scripted
 * since #1065).
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
 * family, and it constrains any line a pack writes for it later.
 *
 * The code below decides WHETHER each line fires (the equipment gate) and how
 * it is scheduled; WHAT is said lives in the active voice's `callouts.json`
 * under the same ids (`scenarios["pit-crew.no-limiter-speeding"]`, `…-entry`).
 * The bundled script addresses the two lines directly as
 * `pool:pit-limiter/no-limiter-speeding` and `pool:pit-limiter/entry` — the
 * clip GROUP is shared with the limiter family (the split is by remedy, not by
 * clip location), the BASES are this family's own — and reads the spoken
 * pit-speed limit through the three `pitSpeed.*` vars registered by
 * {@link registerNoLimiterVocabulary}.
 *
 * Both contracts sit alongside the always-on tick from #912, which is not
 * limiter-gated and is the layer common to every car. The tick is the reflex
 * signal (instant, any overage); a spoken line is the escalation that says what
 * the beep means.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SessionStartSnapshot } from "@iracedeck/event-bus";
import { hasPitLimiter, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { ScenarioContract } from "../../dsl.js";
import { poolRef } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";

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
 * The `!= null` is LOOSE on purpose: it catches `undefined` as well as `null`.
 * `SimEvent`'s telemetry field is an unconstrained generic and every call site
 * reaches it through a cast, so the type is a claim rather than a guarantee.
 * Under a strict `!== null` an `undefined` snapshot would make this return TRUE
 * and fire family B on unknown data — the exact fail-loud behaviour the
 * paragraph above says it prevents, and on a car that may well have a limiter.
 *
 * Residual, accepted: telemetry present but `dc*` fields not yet populated
 * during early connection reads as "no limiter". Both triggers only fire on pit
 * road, by which point the snapshot is fully populated.
 */
export function lacksPitLimiter(telemetry: TelemetryData | null): boolean {
  return telemetry != null && !hasPitLimiter(telemetry);
}

export const NO_LIMITER_SPEEDING: ScenarioContract = {
  id: "pit-crew.no-limiter-speeding",
  when: {
    event: "limiter.speeding",
    where: (e) => lacksPitLimiter(e.telemetry as TelemetryData | null),
  },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-crew",
  family: "limiter",
};

export const NO_LIMITER_ENTRY: ScenarioContract = {
  id: "pit-crew.no-limiter-entry",
  when: {
    event: "pitLane.entered",
    where: (e) => lacksPitLimiter(e.telemetry as TelemetryData | null),
  },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-crew",
  // The bundled script says "Pit entry. Mind the limit." plus, when the limit
  // is speakable, "The pit speed limit is 60 kilometres per hour." That limit
  // clause is `optional` in the script so a limit with no number clip skips
  // the WHOLE clause rather than speaking "The pit speed limit is" into
  // silence — the session-start pattern from #835/#836, which it reuses
  // clip-for-clip.
  //
  // Saying it again here rather than only in the session brief is the point: at
  // pit entry the number is about to matter, where the brief may have been forty
  // minutes ago.
  family: "limiter",
};

export const NO_LIMITER_CONTRACTS: readonly ScenarioContract[] = [NO_LIMITER_SPEEDING, NO_LIMITER_ENTRY];

export const NO_LIMITER_SCENARIO_IDS: readonly string[] = NO_LIMITER_CONTRACTS.map((c) => c.id);

/** Stable identifier for each user-toggleable no-limiter callout (issue #1051). */
export type NoLimiterCalloutId = "speeding" | "entry";

/**
 * Canonical id -> plugin-global setting key. The ids name the CONDITION, matching
 * `PitLimiterCalloutId` next door -- the audience is already named by the family,
 * so repeating it in the id ("no-limiter": "calloutEnabledNoLimiterSpeeding")
 * only read as a typo.
 */
export const NO_LIMITER_CALLOUT_SETTING_KEYS: Record<NoLimiterCalloutId, string> = {
  speeding: "calloutEnabledNoLimiterSpeeding",
  entry: "calloutEnabledNoLimiterEntry",
};

/** Scenario id -> callout id, consumed by `wrapCalloutScenario` in `index.ts`. */
export const SCENARIO_ID_TO_NO_LIMITER_ID: Record<string, NoLimiterCalloutId> = {
  "pit-crew.no-limiter-speeding": "speeding",
  "pit-crew.no-limiter-entry": "entry",
};

/**
 * The clip sources the no-limiter scripts address DIRECTLY — the two lines.
 * The spoken limit's intro, number and unit are var-driven (`pitSpeed.*`,
 * below) and draw from other groups, so they are not sources of this family.
 * The completeness tests read it: the bundled voice must ship at least one
 * clip for each, and the bundled script must reference exactly this set. A
 * `(group, base)` a script addresses is published — renaming a base is a
 * rename in every pack's script and every pack's clip folder.
 */
export const NO_LIMITER_CLIP_SOURCES: readonly { group: "pit-limiter"; base: string }[] = [
  { group: "pit-limiter", base: "no-limiter-speeding" },
  { group: "pit-limiter", base: "entry" },
];

/**
 * Registers the three vars behind the entry callout's optional limit clause
 * (issue #1051; described for the reference since #1065).
 *
 * The limit is read from the SAME resolver the session-start brief uses, so the
 * two can never disagree about the number, and no new parameter is threaded
 * through `registerPitCrew` for it. That resolver is computed live from current
 * telemetry rather than frozen at session start, so it is correct at pit entry.
 *
 * All three vars gate on the same snapshot check, following the `gap.readout*`
 * precedent, so a partial readout ("The pit speed limit is" with no number) can
 * never play — the script's `optional` wrapper drops the clause as a unit.
 *
 * Known coupling, accepted rather than worked around: the shared resolver
 * returns null for several reasons unrelated to the speed limit — `TrackWetness`
 * out of range, no session info yet, and (in the plugins, which compose it with a
 * driver name) an active voice with no driver-name clips. Do not read this list as
 * exhaustive when debugging a missing clause; read the resolver. The clause then
 * skips and "Pit entry. Mind the limit." still plays as a complete sentence. A
 * dedicated limit resolver would decouple it at the cost of another positional
 * parameter on an already long signature.
 */
export function registerNoLimiterVocabulary(
  engine: Pick<IScenarioEngine, "defineVar">,
  getSessionStartSnapshot: () => SessionStartSnapshot | null,
): void {
  engine.defineVar(
    "pitSpeed.limitIntro",
    () => {
      const s = getSessionStartSnapshot();

      return s ? poolRef("session-start", "pit-speed-intro") : null;
    },
    'The lead-in to the spoken pit-speed limit ("The pit speed limit is"), from the session-start/pit-speed-intro clip. Nothing to say while the session conditions are unknown, so keep it in one optional clause with the number and the unit.',
  );

  engine.defineVar(
    "pitSpeed.limitNumber",
    () => {
      const s = getSessionStartSnapshot();

      // The number group is deliberately sparse — iRacing pit limits are a small
      // known set, so it covers observed values rather than a range. A limit with
      // no clip resolves to an EMPTY pool, which skips the optional clause. Do
      // not clamp to the nearest available number: speaking a wrong limit is
      // worse than speaking none.
      return s ? poolRef("session-start-speed-numbers", String(s.pitSpeedLimit)) : null;
    },
    "The pit-speed limit as a number, from the session-start-speed-numbers/<limit> clip. The group covers the limits iRacing actually uses rather than every number, so a limit the voice has no clip for empties the clause instead of rounding to a wrong one.",
  );

  engine.defineVar(
    "pitSpeed.limitUnit",
    () => {
      const s = getSessionStartSnapshot();

      // The ONLY step not shared with the session-start brief, and deliberately so
      // (issue #1051). Its `speed-unit-*` clips end with a COMMA -- correct there,
      // where the clause is followed by the track temperature, but this callout
      // ends on the unit, so borrowing them closed the line on a rising,
      // unfinished inflection that the radio tick then cut off. The intro and the
      // number stay shared, so the two callouts still cannot disagree about the
      // limit; only the sentence-final intonation is our own.
      return s ? poolRef("pit-limiter", `unit-${s.speedUnit}`) : null;
    },
    "The pit-speed limit's unit, sentence-final, from the pit-limiter/unit-kmh or pit-limiter/unit-mph clip — recorded apart from the session brief's unit clips, which end on a comma because a temperature follows them there.",
  );
}
