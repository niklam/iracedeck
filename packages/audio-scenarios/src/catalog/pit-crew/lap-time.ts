/**
 * Lap-time best-lap contract + vocabulary — issue #555; scripted since #1065.
 *
 * Fires on `lap.completed` when the driver sets a new session best (`isBest`)
 * or completes their first valid lap of the session (`isFirstValid`). The
 * intro selector picks `"first-good-lap"` for the first-valid case and
 * `"best-lap-yet"` for every subsequent improvement, driven straight off the
 * payload's `isFirstValid` flag.
 *
 * The code below decides WHETHER a lap is worth a readout and how it is
 * scheduled; WHAT is read out lives in the active voice's `callouts.json`
 * under the same id (`scenarios["pit-crew.lap-time-best"]`), paired at
 * `setScripts` time. The bundled script's shape:
 *   [radio open]
 *   {{lapTime.intro}}             best-lap-yet  OR  first-good-lap
 *   {{lapTime.minute}}            CONDITIONAL on `lapTime.hasMinuteComponent`
 *                                 — skipped for sub-1-min laps
 *   {{lapTime.second}}            whole-second component, with trailing comma
 *   {{lapTime.decimal}}           "point N seconds." — terminates the readout
 *   [radio close]
 *
 * The minute clause is the #1064 spec's boundary case: dropping the minute is
 * a real convention in racing (the assumed minute is understood), so whether
 * a voice keeps the hard `if` or writes `{ optional: ["{{lapTime.minute}}"] }`
 * for a terser register is the pack's decision, not this file's. The bundled
 * script keeps the hard `if` — the assumed minute only holds where it is 1,
 * and an 8:32.4 lap read as "thirty-two four" is nonsense.
 *
 * No leading pause: the translator now triggers `lap.completed` on
 * `LapLastLapTime` updating (which iRacing publishes after the S/F crossing
 * has been registered), so the natural lag of the time-refresh + scenario
 * scheduling already provides the post-line breathing room the pause used
 * to give artificially.
 *
 * Snapshot-at-fire-time (session-start pattern, issue #542): the var resolvers
 * read from a closure-bound `getSnapshot` so deferred replays speak the same
 * frozen lap data. The snapshot is the `lap.completed` event payload itself
 * — the plugin caches the latest one and exposes a getter. Lap events are
 * well-separated in time, so the cache-overwrite race between back-to-back
 * fires is not a practical concern. That is why the vocabulary, not the
 * contract, takes the resolver; the contract's builder keeps only the
 * race-finished gate its `where:` reads.
 *
 * Clip scope derives from the manifest (issues #835/#836): each component
 * resolver returns a pool reference, and a lap time whose minute component has
 * no clip for the active voice aborts the whole readout at expansion — never
 * partial readouts, no hardcoded bounds.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import type { ScenarioContract } from "../../dsl.js";
import { poolRef } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";

/**
 * Resolver for the most recent `lap.completed` payload. Returns `null` when no
 * lap has completed yet — the contract then skips the callout entirely via its
 * `where:` short-circuit.
 */
export type LapCompletedSnapshotResolver = () => LapCompletedSnapshot | null;

/** Snapshot the var resolvers read — exactly the `lap.completed` event payload. */
export type LapCompletedSnapshot = SimEventOf<"lap.completed">["data"];

const LAP_TIME_GROUP_INTRO = "lap-time-intro";
const LAP_TIME_GROUP_MINUTE = "lap-time-minute";
const LAP_TIME_GROUP_SECOND = "lap-time-second";
const LAP_TIME_GROUP_DECIMAL = "lap-time-decimal";

/**
 * Split a lap time (seconds) into minute / whole-second / decimal-tenth, with
 * a single round-to-nearest-tenth at the input boundary so 34.85 → 34.9 and
 * the three components stay internally consistent.
 */
export function splitLapTime(lapTime: number): { minutes: number; seconds: number; tenths: number } {
  if (!Number.isFinite(lapTime) || lapTime < 0) {
    return { minutes: 0, seconds: 0, tenths: 0 };
  }

  const totalTenths = Math.round(lapTime * 10);
  const totalSeconds = Math.floor(totalTenths / 10);
  const tenths = totalTenths % 10;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return { minutes, seconds, tenths };
}

/** Whether the lap has a non-zero minute component (≥1 minute). */
function hasMinuteComponent(snapshot: LapCompletedSnapshot | null): boolean {
  if (!snapshot) return false;

  return splitLapTime(snapshot.lapTime).minutes >= 1;
}

/**
 * Register the vocabulary the lap-time script references (issue #1065): the
 * four readout components as vars and the minute gate as a condition. Every
 * resolver reads the `lap.completed` snapshot through `getSnapshot` at
 * expansion time. Names and descriptions are the public API of the format;
 * the descriptions feed the generated reference (#1066).
 */
export function registerLapTimeVocabulary(
  engine: Pick<IScenarioEngine, "defineVar" | "defineCond">,
  getSnapshot: LapCompletedSnapshotResolver,
): void {
  engine.defineVar(
    "lapTime.intro",
    () => {
      const s = getSnapshot();

      if (!s) return null;

      // Drive intro selection straight off the explicit `isFirstValid` flag
      // rather than inferring it from companion fields (e.g. presence of
      // `previousBestLapTime`). Keeps the behavior independent of how the
      // emitter happens to populate the optional fields.
      return poolRef(LAP_TIME_GROUP_INTRO, s.isFirstValid ? "first-good-lap" : "best-lap-yet");
    },
    "The opening line of the lap-time readout: first-good-lap on the driver's first valid lap of the session, best-lap-yet on every later improvement. Draws from the lap-time-intro clip group.",
  );

  engine.defineVar(
    "lapTime.minute",
    () => {
      const s = getSnapshot();

      if (!s) return null;

      const { minutes } = splitLapTime(s.lapTime);

      if (minutes < 1) return null;

      return poolRef(LAP_TIME_GROUP_MINUTE, String(minutes));
    },
    "The whole-minute part of the lap time, as one clip per minute value; nothing for a lap under a minute. Draws from the lap-time-minute clip group — a minute the voice has no clip for aborts the readout.",
  );

  engine.defineVar(
    "lapTime.second",
    () => {
      const s = getSnapshot();

      if (!s) return null;

      const { seconds } = splitLapTime(s.lapTime);

      return poolRef(LAP_TIME_GROUP_SECOND, String(seconds));
    },
    "The whole-second part of the lap time (0 to 59), one clip per value with a trailing comma. Draws from the lap-time-second clip group.",
  );

  engine.defineVar(
    "lapTime.decimal",
    () => {
      const s = getSnapshot();

      if (!s) return null;

      const { tenths } = splitLapTime(s.lapTime);

      return poolRef(LAP_TIME_GROUP_DECIMAL, String(tenths));
    },
    'The tenths of a second (0 to 9), spoken as "point N seconds" — the clip that ends the readout. Draws from the lap-time-decimal clip group.',
  );

  engine.defineCond(
    "lapTime.hasMinuteComponent",
    () => hasMinuteComponent(getSnapshot()),
    "The lap is a minute or longer, so the minute word is spoken before the seconds. A pack may drop the minute with optional for a terse register; the assumed minute only holds where it is 1.",
  );
}

/**
 * Build the lap-time contract. The contract's `where:` reads the event
 * payload plus the race-finished gate, which is why this stays a builder:
 * `getRaceFinishedFired` suppresses the callout on the final lap of a race
 * (issue #569) — race-end is the only thing the engineer should say when the
 * driver crosses S/F under the checkered. Without this gate the best-lap
 * announcement would fire alongside the race result on a PB final lap and the
 * two would queue head-to-tail. Default `() => false` (race never ends)
 * preserves legacy behavior for tests that don't supply a closure.
 *
 * Holds the fixed `id`, the full `when` block, and the channel/bus/base/family
 * defaults (weight is left at the default `WEIGHT.NORMAL`); the readout's
 * components are the vocabulary's ({@link registerLapTimeVocabulary}).
 */
export function buildLapTimeContract(getRaceFinishedFired: () => boolean = () => false): ScenarioContract {
  return {
    id: "pit-crew.lap-time-best",
    when: {
      event: "lap.completed",
      where: (ev) => {
        if (ev.event !== "lap.completed") return false;

        const data = ev.data as LapCompletedSnapshot;

        // Race finished — defer to race-end (issue #569). The diff sets the
        // latch synchronously before publishing `lap.completed`, so by the
        // time this where: runs the latch reads true on the final lap.
        if (data.sessionType === "race" && getRaceFinishedFired()) return false;

        // Fire on the new-PB case (`isBest`) AND the first-valid-lap case
        // (`isFirstValid`) so an emitter that only marks the latter without
        // setting `isBest` still surfaces the announcement. Whether the
        // components are speakable derives from the clips that exist — a
        // missing component clip aborts at expansion (issues #835/#836).
        return (data.isBest || data.isFirstValid) && Number.isFinite(data.lapTime) && data.lapTime > 0;
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    family: "lap-time",
    description:
      "You cross the line with a new session-best lap, or your first valid lap of the session, in any session — except on the final lap of a race, where the result speaks instead.",
  };
}

/**
 * Stable identifier for the lap-time callout (issue #555). Single subject —
 * "best lap" covers both the new-PB case and the first-valid-lap case (the
 * intro selector handles the distinction internally).
 */
export type LapTimeCalloutId = "best-lap";

/**
 * Canonical mapping from `LapTimeCalloutId` to its plugin-global setting key
 * in `GlobalSettingsSchema`. Plugin entry points use this to read the live
 * opt-in without duplicating the key string.
 */
export const LAP_TIME_CALLOUT_SETTING_KEYS: Record<LapTimeCalloutId, string> = {
  "best-lap": "calloutEnabledLapTimeBestLap",
};

export const SCENARIO_ID_TO_LAP_TIME_ID: Record<string, LapTimeCalloutId> = {
  "pit-crew.lap-time-best": "best-lap",
};

export const LAP_TIME_SCENARIO_IDS: readonly string[] = ["pit-crew.lap-time-best"];

/**
 * The readout is composed entirely from the `lapTime.*` vars, which draw
 * from the four `lap-time-*` clip groups by value — so there is no fixed
 * `(group, base)` list to publish: the bundled script addresses no pool
 * directly. Exported empty for parity with the family-completeness checks
 * the other pit-crew catalog files feed; the var descriptions name the
 * groups.
 */
export const LAP_TIME_CLIP_SOURCES: readonly { group: string; base: string }[] = [];
