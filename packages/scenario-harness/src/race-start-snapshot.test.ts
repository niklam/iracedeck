/**
 * Tests for the harness race-start snapshot store + validator (issue #568).
 */
import type { RaceStartSnapshot } from "@iracedeck/event-bus";
import { TrackWetness } from "@iracedeck/event-bus";
import { afterEach, describe, expect, it } from "vitest";

import {
  getHarnessRaceStartSnapshot,
  setHarnessRaceStartSnapshot,
  validateRaceStartSnapshot,
} from "./race-start-snapshot.js";

const VALID: RaceStartSnapshot = {
  driverName: "niklas",
  trackTemp: 28,
  airTemp: 20,
  tempUnit: "celsius",
  wetness: TrackWetness.Dry,
  playerCarPosition: 7,
};

afterEach(() => {
  setHarnessRaceStartSnapshot(null);
});

describe("race-start snapshot store", () => {
  it("starts null and round-trips a snapshot through get/set", () => {
    expect(getHarnessRaceStartSnapshot()).toBeNull();

    setHarnessRaceStartSnapshot(VALID);
    expect(getHarnessRaceStartSnapshot()).toEqual(VALID);

    setHarnessRaceStartSnapshot(null);
    expect(getHarnessRaceStartSnapshot()).toBeNull();
  });
});

describe("validateRaceStartSnapshot", () => {
  it("accepts a well-formed snapshot", () => {
    expect(validateRaceStartSnapshot(VALID)).toEqual(VALID);
  });

  it("accepts an omitted playerCarPosition (missing-position branch)", () => {
    const { playerCarPosition: _omit, ...withoutPosition } = VALID;
    const result = validateRaceStartSnapshot(withoutPosition);

    expect(typeof result).not.toBe("string");
    expect((result as RaceStartSnapshot).playerCarPosition).toBeUndefined();
  });

  it("normalizes null playerCarPosition to undefined", () => {
    const result = validateRaceStartSnapshot({ ...VALID, playerCarPosition: null });

    expect(typeof result).not.toBe("string");
    expect((result as RaceStartSnapshot).playerCarPosition).toBeUndefined();
  });

  it.each([
    ["non-object body", 42, "body must be an object"],
    ["missing driverName", { ...VALID, driverName: "" }, "driverName must be a non-empty string"],
    ["non-numeric trackTemp", { ...VALID, trackTemp: "28" }, "trackTemp must be a finite number"],
    ["non-numeric airTemp", { ...VALID, airTemp: NaN }, "airTemp must be a finite number"],
    ["bad tempUnit", { ...VALID, tempUnit: "kelvin" }, "tempUnit must be one of: celsius, fahrenheit"],
    ["wetness out of range", { ...VALID, wetness: TrackWetness.Unknown }, /wetness must be a TrackWetness/],
    ["non-integer wetness", { ...VALID, wetness: 2.5 }, /wetness must be a TrackWetness/],
    ["zero playerCarPosition", { ...VALID, playerCarPosition: 0 }, /playerCarPosition must be a positive integer/],
    ["negative playerCarPosition", { ...VALID, playerCarPosition: -3 }, /playerCarPosition must be a positive integer/],
    [
      "non-integer playerCarPosition",
      { ...VALID, playerCarPosition: 3.5 },
      /playerCarPosition must be a positive integer/,
    ],
  ])("rejects %s", (_label, body, expected) => {
    const result = validateRaceStartSnapshot(body);
    expect(typeof result).toBe("string");

    if (typeof expected === "string") {
      expect(result).toBe(expected);
    } else {
      expect(result as string).toMatch(expected);
    }
  });
});
