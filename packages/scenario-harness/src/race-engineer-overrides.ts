/**
 * The Race Engineer dependencies the harness replaces (#1349 slice 2).
 *
 * The harness wires the Race Engineer through the plugins' own
 * `wireRaceEngineer`, and these three are the only dependencies it swaps. Each
 * snapshot is set from the UI (`/api/session-start/snapshot`,
 * `/api/race-start/snapshot`, `/api/qualifying-invalidation/snapshot`) or a
 * shortcut, fully composed, because the translator would build it from session
 * info and telemetry the harness does not drive. Every other dependency comes
 * from the wiring, so the harness cannot miss one.
 */
import type { PitCrewDeps } from "@iracedeck/audio-scenarios/pit-crew";

import { getHarnessQualifyingInvalidationSnapshot } from "./qualifying-invalidation-snapshot.js";
import { getHarnessRaceStartSnapshot } from "./race-start-snapshot.js";
import { getHarnessSessionStartSnapshot } from "./session-start-snapshot.js";

/** The harness's `overrides` for `wireRaceEngineer`: the three snapshot stubs, nothing else. */
export function harnessRaceEngineerOverrides(): Partial<PitCrewDeps> {
  return {
    getSessionStartSnapshot: () => getHarnessSessionStartSnapshot(),
    getRaceStartSnapshot: () => getHarnessRaceStartSnapshot(),
    getQualifyingInvalidationSnapshot: () => getHarnessQualifyingInvalidationSnapshot(),
  };
}
