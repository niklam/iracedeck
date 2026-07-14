/**
 * Race-end final-result callout — issue #569.
 *
 * Fires once per race session on the `race.finished` event published by the
 * iRacing translator when the driver crosses S/F after the checkered flag
 * has raised. The script greets the driver by name, then branches per final
 * effective position:
 *
 *   P1 — "<Name>, we won! We won! Well done. Amazing job. You deserved this win."
 *   P2 — "<Name>, that's second place. Very well done."
 *   P3 — "<Name>, we made it to the podium. We're third. Well done."
 *   P4+ — "<Name>, the race is over. The final result for us is pee N."
 *
 * Effective position picks class vs overall per the snapshot's `isMultiClass`
 * flag, same rule as the position-change callout (#566) — multi-class drivers
 * care about their class standing, not the overall mixed-field order.
 *
 * Snapshot-at-fire-time (session-start / lap-time pattern): the plugin owns
 * the cache. It subscribes to `race.finished` and composes a snapshot from
 * the event payload + the Property Inspector driver-name pick, then exposes
 * the resolver passed in here. Reading at fire time keeps deferred replays
 * coherent — the race-end scenario sits at `weight: WEIGHT.CHATTER` +
 * `queueable: true` so the bus may be busy with a same-tick lap-time-best
 * callout, and the engine defers the race-end fire until the bus is idle.
 *
 * `where:` is `getSnapshot() !== null` — when the snapshot resolver can't
 * compose a valid payload (e.g. driver name unresolvable, position missing),
 * the scenario stays silent rather than producing a partial readout.
 *
 * Family `race-end` so a future per-class or per-result extension can preempt
 * within the family. `weight: WEIGHT.CHATTER` + `queueable: true` rather than a
 * high weight: the race is over by the time it fires, so cutting an in-flight
 * clip to deliver the result would feel jarring; defer-and-replay matches the
 * moment.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import { WEIGHT } from "../../dsl.js";
import type { Scenario, Step } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import { POSITION_NUMBER_MAX, POSITION_NUMBER_MIN, positionNumberIsSpeakable } from "./position.js";

export { POSITION_NUMBER_MAX, POSITION_NUMBER_MIN };

/**
 * Plugin-composed snapshot the scenario reads at fire time. Combines the
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

/** Build a full `voice/{voice}/...` path for a `var` resolver. */
function voicePath(group: string, name: string): string {
  return `voice/{voice}/${group}/${name}.mp3`;
}

/**
 * Pick the position the result clip should speak. Multi-class series read
 * class-position; single-class (or unknown) read overall. Returns `null` when
 * neither side is populated — the scenario then skips the readout.
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

/**
 * Register the race-end scenario's variables on the scenario engine. Must run
 * before {@link buildRaceEndScenario} is registered — load-time validation
 * rejects `{ var }` steps whose names aren't registered.
 */
export function registerRaceEndVars(engine: IScenarioEngine, getSnapshot: RaceFinishedSnapshotResolver): void {
  engine.defineVar("raceEnd.greeting", () => {
    const s = getSnapshot();

    if (!s) return null;

    // Fallback to `driver` if the PI pick is empty / unknown — matches the
    // session-start scenario's behavior.
    const name = s.driverName && s.driverName.length > 0 ? s.driverName : "driver";

    return voicePath(RACE_END_GREETING_GROUP, name);
  });

  engine.defineVar("raceEnd.weWon", () => voicePath(RACE_END_GROUP, "we-won-01"));
  engine.defineVar("raceEnd.secondPlace", () => voicePath(RACE_END_GROUP, "second-place-01"));
  engine.defineVar("raceEnd.podiumThird", () => voicePath(RACE_END_GROUP, "podium-third-01"));
  engine.defineVar("raceEnd.raceOverResultIs", () => voicePath(RACE_END_GROUP, "race-over-result-is-01"));

  engine.defineVar("raceEnd.position", () => {
    const s = getSnapshot();

    if (!s) return null;

    const position = selectEffectiveFinalPosition(s);

    if (position === null || !positionNumberIsSpeakable(position)) return null;

    return voicePath(POSITION_GROUP_NUMBER, String(position));
  });
}

/**
 * Build the race-end scenario bound to a snapshot resolver. Conditional
 * branches pick the result clip at expansion time based on the snapshot's
 * effective position; the resolver also gates `where:` so a missing snapshot
 * (driver-name unresolvable, position missing) skips the scenario entirely.
 */
export function buildRaceEndScenario(getSnapshot: RaceFinishedSnapshotResolver): Scenario {
  const isPosition =
    (target: number): (() => boolean) =>
    () => {
      const s = getSnapshot();

      if (!s) return false;

      return selectEffectiveFinalPosition(s) === target;
    };

  const isFourthOrWorse = (): boolean => {
    const s = getSnapshot();

    if (!s) return false;

    const position = selectEffectiveFinalPosition(s);

    if (position === null) return false;

    return position >= 4 && positionNumberIsSpeakable(position);
  };

  const sequence: Step[] = [
    "@pit-crew.radio-open",
    // Optional (issue #835): driver names are a union across voices, so a
    // voice lacking the picked name clip skips the greeting — a complete
    // sentence either way — instead of aborting the result callout.
    { optional: [{ var: "raceEnd.greeting" }] },
    {
      if: isPosition(1),
      then: [{ var: "raceEnd.weWon" }],
      else: [
        {
          if: isPosition(2),
          then: [{ var: "raceEnd.secondPlace" }],
          else: [
            {
              if: isPosition(3),
              then: [{ var: "raceEnd.podiumThird" }],
              else: [
                {
                  // P4 or worse — composed readout. The `if:` guards against
                  // an unknown / out-of-range position producing a partial
                  // "the race is over, the final result for us is …" with no
                  // number after it.
                  if: isFourthOrWorse,
                  then: [{ var: "raceEnd.raceOverResultIs" }, { var: "raceEnd.position" }],
                },
              ],
            },
          ],
        },
      ],
    },
    "@pit-crew.radio-close",
  ];

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

        return position !== null && positionNumberIsSpeakable(position);
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: WEIGHT.CHATTER,
    queueable: true,
    family: "race-end",
    sequence,
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
 * Empty — the race-end readout is composed entirely from `engine.defineVar`
 * resolvers, not pools. Exported for parity with the family-completeness check
 * used by the other pit-crew catalog files. The broader convention alignment
 * (static `RACE_END_ALERTS` + constructor helper) is tracked in issue #558.
 */
export const RACE_END_POOL_NAMES: readonly string[] = [];
