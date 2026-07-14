/**
 * Race-start greeting + qualifying-position readout — issue #568.
 *
 * Fires once per race session on `session.changed` after a short delay
 * ({@link RACE_START_DELAY_MS}). Greets the driver by name, reports the
 * qualifying-finish (grid) position, and reads the same track + air
 * temperature + wetness brief as the session-start callout — minus the pit
 * speed limit, which the driver heard during practice / qualifying and which
 * isn't useful at the green flag. Race start is the only moment the driver
 * wants the position context.
 *
 * Coexistence with session-start (issue #542): the session-start scenario's
 * `where:` returns false in race sessions, so race entries are spoken
 * exclusively by this scenario. Practice and qualifying are unchanged.
 *
 * Script (fires {@link RACE_START_DELAY_MS} after `session.changed`):
 *   [radio open]
 *   "Time to race, <Name>."                        race-start-greeting/<driver>.mp3
 *   ── conditional position clause ───────────────
 *     P1                   "Starting from pole. Well done."
 *     P2…P{@link POSITION_MAX}
 *                          "Qualifying put us to," + "P N."  (position-number group)
 *     missing / P > MAX    (clause skipped entirely)
 *   ──
 *   "Track temperature is" <N> "degrees" <unit>    (session-start clips)
 *   "air temperature is"   <N> "degrees" <unit>    (session-start clips)
 *   "and the track is" <wetness-state>             (session-start clips)
 *   [radio close]
 *
 * The greeting is a single per-name clip ("Time to race, Niklas.") rather than
 * a composed "Time to race," + bare-name pair. Composition produced awkward
 * prosody — the prefix ended with a sentence terminator and the bare name
 * read as a fresh utterance instead of a continuation. Per-name clips speak
 * naturally at the cost of one clip per supported name.
 *
 * Snapshot-at-fire-time (session-start pattern, issue #542): every dynamic clip
 * is a `{ var }` step backed by a resolver that reads the snapshot closure at
 * fire time. The clip ranges (temp 0-150 in display units, position 1-64) are
 * the same as the families they borrow from — both come from the same voice-
 * group source of truth and don't need to be tracked separately here.
 *
 * Family `race-start`: reserves the namespace for future race-start scenarios
 * (wet-race opener, formation-lap brief, weather forecast). Distinct from
 * `session-start` so preemption between the two families is clean — a future
 * race-only opener can preempt this one without affecting practice / qualifying
 * sessions still using session-start.
 *
 * `where:` is `classifySessionType(getSessionType()) === "race" &&
 * getSnapshot() !== null`. The first arm gates the scenario open only for race
 * transitions (practice/qualifying are owned by session-start); the second arm
 * short-circuits when telemetry / wetness aren't yet available so the scenario
 * skips entirely rather than speaking a partial readout.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type RaceStartSnapshot, TrackWetness } from "@iracedeck/event-bus";
import type { ILogger } from "@iracedeck/logger";
import { getSessionType } from "@iracedeck/sim-events-iracing";

import type { Scenario, Step } from "../../dsl.js";
import { poolRef } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";

/**
 * Resolver for the race-start snapshot, invoked at fire time. Returns `null`
 * when conditions aren't available — the scenario then skips the callout
 * entirely (its `where:` predicate short-circuits).
 */
export type RaceStartSnapshotResolver = () => RaceStartSnapshot | null;

/**
 * Delay before the where: predicate and sequence-expansion run, once
 * `session.changed` lands in a race session. Implemented as the scenario's
 * `triggerDelay` (NOT a leading `{ pause }` step) so iRacing's telemetry has
 * a chance to settle before we read it.
 *
 * iRacing publishes `SessionNum`-changed ticks immediately on session
 * transition, but `TrackWetness` (and a few other fields) can briefly read
 * `Unknown` for a beat right at the transition. A leading `{ pause }` step
 * inside the sequence does NOT help — vars are resolved at expansion time,
 * synchronously when the where: returns true. By the time the pause's audio-
 * gap actually plays, the var paths are already frozen. `triggerDelay`
 * defers the entire fire decision so where: and var resolvers see fresh,
 * settled telemetry.
 */
export const RACE_START_DELAY_MS = 3000;

/** Wetness enum → `session-start/wetness-<suffix>.mp3` clip suffix. */
const WETNESS_CLIP_SUFFIX: Readonly<Partial<Record<TrackWetness, string>>> = {
  [TrackWetness.Dry]: "dry",
  [TrackWetness.MostlyDry]: "mostly-dry",
  [TrackWetness.VeryLightlyWet]: "very-lightly-wet",
  [TrackWetness.LightlyWet]: "lightly-wet",
  [TrackWetness.ModeratelyWet]: "moderately-wet",
  [TrackWetness.VeryWet]: "very-wet",
  [TrackWetness.ExtremelyWet]: "extremely-wet",
};

const RACE_START_BASE = "race-start";
const RACE_START_GREETING_GROUP = "race-start-greeting";
const SESSION_START_GROUP = "session-start";
const SESSION_START_TEMP_NUMBERS_GROUP = "session-start-temp-numbers";
const POSITION_NUMBER_GROUP = "position-number";
/** Group holding the setup-mismatch warning clips (issue #625). */
const SETUP_WARNING_GROUP = "setup-warning";

/** Build a `clip` step path relative to the scenario's `voice/{voice}` base. */
function clipPath(filename: string): string {
  return `${RACE_START_BASE}/${filename}`;
}

/**
 * Whether `classifySessionType(getSessionType())` is `"race"`. Public so the
 * `where:` predicate can be unit-tested without mocking the entire scenario
 * harness. Matches the translator's `classifySessionType` mapping — anything
 * that isn't practice / testing / qualifying reads as race.
 */
export function isRaceSession(sessionType: string): boolean {
  if (sessionType.includes("Practice") || sessionType.includes("Testing")) return false;

  if (sessionType.includes("Qualify")) return false;

  return true;
}

/**
 * Register the race-start scenario's variables on the scenario engine. Must
 * run before the scenario is defined — load-time validation rejects a
 * `{ var }` step whose name isn't registered. Resolvers close over the
 * snapshot closure and return `null` (a no-op step) whenever conditions
 * aren't available.
 */
export function registerRaceStartVars(engine: IScenarioEngine, getSnapshot: RaceStartSnapshotResolver): void {
  // Single per-name greeting clip — "Time to race, <Name>." recorded as one
  // sentence rather than composed from a "Time to race," prefix + a bare name
  // clip. Composition produced awkward prosody (sentence terminator + opening
  // intonation on the bare name); per-name clips speak naturally.
  engine.defineVar("raceStart.greeting", () => {
    const s = getSnapshot();

    if (!s) return null;

    const name = s.driverName && s.driverName.length > 0 ? s.driverName : "driver";

    return poolRef(RACE_START_GREETING_GROUP, name);
  });

  engine.defineVar("raceStart.position", () => {
    const s = getSnapshot();

    if (!s || typeof s.playerCarPosition !== "number" || s.playerCarPosition < 1) return null;

    return poolRef(POSITION_NUMBER_GROUP, String(s.playerCarPosition));
  });

  engine.defineVar("raceStart.trackTempNumber", () => {
    const s = getSnapshot();

    if (!s) return null;

    return poolRef(SESSION_START_TEMP_NUMBERS_GROUP, String(s.trackTemp));
  });

  engine.defineVar("raceStart.airTempNumber", () => {
    const s = getSnapshot();

    if (!s) return null;

    return poolRef(SESSION_START_TEMP_NUMBERS_GROUP, String(s.airTemp));
  });

  engine.defineVar("raceStart.degreesUnit", () => {
    const s = getSnapshot();

    if (!s) return null;

    return poolRef(SESSION_START_GROUP, `degrees-${s.tempUnit}`);
  });

  engine.defineVar("raceStart.wetness", () => {
    const s = getSnapshot();
    const suffix = s ? WETNESS_CLIP_SUFFIX[s.wetness] : undefined;

    return suffix ? poolRef(SESSION_START_GROUP, `wetness-${suffix}`) : null;
  });
}

/**
 * Build the race-start scenario bound to a snapshot resolver. The resolver
 * is read in the `where:` predicate (to gate firing) and inside the position
 * clause's conditional `if` step (to pick pole vs composed); the per-clip
 * `var` resolvers registered by {@link registerRaceStartVars} read it again
 * at sequence-expansion time.
 *
 * `getSetupWarningMismatch` (issue #625) appends a "double-check your setup"
 * nudge before the radio close when the loaded setup name looks like a
 * qualifying setup. Read live at fire time; race-start only ever fires in a
 * race session, so no session-type re-check is needed here.
 */
export function buildRaceStartScenario(
  getSnapshot: RaceStartSnapshotResolver,
  logger?: ILogger,
  getSetupWarningMismatch: (kind: "qualifying" | "race") => boolean = () => false,
): Scenario {
  const isPole = (): boolean => getSnapshot()?.playerCarPosition === 1;
  const isComposedPosition = (): boolean => {
    const s = getSnapshot();

    if (!s) return false;

    const position = s.playerCarPosition;

    return typeof position === "number" && position >= 2;
  };

  const sequence: Step[] = [
    "@pit-crew.radio-open",
    // Optional (issue #835): driver names are a union across voices, so a
    // voice lacking the picked name clip skips the greeting — a complete
    // sentence either way — instead of aborting the whole brief.
    { optional: [{ var: "raceStart.greeting" }] },
    // Optional clause (issue #836): whether a grid position is speakable
    // derives from the clips that exist (no hardcoded bound) — a position (or
    // a voice) without the number clip skips the clause entirely and the
    // readout continues with the conditions brief.
    {
      optional: [
        {
          if: isPole,
          then: [clipPath("starting-from-pole-01.mp3")],
          else: [
            {
              if: isComposedPosition,
              then: [clipPath("qualifying-put-us-to-01.mp3"), { var: "raceStart.position" }],
              // No `else` — a missing position skips the clause entirely.
            },
          ],
        },
      ],
    },
    // Optional clauses (issue #836): the temp clip range is defined by the
    // generated clips (no clamping) — a reading outside it skips its clause
    // rather than speaking a wrong clamped number or killing the brief.
    {
      optional: [
        `${SESSION_START_GROUP}/track-temp-intro.mp3`,
        { var: "raceStart.trackTempNumber" },
        { var: "raceStart.degreesUnit" },
      ],
    },
    {
      optional: [
        `${SESSION_START_GROUP}/air-temp-intro.mp3`,
        { var: "raceStart.airTempNumber" },
        { var: "raceStart.degreesUnit" },
      ],
    },
    `${SESSION_START_GROUP}/wetness-intro.mp3`,
    { var: "raceStart.wetness" },
    {
      if: () => getSetupWarningMismatch("race"),
      // Optional clause (issue #835): the nudge is a self-contained add-on —
      // a voice without the clip skips it, not the brief.
      then: [{ optional: [`${SETUP_WARNING_GROUP}/race-01.mp3`] }],
    },
    "@pit-crew.radio-close",
  ];

  return {
    id: "pit-crew.race-start",
    when: {
      event: "session.changed",
      where: () => {
        const sessionType = getSessionType();
        const inRace = isRaceSession(sessionType);
        const snapshot = getSnapshot();

        if (!inRace) {
          logger?.info(`race-start where: rejected — sessionType="${sessionType}" is not race`);

          return false;
        }

        if (snapshot === null) {
          logger?.info(`race-start where: rejected — snapshot is null (telemetry not ready / wetness unknown)`);

          return false;
        }

        logger?.info(
          `race-start where: passed — sessionType="${sessionType}", position=${snapshot.playerCarPosition ?? "?"}`,
        );

        return true;
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    family: "race-start",
    // Defer where: + var resolution so telemetry has settled by the time we
    // read TrackWetness / TrackTempCrew / AirTemp / PlayerCarPosition. See
    // `RACE_START_DELAY_MS` for the rationale.
    triggerDelay: RACE_START_DELAY_MS,
    sequence,
  };
}

/**
 * Stable identifier for the race-start callout (issue #568). Single subject —
 * the whole readout (greeting + position + conditions) is one user-toggleable
 * callout. Kept as a union for symmetry with the other per-callout families
 * so a future second subject (wet-race opener, etc.) can be added by widening
 * the union without restructuring the wiring.
 */
export type RaceStartCalloutId = "race-start";

/**
 * Canonical mapping from `RaceStartCalloutId` to its plugin-global setting
 * key in `GlobalSettingsSchema`. Plugin entry points use this to read the
 * live opt-in without duplicating the key string.
 */
export const RACE_START_CALLOUT_SETTING_KEYS: Record<RaceStartCalloutId, string> = {
  "race-start": "calloutEnabledRaceStart",
};

// `as const` for the compile-time completeness check on `SCENARIO_ID_TO_RACE_START_ID`.
export const RACE_START_SCENARIO_IDS = ["pit-crew.race-start"] as const;

export const SCENARIO_ID_TO_RACE_START_ID: Record<(typeof RACE_START_SCENARIO_IDS)[number], RaceStartCalloutId> = {
  "pit-crew.race-start": "race-start",
};

/**
 * Empty — the race-start readout is composed entirely from `engine.defineVar`
 * resolvers, not pools. Exported for parity with the family-completeness check
 * used by the other pit-crew catalog files.
 */
export const RACE_START_POOL_NAMES: readonly string[] = [];
