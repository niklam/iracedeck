/**
 * The full-course caution, narrated (issue #1127) — eight contracts over the
 * translator's caution events: the caution out and who to follow, the pace
 * car reaching the track, the pickup, each extra lap, one to go, a change to
 * the car ahead, the pace car peeling off, and the green.
 *
 * As everywhere since #1064, the code here decides WHETHER and WHEN the
 * engineer speaks and how the fire is scheduled; WHAT he says lives in the
 * active voice's `callouts.json` under the same ids
 * (`scenarios["pit-crew.caution-follow"]`, …), paired at `setScripts` time.
 *
 * **The lineup is read at speak time, never frozen into a payload.** The
 * `caution.*` vocabulary registered below reads the translator's lineup
 * through an injected resolver on every resolution, so a call that plays
 * seconds after its trigger names the car that is ahead NOW. That is the
 * whole reason the events carry their lineup values only as a fallback: the
 * captures show a call waiting behind the spotter while the field re-forms in
 * under a second.
 *
 * **Session and replay gating lives here, not in the diff** (the #480
 * precedent in `race-engineer-callout-examples.md`): every contract carries
 * the flag family's `liveRaceCar` predicate — a race session, live in the
 * car, not past the checkered — so the events stay publishable and
 * harness-firable while only a driver in a race hears them.
 *
 * Three behaviours below are measured rather than assumed, from the
 * 2026-09-17 Homestead capture the spec is built on:
 *
 * **1. The two pace-car events are deliberately generic**, so the two
 * pace-car contracts gate on the caution. `paceCar.deployed` /
 * `paceCar.off` fire at a rolling start (132.35 / 196.53, both with
 * `SessionState` ParadeLaps) exactly as they do under a caution (264.27 /
 * 488.07, Racing) — the spec made them generic on purpose and left "whether
 * the engineer speaks at a given occurrence" to the callout. The rolling
 * start's pace car belongs to the start, whose own "green's coming" line
 * already owns that moment, so these two ask the translator's caution state
 * through {@link UnderCautionResolver}. Asking the phase rather than
 * re-deriving it from `SessionState` or the caution bits is deliberate: the
 * phase is the value `diffStartLights` reads to tell a restart from a race
 * start, and a second derivation is a second answer waiting to disagree.
 *
 * **2. The lineup change lands one tick BEFORE one to go**, so it holds its
 * decision and then stands down. The field re-forms double file on the tick
 * before the flag — 415.10 vs 415.12, and 793.92 vs 793.93 — so without a
 * hold the "you're behind car number twelve now" line would start playing
 * 20 ms before "One to go. Take the inside line behind the oh nine." and be
 * cut mid-beep by it (same `family`, so preemption is wholesale and
 * weight-independent). `triggerDelay` is the engine's own answer to "the data
 * this scenario needs takes a moment to settle": the fire DECISION waits
 * {@link CAUTION_LINEUP_CHANGE_DELAY_MS}, and by then the one-to-go flag is up
 * in live telemetry and the change is no longer news — the one-to-go call
 * names the car and the lane itself. A genuine mid-caution reorder (someone
 * pitting) has no flag beside it, so it speaks a second and a half late,
 * which is nothing against the minute it has. The hold also coalesces a
 * re-form that shuffles the car ahead over several ticks into one decision,
 * since a fresh event replaces the pending timer.
 *
 * That hold is also why this one contract asks whether the caution is still
 * running. A change emitted in the last breath before the green would
 * otherwise be spoken INTO the restart — which is the exact shape #1127 was
 * filed about ("Yellow cleared." three seconds into a restart).
 *
 * **3. The pace rows are assigned ~50 ms after the caution flag** (239.88 →
 * 239.93), so the follow call cannot read the lineup on the flag's own tick;
 * it holds for {@link CAUTION_FOLLOW_DELAY_MS} first.
 *
 * **The follow call deliberately carries no `family`.** Every other contract
 * here shares `family: "flag"` so a newer caution call supersedes a stale
 * older one. The follow call cannot: it rides the very event that fires the
 * existing `pit-crew.flag-caution-waving` line ("Caution! Caution! Yellow
 * flag is out."), and the two are the two halves of one moment, meant to be
 * heard in order. Same-family preemption replaces an in-flight family-mate
 * wholesale, regardless of weight and regardless of `interrupt`, so sharing
 * the family would have this call cut the caution announcement mid-word —
 * and no `triggerDelay` fixes that, because the delay would have to exceed a
 * clip length that every voice pack chooses for itself. With no family and
 * `queueable: true` it defers behind that line and speaks after it: the
 * overtake family's reaction-then-readout pairing, applied to one moment
 * described by two calls.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { Flags, hasFlag, type TelemetryData } from "@iracedeck/iracing-sdk";
import { type CautionLineup, getLatestTelemetry } from "@iracedeck/sim-events-iracing";

import type { ScenarioContract } from "../../dsl.js";
import { poolRef, WEIGHT } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import { liveRaceCar, WAVING_FLAG_COOLDOWN_MS } from "./flag-alerts.js";

/** Stable identifier for each user-toggleable caution callout (issue #1127). */
export type CautionCalloutId =
  | "follow"
  | "pace-car-out"
  | "field-caught"
  | "extra-lap"
  | "one-to-go"
  | "lineup-changed"
  | "pace-car-off"
  | "restart";

/**
 * Reader the plugins wire to `getCautionLineup()` from
 * `@iracedeck/sim-events-iracing`: the player's place in the caution lineup as
 * of the latest tick, or `null` when there is none to read. Injected rather
 * than imported so this package keeps no runtime dependency on the translator
 * — the shape `registerOpponentFlagVocabulary` takes its live-position reader
 * in.
 */
export type CautionLineupResolver = () => CautionLineup | null;

/**
 * Reader the plugins wire to `isUnderFullCourseCaution()`: the translator's own
 * caution phase, NOT a re-derivation of the caution bits. Read live at event
 * arrival by the contracts whose event can also fire outside a caution.
 */
export type UnderCautionResolver = () => boolean;

/** The clip group every car number is spoken from (issue #1127) — `09` and `9` are different clips. */
const CAR_NUMBER_GROUP = "car-number";

/** The existing spoken-position group the restart position is drawn from. */
const POSITION_NUMBER_GROUP = "position-number";

/**
 * How long the follow call holds before deciding and expanding. The pace rows
 * land ~50 ms after the caution flag in the capture (239.88 → 239.93), so the
 * lineup is unreadable on the flag's own tick; a second is generous against a
 * slower assignment and invisible to a driver who has just seen a yellow.
 */
export const CAUTION_FOLLOW_DELAY_MS = 1000;

/**
 * How long a lineup change holds before deciding. The measured gap between
 * the double-file re-form and the one-to-go flag is one tick (20 ms); a second
 * and a half clears it with room for a slower tick and coalesces a multi-tick
 * re-form into one decision, while staying short against the minute a genuine
 * mid-caution reorder has before the green.
 */
export const CAUTION_LINEUP_CHANGE_DELAY_MS = 1500;

/**
 * The one-to-go flag as live telemetry reports it right now — asked by the
 * held lineup-change decision, which is why it cannot read the event's own
 * (by then stale) telemetry. Missing telemetry reads as "not out" so a
 * missing signal never silences a call (the #574 precedent).
 */
function oneLapToGreenShown(): boolean {
  const telemetry = getLatestTelemetry() as TelemetryData | null;

  if (telemetry === null) return false;

  return hasFlag(telemetry.SessionFlags ?? 0, Flags.OneLapToGreen);
}

/** The fields every contract in the family shares. */
function cautionContract(id: CautionCalloutId): Omit<ScenarioContract, "description" | "when"> {
  return {
    id: `pit-crew.caution-${id}`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: WEIGHT.SAFETY,
    family: "flag",
    // Nothing in a caution sequence is ever dropped for a busy bus. The
    // capture is the reason it is stated rather than inherited: the caution
    // call itself fired 0.8 s after `!yellow` and was DISCARDED because the
    // spotter held the bus, which is the "no audio when the caution is
    // thrown" report #1127 was filed with.
    queueable: true,
  };
}

/**
 * The family, built against the plugin's caution reader. A builder rather
 * than a constant because the two pace-car contracts must ask whether a
 * caution is out at all — see the module header — and this package takes no
 * runtime dependency on the translator.
 */
export function buildCautionContracts(getUnderFullCourseCaution: UnderCautionResolver): readonly ScenarioContract[] {
  /** The shared gate, plus "a caution is actually out" for an event that also fires elsewhere. */
  const underCautionCar = (e: SimEventOf<SimEventName>): boolean => liveRaceCar(e) && getUnderFullCourseCaution();

  return [
    {
      ...cautionContract("follow"),
      family: undefined,
      triggerDelay: CAUTION_FOLLOW_DELAY_MS,
      // The `CautionWaving` bit re-raises on every re-approach of the incident
      // zone, exactly as the yellow one does, so this rides its sibling's
      // cooldown (issue #671).
      cooldown: WAVING_FLAG_COOLDOWN_MS,
      description:
        "iRacing waves the full-course caution at the field in a race while you are live in the car, and a second later the pace rows say who you line up behind.",
      when: { event: "flag.caution-waving.raised", where: liveRaceCar },
    },
    {
      ...cautionContract("pace-car-out"),
      description:
        "The pace car reaches the track during a full-course caution in a race, about twenty seconds after the flag; the pace car leading a rolling start belongs to the start and stays silent here.",
      when: { event: "paceCar.deployed", where: underCautionCar },
    },
    {
      ...cautionContract("field-caught"),
      description:
        "The pace car has picked up the field — the waving caution goes static at the leader's crossing, about ninety seconds in — while you are live in the car in a race.",
      when: { event: "caution.fieldCaught", where: liveRaceCar },
    },
    {
      ...cautionContract("extra-lap"),
      description:
        "The race leader crosses the line under caution and the one-to-go flag does not come with it, so the caution has been extended past the two laps it defaults to.",
      when: { event: "caution.extraLap", where: liveRaceCar },
    },
    {
      ...cautionContract("one-to-go"),
      description:
        "iRacing raises the one-lap-to-green flag under a full-course caution and the field forms up for the restart, single or double file.",
      when: { event: "caution.oneLapToGreen", where: liveRaceCar },
    },
    {
      ...cautionContract("lineup-changed"),
      triggerDelay: CAUTION_LINEUP_CHANGE_DELAY_MS,
      description:
        "The car you line up behind under caution changes — a car pitted, or the field re-formed — and a second and a half later the caution is still running with the one-to-go flag not yet out.",
      when: {
        event: "caution.lineup.changed",
        // Decided after the hold, against live state: the one-to-go call names
        // the car and the lane itself, and a change held over the green must
        // never be spoken into the restart. See the module header.
        where: (e) => underCautionCar(e) && !oneLapToGreenShown(),
      },
    },
    {
      ...cautionContract("pace-car-off"),
      description:
        "The pace car peels off to pit road during a full-course caution, about five seconds before the green.",
      when: { event: "paceCar.off", where: underCautionCar },
    },
    {
      ...cautionContract("restart"),
      // The green lands on the driver's launch — nothing that is still
      // playing may delay it, so this one cuts.
      weight: WEIGHT.CRITICAL,
      interrupt: true,
      description: "The green flag ends a full-course caution and the field is released in a race.",
      when: { event: "caution.restarted", where: liveRaceCar },
    },
  ];
}

/**
 * The family's scenario ids, in the order a caution runs through them. Derived
 * from the contracts themselves so the two can never drift; the resolver they
 * are built with cannot change an id.
 */
export const CAUTION_SCENARIO_IDS: readonly string[] = buildCautionContracts(() => false).map((c) => c.id);

/**
 * Canonical mapping from {@link CautionCalloutId} to its plugin-global setting
 * key in `GlobalSettingsSchema`. Plugin entry points read the live opt-in
 * through it without duplicating the key strings.
 */
export const CAUTION_CALLOUT_SETTING_KEYS: Record<CautionCalloutId, string> = {
  follow: "calloutEnabledCautionFollow",
  "pace-car-out": "calloutEnabledCautionPaceCarOut",
  "field-caught": "calloutEnabledCautionFieldCaught",
  "extra-lap": "calloutEnabledCautionExtraLap",
  "one-to-go": "calloutEnabledCautionOneToGo",
  "lineup-changed": "calloutEnabledCautionLineupChanged",
  "pace-car-off": "calloutEnabledCautionPaceCarOff",
  restart: "calloutEnabledCautionRestart",
};

/** Scenario id → callout id, the map `registerPitCrew`'s opt-in wrapper is given. */
export const SCENARIO_ID_TO_CAUTION_ID: Record<string, CautionCalloutId> = {
  "pit-crew.caution-follow": "follow",
  "pit-crew.caution-pace-car-out": "pace-car-out",
  "pit-crew.caution-field-caught": "field-caught",
  "pit-crew.caution-extra-lap": "extra-lap",
  "pit-crew.caution-one-to-go": "one-to-go",
  "pit-crew.caution-lineup-changed": "lineup-changed",
  "pit-crew.caution-pace-car-off": "pace-car-off",
  "pit-crew.caution-restart": "restart",
};

/**
 * Register the vocabulary the caution scripts name (issue #1127). Must run
 * before the contracts are defined so the first `setScripts` compile sees it;
 * a later registration only marks the compiled scripts dirty.
 *
 * Every entry reads the lineup afresh through `getCautionLineup`, so a call
 * that waited behind a busier bus names the car that is ahead at the moment it
 * is spoken rather than the one that was ahead when it fired.
 */
export function registerCautionVocabulary(
  engine: Pick<IScenarioEngine, "defineVar" | "defineCond" | "defineCase">,
  getCautionLineup: CautionLineupResolver,
): void {
  engine.defineVar(
    "caution.followCarNumber",
    () => {
      const lineup = getCautionLineup();

      // Following the pace car is not a car number. The lineup names the pace
      // car's own number there, and a script that spoke it would say "line up
      // behind car number zero" — so the number is withheld and the answer to
      // "who is ahead" is the `caution.followsPaceCar` condition below. A pack
      // that names the number without asking that first gets a callout that
      // drops rather than a wrong one, which is the safe way round.
      if (lineup === null || lineup.followsPaceCar) return null;

      const number = lineup.followCarNumber;

      return number !== null && number !== "" ? poolRef(CAR_NUMBER_GROUP, number) : null;
    },
    'The car number you line up behind under caution, spoken from the car-number group exactly as the sim spells it — "09" and "9" are different clips. Null while the pace car is the only thing ahead of you, and while the field carries no readable lineup, so branch on caution.followsPaceCar before naming it.',
  );

  engine.defineVar(
    "caution.restartPosition",
    () => {
      const position = getCautionLineup()?.restartPosition ?? null;

      return position !== null && Number.isInteger(position) && position > 0
        ? poolRef(POSITION_NUMBER_GROUP, String(position))
        : null;
    },
    "The position you would restart in, spoken from the position-number group. Read from the pace rows rather than the running order — that is what iRacing lines the field up by — and null whenever the rows carry no absolute position, so a line naming it should survive its absence.",
  );

  engine.defineCond(
    "caution.isLeader",
    () => getCautionLineup()?.isLeader === true,
    "You would restart first. Not the same as having only the pace car ahead of you, which is true of both front cars on a double-file restart — that is caution.followsPaceCar.",
  );

  engine.defineCond(
    "caution.followsPaceCar",
    () => getCautionLineup()?.followsPaceCar === true,
    "There is nobody ahead of you in your own line, so the pace car is the only thing in front. True for the leader and for the outside front car on a double-file restart; the condition to ask before naming a car number.",
  );

  engine.defineCond(
    "caution.isDoubleFile",
    () => getCautionLineup()?.doubleFile === true,
    "The field is lined up in two columns rather than one. iRacing re-forms the field double file on the tick before the one-to-go flag when the restart is a double-file one.",
  );

  engine.defineCase(
    "caution.line",
    () => getCautionLineup()?.line ?? null,
    {
      inside: "You line up in the inside lane.",
      outside: "You line up in the outside lane.",
    },
    "Which lane you line up in. Only ever answered on an oval running double file — on any other discipline, and single file, there is no lane to name and the default branch runs.",
  );
}
