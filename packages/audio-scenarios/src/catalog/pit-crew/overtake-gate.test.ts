/**
 * Unit tests for the overtake callout gate (issue #574 follow-up).
 */
import { describe, expect, it } from "vitest";

import {
  OVERTAKE_MIN_SPEED_KMH,
  OVERTAKE_RECENT_INCIDENT_MS,
  overtakeContextAllows,
  type OvertakeGate,
  PERMISSIVE_OVERTAKE_GATE,
} from "./overtake-gate.js";

function gate(overrides: Partial<OvertakeGate> = {}): OvertakeGate {
  return {
    carsAlongside: false,
    onTrack: true,
    speedKmh: 120,
    onPitRoad: false,
    msSinceIncident: null,
    ...overrides,
  };
}

describe("overtakeContextAllows", () => {
  it("allows a clean racing moment", () => {
    expect(overtakeContextAllows(gate())).toBe(true);
    expect(overtakeContextAllows(PERMISSIVE_OVERTAKE_GATE)).toBe(true);
  });

  it("suppresses when telemetry is unavailable (null)", () => {
    expect(overtakeContextAllows(null)).toBe(false);
  });

  it("suppresses when a car is alongside", () => {
    expect(overtakeContextAllows(gate({ carsAlongside: true }))).toBe(false);
  });

  it("suppresses when off track", () => {
    expect(overtakeContextAllows(gate({ onTrack: false }))).toBe(false);
  });

  it("suppresses below the speed floor, allows at/above it", () => {
    expect(overtakeContextAllows(gate({ speedKmh: OVERTAKE_MIN_SPEED_KMH - 1 }))).toBe(false);
    expect(overtakeContextAllows(gate({ speedKmh: OVERTAKE_MIN_SPEED_KMH }))).toBe(true);
  });

  it("suppresses on pit road", () => {
    expect(overtakeContextAllows(gate({ onPitRoad: true }))).toBe(false);
  });

  it("suppresses within the recent-incident window, allows outside it", () => {
    expect(overtakeContextAllows(gate({ msSinceIncident: OVERTAKE_RECENT_INCIDENT_MS - 1 }))).toBe(false);
    expect(overtakeContextAllows(gate({ msSinceIncident: OVERTAKE_RECENT_INCIDENT_MS }))).toBe(true);
    expect(overtakeContextAllows(gate({ msSinceIncident: null }))).toBe(true);
  });
});
