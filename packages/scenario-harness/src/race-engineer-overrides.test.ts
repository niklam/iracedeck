/**
 * The harness's Race Engineer overrides (#1349 slice 2): exactly the three
 * snapshot stubs, each answering what its harness store holds.
 */
import type { QualifyingInvalidationSnapshot } from "@iracedeck/audio-scenarios/pit-crew";
import { type RaceStartSnapshot, type SessionStartSnapshot, TrackWetness } from "@iracedeck/event-bus";
import { afterEach, describe, expect, it } from "vitest";

import { setHarnessQualifyingInvalidationSnapshot } from "./qualifying-invalidation-snapshot.js";
import { harnessRaceEngineerOverrides } from "./race-engineer-overrides.js";
import { setHarnessRaceStartSnapshot } from "./race-start-snapshot.js";
import { setHarnessSessionStartSnapshot } from "./session-start-snapshot.js";

const SESSION_START: SessionStartSnapshot = {
  driverName: "niklas",
  sessionType: "race",
  pitSpeedLimit: 80,
  speedUnit: "kmh",
  trackTemp: 28,
  airTemp: 20,
  tempUnit: "celsius",
  wetness: TrackWetness.Dry,
};

const RACE_START: RaceStartSnapshot = {
  driverName: "niklas",
  trackTemp: 28,
  airTemp: 20,
  tempUnit: "celsius",
  wetness: TrackWetness.Dry,
  playerCarPosition: 4,
};

const QUALIFYING_INVALIDATION: QualifyingInvalidationSnapshot = {
  sessionType: "qualifying",
  sessionNum: 1,
  lapsRemaining: 2,
  lapLimited: true,
  lapCompleted: 1,
  lapStartedFromPits: false,
  lapCounted: true,
};

describe("harnessRaceEngineerOverrides", () => {
  afterEach(() => {
    setHarnessSessionStartSnapshot(null);
    setHarnessRaceStartSnapshot(null);
    setHarnessQualifyingInvalidationSnapshot(null);
  });

  it("replaces exactly the three snapshot getters and nothing the wiring builds", () => {
    expect(Object.keys(harnessRaceEngineerOverrides()).sort()).toEqual([
      "getQualifyingInvalidationSnapshot",
      "getRaceStartSnapshot",
      "getSessionStartSnapshot",
    ]);
  });

  it("answers the session-start snapshot the harness store holds", () => {
    const overrides = harnessRaceEngineerOverrides();

    expect(overrides.getSessionStartSnapshot?.()).toBeNull();
    setHarnessSessionStartSnapshot(SESSION_START);
    expect(overrides.getSessionStartSnapshot?.()).toBe(SESSION_START);
  });

  it("answers the race-start snapshot the harness store holds", () => {
    const overrides = harnessRaceEngineerOverrides();

    expect(overrides.getRaceStartSnapshot?.()).toBeNull();
    setHarnessRaceStartSnapshot(RACE_START);
    expect(overrides.getRaceStartSnapshot?.()).toBe(RACE_START);
  });

  it("answers the qualifying-invalidation snapshot the harness store holds", () => {
    const overrides = harnessRaceEngineerOverrides();

    expect(overrides.getQualifyingInvalidationSnapshot?.()).toBeNull();
    setHarnessQualifyingInvalidationSnapshot(QUALIFYING_INVALIDATION);
    expect(overrides.getQualifyingInvalidationSnapshot?.()).toBe(QUALIFYING_INVALIDATION);
  });
});
