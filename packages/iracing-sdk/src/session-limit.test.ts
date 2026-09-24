/**
 * Unit tests for the shared session-limit helper (issue #1109): the two
 * sentinel-aware readers, the whichever-ends-sooner verdict with its tie to
 * laps, and the value companion that applies the verdict.
 */
import { describe, expect, it } from "vitest";

import {
  bindingLapsToGo,
  resolveBindingLimit,
  resolveLapsRemaining,
  resolveShownTimeRemainingS,
  resolveTimeRemainingS,
} from "./session-limit.js";
import { IRSDK_UNLIMITED_LAPS, IRSDK_UNLIMITED_TIME, type TelemetryData } from "./types.js";

/** Build a minimal TelemetryData mock from a partial set of fields. */
function telemetry(fields: Partial<TelemetryData>): TelemetryData {
  return fields as TelemetryData;
}

describe("resolveLapsRemaining", () => {
  it("returns a finite, non-negative counter as-is — 0 included, it is a real count", () => {
    expect(resolveLapsRemaining(telemetry({ SessionLapsRemainEx: 10 }))).toBe(10);
    expect(resolveLapsRemaining(telemetry({ SessionLapsRemainEx: 1 }))).toBe(1);
    expect(resolveLapsRemaining(telemetry({ SessionLapsRemainEx: 0 }))).toBe(0);
  });

  it("returns null on the unlimited sentinel (a timed race) and anything past it", () => {
    expect(resolveLapsRemaining(telemetry({ SessionLapsRemainEx: IRSDK_UNLIMITED_LAPS }))).toBeNull();
    expect(resolveLapsRemaining(telemetry({ SessionLapsRemainEx: IRSDK_UNLIMITED_LAPS + 1 }))).toBeNull();
  });

  it("returns null when the field is missing, or the telemetry itself is", () => {
    expect(resolveLapsRemaining(telemetry({}))).toBeNull();
    expect(resolveLapsRemaining(null)).toBeNull();
    expect(resolveLapsRemaining(undefined)).toBeNull();
  });

  it("returns null on a nonsensical reading (NaN, infinite, negative)", () => {
    expect(resolveLapsRemaining(telemetry({ SessionLapsRemainEx: NaN }))).toBeNull();
    expect(resolveLapsRemaining(telemetry({ SessionLapsRemainEx: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(resolveLapsRemaining(telemetry({ SessionLapsRemainEx: -1 }))).toBeNull();
  });
});

describe("resolveTimeRemainingS", () => {
  it("returns a finite, non-negative clock as-is — 0 included, the race is not over at expiry", () => {
    expect(resolveTimeRemainingS(telemetry({ SessionTimeRemain: 3661 }))).toBe(3661);
    expect(resolveTimeRemainingS(telemetry({ SessionTimeRemain: 0.5 }))).toBe(0.5);
    expect(resolveTimeRemainingS(telemetry({ SessionTimeRemain: 0 }))).toBe(0);
  });

  it("returns null on the unlimited sentinel (a lap race) and anything past it", () => {
    expect(resolveTimeRemainingS(telemetry({ SessionTimeRemain: IRSDK_UNLIMITED_TIME }))).toBeNull();
    expect(resolveTimeRemainingS(telemetry({ SessionTimeRemain: IRSDK_UNLIMITED_TIME + 1 }))).toBeNull();
  });

  it("returns null when the field is missing, or the telemetry itself is", () => {
    expect(resolveTimeRemainingS(telemetry({}))).toBeNull();
    expect(resolveTimeRemainingS(null)).toBeNull();
    expect(resolveTimeRemainingS(undefined)).toBeNull();
  });

  it("returns null on a nonsensical reading (NaN, infinite, negative)", () => {
    expect(resolveTimeRemainingS(telemetry({ SessionTimeRemain: NaN }))).toBeNull();
    expect(resolveTimeRemainingS(telemetry({ SessionTimeRemain: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(resolveTimeRemainingS(telemetry({ SessionTimeRemain: -1 }))).toBeNull();
  });
});

describe("resolveShownTimeRemainingS (#1221)", () => {
  it("returns a live clock as-is, 0 included", () => {
    expect(resolveShownTimeRemainingS(telemetry({ SessionTimeRemain: 3661 }))).toBe(3661);
    expect(resolveShownTimeRemainingS(telemetry({ SessionTimeRemain: 0 }))).toBe(0);
  });

  it("shows a clock that has run past zero as the 0 it has left", () => {
    expect(resolveShownTimeRemainingS(telemetry({ SessionTimeRemain: -3.2 }))).toBe(0);
    expect(resolveShownTimeRemainingS(telemetry({ SessionTimeRemain: -0.01 }))).toBe(0);
  });

  it("still returns null for the unlimited sentinel, a missing field and a non-finite reading", () => {
    expect(resolveShownTimeRemainingS(telemetry({ SessionTimeRemain: IRSDK_UNLIMITED_TIME }))).toBeNull();
    expect(resolveShownTimeRemainingS(telemetry({}))).toBeNull();
    expect(resolveShownTimeRemainingS(null)).toBeNull();
    expect(resolveShownTimeRemainingS(telemetry({ SessionTimeRemain: NaN }))).toBeNull();
    expect(resolveShownTimeRemainingS(telemetry({ SessionTimeRemain: Number.NEGATIVE_INFINITY }))).toBeNull();
    expect(resolveShownTimeRemainingS(telemetry({ SessionTimeRemain: Number.POSITIVE_INFINITY }))).toBeNull();
  });
});

describe("resolveBindingLimit", () => {
  it("lap-limited only: the lap cap binds", () => {
    expect(resolveBindingLimit(10, null)).toBe("laps");
  });

  it("timed only: the clock binds", () => {
    expect(resolveBindingLimit(null, 12)).toBe("time");
  });

  it("dual limit before any estimate exists: a finite lap cap binds over the clock", () => {
    // The 2026-08-08 capture — a 10-lap race under a 23.7 h clock. With no
    // lap-time estimate yet the caller cannot express the clock in laps and
    // passes null; the cap wins by being the only number, which is what stops
    // the key showing 23:44:24 for a lap and then flipping.
    expect(resolveBindingLimit(10, null)).toBe("laps");
  });

  it("dual limit where the clock ends the race sooner: time binds", () => {
    expect(resolveBindingLimit(10, 2)).toBe("time");
  });

  it("dual limit where the lap cap ends the race sooner: laps bind", () => {
    expect(resolveBindingLimit(3, 22)).toBe("laps");
  });

  it("a tie goes to laps — the cap is the hard number, the time side an estimate", () => {
    expect(resolveBindingLimit(5, 5)).toBe("laps");
    expect(resolveBindingLimit(0, 0)).toBe("laps");
  });

  it("both unknown or unlimited: none — a statement of ignorance, never a short race", () => {
    expect(resolveBindingLimit(null, null)).toBe("none");
  });

  it("a known 0 on one side still binds over an unknown other side", () => {
    expect(resolveBindingLimit(0, null)).toBe("laps");
    expect(resolveBindingLimit(null, 0)).toBe("time");
  });
});

describe("bindingLapsToGo", () => {
  it("returns the binding side's value, agreeing with the verdict about the tie", () => {
    expect(bindingLapsToGo(10, null)).toBe(10);
    expect(bindingLapsToGo(null, 12)).toBe(12);
    expect(bindingLapsToGo(10, 2)).toBe(2);
    expect(bindingLapsToGo(3, 22)).toBe(3);
    expect(bindingLapsToGo(5, 5)).toBe(5);
    expect(bindingLapsToGo(0, null)).toBe(0);
  });

  it("returns null when neither side is known — the caller decides what unknown means", () => {
    expect(bindingLapsToGo(null, null)).toBeNull();
  });
});
