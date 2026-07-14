import { PitSvFlags } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { isAutofuelActive, isAutofuelEnabled, isFuelFillOn, isPitstopActive } from "./fuel-telemetry.js";

describe("isFuelFillOn", () => {
  it("returns true when the FuelFill flag is set", () => {
    expect(isFuelFillOn({ PitSvFlags: PitSvFlags.FuelFill } as never)).toBe(true);
  });

  it("returns false when the flag is clear, missing, or telemetry is null", () => {
    expect(isFuelFillOn({ PitSvFlags: 0 } as never)).toBe(false);
    expect(isFuelFillOn({} as never)).toBe(false);
    expect(isFuelFillOn(null)).toBe(false);
  });
});

describe("isPitstopActive", () => {
  it("returns true when the player car is receiving pit service", () => {
    expect(isPitstopActive({ PitstopActive: true } as never)).toBe(true);
  });

  it("returns false when false, missing, or telemetry is null", () => {
    expect(isPitstopActive({ PitstopActive: false } as never)).toBe(false);
    expect(isPitstopActive({} as never)).toBe(false);
    expect(isPitstopActive(null)).toBe(false);
  });
});

describe("isAutofuelActive", () => {
  it("returns true when dpFuelAutoFillActive is nonzero", () => {
    expect(isAutofuelActive({ dpFuelAutoFillActive: 1 } as never)).toBe(true);
  });

  it("returns false when 0, missing, or telemetry is null", () => {
    expect(isAutofuelActive({ dpFuelAutoFillActive: 0 } as never)).toBe(false);
    expect(isAutofuelActive({} as never)).toBe(false);
    expect(isAutofuelActive(null)).toBe(false);
  });
});

describe("isAutofuelEnabled", () => {
  it("returns true when dpFuelAutoFillEnabled is nonzero", () => {
    expect(isAutofuelEnabled({ dpFuelAutoFillEnabled: 1 } as never)).toBe(true);
  });

  it("returns false when dpFuelAutoFillEnabled is 0", () => {
    expect(isAutofuelEnabled({ dpFuelAutoFillEnabled: 0 } as never)).toBe(false);
  });

  it("defaults to true when the field is absent or telemetry is null", () => {
    expect(isAutofuelEnabled({} as never)).toBe(true);
    expect(isAutofuelEnabled(null)).toBe(true);
  });
});
