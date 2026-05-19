/**
 * Session-start ("car entry") readout scenario — issue #542.
 *
 * Fires once per session on `driver.firstOnTrack`, after a short delay
 * ({@link SESSION_START_DELAY_MS}): the engineer greets the driver by name,
 * names the session type, and reads the situational brief — pit speed limit,
 * track temperature, air temperature, track wetness.
 *
 * Script:
 *   [{@link SESSION_START_DELAY_MS} pause]
 *   [radio open]
 *   "Ok, <Name>,"                                  greeting (per-name clip)
 *   <session line>                                 practice / qualifying / race
 *   "The pit speed limit is" <N> <speed-unit>      CONDITIONAL — see below
 *   "Track temperature is" <N> "degrees" <unit>
 *   "air temperature is" <N> "degrees" <unit>
 *   "and the track is" <wetness-state>
 *   [radio close]
 *
 * Snapshot-at-fire-time (readback.ts pattern, issue #481): every dynamic clip
 * is a `{ var }` step backed by a resolver that reads the snapshot closure at
 * fire time, so a deferred replay speaks current conditions. Units, rounding,
 * and the session-type bucket are resolved upstream in
 * `getSessionStartConditions()` — this file only maps the snapshot fields onto
 * clip paths.
 *
 * The pit-speed clause is conditional: iRacing pit limits are a small known
 * set, so the `session-start-speed-numbers` group only covers observed values
 * (plus ±1 for telemetry drift). The clause is skipped entirely for any value
 * outside {@link SESSION_START_SPEED_VALUES} — a guessed or rounded number
 * could imply a false pit-speed-penalty risk.
 *
 * `where:` is `getSnapshot() !== null`, so the scenario doesn't fire at all
 * when conditions are unavailable (no telemetry / session info, or wetness
 * still `Unknown`).
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type SessionStartSnapshot, TrackWetness } from "@iracedeck/event-bus";

import type { Scenario, Step } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";

/**
 * Resolver for the session-start snapshot, invoked at fire time. Returns
 * `null` when conditions aren't available — the scenario then skips the
 * callout entirely (its `where:` predicate short-circuits).
 */
export type SessionStartSnapshotResolver = () => SessionStartSnapshot | null;

/**
 * Observed iRacing pit speed limits, in km/h and mph (field findings). Each is
 * expanded by ±1 because telemetry occasionally reports a value one unit off
 * the posted limit. The scenario only speaks a pit-speed clause for a value in
 * this set; everything else is skipped. New limits get appended here and to
 * the `session-start-speed-numbers` voice group together — the two must stay
 * in sync.
 */
const PIT_LIMIT_FINDINGS_KMH = [40, 48, 50, 56, 60, 64, 72, 80] as const;
const PIT_LIMIT_FINDINGS_MPH = [25, 30, 31, 35, 37, 40, 45, 50] as const;

export const SESSION_START_SPEED_VALUES: ReadonlySet<number> = new Set(
  [...PIT_LIMIT_FINDINGS_KMH, ...PIT_LIMIT_FINDINGS_MPH].flatMap((v) => [v - 1, v, v + 1]),
);

/** Track temperature / air temperature clip range, in the display unit. */
export const SESSION_START_TEMP_MIN = 0;
export const SESSION_START_TEMP_MAX = 150;

/**
 * Delay before the readout starts, once `driver.firstOnTrack` fires. A short
 * beat after going on track feels more natural than the engineer blurting the
 * brief the instant the wheels move. The scenario holds the Voice bus for the
 * duration, so a higher-priority callout (e.g. meatball) can still preempt it.
 */
export const SESSION_START_DELAY_MS = 3000;

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

const SESSION_START_BASE = "session-start";

/** Build a `clip` step path relative to the scenario's `voice/{voice}` base. */
function clipPath(filename: string): string {
  return `${SESSION_START_BASE}/${filename}`;
}

/** Build a full `voice/{voice}/...` path for a `var` resolver (no base applied). */
function voicePath(group: string, name: string): string {
  return `voice/{voice}/${group}/${name}.mp3`;
}

/** Clamp a temperature reading into the generated clip range. */
function clampTemp(value: number): number {
  return Math.min(SESSION_START_TEMP_MAX, Math.max(SESSION_START_TEMP_MIN, value));
}

/** Whether the pit-speed clause can be spoken for this snapshot. */
function speedIsSpeakable(snapshot: SessionStartSnapshot | null): boolean {
  return snapshot !== null && SESSION_START_SPEED_VALUES.has(snapshot.pitSpeedLimit);
}

/**
 * Register the session-start scenario's variables on the scenario engine.
 * Must run before the scenario is defined — load-time validation rejects a
 * `{ var }` step whose name isn't registered. The resolvers close over the
 * snapshot closure and return `null` (a no-op step) whenever conditions
 * aren't available.
 */
export function registerSessionStartVars(engine: IScenarioEngine, getSnapshot: SessionStartSnapshotResolver): void {
  engine.defineVar("sessionStart.greeting", () => {
    const s = getSnapshot();

    return s ? voicePath("session-start-greeting", s.driverName) : null;
  });

  engine.defineVar("sessionStart.sessionLine", () => {
    const s = getSnapshot();

    return s ? voicePath("session-start", `session-${s.sessionType}`) : null;
  });

  engine.defineVar("sessionStart.speedNumber", () => {
    const s = getSnapshot();

    return s && SESSION_START_SPEED_VALUES.has(s.pitSpeedLimit)
      ? voicePath("session-start-speed-numbers", String(s.pitSpeedLimit))
      : null;
  });

  engine.defineVar("sessionStart.speedUnit", () => {
    const s = getSnapshot();

    return s ? voicePath("session-start", `speed-unit-${s.speedUnit}`) : null;
  });

  engine.defineVar("sessionStart.trackTempNumber", () => {
    const s = getSnapshot();

    return s ? voicePath("session-start-temp-numbers", String(clampTemp(s.trackTemp))) : null;
  });

  engine.defineVar("sessionStart.airTempNumber", () => {
    const s = getSnapshot();

    return s ? voicePath("session-start-temp-numbers", String(clampTemp(s.airTemp))) : null;
  });

  engine.defineVar("sessionStart.degreesUnit", () => {
    const s = getSnapshot();

    return s ? voicePath("session-start", `degrees-${s.tempUnit}`) : null;
  });

  engine.defineVar("sessionStart.wetness", () => {
    const s = getSnapshot();
    const suffix = s ? WETNESS_CLIP_SUFFIX[s.wetness] : undefined;

    return suffix ? voicePath("session-start", `wetness-${suffix}`) : null;
  });
}

/**
 * Build the session-start scenario bound to a snapshot resolver. The resolver
 * is read in the `where:` predicate (to gate firing) and inside the
 * pit-speed `if` step (to gate the conditional clause); the per-clip `var`
 * resolvers registered by {@link registerSessionStartVars} read it again at
 * sequence-expansion time.
 */
export function buildSessionStartScenario(getSnapshot: SessionStartSnapshotResolver): Scenario {
  const sequence: Step[] = [
    { pause: SESSION_START_DELAY_MS },
    "@pit-crew.radio-open",
    { var: "sessionStart.greeting" },
    { var: "sessionStart.sessionLine" },
    {
      if: () => speedIsSpeakable(getSnapshot()),
      then: [
        clipPath("pit-speed-intro.mp3"),
        { var: "sessionStart.speedNumber" },
        { var: "sessionStart.speedUnit" },
      ],
    },
    clipPath("track-temp-intro.mp3"),
    { var: "sessionStart.trackTempNumber" },
    { var: "sessionStart.degreesUnit" },
    clipPath("air-temp-intro.mp3"),
    { var: "sessionStart.airTempNumber" },
    { var: "sessionStart.degreesUnit" },
    clipPath("wetness-intro.mp3"),
    { var: "sessionStart.wetness" },
    "@pit-crew.radio-close",
  ];

  return {
    id: "pit-crew.session-start",
    when: {
      event: "driver.firstOnTrack",
      where: () => {
        const snapshot = getSnapshot();

        if (snapshot === null) return false;

        // Race sessions are handled exclusively by the race-start scenario
        // (issue #568) which fires earlier and reads the grid position. Without
        // this gate the engineer would say both the race-start brief (~3 s
        // after `session.changed`) and the session-start brief (on
        // `driver.firstOnTrack` once the driver enters the car).
        if (snapshot.sessionType === "race") return false;

        return true;
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    priority: "normal",
    family: "session-start",
    sequence,
  };
}

/**
 * Stable identifier for the session-start callout (issue #542). Single
 * subject — the whole readout is one user-toggleable callout.
 */
export type SessionStartCalloutId = "session-start";

/**
 * Canonical mapping from `SessionStartCalloutId` to its plugin-global setting
 * key in `GlobalSettingsSchema`. Plugin entry points use this to read the live
 * opt-in without duplicating the key string.
 */
export const SESSION_START_CALLOUT_SETTING_KEYS: Record<SessionStartCalloutId, string> = {
  "session-start": "calloutEnabledSessionStart",
};

export const SCENARIO_ID_TO_SESSION_START_ID: Record<string, SessionStartCalloutId> = {
  "pit-crew.session-start": "session-start",
};

export const SESSION_START_SCENARIO_IDS: readonly string[] = ["pit-crew.session-start"];
