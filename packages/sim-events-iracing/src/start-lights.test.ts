/**
 * Unit tests for the start-light session-YAML helpers (issue #480).
 */
import { describe, expect, it } from "vitest";

import { resolveIsAiRace, resolveStandingStart } from "./start-lights.js";

describe("resolveStandingStart", () => {
  it("returns true when WeekendOptions.StandingStart === 1", () => {
    expect(resolveStandingStart({ WeekendInfo: { WeekendOptions: { StandingStart: 1 } } })).toBe(true);
  });

  it("returns false when StandingStart === 0 (rolling)", () => {
    expect(resolveStandingStart({ WeekendInfo: { WeekendOptions: { StandingStart: 0 } } })).toBe(false);
  });

  it("returns false for null session info", () => {
    expect(resolveStandingStart(null)).toBe(false);
  });

  it("returns false when the field is missing", () => {
    expect(resolveStandingStart({ WeekendInfo: { WeekendOptions: {} } })).toBe(false);
    expect(resolveStandingStart({ WeekendInfo: {} })).toBe(false);
    expect(resolveStandingStart({})).toBe(false);
  });

  it("returns false for malformed shapes", () => {
    expect(resolveStandingStart({ WeekendInfo: "nope" } as unknown as Record<string, unknown>)).toBe(false);
    expect(
      resolveStandingStart({ WeekendInfo: { WeekendOptions: { StandingStart: "1" } } } as Record<string, unknown>),
    ).toBe(false);
  });
});

describe("resolveIsAiRace", () => {
  it("returns true when any driver has CarIsAI === 1", () => {
    expect(
      resolveIsAiRace({
        DriverInfo: { Drivers: [{ CarIsAI: 0 }, { CarIsAI: 1 }, { CarIsAI: 0 }] },
      }),
    ).toBe(true);
  });

  it("returns false when all drivers are human", () => {
    expect(resolveIsAiRace({ DriverInfo: { Drivers: [{ CarIsAI: 0 }, { CarIsAI: 0 }] } })).toBe(false);
  });

  it("ignores the AI pace car (human field with an AI pace car is not an AI race)", () => {
    expect(
      resolveIsAiRace({
        DriverInfo: {
          Drivers: [{ CarIsAI: 0 }, { CarIsAI: 1, CarIsPaceCar: 1 }],
        },
      }),
    ).toBe(false);
  });

  it("returns false for null session info", () => {
    expect(resolveIsAiRace(null)).toBe(false);
  });

  it("returns false when Drivers is absent / not an array", () => {
    expect(resolveIsAiRace({ DriverInfo: {} })).toBe(false);
    expect(resolveIsAiRace({ DriverInfo: { Drivers: "nope" } } as unknown as Record<string, unknown>)).toBe(false);
    expect(resolveIsAiRace({})).toBe(false);
  });

  it("returns false for malformed driver entries", () => {
    expect(resolveIsAiRace({ DriverInfo: { Drivers: [null, { CarIsAI: "1" }] } } as Record<string, unknown>)).toBe(
      false,
    );
  });
});
