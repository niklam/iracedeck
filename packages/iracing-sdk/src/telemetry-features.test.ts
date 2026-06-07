import { SessionState, type TelemetryData } from "@iracedeck/iracing-native";
import { describe, expect, it } from "vitest";

import { hasPitLimiter, hasVisor, hasWipers, isPostRace, isPreGreen } from "./telemetry-features.js";

/** Build a minimal TelemetryData mock from a partial set of fields. */
function telemetry(fields: Partial<TelemetryData>): TelemetryData {
  return fields as TelemetryData;
}

describe("telemetry-features", () => {
  describe("hasPitLimiter", () => {
    it("returns true when dcPitSpeedLimiterToggle is present", () => {
      expect(hasPitLimiter(telemetry({ dcPitSpeedLimiterToggle: false }))).toBe(true);
      expect(hasPitLimiter(telemetry({ dcPitSpeedLimiterToggle: true }))).toBe(true);
    });

    it("returns false when the field is absent", () => {
      expect(hasPitLimiter(telemetry({}))).toBe(false);
    });

    it("returns false for null telemetry", () => {
      expect(hasPitLimiter(null)).toBe(false);
    });
  });

  describe("hasVisor", () => {
    it("returns true when dcTearOffVisor is present", () => {
      expect(hasVisor(telemetry({ dcTearOffVisor: false }))).toBe(true);
    });

    it("returns false when the field is absent", () => {
      expect(hasVisor(telemetry({}))).toBe(false);
    });

    it("returns false for null telemetry", () => {
      expect(hasVisor(null)).toBe(false);
    });
  });

  describe("hasWipers", () => {
    it("returns true when dcToggleWindshieldWipers is present", () => {
      expect(hasWipers(telemetry({ dcToggleWindshieldWipers: false }))).toBe(true);
    });

    it("returns true when dcTriggerWindshieldWipers is present", () => {
      expect(hasWipers(telemetry({ dcTriggerWindshieldWipers: false }))).toBe(true);
    });

    it("returns true when both wiper fields are present", () => {
      expect(hasWipers(telemetry({ dcToggleWindshieldWipers: false, dcTriggerWindshieldWipers: false }))).toBe(true);
    });

    it("returns false when neither wiper field is present", () => {
      expect(hasWipers(telemetry({}))).toBe(false);
    });

    it("returns false for null telemetry", () => {
      expect(hasWipers(null)).toBe(false);
    });
  });

  describe("isPreGreen", () => {
    it("returns true for the pre-racing states (Invalid / GetInCar / Warmup / ParadeLaps)", () => {
      expect(isPreGreen(telemetry({ SessionState: SessionState.Invalid }))).toBe(true);
      expect(isPreGreen(telemetry({ SessionState: SessionState.GetInCar }))).toBe(true);
      expect(isPreGreen(telemetry({ SessionState: SessionState.Warmup }))).toBe(true);
      expect(isPreGreen(telemetry({ SessionState: SessionState.ParadeLaps }))).toBe(true);
    });

    it("returns false once racing and for the post-racing states", () => {
      expect(isPreGreen(telemetry({ SessionState: SessionState.Racing }))).toBe(false);
      expect(isPreGreen(telemetry({ SessionState: SessionState.Checkered }))).toBe(false);
      expect(isPreGreen(telemetry({ SessionState: SessionState.CoolDown }))).toBe(false);
    });

    it("returns false when SessionState is absent (back-compat default)", () => {
      expect(isPreGreen(telemetry({}))).toBe(false);
    });

    it("returns false for null/undefined telemetry", () => {
      expect(isPreGreen(null)).toBe(false);
      expect(isPreGreen(undefined)).toBe(false);
    });
  });

  describe("isPostRace", () => {
    it("returns true for the post-racing states (Checkered / CoolDown)", () => {
      expect(isPostRace(telemetry({ SessionState: SessionState.Checkered }))).toBe(true);
      expect(isPostRace(telemetry({ SessionState: SessionState.CoolDown }))).toBe(true);
    });

    it("returns false for the pre-racing and racing states", () => {
      expect(isPostRace(telemetry({ SessionState: SessionState.Invalid }))).toBe(false);
      expect(isPostRace(telemetry({ SessionState: SessionState.GetInCar }))).toBe(false);
      expect(isPostRace(telemetry({ SessionState: SessionState.Warmup }))).toBe(false);
      expect(isPostRace(telemetry({ SessionState: SessionState.ParadeLaps }))).toBe(false);
      expect(isPostRace(telemetry({ SessionState: SessionState.Racing }))).toBe(false);
    });

    it("returns false when SessionState is absent (back-compat default)", () => {
      expect(isPostRace(telemetry({}))).toBe(false);
    });

    it("returns false for null/undefined telemetry", () => {
      expect(isPostRace(null)).toBe(false);
      expect(isPostRace(undefined)).toBe(false);
    });
  });
});
