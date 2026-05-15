/**
 * Tests for the harness session-start snapshot store + validator (issue #542).
 */
import type { SessionStartSnapshot } from "@iracedeck/event-bus";
import { TrackWetness } from "@iracedeck/event-bus";
import { afterEach, describe, expect, it } from "vitest";

import {
  getHarnessSessionStartSnapshot,
  setHarnessSessionStartSnapshot,
  validateSessionStartSnapshot,
} from "./session-start-snapshot.js";

const VALID: SessionStartSnapshot = {
  driverName: "niklas",
  sessionType: "race",
  pitSpeedLimit: 80,
  speedUnit: "kmh",
  trackTemp: 28,
  airTemp: 20,
  tempUnit: "celsius",
  wetness: TrackWetness.MostlyDry,
};

afterEach(() => {
  setHarnessSessionStartSnapshot(null);
});

describe("session-start snapshot store", () => {
  it("starts null and round-trips a snapshot through get/set", () => {
    expect(getHarnessSessionStartSnapshot()).toBeNull();

    setHarnessSessionStartSnapshot(VALID);
    expect(getHarnessSessionStartSnapshot()).toEqual(VALID);

    setHarnessSessionStartSnapshot(null);
    expect(getHarnessSessionStartSnapshot()).toBeNull();
  });
});

describe("validateSessionStartSnapshot", () => {
  it("accepts a well-formed snapshot", () => {
    expect(validateSessionStartSnapshot(VALID)).toEqual(VALID);
  });

  it.each([
    ["non-object body", 42, "body must be an object"],
    ["missing driverName", { ...VALID, driverName: "" }, "driverName must be a non-empty string"],
    ["bad sessionType", { ...VALID, sessionType: "warmup" }, "sessionType must be one of: practice, qualifying, race"],
    ["non-numeric pitSpeedLimit", { ...VALID, pitSpeedLimit: "80" }, "pitSpeedLimit must be a finite number"],
    ["bad speedUnit", { ...VALID, speedUnit: "knots" }, "speedUnit must be one of: kmh, mph"],
    ["non-numeric trackTemp", { ...VALID, trackTemp: null }, "trackTemp must be a finite number"],
    ["non-numeric airTemp", { ...VALID, airTemp: NaN }, "airTemp must be a finite number"],
    ["bad tempUnit", { ...VALID, tempUnit: "kelvin" }, "tempUnit must be one of: celsius, fahrenheit"],
    ["wetness out of range", { ...VALID, wetness: TrackWetness.Unknown }, /wetness must be a TrackWetness/],
    ["non-integer wetness", { ...VALID, wetness: 2.5 }, /wetness must be a TrackWetness/],
  ])("rejects %s", (_label, body, expected) => {
    const result = validateSessionStartSnapshot(body);
    expect(typeof result).toBe("string");

    if (typeof expected === "string") {
      expect(result).toBe(expected);
    } else {
      expect(result as string).toMatch(expected);
    }
  });
});
