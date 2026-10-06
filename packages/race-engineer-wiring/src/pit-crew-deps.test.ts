import { _resetGlobalSettings, evaluateSetupWarning, updateGlobalSettings } from "@iracedeck/deck-core";
import { silentLogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RaceEngineerCaches } from "./caches.js";
import { buildPitCrewDeps } from "./pit-crew-deps.js";
import type { SimRuntime } from "./sim-runtime.js";
import type { RaceEngineerWiringDeps } from "./wire-race-engineer.js";

// The settings the gates read, swapped per test. The gates call deck-core's
// getGlobalSettings() at call time, so a change applies to an already-built gate.
const stored = vi.hoisted((): { current: Record<string, unknown> } => ({ current: {} }));

// Only the two reads are replaced; resolveActiveDriverName stays real (it reads
// deck-core's own cache, whose schema default names no driver).
vi.mock("@iracedeck/deck-core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGlobalSettings: vi.fn(() => stored.current),
  evaluateSetupWarning: vi.fn(() => false),
}));

/** A sim whose every getter is a spy returning `null`; a test overrides the one it reads. */
function fakeSim(overrides: Partial<Record<keyof SimRuntime, unknown>> = {}): SimRuntime {
  return new Proxy({} as SimRuntime, {
    get: (_t, name: string) => (name in overrides ? overrides[name as keyof SimRuntime] : vi.fn(() => null)),
  });
}

type BuildDeps = Omit<RaceEngineerWiringDeps, "overrides">;

function fakeDeps(extra: Partial<BuildDeps> = {}): BuildDeps {
  return { logger: silentLogger, sim: fakeSim(), voice: { driverNames: ["adam"] }, ...extra };
}

const noCaches: RaceEngineerCaches = {
  lapCompleted: () => null,
  cornerName: () => null,
  raceFinished: () => null,
  lastIncidentAt: () => null,
};

describe("buildPitCrewDeps", () => {
  beforeEach(() => {
    stored.current = {};
    // restoreAllMocks below only undoes spies; the two deck-core vi.fn mocks
    // keep their call history unless it is cleared here.
    vi.clearAllMocks();
  });
  afterEach(() => vi.restoreAllMocks());

  it("builds all 28 dependencies, so none falls back to DEFAULT_DEPS", () => {
    const built = buildPitCrewDeps(fakeDeps(), noCaches);

    expect(Object.keys(built)).toHaveLength(28);

    for (const [key, value] of Object.entries(built)) expect(value, key).toBeDefined();
  });

  it("passes deck-core's callout lookup, live: an on key, an off key and an off-default key (#1350)", () => {
    // `isCalloutEnabled` reads deck-core's own settings cache, not the mocked
    // `getGlobalSettings` above, so the settings are changed through the real
    // update path and reset afterwards.
    const { isCalloutEnabled } = buildPitCrewDeps(fakeDeps(), noCaches);

    try {
      expect(isCalloutEnabled("calloutEnabledFlagGreen"), "an on-default key").toBe(true);
      expect(isCalloutEnabled("calloutEnabledFuelLapsLeft10"), "an off-default key").toBe(false);
      updateGlobalSettings({ calloutEnabledFlagGreen: false, calloutEnabledFuelLapsLeft10: true });
      expect(isCalloutEnabled("calloutEnabledFlagGreen"), "switched off").toBe(false);
      expect(isCalloutEnabled("calloutEnabledFuelLapsLeft10"), "switched on").toBe(true);
    } finally {
      _resetGlobalSettings();
    }
  });

  it("reads the master gates as opt-in: only an explicit true is on", () => {
    const built = buildPitCrewDeps(fakeDeps(), noCaches);

    expect(built.getRaceEngineerMasterEnabled()).toBe(false);
    expect(built.getRadarMasterEnabled()).toBe(false);
    stored.current = { pitCrewRaceEngineerEnabled: true, pitCrewRadarEnabled: true };
    expect(built.getRaceEngineerMasterEnabled()).toBe(true);
    expect(built.getRadarMasterEnabled()).toBe(true);
  });

  it("asks deck-core's setup-warning rule with the live settings and setup name (#625)", () => {
    vi.mocked(evaluateSetupWarning).mockReturnValueOnce(true);
    stored.current = { setupWarningEnabled: true };
    const sim = fakeSim({ getDriverSetupName: () => "race-dry.sto" });

    expect(buildPitCrewDeps(fakeDeps({ sim }), noCaches).getSetupWarningMismatch("qualifying")).toBe(true);
    expect(evaluateSetupWarning).toHaveBeenCalledExactlyOnceWith("qualifying", stored.current, "race-dry.sto");
  });

  it("makes the PitCrewScenarios logger a scope of its own", () => {
    const scoped = { ...silentLogger };
    const logger = { ...silentLogger, createScope: vi.fn(() => scoped) };

    expect(buildPitCrewDeps(fakeDeps({ logger }), noCaches).logger).toBe(scoped);
    expect(logger.createScope).toHaveBeenCalledWith("PitCrewScenarios");
  });

  it("briefs a session start with 'driver' when the voices carry no name clip (#1284)", () => {
    const sim = fakeSim({ getSessionStartConditions: () => ({ trackName: "spa" }) });
    const built = buildPitCrewDeps(fakeDeps({ sim, voice: { driverNames: [] } }), noCaches);

    expect(built.getSessionStartSnapshot()).toEqual({ trackName: "spa", driverName: "driver" });
  });

  it("reads the driver-name list live, so a rescan reaches an already-built resolver", () => {
    const voice = { driverNames: [] as string[] };
    const caches = { ...noCaches, raceFinished: () => ({ position: 2 }) };
    const built = buildPitCrewDeps(fakeDeps({ voice }), caches);

    expect(built.getRaceFinishedSnapshot(), "no name clips: no race-finished snapshot").toBeNull();
    voice.driverNames = ["adam"];
    expect(built.getRaceFinishedSnapshot()).toEqual({ position: 2, driverName: "adam" });
  });

  it("composes the overtake gate from telemetry and the last incident", () => {
    vi.spyOn(Date, "now").mockReturnValue(5_000);
    const sim = fakeSim({ getOvertakeTelemetryGate: () => ({ speed: 50 }) });
    const caches = { ...noCaches, lastIncidentAt: () => 3_000 };

    expect(buildPitCrewDeps(fakeDeps({ sim }), caches).getOvertakeGate()).toEqual({
      speed: 50,
      msSinceIncident: 2_000,
    });
  });

  it("reads a pending car's live position in the projection it was classified in", () => {
    const sim = fakeSim({ getLiveCarPosition: () => ({ position: 7, classPosition: 2 }) });
    const built = buildPitCrewDeps(fakeDeps({ sim }), noCaches);

    expect(built.getOpponentPitLivePosition({ carIdx: 4, position: 9, isMultiClass: true })).toBe(2);
    expect(built.getOpponentFlagLivePosition({ carIdx: 4, position: 9, isMultiClass: false })).toBe(7);
  });
});
