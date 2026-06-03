import type { TelemetryData } from "@iracedeck/iracing-native";
import { describe, expect, it } from "vitest";

import { hasPitLimiter, hasVisor, hasWipers } from "./telemetry-features.js";

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
});
