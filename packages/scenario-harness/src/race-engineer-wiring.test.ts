/**
 * The harness's Race Engineer, wired by the call `main.ts` makes (#1349 slice 2).
 *
 * The wiring now reads real settings where the harness used to run on the
 * `() => true` defaults, so a gate the harness's seed leaves closed would
 * silence a whole shortcut family. Booted against the seeded memory store,
 * both master gates (`=== true`, seeded on) and a sample of callout keys
 * through the one `isCalloutEnabled` lookup (`!== false`, never seeded) must
 * read open.
 */
import type { AudioAssetsManifest } from "@iracedeck/audio-scenarios";
import {
  type PitCrewDeps,
  type QualifyingInvalidationSnapshot,
  registerPitCrew,
} from "@iracedeck/audio-scenarios/pit-crew";
import {
  _resetEventBus,
  initializeEventBus,
  type RaceStartSnapshot,
  type SessionStartSnapshot,
} from "@iracedeck/event-bus";
import { silentLogger } from "@iracedeck/logger";
import {
  _resetGlobalSettings,
  createMemorySettingsStore,
  initGlobalSettings,
  updateGlobalSettings,
  whenSettingsStoreSettled,
} from "@iracedeck/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAudioAssetsManifest, seedGlobalSettings } from "./bootstrap-settings.js";
import { MockPlatformAdapter } from "./mock-platform-adapter.js";
import { setHarnessQualifyingInvalidationSnapshot } from "./qualifying-invalidation-snapshot.js";
import { applyMergedManifest, type HarnessVoiceState, wireHarnessRaceEngineer } from "./race-engineer-wiring.js";
import { setHarnessRaceStartSnapshot } from "./race-start-snapshot.js";
import { setHarnessSessionStartSnapshot } from "./session-start-snapshot.js";

// Registration itself is stubbed: `registerPitCrew` needs an initialised
// scenario engine, and it binds the radar, spotter and pit-speeding engines to
// the first bus it sees and refuses any other, while each test here starts a
// fresh bus and those engines' resets are not exported. The dependencies are
// read from what `wireHarnessRaceEngineer` returns, which is what it registers.
vi.mock("@iracedeck/audio-scenarios/pit-crew", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerPitCrew: vi.fn(),
}));

describe("the harness's Race Engineer wiring", () => {
  let voices: HarnessVoiceState;
  let passed: Readonly<PitCrewDeps>;

  beforeEach(async () => {
    vi.clearAllMocks();

    const bus = initializeEventBus(silentLogger);
    const adapter = new MockPlatformAdapter(silentLogger);
    voices = seedGlobalSettings(adapter);

    passed = wireHarnessRaceEngineer(bus, silentLogger, voices);

    // Late, as in `main.ts`: the gates read settings when a callout fires.
    initGlobalSettings(adapter, silentLogger, createMemorySettingsStore());
    await whenSettingsStoreSettled();

    expect(vi.mocked(registerPitCrew)).toHaveBeenCalledExactlyOnceWith(bus, passed);
  });

  afterEach(() => {
    setHarnessSessionStartSnapshot(null);
    setHarnessRaceStartSnapshot(null);
    setHarnessQualifyingInvalidationSnapshot(null);
    _resetGlobalSettings();
    _resetEventBus();
  });

  it("opens both master gates from the seeded settings", () => {
    expect(passed.getRaceEngineerMasterEnabled?.()).toBe(true);
    expect(passed.getRadarMasterEnabled?.()).toBe(true);
  });

  it("opens the callout keys the seed never names", () => {
    expect(passed.isCalloutEnabled?.("calloutEnabledCautionFollow")).toBe(true);
    expect(passed.isCalloutEnabled?.("calloutEnabledFlagGreen")).toBe(true);
    expect(passed.isCalloutEnabled?.("calloutEnabledDamageRepairNeeded")).toBe(true);
  });

  it("reads those gates from the live settings, so the harness can close them", () => {
    updateGlobalSettings({
      pitCrewRaceEngineerEnabled: false,
      pitCrewRadarEnabled: false,
      calloutEnabledCautionFollow: false,
      calloutEnabledFlagGreen: false,
      calloutEnabledDamageRepairNeeded: false,
    });

    expect(passed.getRaceEngineerMasterEnabled?.()).toBe(false);
    expect(passed.getRadarMasterEnabled?.()).toBe(false);
    expect(passed.isCalloutEnabled?.("calloutEnabledCautionFollow")).toBe(false);
    expect(passed.isCalloutEnabled?.("calloutEnabledFlagGreen")).toBe(false);
    expect(passed.isCalloutEnabled?.("calloutEnabledDamageRepairNeeded")).toBe(false);
  });

  it("passes the harness's snapshot stubs as the three snapshot getters", () => {
    // Each answers whatever the UI last posted to its stub, which a getter the
    // wiring built from the translator would not. Objects stand in for the
    // snapshots: only their identity is under test.
    const sessionStart = {} as SessionStartSnapshot;
    const raceStart = {} as RaceStartSnapshot;
    const qualifyingInvalidation = {} as QualifyingInvalidationSnapshot;

    setHarnessSessionStartSnapshot(sessionStart);
    setHarnessRaceStartSnapshot(raceStart);
    setHarnessQualifyingInvalidationSnapshot(qualifyingInvalidation);

    expect(passed.getSessionStartSnapshot?.()).toBe(sessionStart);
    expect(passed.getRaceStartSnapshot?.()).toBe(raceStart);
    expect(passed.getQualifyingInvalidationSnapshot?.()).toBe(qualifyingInvalidation);
  });

  it("speaks a driver name an installed pack adds once its manifest is merged, as the plugins do", () => {
    // A name no bundled clip has, chosen in the settings: unavailable until a
    // merge brings its clip, then the one the overtake-lost line speaks.
    const bundled = getAudioAssetsManifest();
    const merged: AudioAssetsManifest = {
      ...bundled,
      clips: [...bundled.clips, "voice/pack-a::v1/names/zeppelin.mp3"],
    };
    updateGlobalSettings({ driverName: "zeppelin" });

    expect(passed.getOvertakeDriverName?.()).not.toBe("zeppelin");

    applyMergedManifest(voices, merged);

    expect(voices.driverNames).toContain("zeppelin");
    expect(passed.getOvertakeDriverName?.()).toBe("zeppelin");
  });
});
