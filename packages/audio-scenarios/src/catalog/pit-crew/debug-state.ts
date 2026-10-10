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
 * under one key per file. `debug-state.test.ts` scans the directory and fails
 * for a file that declares module state and exports no reader, or exports a
 * reader this module does not call.
 *
 * Every reader is synchronous and a pure read — no logging, no timers, no
 * mutation — and works before its family was registered. What they return is
 * live state, not a copy, and may hold a `Set`, a `Map` or a hole: the
 * snapshot's encoder (`@iracedeck/diagnostics`, which this package does not
 * import) copies it into JSON. A reader never returns a timer handle, a
 * logger, the bus, an audio object or a closure.
 *
 * Each part fails on its own. The snapshot's collector isolates per section,
 * so a throw out of `readRaceEngineerState` would replace the whole section
 * with an error entry and take every healthy part with it. The engine and
 * each family are therefore read through `readStatePart`: a part that throws
 * is `{ error: "<reason>" }` in its place — never the section's own top-level
 * `error`, which is the collector's — and the rest are reported as they are.
 * Nothing is logged, and `readRaceEngineerState` never throws.
 */
import { getScenarioEngine, isAudioScenariosInitialized, type ScenarioEngineState } from "../../interpreter.js";
import { isStatePartError, readStatePart, type StatePartError } from "../../state-part.js";
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

/**
 * One key per pit-crew file that keeps state, holding what that file's reader
 * returns — or the error entry of a reader that threw. Each reader is called
 * inside its own `readStatePart`, so one family's failure is one key's.
 */
function readFamilies() {
  return {
    backgroundTest: readStatePart(() => readBackgroundTestDebugState()),
    caution: readStatePart(() => readCautionDebugState()),
    flagAlerts: readStatePart(() => readFlagAlertsDebugState()),
    gaps: readStatePart(() => readGapsDebugState()),
    incidents: readStatePart(() => readIncidentsDebugState()),
    opponentPit: readStatePart(() => readOpponentPitDebugState()),
    pitSpeeding: readStatePart(() => readPitSpeedingDebugState()),
    positionReadout: readStatePart(() => readPositionReadoutDebugState()),
    qualifyingInvalidation: readStatePart(() => readQualifyingInvalidationDebugState()),
    radar: readStatePart(() => readRadarDebugState()),
    spotter: readStatePart(() => readSpotterDebugState()),
  };
}

/**
 * The callout families' own state, keyed by family — see `readFamilies`. Each
 * key is that family's state or a {@link StatePartError}.
 */
export type RaceEngineerFamiliesState = ReturnType<typeof readFamilies>;

/**
 * The section. `engine` is the engine's state or the error entry of a
 * `describeState` that threw; inside a healthy `engine`, `activeVoice` and
 * `frameOptions` can each be an error entry of their own
 * (`ScenarioEngineState`).
 */
export type RaceEngineerState =
  | { initialized: false }
  | { initialized: true; engine: ScenarioEngineState | StatePartError; families: RaceEngineerFamiliesState };

/**
 * The Race Engineer's state right now. Before `initializeAudioScenarios` —
 * a press during startup, or a build with the audio off — it is exactly
 * `{ initialized: false }`, never a throw. The families are read either way
 * once the engine exists: a family the catalog never registered reads as its
 * untouched state. Never throws: a part that cannot be read is an error entry
 * in its place.
 */
export function readRaceEngineerState(): RaceEngineerState {
  if (!isAudioScenariosInitialized()) return { initialized: false };

  return {
    initialized: true,
    // The lookup is inside the read too: it throws for an engine reset since the check above.
    engine: readStatePart(() => getScenarioEngine().describeState()),
    families: readFamilies(),
  };
}

/** A headline cell for a part that could not be read — never "idle" or "none", which are healthy answers. */
const readFailed = (part: StatePartError): string => `read failed: ${part.error}`;

/**
 * The rows the snapshot's Markdown companion leads the section with: the
 * voice, what holds the Voice bus, and how many callouts wait across the
 * buses. One row saying so when the engine is not initialized.
 *
 * A part that failed says so in its own row: all three when the engine could
 * not describe itself, the voice row alone when only the voice accessor
 * threw. Families have no row of their own, so any that could not be read
 * are named in one more row, present only then.
 */
export function raceEngineerStateHeadline(state: RaceEngineerState): Array<readonly [string, string]> {
  if (!state.initialized) return [["Race Engineer", "not initialized"]];

  const { engine, families } = state;
  const rows: Array<readonly [string, string]> = [];

  if (isStatePartError(engine)) {
    const failed = readFailed(engine);

    rows.push(["Race Engineer voice", failed], ["Voice bus", failed], ["Waiting callouts", failed]);
  } else {
    const { activeVoice, buses } = engine;
    const voiceBus = buses.find((b) => b.bus === "Voice");
    const waiting = buses.reduce((count, b) => count + b.waiting.length, 0);

    rows.push(
      ["Race Engineer voice", isStatePartError(activeVoice) ? readFailed(activeVoice) : (activeVoice ?? "none")],
      ["Voice bus", voiceBus?.playingId ?? "idle"],
      ["Waiting callouts", String(waiting)],
    );
  }

  const unreadable = Object.entries(families)
    .filter(([, part]) => isStatePartError(part))
    .map(([family]) => family);

  if (unreadable.length > 0) rows.push(["Unreadable families", unreadable.join(", ")]);

  return rows;
}
