/**
 * The Race Engineer's section of the Telemetry Snapshot's `pluginState`
 * (issue #1387): what the scenario engine and the callout families had in
 * hand at the moment the key was pressed, so a support case can tell a
 * callout that was queued, refused by a cooldown, or never asked for.
 *
 * Two halves. The engine reports itself (`IScenarioEngine.describeState`):
 * the buses, what waits for them, the focus floor, each contract's last fire.
 * Each pit-crew file that keeps state of its own exports a
 * `read<Family>DebugState()` beside that state, and this module collects them
 * under one key per file.
 *
 * Every reader is synchronous and a pure read — no logging, no timers, no
 * mutation — and works before its family was registered. What they return is
 * live state, not a copy, and may hold a `Set`, a `Map` or a hole: the
 * snapshot's encoder (`@iracedeck/diagnostics`, which this package does not
 * import) copies it into JSON. A reader never returns a timer handle, a
 * logger, the bus, an audio object or a closure.
 */
import { getScenarioEngine, isAudioScenariosInitialized, type ScenarioEngineState } from "../../interpreter.js";
import { readBackgroundTestDebugState } from "./background-test.js";
import { readCautionDebugState } from "./caution.js";
import { readFlagAlertsDebugState } from "./flag-alerts.js";
import { readGapsDebugState } from "./gaps.js";
import { readIncidentsDebugState } from "./incidents.js";
import { readOpponentPitDebugState } from "./opponent-pit.js";
import { readPitSpeedingDebugState } from "./pit-speeding-engine.js";
import { readPositionReadoutDebugState } from "./position-readout.js";
import { readQualifyingInvalidationDebugState } from "./qualifying-invalidation.js";
import { readRadarDebugState } from "./radar-engine.js";
import { readSpotterDebugState } from "./spotter-engine.js";

/** One key per pit-crew file that keeps state, holding what that file's reader returns. */
function readFamilies() {
  return {
    backgroundTest: readBackgroundTestDebugState(),
    caution: readCautionDebugState(),
    flagAlerts: readFlagAlertsDebugState(),
    gaps: readGapsDebugState(),
    incidents: readIncidentsDebugState(),
    opponentPit: readOpponentPitDebugState(),
    pitSpeeding: readPitSpeedingDebugState(),
    positionReadout: readPositionReadoutDebugState(),
    qualifyingInvalidation: readQualifyingInvalidationDebugState(),
    radar: readRadarDebugState(),
    spotter: readSpotterDebugState(),
  };
}

/** The callout families' own state, keyed by family — see `readFamilies`. */
export type RaceEngineerFamiliesState = ReturnType<typeof readFamilies>;

export type RaceEngineerState =
  { initialized: false } | { initialized: true; engine: ScenarioEngineState; families: RaceEngineerFamiliesState };

/**
 * The Race Engineer's state right now. Before `initializeAudioScenarios` —
 * a press during startup, or a build with the audio off — it is exactly
 * `{ initialized: false }`, never a throw. The families are read either way
 * once the engine exists: a family the catalog never registered reads as its
 * untouched state.
 */
export function readRaceEngineerState(): RaceEngineerState {
  if (!isAudioScenariosInitialized()) return { initialized: false };

  return { initialized: true, engine: getScenarioEngine().describeState(), families: readFamilies() };
}

/**
 * The rows the snapshot's Markdown companion leads the section with: the
 * voice, what holds the Voice bus, and how many callouts wait across the
 * buses. One row saying so when the engine is not initialized.
 */
export function raceEngineerStateHeadline(state: RaceEngineerState): Array<readonly [string, string]> {
  if (!state.initialized) return [["Race Engineer", "not initialized"]];

  const { activeVoice, buses } = state.engine;
  const voiceBus = buses.find((b) => b.bus === "Voice");
  const waiting = buses.reduce((count, b) => count + b.waiting.length, 0);

  return [
    ["Race Engineer voice", activeVoice ?? "none"],
    ["Voice bus", voiceBus?.playingId ?? "idle"],
    ["Waiting callouts", String(waiting)],
  ];
}
