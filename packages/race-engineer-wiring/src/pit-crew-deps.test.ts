import {
  AUTO_FUEL_CALLOUT_SETTING_KEYS,
  CAUTION_CALLOUT_SETTING_KEYS,
  CORNER_NAME_CALLOUT_SETTING_KEYS,
  DAMAGE_CALLOUT_SETTING_KEYS,
  FLAG_CALLOUT_SETTING_KEYS,
  FUEL_CALLOUT_SETTING_KEYS,
  GAP_CALLOUT_SETTING_KEYS,
  INCIDENT_CALLOUT_SETTING_KEYS,
  LAP_TIME_CALLOUT_SETTING_KEYS,
  NO_LIMITER_CALLOUT_SETTING_KEYS,
  OPPONENT_FLAG_CALLOUT_SETTING_KEYS,
  OPPONENT_PIT_CALLOUT_SETTING_KEYS,
  OVERTAKE_CALLOUT_SETTING_KEYS,
  PIT_BOX_CALLOUT_SETTING_KEYS,
  PIT_LIMITER_CALLOUT_SETTING_KEYS,
  PIT_READBACK_CALLOUT_SETTING_KEYS,
  PIT_SPEEDING_CALLOUT_SETTING_KEYS,
  PIT_STATUS_CALLOUT_SETTING_KEYS,
  PIT_WINDOW_CALLOUT_SETTING_KEYS,
  type PitCrewDeps,
  POSITION_CALLOUT_SETTING_KEYS,
  QUALIFYING_INVALIDATION_CALLOUT_SETTING_KEYS,
  RACE_END_CALLOUT_SETTING_KEYS,
  RACE_START_CALLOUT_SETTING_KEYS,
  RACE_STATUS_CALLOUT_SETTING_KEYS,
  ROLLING_START_CALLOUT_SETTING_KEYS,
  SESSION_START_CALLOUT_SETTING_KEYS,
  SPOTTER_CALLOUT_SETTING_KEYS,
  START_LIGHT_CALLOUT_SETTING_KEYS,
  TIRE_WEAR_CALLOUT_SETTING_KEYS,
  TRACK_CONDITIONS_CALLOUT_SETTING_KEYS,
} from "@iracedeck/audio-scenarios/pit-crew";
import { evaluateSetupWarning } from "@iracedeck/deck-core";
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

function fakeDeps(extra: Partial<RaceEngineerWiringDeps> = {}): RaceEngineerWiringDeps {
  return { logger: silentLogger, sim: fakeSim(), voice: { driverNames: ["adam"] }, ...extra };
}

const noCaches: RaceEngineerCaches = {
  lapCompleted: () => null,
  cornerName: () => null,
  raceFinished: () => null,
  lastIncidentAt: () => null,
};

/** The 30 per-family opt-ins (#1350 replaces them; until then each reads its own key, absent = on). */
const GATES: [keyof PitCrewDeps, Readonly<Record<string, string>>][] = [
  ["getAutoFuelCalloutEnabled", AUTO_FUEL_CALLOUT_SETTING_KEYS],
  ["getCautionCalloutEnabled", CAUTION_CALLOUT_SETTING_KEYS],
  ["getCornerNameCalloutEnabled", CORNER_NAME_CALLOUT_SETTING_KEYS],
  ["getDamageCalloutEnabled", DAMAGE_CALLOUT_SETTING_KEYS],
  ["getFlagCalloutEnabled", FLAG_CALLOUT_SETTING_KEYS],
  ["getFuelCalloutEnabled", FUEL_CALLOUT_SETTING_KEYS],
  ["getGapCalloutEnabled", GAP_CALLOUT_SETTING_KEYS],
  ["getIncidentCalloutEnabled", INCIDENT_CALLOUT_SETTING_KEYS],
  ["getLapTimeCalloutEnabled", LAP_TIME_CALLOUT_SETTING_KEYS],
  ["getNoLimiterCalloutEnabled", NO_LIMITER_CALLOUT_SETTING_KEYS],
  ["getOpponentFlagCalloutEnabled", OPPONENT_FLAG_CALLOUT_SETTING_KEYS],
  ["getOpponentPitCalloutEnabled", OPPONENT_PIT_CALLOUT_SETTING_KEYS],
  ["getOvertakeCalloutEnabled", OVERTAKE_CALLOUT_SETTING_KEYS],
  ["getPitBoxCalloutEnabled", PIT_BOX_CALLOUT_SETTING_KEYS],
  ["getPitLimiterCalloutEnabled", PIT_LIMITER_CALLOUT_SETTING_KEYS],
  ["getPitReadbackEnabled", PIT_READBACK_CALLOUT_SETTING_KEYS],
  ["getPitSpeedingCalloutEnabled", PIT_SPEEDING_CALLOUT_SETTING_KEYS],
  ["getPitStatusCalloutEnabled", PIT_STATUS_CALLOUT_SETTING_KEYS],
  ["getPitWindowCalloutEnabled", PIT_WINDOW_CALLOUT_SETTING_KEYS],
  ["getPositionCalloutEnabled", POSITION_CALLOUT_SETTING_KEYS],
  ["getQualifyingInvalidationCalloutEnabled", QUALIFYING_INVALIDATION_CALLOUT_SETTING_KEYS],
  ["getRaceEndCalloutEnabled", RACE_END_CALLOUT_SETTING_KEYS],
  ["getRaceStartCalloutEnabled", RACE_START_CALLOUT_SETTING_KEYS],
  ["getRaceStatusCalloutEnabled", RACE_STATUS_CALLOUT_SETTING_KEYS],
  ["getRollingStartCalloutEnabled", ROLLING_START_CALLOUT_SETTING_KEYS],
  ["getSessionStartCalloutEnabled", SESSION_START_CALLOUT_SETTING_KEYS],
  ["getSpotterCalloutEnabled", SPOTTER_CALLOUT_SETTING_KEYS],
  ["getStartLightCalloutEnabled", START_LIGHT_CALLOUT_SETTING_KEYS],
  ["getTireWearCalloutEnabled", TIRE_WEAR_CALLOUT_SETTING_KEYS],
  ["getTrackConditionsCalloutEnabled", TRACK_CONDITIONS_CALLOUT_SETTING_KEYS],
];

describe("buildPitCrewDeps", () => {
  beforeEach(() => {
    stored.current = {};
  });
  afterEach(() => vi.restoreAllMocks());

  it("builds all 58 dependencies, so none falls back to DEFAULT_DEPS", () => {
    const built = buildPitCrewDeps(fakeDeps(), noCaches);

    expect(Object.keys(built)).toHaveLength(58);

    for (const [key, value] of Object.entries(built)) expect(value, key).toBeDefined();
  });

  it("covers 30 family gates", () => {
    expect(GATES).toHaveLength(30);
  });

  it.each(GATES)("%s reads its own key per id, live, and an absent key means on", (depKey, keys) => {
    const gate = buildPitCrewDeps(fakeDeps(), noCaches)[depKey] as (id: string) => boolean;

    for (const id of Object.keys(keys)) expect(gate(id), `${String(depKey)}(${id}) with nothing stored`).toBe(true);

    for (const [id, key] of Object.entries(keys)) {
      stored.current = { [key]: false };

      expect(gate(id), `${String(depKey)}(${id}) with ${key}=false`).toBe(false);

      for (const [other, otherKey] of Object.entries(keys)) {
        if (otherKey !== key) expect(gate(other), `${String(depKey)}(${other}) must not read ${key}`).toBe(true);
      }
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

  it("reads pit service requests from its own key", () => {
    const built = buildPitCrewDeps(fakeDeps(), noCaches);

    expect(built.getPitServiceRequestsEnabled()).toBe(true);
    stored.current = { calloutEnabledPitServiceRequests: false };
    expect(built.getPitServiceRequestsEnabled()).toBe(false);
  });

  it("asks deck-core's setup-warning rule with the live settings and setup name (#625)", () => {
    vi.mocked(evaluateSetupWarning).mockReturnValue(true);
    stored.current = { setupWarningEnabled: true };
    const sim = fakeSim({ getDriverSetupName: () => "race-dry.sto" });

    expect(buildPitCrewDeps(fakeDeps({ sim }), noCaches).getSetupWarningMismatch("qualifying")).toBe(true);
    expect(evaluateSetupWarning).toHaveBeenCalledWith("qualifying", stored.current, "race-dry.sto");
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
