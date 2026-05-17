/**
 * Lap-time best-lap callout — issue #555.
 *
 * Fires on `lap.completed` when the driver sets a new session best (`isBest`)
 * or completes their first valid lap of the session (`isFirstValid`). The
 * intro selector picks `"first-good-lap"` for the first-valid case and
 * `"best-lap-yet"` for every subsequent improvement, driven straight off the
 * payload's `isFirstValid` flag.
 *
 * Script:
 *   [radio open]
 *   <intro>                       best-lap-yet  OR  first-good-lap
 *   <minute>                      CONDITIONAL — skipped for sub-1-min laps
 *   <second>                      whole-second component, with trailing comma
 *   <decimal>                     "point N seconds." — terminates the readout
 *   [radio close]
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
 * fires is not a practical concern.
 *
 * Initial clip scope (find-shape-during-implementation per the issue): minutes
 * 1–10, whole seconds 0–59, decimals 0–9. Out-of-range lap times (currently
 * just laps ≥ 11 minutes) are filtered by the `where:` predicate via
 * {@link lapTimeIsSpeakable} so the scenario doesn't fire at all when a step
 * would have no clip — never partial readouts.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import type { Scenario, Step } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";

/**
 * Resolver for the most recent `lap.completed` payload. Returns `null` when no
 * lap has completed yet — the scenario then skips the callout entirely via its
 * `where:` short-circuit.
 */
export type LapCompletedSnapshotResolver = () => LapCompletedSnapshot | null;

/** Snapshot the var resolvers read — exactly the `lap.completed` event payload. */
export type LapCompletedSnapshot = SimEventOf<"lap.completed">["data"];

/**
 * Initial clip-scope bounds for the readout (issue #555). The voice config
 * currently ships `lap-time-minute/1..10` and `lap-time-second/0..59`; lap
 * times whose minute component falls outside `0..LAP_TIME_MINUTE_MAX` are
 * skipped at the `where:` predicate so the readout is never partial. The
 * second-component range covers the full minute, so no per-second filtering
 * applies — only the bounds check stays for defensive correctness if the
 * scenario is ever called with junk telemetry.
 * Expand both groups + these constants together when widening coverage.
 */
export const LAP_TIME_MINUTE_MAX = 10;
export const LAP_TIME_SECOND_MIN = 0;
export const LAP_TIME_SECOND_MAX = 59;

const LAP_TIME_GROUP_INTRO = "lap-time-intro";
const LAP_TIME_GROUP_MINUTE = "lap-time-minute";
const LAP_TIME_GROUP_SECOND = "lap-time-second";
const LAP_TIME_GROUP_DECIMAL = "lap-time-decimal";

/** Build a full `voice/{voice}/...` path for a `var` resolver (no base applied). */
function voicePath(group: string, name: string): string {
  return `voice/{voice}/${group}/${name}.mp3`;
}

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
 * Whether every clip needed for the readout currently exists. Off-range lap
 * times are dropped at the `where:` predicate so the scenario never plays a
 * partial readout. Expand the bounds together with the voice config groups.
 */
export function lapTimeIsSpeakable(lapTime: number): boolean {
  if (!Number.isFinite(lapTime) || lapTime <= 0) return false;

  const { minutes, seconds } = splitLapTime(lapTime);

  if (minutes > LAP_TIME_MINUTE_MAX) return false;

  // Defensive bounds check on the whole-second component. The current scope is
  // 0..59, which covers the entire minute, so this never rejects realistic
  // input — it only catches programming errors or junk telemetry.
  if (seconds < LAP_TIME_SECOND_MIN || seconds > LAP_TIME_SECOND_MAX) return false;

  return true;
}

/**
 * Register the lap-time scenario's variables on the scenario engine. Must run
 * before {@link buildLapTimeScenario} is registered — load-time validation
 * rejects a `{ var }` step whose name isn't registered.
 */
export function registerLapTimeVars(engine: IScenarioEngine, getSnapshot: LapCompletedSnapshotResolver): void {
  engine.defineVar("lapTime.intro", () => {
    const s = getSnapshot();

    if (!s) return null;

    // Drive intro selection straight off the explicit `isFirstValid` flag
    // rather than inferring it from companion fields (e.g. presence of
    // `previousBestLapTime`). Keeps the behavior independent of how the
    // emitter happens to populate the optional fields.
    return voicePath(LAP_TIME_GROUP_INTRO, s.isFirstValid ? "first-good-lap" : "best-lap-yet");
  });

  engine.defineVar("lapTime.minute", () => {
    const s = getSnapshot();

    if (!s) return null;

    const { minutes } = splitLapTime(s.lapTime);

    if (minutes < 1 || minutes > LAP_TIME_MINUTE_MAX) return null;

    return voicePath(LAP_TIME_GROUP_MINUTE, String(minutes));
  });

  engine.defineVar("lapTime.second", () => {
    const s = getSnapshot();

    if (!s) return null;

    const { seconds } = splitLapTime(s.lapTime);

    if (seconds < LAP_TIME_SECOND_MIN || seconds > LAP_TIME_SECOND_MAX) return null;

    return voicePath(LAP_TIME_GROUP_SECOND, String(seconds));
  });

  engine.defineVar("lapTime.decimal", () => {
    const s = getSnapshot();

    if (!s) return null;

    const { tenths } = splitLapTime(s.lapTime);

    if (tenths < 0 || tenths > 9) return null;

    return voicePath(LAP_TIME_GROUP_DECIMAL, String(tenths));
  });
}

/**
 * Build the lap-time scenario bound to a snapshot resolver. The resolver is
 * read by the per-clip `var` resolvers at sequence-expansion time and by the
 * conditional `if` step that gates the minute clip.
 *
 * `getRaceFinishedFired` suppresses the callout on the final lap of a race
 * (issue #569) — race-end is the only thing the engineer should say when the
 * driver crosses S/F under the checkered. Without this gate the best-lap
 * announcement would fire alongside the race result on a PB final lap and the
 * two would queue head-to-tail. Default `() => false` (race never ends)
 * preserves legacy behavior for tests that don't supply a closure.
 */
export function buildLapTimeScenario(
  getSnapshot: LapCompletedSnapshotResolver,
  getRaceFinishedFired: () => boolean = () => false,
): Scenario {
  const sequence: Step[] = [
    "@pit-crew.radio-open",
    { var: "lapTime.intro" },
    {
      if: () => hasMinuteComponent(getSnapshot()),
      then: [{ var: "lapTime.minute" }],
    },
    { var: "lapTime.second" },
    { var: "lapTime.decimal" },
    "@pit-crew.radio-close",
  ];

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
        // setting `isBest` still surfaces the announcement.
        return (data.isBest || data.isFirstValid) && lapTimeIsSpeakable(data.lapTime);
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    priority: "normal",
    family: "lap-time",
    sequence,
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
 * Empty — the lap-time readout is composed entirely from `engine.defineVar`
 * resolvers, not pools. Exported anyway for parity with the family-completeness
 * check used by the other pit-crew catalog files. The broader convention
 * alignment (static `LAP_TIME_ALERTS` + constructor helper) is tracked in
 * issue #558.
 */
export const LAP_TIME_POOL_NAMES: readonly string[] = [];
