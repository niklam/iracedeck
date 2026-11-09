import { describe, expect, it } from "vitest";

import { parseTrackPitSpeedLimit } from "./pit-speed-limit.js";

describe("parseTrackPitSpeedLimit", () => {
  describe("a number with a unit", () => {
    it("reads a metric limit with its two published decimals", () => {
      expect(parseTrackPitSpeedLimit("80.00 kph")).toEqual({ value: 80, unit: "kmh", decimals: 2 });
    });

    it("returns a converted imperial limit as published, with no #1059 correction", () => {
      // 45.00 mph is published as "72.42 kph"; the half-unit window belongs to the translator.
      expect(parseTrackPitSpeedLimit("72.42 kph")).toEqual({ value: 72.42, unit: "kmh", decimals: 2 });
    });

    it("reads mph", () => {
      expect(parseTrackPitSpeedLimit("45 mph")).toEqual({ value: 45, unit: "mph", decimals: 0 });
    });

    it("matches the unit in any case", () => {
      expect(parseTrackPitSpeedLimit("80.00 KPH")).toEqual({ value: 80, unit: "kmh", decimals: 2 });
      expect(parseTrackPitSpeedLimit("45.00 MpH")).toEqual({ value: 45, unit: "mph", decimals: 2 });
    });

    it("reads every metric spelling as km/h", () => {
      expect(parseTrackPitSpeedLimit("60 km/h")).toEqual({ value: 60, unit: "kmh", decimals: 0 });
      expect(parseTrackPitSpeedLimit("60 kmh")).toEqual({ value: 60, unit: "kmh", decimals: 0 });
      expect(parseTrackPitSpeedLimit("60kph")).toEqual({ value: 60, unit: "kmh", decimals: 0 });
    });

    it("returns a published zero as zero, leaving 'unknown' to the consumer", () => {
      expect(parseTrackPitSpeedLimit("0.00 kph")).toEqual({ value: 0, unit: "kmh", decimals: 2 });
    });

    it("finds the limit anywhere in the string, as the translator always did", () => {
      expect(parseTrackPitSpeedLimit("limit: 55.5 mph ")).toEqual({ value: 55.5, unit: "mph", decimals: 1 });
    });

    it("keeps the translator's reading of a malformed digit run", () => {
      // `[\d.]+` takes "1.2.3"; parseFloat stops at the second dot and the
      // decimals count is the run after the first. Pinned so the shared parser
      // stays byte-compatible with the regex it replaced.
      expect(parseTrackPitSpeedLimit("1.2.3 kph")).toEqual({ value: 1.2, unit: "kmh", decimals: 1 });
    });

    it("rejects a unit whose digits do not make a number", () => {
      expect(parseTrackPitSpeedLimit(". kph")).toBeNull();
    });
  });

  describe("a bare number", () => {
    it("reads it as km/h, which is what iRacing publishes", () => {
      expect(parseTrackPitSpeedLimit("60")).toEqual({ value: 60, unit: "kmh", decimals: 0 });
    });

    it("keeps its decimals and ignores surrounding whitespace", () => {
      expect(parseTrackPitSpeedLimit(" 60.5 ")).toEqual({ value: 60.5, unit: "kmh", decimals: 1 });
    });

    it("rejects a lone dot", () => {
      expect(parseTrackPitSpeedLimit(".")).toBeNull();
    });

    it("rejects a number followed by anything that is not a unit", () => {
      expect(parseTrackPitSpeedLimit("60 knots")).toBeNull();
      expect(parseTrackPitSpeedLimit("-60")).toBeNull();
    });
  });

  describe("nothing to parse", () => {
    it("returns null for an empty or unreadable string", () => {
      expect(parseTrackPitSpeedLimit("")).toBeNull();
      expect(parseTrackPitSpeedLimit("   ")).toBeNull();
      expect(parseTrackPitSpeedLimit("abc")).toBeNull();
    });

    it("returns null for anything that is not a string", () => {
      expect(parseTrackPitSpeedLimit(undefined)).toBeNull();
      expect(parseTrackPitSpeedLimit(null)).toBeNull();
      expect(parseTrackPitSpeedLimit(80)).toBeNull();
    });
  });
});
