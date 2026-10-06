/**
 * The harness's Race Engineer, wired the way `main.ts` wires it (#1349 slice 2).
 *
 * The wiring now reads real settings where the harness used to run on the
 * `() => true` defaults, so a gate the harness's seed leaves closed would
 * silence a whole shortcut family. Booted against the seeded memory store,
 * both master gates (`=== true`, seeded on) and a sample of family gates
 * (`!== false`, never seeded) must read open.
 */
import { type PitCrewDeps, registerPitCrew } from "@iracedeck/audio-scenarios/pit-crew";
import {
  _resetGlobalSettings,
  createMemorySettingsStore,
  initGlobalSettings,
  updateGlobalSettings,
  whenSettingsStoreSettled,
} from "@iracedeck/deck-core";
import { _resetEventBus, initializeEventBus } from "@iracedeck/event-bus";
import { silentLogger } from "@iracedeck/logger";
import { createIracingSimRuntime, wireRaceEngineer } from "@iracedeck/race-engineer-wiring";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { seedGlobalSettings } from "./bootstrap-settings.js";
import { MockPlatformAdapter } from "./mock-platform-adapter.js";
import { harnessRaceEngineerOverrides } from "./race-engineer-overrides.js";

vi.mock("@iracedeck/audio-scenarios/pit-crew", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerPitCrew: vi.fn(),
}));

describe("the harness's Race Engineer wiring", () => {
  let overrides: Partial<PitCrewDeps>;
  let passed: PitCrewDeps;

  beforeEach(async () => {
    vi.clearAllMocks();

    const bus = initializeEventBus(silentLogger);
    const adapter = new MockPlatformAdapter(silentLogger);
    const { driverNames } = seedGlobalSettings(adapter);

    overrides = harnessRaceEngineerOverrides();
    wireRaceEngineer(bus, {
      logger: silentLogger.createScope("RaceEngineer"),
      sim: createIracingSimRuntime(),
      voice: { driverNames },
      overrides,
    });

    // Late, as in `main.ts`: the gates read settings when a callout fires.
    initGlobalSettings(adapter, silentLogger, createMemorySettingsStore());
    await whenSettingsStoreSettled();

    expect(vi.mocked(registerPitCrew)).toHaveBeenCalledOnce();
    passed = vi.mocked(registerPitCrew).mock.calls[0][1] as PitCrewDeps;
  });

  afterEach(() => {
    _resetGlobalSettings();
    _resetEventBus();
  });

  it("opens both master gates from the seeded settings", () => {
    expect(passed.getRaceEngineerMasterEnabled?.()).toBe(true);
    expect(passed.getRadarMasterEnabled?.()).toBe(true);
  });

  it("opens the family gates the seed never names", () => {
    expect(passed.getCautionCalloutEnabled?.("follow")).toBe(true);
    expect(passed.getFlagCalloutEnabled?.("green")).toBe(true);
    expect(passed.getDamageCalloutEnabled?.("repair-needed")).toBe(true);
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
    expect(passed.getCautionCalloutEnabled?.("follow")).toBe(false);
    expect(passed.getFlagCalloutEnabled?.("green")).toBe(false);
    expect(passed.getDamageCalloutEnabled?.("repair-needed")).toBe(false);
  });

  it("passes the harness's snapshot stubs as the three snapshot getters", () => {
    expect(passed.getSessionStartSnapshot).toBe(overrides.getSessionStartSnapshot);
    expect(passed.getRaceStartSnapshot).toBe(overrides.getRaceStartSnapshot);
    expect(passed.getQualifyingInvalidationSnapshot).toBe(overrides.getQualifyingInvalidationSnapshot);
  });
});
