/**
 * The harness's Race Engineer wiring (#1349 slice 2): the one call `main.ts`
 * makes and `race-engineer-wiring.test.ts` checks, so the test cannot drift
 * from what the harness boots.
 */
import { type AudioAssetsManifest, scanDriverNames, scanRaceEngineerVoices } from "@iracedeck/audio-scenarios";
import type { PitCrewDeps } from "@iracedeck/audio-scenarios/pit-crew";
import type { IEventBus } from "@iracedeck/event-bus";
import type { ILogger } from "@iracedeck/logger";
import { createIracingSimRuntime, wireRaceEngineer } from "@iracedeck/race-engineer-wiring";

import { harnessRaceEngineerOverrides } from "./race-engineer-overrides.js";

/**
 * The voice lists the harness keeps, the plugins' voice-pack state in
 * miniature: seeded from the bundled manifest, replaced on every manifest
 * merge, and read live — the engine's voice resolver reads
 * `raceEngineerVoices`, and the wiring reads `driverNames` on every call.
 */
export type HarnessVoiceState = {
  raceEngineerVoices: readonly string[];
  driverNames: readonly string[];
};

/**
 * Rescan both lists from a merged manifest (bundled plus every installed
 * pack's clips), as the plugins' `applyManifest` does in
 * `plugin-runtime/src/phases/voice-packs.ts`, with the same two scanners.
 */
export function applyMergedManifest(voices: HarnessVoiceState, merged: AudioAssetsManifest): void {
  voices.raceEngineerVoices = scanRaceEngineerVoices(merged);
  voices.driverNames = scanDriverNames(merged);
}

/**
 * The plugins' `wireRaceEngineer` with the harness's arguments: a
 * `RaceEngineer` scope of the harness logger, the iRacing sim runtime over the
 * running translator, the live voice state, and the three snapshot stubs as
 * the only overrides. Returns the dependencies it registered.
 */
export function wireHarnessRaceEngineer(
  bus: IEventBus,
  logger: ILogger,
  voices: HarnessVoiceState,
): Readonly<PitCrewDeps> {
  return wireRaceEngineer(bus, {
    logger: logger.createScope("RaceEngineer"),
    sim: createIracingSimRuntime(),
    voice: voices,
    overrides: harnessRaceEngineerOverrides(),
  });
}
