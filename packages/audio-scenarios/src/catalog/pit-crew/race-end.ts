/**
 * Race-end final-result callout — issue #569; scripted since #1065.
 *
 * Fires once per race session on the `race.finished` event published by the
 * iRacing translator when the driver crosses S/F after the checkered flag
 * has raised. The bundled script greets the driver by name, then branches per
 * final effective position through the `raceEnd.result` case:
 *
 *   won    — "<Name>, we won! We won! Well done. Amazing job. You deserved this win."
 *   second — "<Name>, that's second place. Very well done."
 *   third  — "<Name>, we made it to the podium. We're third. Well done."
 *   other  — "<Name>, the race is over. The final result for us is pee N."
 *
 * The code below decides WHETHER the result is speakable and how it is
 * scheduled; WHAT is said lives in the active voice's `callouts.json` under
 * the same id (`scenarios["pit-crew.race-end"]`), paired at `setScripts`
 * time. The result branch is a `case` rather than three nested `if`s: it is a
 * lookup over a closed set (the #1064 spec's first rule), and a declared key
 * set is what lets a pack collapse the two podium keys onto one line, or add
 * a fourth for a class win, without touching code.
 *
 * Effective position picks class vs overall per the snapshot's `isMultiClass`
 * flag, same rule as the position-change callout (#566) — multi-class drivers
 * care about their class standing, not the overall mixed-field order.
 *
 * Snapshot-at-fire-time (session-start / lap-time pattern): the plugin owns
 * the cache. It subscribes to `race.finished` and composes a snapshot from
 * the event payload + the Property Inspector driver-name pick, then exposes
 * the resolver passed in here. Reading at fire time keeps deferred replays
 * coherent — the race-end contract sits at `weight: WEIGHT.CHATTER` +
 * `queueable: true` so the bus may be busy with a same-tick lap-time-best
 * callout, and the engine defers the race-end fire until the bus is idle.
 * That is why the vocabulary takes the resolver; the contract builder keeps
 * it too, for the `where:` below.
 *
 * `where:` requires a speakable effective position — when the snapshot
 * resolver can't compose a valid payload (e.g. driver name unresolvable,
 * position missing), the contract stays silent rather than producing a
 * partial readout.
 *
 * Family `race-end` so a future per-class or per-result extension can preempt
 * within the family. `weight: WEIGHT.CHATTER` + `queueable: true` rather than a
 * high weight: the race is over by the time it fires, so cutting an in-flight
 * clip to deliver the result would feel jarring; defer-and-replay matches the
 * moment.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import { poolRef, WEIGHT } from "../../dsl.js";
import type { ScenarioContract } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";

/**
 * Plugin-composed snapshot the vocabulary reads at fire time. Combines the
 * `race.finished` event payload (cached by the plugin on event arrival) with
 * the Property Inspector driver-name pick (resolved per-instance from the
 * Pit Crew action's settings). Driver-name lives outside the bus event because
 * it isn't telemetry-derived — same composition pattern as
 * {@link SessionStartSnapshot}.
 */
export type RaceFinishedSnapshot = SimEventOf<"race.finished">["data"] & {
  /** Kebab-case identifier matching a `race-end-greeting/<name>` clip. */
  driverName: string;
};

export type RaceFinishedSnapshotResolver = () => RaceFinishedSnapshot | null;

const RACE_END_GREETING_GROUP = "race-end-greeting";
const RACE_END_GROUP = "race-end";
const POSITION_GROUP_NUMBER = "position-number";

/**
 * Pick the position the result clip should speak. Multi-class series read
 * class-position; single-class (or unknown) read overall. Returns `null` when
 * neither side is populated — the contract then skips the readout.
 *
 * Mirrors `selectEffectivePosition` from position.ts but returns just the
 * current value (race-end has no notion of a "previous"). Kept local so the
 * race-end and race-status families don't share a circular dependency through
 * a position.ts re-export.
 */
export function selectEffectiveFinalPosition(snapshot: RaceFinishedSnapshot): number | null {
  const useClass = snapshot.isMultiClass === true;
  const current = useClass ? snapshot.classPosition : snapshot.position;

  if (typeof current !== "number" || current <= 0) return null;

  return current;
}

/** The keys of the `raceEnd.result` case — the closed set the result branch is a lookup over. */
export type RaceEndResultKey = "won" | "second" | "third" | "other";

/**
 * The declared key set of `raceEnd.result`, each with the description the
 * generated reference (#1066) shows a pack author.
 *
 * @internal Exported for testing — the test enumerates the positions and
 * checks the resolver returns nothing outside this set.
 */
export const RACE_END_RESULT_KEYS: Readonly<Record<RaceEndResultKey, string>> = {
  won: "Finished first — or first in class in a multi-class race.",
  second: "Finished second (in class, in a multi-class race).",
  third: "Finished third (in class, in a multi-class race) — the last podium step.",
  other: "Finished fourth or worse — the bundled script reads the result-is line and the position number.",
};

/**
 * The result key for a snapshot: the effective final position bucketed into
 * the four keys, or `null` when no position is known — the case then takes
 * its `default` branch, and with none the result says nothing. The `where:`
 * already refuses a fire without a position, so `null` is only ever reached
 * by an imperative fire.
 *
 * @internal Exported for testing.
 */
export function resolveRaceEndResult(snapshot: RaceFinishedSnapshot | null): RaceEndResultKey | null {
  if (!snapshot) return null;

  const position = selectEffectiveFinalPosition(snapshot);

  if (position === null) return null;

  if (position === 1) return "won";

  if (position === 2) return "second";

  if (position === 3) return "third";

  return "other";
}

/**
 * Register the vocabulary the race-end script references (issue #1065): the
 * six vars the lines are built from and the `raceEnd.result` case the script
 * branches on. Every resolver reads the race-finished snapshot through
 * `getSnapshot` at expansion time. Names and descriptions are the public API
 * of the format; the descriptions feed the generated reference (#1066).
 */
export function registerRaceEndVocabulary(
  engine: Pick<IScenarioEngine, "defineVar" | "defineCase">,
  getSnapshot: RaceFinishedSnapshotResolver,
): void {
  engine.defineVar(
    "raceEnd.greeting",
    () => {
      const s = getSnapshot();

      if (!s) return null;

      // Fallback to `driver` if the PI pick is empty / unknown — matches the
      // session-start scenario's behavior.
      const name = s.driverName && s.driverName.length > 0 ? s.driverName : "driver";

      return poolRef(RACE_END_GREETING_GROUP, name);
    },
    "The driver's name as a race-end greeting, one clip per name the voice recorded (the generic driver clip when no name is picked). Draws from the race-end-greeting clip group — a name the voice lacks resolves to nothing, so keep it optional.",
  );

  engine.defineVar(
    "raceEnd.weWon",
    () => poolRef(RACE_END_GROUP, "we-won"),
    "The whole winning line — we won, well done. Draws the we-won line from the race-end clip group.",
  );
  engine.defineVar(
    "raceEnd.secondPlace",
    () => poolRef(RACE_END_GROUP, "second-place"),
    "The whole second-place line. Draws the second-place line from the race-end clip group.",
  );
  engine.defineVar(
    "raceEnd.podiumThird",
    () => poolRef(RACE_END_GROUP, "podium-third"),
    "The whole third-place line — we made the podium. Draws the podium-third line from the race-end clip group.",
  );
  engine.defineVar(
    "raceEnd.raceOverResultIs",
    () => poolRef(RACE_END_GROUP, "race-over-result-is"),
    "The lead-in of the fourth-or-worse readout — the race is over, the final result for us is. A fragment of a sentence: the position number must follow it. Draws the race-over-result-is line from the race-end clip group.",
  );

  engine.defineVar(
    "raceEnd.position",
    () => {
      const s = getSnapshot();

      if (!s) return null;

      const position = selectEffectiveFinalPosition(s);

      return position !== null ? poolRef(POSITION_GROUP_NUMBER, String(position)) : null;
    },
    "The final position as a spoken number — the class position in a multi-class race, the overall position otherwise. Draws from the position-number clip group; a position the voice has no clip for aborts the readout.",
  );

  engine.defineCase(
    "raceEnd.result",
    () => resolveRaceEndResult(getSnapshot()),
    RACE_END_RESULT_KEYS,
    "How the race ended for the driver — won, second, third, or fourth or worse — judged on the class position in a multi-class race and the overall position otherwise. Exactly one key applies per finish.",
  );
}

/**
 * Build the race-end contract bound to a snapshot resolver. Stays a builder
 * because the `where:` reads the resolver: a missing snapshot (driver-name
 * unresolvable, position missing) skips the contract entirely. The result
 * branch is the vocabulary's ({@link registerRaceEndVocabulary}).
 */
export function buildRaceEndContract(getSnapshot: RaceFinishedSnapshotResolver): ScenarioContract {
  return {
    id: "pit-crew.race-end",
    when: {
      event: "race.finished",
      where: () => {
        // Tighter than `snapshot !== null` — also require a speakable
        // effective position so we don't open the radio, say the driver's
        // name, then have every per-position branch fall through silent.
        // Without this, an off-range position (e.g. P65 in some hypothetical
        // monster split) or a snapshot that resolves to null position via
        // `selectEffectiveFinalPosition` would produce a greeting-only fire.
        const snapshot = getSnapshot();

        if (!snapshot) return false;

        const position = selectEffectiveFinalPosition(snapshot);

        return position !== null;
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: WEIGHT.CHATTER,
    queueable: true,
    family: "race-end",
    description:
      "You take the checkered flag and cross the line in a race, and your final position (your class position in a multi-class race) is known.",
  };
}

/**
 * Stable identifier for the race-end callout (issue #569). Single subject —
 * the per-position result branch is selected internally.
 */
export type RaceEndCalloutId = "race-end";

/**
 * Canonical mapping from `RaceEndCalloutId` to its plugin-global setting key
 * in `GlobalSettingsSchema`. Plugin entry points use this to read the live
 * opt-in without duplicating the key string.
 */
export const RACE_END_CALLOUT_SETTING_KEYS: Record<RaceEndCalloutId, string> = {
  "race-end": "calloutEnabledRaceEnd",
};

// `as const` for the compile-time completeness check on `SCENARIO_ID_TO_RACE_END_ID`.
export const RACE_END_SCENARIO_IDS = ["pit-crew.race-end"] as const;

export const SCENARIO_ID_TO_RACE_END_ID: Record<(typeof RACE_END_SCENARIO_IDS)[number], RaceEndCalloutId> = {
  "pit-crew.race-end": "race-end",
};

/**
 * The readout is composed entirely from the `raceEnd.*` vars, which draw
 * from the `race-end-greeting`, `race-end` and `position-number` clip groups
 * by value — so there is no fixed `(group, base)` list to publish: the
 * bundled script addresses no pool directly. Exported empty for parity with
 * the family-completeness checks the other pit-crew catalog files feed; the
 * var descriptions name the groups.
 */
export const RACE_END_CLIP_SOURCES: readonly { group: string; base: string }[] = [];
